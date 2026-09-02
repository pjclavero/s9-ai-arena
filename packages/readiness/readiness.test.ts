/**
 * R17 · Suite del motor de readiness.
 *
 * El test que importa es el de MUTACIONES: para cada comprobación se reproduce
 * un fallo real y se exige que la comprobación lo detecte. Una comprobación sin
 * mutación que la ponga roja se considera un defecto de la suite y falla aquí.
 */
import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CONFIG_MODEL, resolveConfig, isEnabled } from "./config.ts";
import { READINESS_CHECKS } from "./checks.ts";
import { runReadiness, type ReadinessContext } from "./engine.ts";
import { planFirstRun } from "./first-run.ts";
import { MUTATIONS, nominalContext, nominalEnv } from "./mutations.ts";
import { localProbes } from "./probes-local.ts";
import { renderReport } from "./report.ts";

describe("modelo de configuración", () => {
  it("el escenario nominal es válido y sin puertas encendidas", () => {
    const r = resolveConfig(nominalEnv());
    expect(r.problems.filter((p) => p.severity === "error")).toEqual([]);
    expect(r.gatesOn).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("faltar una clave obligatoria es error, no aviso", () => {
    const env = nominalEnv();
    delete env.RESTIC_REPOSITORY;
    const r = resolveConfig(env);
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.code === "missing_required" && p.key === "RESTIC_REPOSITORY")).toBe(true);
  });

  // El modelo describe el DESPLIEGUE REAL. Estas cuatro claves no existen en
  // ningún sitio de la instalación y producían cuatro bloqueantes permanentes
  // que ninguna configuración podía satisfacer.
  it("no exige claves que no existen en el despliegue", () => {
    const declaradas = new Set(CONFIG_MODEL.map((e) => e.key));
    for (const fantasma of ["S9_DATA_DIR", "S9_DB_URL", "S9_JWT_SECRET", "S9_BACKUP_TARGET"]) {
      expect(declaradas.has(fantasma)).toBe(false);
    }
  });

  it("el contrato real de secretos son las claves *_FILE con ruta montada", () => {
    for (const key of [
      "JWT_SECRET_FILE",
      "PGPASSWORD_FILE",
      "RESTIC_PASSWORD_FILE",
      "ARENA_ENGINE_SHARED_SECRET_FILE",
      "REPLAY_INGEST_SECRET_FILE",
    ]) {
      const entry = CONFIG_MODEL.find((e) => e.key === key);
      expect(entry, `${key} debe estar en el modelo`).toBeDefined();
      expect(entry!.pathToSecret).toBe(true);
    }
  });

  it("un secreto puesto en la clave *_FILE en vez de su ruta es ERROR", () => {
    const r = resolveConfig({ ...nominalEnv(), JWT_SECRET_FILE: "un-secreto-en-claro" });
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.code === "forbidden_value" && p.key === "JWT_SECRET_FILE")).toBe(true);
  });

  it("las dos claves S9_* que se conservan siguen en el modelo, con justificación de uso real", () => {
    const declaradas = new Set(CONFIG_MODEL.map((e) => e.key));
    // S9_DOMAIN está en el .env de la instalación; las puertas las lee apps/api.
    for (const real of ["S9_DOMAIN", "S9_ENABLE_REAL_BATTLE_RUNS", "S9_PUBLIC_SPECTATE_ENABLED"]) {
      expect(declaradas.has(real)).toBe(true);
    }
  });

  it("encender una puerta bloqueada por el operador es ERROR", () => {
    for (const key of ["S9_ENABLE_REAL_BATTLE_RUNS", "S9_PUBLIC_SPECTATE_ENABLED"]) {
      const r = resolveConfig({ ...nominalEnv(), [key]: "1" });
      expect(r.gatesOn).toContain(key);
      expect(r.problems.some((p) => p.code === "gate_blocked" && p.key === key)).toBe(true);
      expect(r.ok).toBe(false);
    }
  });

  it("las puertas están apagadas por defecto cuando no se declaran", () => {
    const env = nominalEnv();
    delete env.S9_ENABLE_REAL_BATTLE_RUNS;
    delete env.S9_PUBLIC_SPECTATE_ENABLED;
    expect(resolveConfig(env).gatesOn).toEqual([]);
  });

  it("un secreto por entorno nunca se imprime", () => {
    const r = resolveConfig({ ...nominalEnv(), DATABASE_URL: "postgres://u:changeme@h/db" });
    const problem = r.problems.find((p) => p.code === "secret_inline" && p.key === "DATABASE_URL");
    expect(problem).toBeDefined();
    expect(problem!.message).not.toContain("changeme");
    expect(r.effective.DATABASE_URL).not.toContain("changeme");
  });

  it("un secreto por entorno en claro genera aviso a favor de *_FILE", () => {
    const r = resolveConfig({ ...nominalEnv(), DATABASE_URL: "postgres://u:p@<internal-db-host>/db" });
    expect(r.problems.some((p) => p.code === "secret_inline" && p.key === "DATABASE_URL")).toBe(true);
  });

  it("una clave fantasma de las familias del proyecto también se señala", () => {
    const r = resolveConfig({ ...nominalEnv(), RESTIC_TURBO: "1" });
    expect(r.problems.some((p) => p.code === "unknown_key" && p.key === "RESTIC_TURBO")).toBe(true);
  });

  it("una clave S9_* desconocida se señala como configuración fantasma", () => {
    const r = resolveConfig({ ...nominalEnv(), S9_TURBO_MODE: "1" });
    expect(r.problems.some((p) => p.code === "unknown_key" && p.key === "S9_TURBO_MODE")).toBe(true);
  });

  it("REPLAYS_DIR en /tmp es un valor prohibido", () => {
    const r = resolveConfig({ ...nominalEnv(), REPLAYS_DIR: "/tmp" });
    expect(r.ok).toBe(false);
  });

  it("isEnabled interpreta igual todas las formas afirmativas", () => {
    for (const v of ["1", "true", "TRUE", " yes ", "on"]) expect(isEnabled(v)).toBe(true);
    for (const v of ["0", "false", "", undefined, "no"]) expect(isEnabled(v)).toBe(false);
  });

  it("toda entrada del modelo declara propósito, y las puertas tienen defecto apagado", () => {
    for (const e of CONFIG_MODEL) {
      expect(e.purpose.length).toBeGreaterThan(10);
      if (e.kind === "gate") expect(isEnabled(e.default)).toBe(false);
      if (e.kind === "safeDefault") expect(e.default).toBeDefined();
    }
  });
});

describe("contrato de las comprobaciones", () => {
  it("toda comprobación declara qué demuestra y qué NO demuestra", () => {
    for (const c of READINESS_CHECKS) {
      expect(c.proves.length).toBeGreaterThan(20);
      expect(c.doesNotProve.length).toBeGreaterThan(20);
      expect(c.proves).not.toEqual(c.doesNotProve);
    }
  });

  it("los identificadores son únicos", () => {
    const ids = READINESS_CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("hay cobertura de los seis bloques de R17", () => {
    const blocks = new Set(READINESS_CHECKS.map((c) => c.block));
    for (const b of [
      "almacenamiento",
      "copias",
      "puertas-ejecucion",
      "puertas-spectator",
      "seguridad",
      "diagnostico",
    ]) {
      expect(blocks).toContain(b);
    }
  });
});

describe("motor", () => {
  it("el escenario nominal da READY", async () => {
    const report = await runReadiness(READINESS_CHECKS, nominalContext());
    expect(report.verdict).toBe("READY");
    expect(report.counts.verified).toBe(READINESS_CHECKS.length);
    expect(report.blockers).toEqual([]);
  });

  it("una sonda que lanza excepción NO se salta: deja NOT_READY", async () => {
    const ctx = nominalContext();
    ctx.probes.dataDirWrite = async () => {
      throw new Error("boom");
    };
    const report = await runReadiness(READINESS_CHECKS, ctx);
    expect(report.verdict).toBe("NOT_READY");
    const r = report.results.find((x) => x.check.id === "storage.writable")!;
    expect(r.outcome.status).toBe("not_exercised");
  });

  it("no-ejercida nunca cuenta como aprobada", async () => {
    const ctx: ReadinessContext = { env: nominalEnv(), probes: localProbes() };
    const report = await runReadiness(READINESS_CHECKS, ctx);
    expect(report.verdict).toBe("NOT_READY");
    expect(report.counts.not_exercised).toBeGreaterThan(0);
    expect(report.counts.verified).toBeLessThan(READINESS_CHECKS.length);
  });

  it("las sondas locales sí ejercen de verdad la escritura en disco", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r17-"));
    try {
      const ctx: ReadinessContext = { env: { REPLAYS_DIR: dir }, probes: localProbes() };
      const check = READINESS_CHECKS.find((c) => c.id === "storage.writable")!;
      const ok = await check.run(ctx);
      expect(ok.status).toBe("verified");

      // Mutación real sobre el sistema de ficheros: sin permiso de escritura,
      // la misma comprobación debe ponerse roja.
      chmodSync(dir, 0o500);
      const denied = await check.run(ctx);
      if (process.getuid?.() === 0) {
        // root ignora los permisos: no se puede provocar el fallo así.
        expect(["verified", "failed"]).toContain(denied.status);
      } else {
        // Se INTENTÓ escribir y el sistema de ficheros lo rechazó: eso es un
        // fallo comprobado, no una comprobación pendiente.
        expect(denied.status).toBe("failed");
        expect(denied.evidence).toContain("se intentó escribir");
      }
    } finally {
      try {
        chmodSync(dir, 0o700);
      } catch {
        /* limpieza best-effort */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mutaciones: cada comprobación puede ponerse ROJA", () => {
  it("toda comprobación tiene al menos una mutación que la detecta", () => {
    const cubiertas = new Set(MUTATIONS.map((m) => m.checkId));
    const sinMutacion = READINESS_CHECKS.filter((c) => !cubiertas.has(c.id)).map((c) => c.id);
    expect(sinMutacion).toEqual([]);
  });

  it("toda mutación apunta a una comprobación existente", () => {
    const ids = new Set(READINESS_CHECKS.map((c) => c.id));
    for (const m of MUTATIONS) expect(ids.has(m.checkId)).toBe(true);
  });

  for (const mutation of MUTATIONS) {
    it(`[${mutation.checkId}] detecta: ${mutation.name}`, async () => {
      const ctx = nominalContext();
      mutation.apply(ctx);
      const report = await runReadiness(READINESS_CHECKS, ctx);
      const result = report.results.find((r) => r.check.id === mutation.checkId)!;
      expect(result.outcome.status).not.toBe("verified");
      expect(result.outcome.remedy ?? "").not.toBe("");
      if (result.check.required) expect(report.verdict).toBe("NOT_READY");
    });
  }
});

describe("asistente de primer arranque", () => {
  it("con configuración vacía no deja continuar y pide lo obligatorio", () => {
    const plan = planFirstRun({});
    expect(plan.canProceed).toBe(false);
    const pendientes = plan.steps.filter((s) => s.mandatory && s.state !== "done").map((s) => s.id);
    expect(pendientes).toContain("config.REPLAYS_DIR");
    expect(pendientes).toContain("config.JWT_SECRET_FILE");
  });

  it("con el nominal y sin readiness ejecutado, los pasos de config quedan hechos", () => {
    const plan = planFirstRun(nominalEnv());
    expect(plan.canProceed).toBe(true);
    expect(plan.steps.find((s) => s.id === "gate.S9_ENABLE_REAL_BATTLE_RUNS")!.state).toBe("done");
  });

  it("un readiness con comprobaciones no ejercidas deja pasos 'unknown' y bloquea", async () => {
    const report = await runReadiness(READINESS_CHECKS, {
      env: nominalEnv(),
      probes: localProbes(),
    });
    const plan = planFirstRun(nominalEnv(), report);
    expect(plan.canProceed).toBe(false);
    expect(plan.steps.some((s) => s.state === "unknown")).toBe(true);
  });

  it("una puerta bloqueada encendida deja el plan en pendiente", () => {
    const plan = planFirstRun({ ...nominalEnv(), S9_PUBLIC_SPECTATE_ENABLED: "1" });
    expect(plan.canProceed).toBe(false);
  });
});

describe("informe", () => {
  it("incluye veredicto, recuento completo y el 'NO demuestra' de cada comprobación", async () => {
    const report = await runReadiness(READINESS_CHECKS, nominalContext());
    const texto = renderReport(report, resolveConfig(nominalEnv()), planFirstRun(nominalEnv(), report));
    expect(texto).toContain("VEREDICTO: READY");
    expect(texto).toContain("no-ejercidas=");
    for (const c of READINESS_CHECKS) expect(texto).toContain(c.id);
    expect(texto).toContain("NO demuestra:");
  });

  it("nunca imprime el valor de un secreto", async () => {
    const env = { ...nominalEnv(), DATABASE_URL: "postgres://u:valor-super-secreto-42@h/db" };
    const report = await runReadiness(READINESS_CHECKS, { env, probes: nominalContext().probes });
    const texto = renderReport(report, resolveConfig(env), planFirstRun(env, report));
    expect(texto).not.toContain("valor-super-secreto-42");
  });
});

/**
 * La frontera de los tres estados. Estos tests son el gate de la corrección que
 * motivó este carril: `security.secret_mounted` devolvía `failed` cuando la
 * sonda decía "no disponible en este entorno" — un FALSO FALLO que afirmaba
 * "no está montado" sin haber mirado nada. Cuatro rojos falsos entierran los
 * rojos de verdad, así que la distinción se prueba comprobación a comprobación.
 */
describe("semántica de los tres estados", () => {
  const conSonda = async (id: string, mutar: (ctx: ReadinessContext) => void) => {
    const ctx = nominalContext();
    mutar(ctx);
    const report = await runReadiness(READINESS_CHECKS, ctx);
    return report.results.find((r) => r.check.id === id)!.outcome;
  };

  it("no haber mirado el montaje del secreto es NO EJERCIDA, nunca FALLIDA", async () => {
    const o = await conSonda("security.secret_mounted", (c) => {
      c.probes.secretMounted = async () => ({
        probed: false,
        existsOnHost: false,
        mountedInProcess: false,
        readableBytes: 0,
        reason: "sonda no disponible en este entorno",
      });
    });
    expect(o.status).toBe("not_exercised");
    expect(o.evidence).toContain("no se pudo mirar");
  });

  it("haber mirado y no estar montado SÍ es FALLIDA", async () => {
    const o = await conSonda("security.secret_mounted", (c) => {
      c.probes.secretMounted = async () => ({
        probed: true,
        existsOnHost: true,
        mountedInProcess: false,
        readableBytes: 0,
      });
    });
    expect(o.status).toBe("failed");
  });

  it("un efecto nulo OBSERVADO es FALLIDA, no una comprobación pendiente", async () => {
    // Cada uno de estos casos se miró de verdad y salió a cero. Antes los seis
    // se contaban como `not_exercised`, que es "ya lo miraremos".
    expect(
      (
        await conSonda("storage.writable", (c) => {
          c.probes.dataDirWrite = async () => ({
            attempted: true,
            bytesWritten: 0,
            readBack: false,
            sameContent: false,
            reason: "EACCES",
          });
        })
      ).status,
    ).toBe("failed");
    expect(
      (
        await conSonda("backup.last_snapshot_verified", (c) => {
          c.probes.backupLastSnapshot = async () => ({
            probed: true,
            snapshotCount: 3,
            repositorySnapshotCount: 7,
            latestSnapshotAt: "2026-08-30T02:00:05Z",
            latestSnapshotBytes: 0,
            ageHours: 2,
          });
        })
      ).status,
    ).toBe("failed");
    expect(
      (
        await conSonda("backup.restore_verified", (c) => {
          c.probes.backupRestoreDrill = async () => ({
            attempted: true,
            restoredBytes: 0,
            canaryFound: false,
          });
        })
      ).status,
    ).toBe("failed");
    expect(
      (
        await conSonda("diagnostics.db_canary", (c) => {
          c.probes.dbCanary = async () => ({ queryExecuted: true, canaryRowsSeen: 0, rowsAffected: 0 });
        })
      ).status,
    ).toBe("failed");
    expect(
      (
        await conSonda("diagnostics.bundle_redacted", (c) => {
          c.probes.diagnosticsBundle = async () => ({ generated: true, bytes: 0, secretLikeMatches: 0 });
        })
      ).status,
    ).toBe("failed");
    expect(
      (
        await conSonda("backup.pg_dump_checksum_verified", (c) => {
          c.probes.backupPgDumpChecksum = async () => ({ probed: true, checksumMatches: true, dumpBytes: 0 });
        })
      ).status,
    ).toBe("failed");
  });

  it("no haber mirado NUNCA se convierte en FALLIDA en ninguna comprobación", async () => {
    // Con las sondas locales (que no observan infraestructura), ninguna
    // comprobación puede afirmar un fallo: o mira de verdad, o dice que no.
    const report = await runReadiness(READINESS_CHECKS, { env: nominalEnv(), probes: localProbes() });
    for (const { check, outcome } of report.results) {
      if (outcome.status !== "failed") continue;
      expect(outcome.evidence, `${check.id} afirma un fallo sin haber observado nada`).not.toContain(
        "no disponible en este entorno",
      );
    }
  });
});

/**
 * Descomposición del bloque de copias. "Cron vivo" no es "backup listo": el
 * healthcheck real del servicio es `pgrep crond` y pasa en verde con la copia
 * fallando todas las noches.
 */
describe("copias descompuestas", () => {
  it("el planificador vivo NO alcanza para declarar readiness", async () => {
    const ctx = nominalContext();
    // Cron vivo, pero la copia de anoche falló.
    ctx.probes.backupLastRun = async () => ({
      probed: true,
      ranAt: "2026-08-30T02:00:00Z",
      exitCode: 2,
      ageHours: 6,
    });
    const report = await runReadiness(READINESS_CHECKS, ctx);
    const vivo = report.results.find((r) => r.check.id === "backup.process_alive")!;
    expect(vivo.outcome.status).toBe("verified");
    expect(report.verdict).toBe("NOT_READY");
    expect(report.blockers.some((b) => b.startsWith("backup.last_run_success"))).toBe(true);
  });

  it("las cinco comprobaciones de copias existen y sólo process_alive no bloquea", () => {
    const copias = READINESS_CHECKS.filter((c) => c.block === "copias");
    expect(copias.map((c) => c.id).sort()).toEqual([
      "backup.last_run_success",
      "backup.last_snapshot_verified",
      "backup.pg_dump_checksum_verified",
      "backup.process_alive",
      "backup.restore_verified",
    ]);
    expect(copias.filter((c) => !c.required).map((c) => c.id)).toEqual(["backup.process_alive"]);
  });
});

/**
 * Huecos encontrados por la propia calibración: tres mutaciones al código de
 * producción sobrevivían porque las comprobaciones se ponían rojas por el
 * motivo EQUIVOCADO. Un rojo con la causa cambiada manda al operador a arreglar
 * lo que no está roto, así que aquí se ata el motivo, no sólo el color.
 */
describe("el motivo del rojo también se calibra", () => {
  it("repositorio vacío y snapshot de 0 bytes son diagnósticos DISTINTOS", async () => {
    const ctx = nominalContext();
    ctx.probes.backupLastSnapshot = async () => ({
      probed: true,
      snapshotCount: 0,
      repositorySnapshotCount: 18,
      latestSnapshotAt: null,
      latestSnapshotBytes: 0,
      ageHours: null,
    });
    const vacio = (await runReadiness(READINESS_CHECKS, ctx)).results.find(
      (r) => r.check.id === "backup.last_snapshot_verified",
    )!.outcome;
    expect(vacio.status).toBe("failed");
    expect(vacio.evidence).toContain("no hay ningún snapshot");

    ctx.probes.backupLastSnapshot = async () => ({
      probed: true,
      snapshotCount: 4,
      repositorySnapshotCount: 9,
      latestSnapshotAt: "2026-09-02T04:15:01Z",
      latestSnapshotBytes: 0,
      ageHours: 2,
    });
    const cero = (await runReadiness(READINESS_CHECKS, ctx)).results.find(
      (r) => r.check.id === "backup.last_snapshot_verified",
    )!.outcome;
    expect(cero.status).toBe("failed");
    expect(cero.evidence).toContain("0 bytes");
  });

  it("no intentar la escritura NO se convierte en 'volumen que rechaza'", async () => {
    const ctx = nominalContext();
    ctx.probes.dataDirWrite = async () => ({
      attempted: false,
      bytesWritten: 0,
      readBack: false,
      sameContent: false,
      reason: "el volumen no está montado en este proceso",
    });
    const o = (await runReadiness(READINESS_CHECKS, ctx)).results.find(
      (r) => r.check.id === "storage.writable",
    )!.outcome;
    expect(o.status).toBe("not_exercised");
    expect(o.evidence).toContain("no se intentó escribir");
  });
});

/**
 * Defectos encontrados por el coordinador verificando el informe contra la
 * máquina. Ninguno de los dos era un número mal copiado: los dos son la misma
 * clase de fallo que R17 existe para no cometer — describir un SUBCONJUNTO como
 * si fuera el todo, y leer una AUSENCIA de una vista parcial.
 */
describe("un subconjunto no se describe como el todo", () => {
  const conSnapshots = async (probe: ReadinessContext["probes"]["backupLastSnapshot"]) => {
    const ctx = nominalContext();
    ctx.probes.backupLastSnapshot = probe;
    return (await runReadiness(READINESS_CHECKS, ctx)).results.find(
      (r) => r.check.id === "backup.last_snapshot_verified",
    )!.outcome;
  };

  it("el recuento verde nombra el subconjunto de datos Y el total del repositorio", async () => {
    // En la instalación real son 17 snapshots con la etiqueta de datos de 35 en
    // el repositorio (17 de datos + 17 de secretos + 1 de la primera copia).
    // Decir "17 snapshots en el repositorio" es falso, y esa frase salió del
    // informe a un humano que tuvo que ir a desmentirla a mano.
    const o = await conSnapshots(async () => ({
      probed: true,
      snapshotCount: 17,
      repositorySnapshotCount: 35,
      latestSnapshotAt: "2026-09-02T04:15:01Z",
      latestSnapshotBytes: 108_979,
      ageHours: 6,
    }));
    expect(o.status).toBe("verified");
    expect(o.evidence).toContain("17");
    expect(o.evidence).toContain("35");
    expect(o.evidence).toContain("etiqueta de datos");
  });

  it("cero de datos con el repositorio lleno NO se cuenta como repositorio vacío", async () => {
    const o = await conSnapshots(async () => ({
      probed: true,
      snapshotCount: 0,
      repositorySnapshotCount: 18,
      latestSnapshotAt: null,
      latestSnapshotBytes: 0,
      ageHours: null,
    }));
    expect(o.status).toBe("failed");
    // El operador tiene que poder distinguir "la copia de datos no está
    // llegando" de "no hay repositorio", que se arreglan en sitios distintos.
    expect(o.evidence).toContain("etiqueta de datos");
    expect(o.evidence).toContain("18");
  });
});

describe("una clave que falta no acusa a un servicio de estar caído", () => {
  it("el modelo declara QUÉ servicio aporta cada clave obligatoria", () => {
    for (const e of CONFIG_MODEL.filter((x) => x.kind === "required")) {
      expect(e.providedBy, `${e.key} no declara quién la aporta`).toBeDefined();
      expect(e.providedBy!.length).toBeGreaterThan(0);
    }
  });

  it("el aviso de clave ausente dice quién la aporta y que eso no es un servicio caído", () => {
    // Resolver el modelo de la INSTALACIÓN contra el entorno de UN proceso
    // siempre echará en falta las claves de los demás. Sin este texto, "falta
    // JWT_SECRET_FILE" se leyó como "la API no está en marcha" — y la API
    // llevaba tres días sana con sus cuatro secretos montados.
    const soloCopias = {
      RESTIC_REPOSITORY: "sftp:<usuario>@<backup-host>:/<repo>",
      RESTIC_PASSWORD_FILE: "/run/secrets/<secret-name>",
      RESTIC_SSH_KEY_FILE: "/run/secrets/<secret-name>",
      RESTIC_SSH_KNOWN_HOSTS_FILE: "/run/secrets/<secret-name>",
    };
    const problema = resolveConfig(soloCopias).problems.find(
      (p) => p.code === "missing_required" && p.key === "JWT_SECRET_FILE",
    );
    expect(problema).toBeDefined();
    expect(problema!.message).toContain("api");
    expect(problema!.message).toContain("NO significa que ese servicio esté caído");
  });
});
