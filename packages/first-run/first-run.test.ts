/**
 * R17 · Suite del asistente de primer arranque.
 *
 * Tres cosas se comprueban aquí y en este orden de importancia:
 *
 *  1. Que cada comprobación del asistente PUEDE ponerse roja (mutaciones).
 *  2. Que la sonda de almacenamiento es real: escribe de verdad en un
 *     directorio de verdad y se pone roja con un fallo real, no simulado.
 *  3. Que el asistente no aprueba por omisión ni activa nada: sin evidencia
 *     hay `unknown`, y ninguna puerta bloqueada se concede jamás.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveConfig } from "../readiness/config.ts";
import { READINESS_CHECKS } from "../readiness/checks.ts";
import { runReadiness, type ReadinessCheck } from "../readiness/engine.ts";
import { FIRST_RUN_CHECKS, resolveStorageDir, type FirstRunContext } from "./checks.ts";
import { CONFUSIONS } from "./confusions.ts";
import { CHECK_COVERAGE, DOMAINS } from "./domains.ts";
import { FIRST_RUN_MUTATIONS, nominalFirstRunContext, nominalFirstRunEnv } from "./mutations.ts";
import { localStorageWrite } from "./probes-local.ts";
import { coveredConfusions, planWizard, renderWizard, type WizardPlan } from "./wizard.ts";
import { requestActivation, requiredAcknowledgement, MAX_EVIDENCE_AGE_MINUTES } from "./activation.ts";

const ALL_CHECKS = [...READINESS_CHECKS, ...FIRST_RUN_CHECKS] as readonly ReadinessCheck[];

async function nominalPlan(): Promise<WizardPlan> {
  const ctx = nominalFirstRunContext();
  const report = await runReadiness(ALL_CHECKS, ctx);
  return planWizard({ resolution: resolveConfig(ctx.env), report });
}

describe("modelo de dominios y confusiones", () => {
  it("cubre los trece dominios del encargo, sin duplicados", () => {
    expect(DOMAINS).toHaveLength(13);
    expect(new Set(DOMAINS.map((d) => d.id)).size).toBe(13);
  });

  it("cada requisito de un dominio existe en el modelo", () => {
    const ids = new Set(DOMAINS.map((d) => d.id));
    for (const d of DOMAINS) for (const r of d.requires) expect(ids.has(r)).toBe(true);
  });

  it("las siete confusiones están declaradas y alguna comprobación las cubre", () => {
    expect(CONFUSIONS).toHaveLength(7);
    const claimed = new Set(Object.values(CHECK_COVERAGE).flat());
    for (const c of CONFUSIONS) expect(claimed.has(c.id)).toBe(true);
  });

  it("toda comprobación declara qué NO demuestra", () => {
    for (const c of FIRST_RUN_CHECKS) expect(c.doesNotProve.trim().length).toBeGreaterThan(20);
  });
});

describe("mutaciones: cada comprobación del asistente puede ponerse roja", () => {
  it("cada comprobación tiene al menos una mutación que la ataca", () => {
    for (const check of FIRST_RUN_CHECKS) {
      expect(FIRST_RUN_MUTATIONS.some((m) => m.checkId === check.id)).toBe(true);
    }
  });

  it("el escenario nominal deja TODAS las comprobaciones del asistente verificadas", async () => {
    const ctx = nominalFirstRunContext();
    for (const check of FIRST_RUN_CHECKS) {
      const outcome = await check.run(ctx);
      expect(`${check.id}:${outcome.status}`).toBe(`${check.id}:verified`);
    }
  });

  for (const mutation of FIRST_RUN_MUTATIONS) {
    it(`«${mutation.name}» saca ${mutation.checkId} de verificada`, async () => {
      const ctx: FirstRunContext = nominalFirstRunContext();
      mutation.apply(ctx);
      const check = FIRST_RUN_CHECKS.find((c) => c.id === mutation.checkId)!;
      const outcome = await check.run(ctx);
      expect(outcome.status).not.toBe("verified");
      expect(outcome.evidence.length).toBeGreaterThan(0);
      expect(outcome.remedy ?? "").not.toBe("");
    });
  }
});

describe("sonda de almacenamiento REAL (no simulada)", () => {
  it("escribe, relee y limpia de verdad, diciendo con qué uid", () => {
    const dir = mkdtempSync(join(tmpdir(), "r17-fr-ok-"));
    try {
      const r = localStorageWrite("bots", join(dir, "bots"));
      expect(r.bytesWritten).toBeGreaterThan(0);
      expect(r.sameContent).toBe(true);
      expect(r.cleanedUp).toBe(true);
      if (typeof process.getuid === "function") expect(r.uid).toBe(process.getuid());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("se pone roja con un fallo REAL del sistema de ficheros (un fichero donde debía haber directorio)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r17-fr-notdir-"));
    const file = join(dir, "no-soy-un-directorio");
    writeFileSync(file, "x");
    try {
      const r = localStorageWrite("replays", file);
      expect(r.bytesWritten).toBe(0);
      expect(r.reason ?? "").not.toBe("");

      const ctx = nominalFirstRunContext();
      ctx.env.S9_REPLAYS_DIR = file;
      ctx.probes.storageWriteAsProcess = async (kind, d) => localStorageWrite(kind, d);
      const check = FIRST_RUN_CHECKS.find((c) => c.id === "storage.replays.writable_by_process")!;
      expect((await check.run(ctx)).status).not.toBe("verified");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("un directorio sin permiso de escritura no aprueba (se omite si el proceso es root)", async () => {
    if (typeof process.getuid !== "function" || process.getuid() === 0) return;
    const base = mkdtempSync(join(tmpdir(), "r17-fr-ro-"));
    const dir = join(base, "solo-lectura");
    try {
      const seed = localStorageWrite("bots", dir);
      expect(seed.bytesWritten).toBeGreaterThan(0);
      chmodSync(dir, 0o500);
      const r = localStorageWrite("bots", dir);
      expect(r.bytesWritten).toBe(0);
      expect(r.uid).toBe(process.getuid());
    } finally {
      try {
        chmodSync(dir, 0o700);
      } catch {
        /* limpieza, no veredicto */
      }
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("escribir CERO bytes no es 'escribible': es no ejercido, aunque la relectura diga que sí", async () => {
    // La forma exacta de EXIT 0 != EFFECT VERIFIED: la operación no da error y
    // la relectura 'coincide', pero no se escribió nada. Debe quedar
    // `not_exercised`, nunca `verified`.
    const ctx = nominalFirstRunContext();
    ctx.probes.storageWriteAsProcess = async (_kind, dir) => ({
      dir,
      uid: 1000,
      gid: 1000,
      bytesWritten: 0,
      readBack: true,
      sameContent: true,
      cleanedUp: true,
    });
    for (const id of ["storage.bots.writable_by_process", "storage.replays.writable_by_process"]) {
      const outcome = await FIRST_RUN_CHECKS.find((c) => c.id === id)!.run(ctx);
      expect([id, outcome.status]).toEqual([id, "not_exercised"]);
    }
  });

  it("resolveStorageDir separa bots y replays y no inventa ruta sin datos", () => {
    const env = nominalFirstRunEnv();
    delete env.S9_BOTS_DIR;
    delete env.S9_REPLAYS_DIR;
    expect(resolveStorageDir(env, "bots")).not.toBe(resolveStorageDir(env, "replays"));
    expect(resolveStorageDir({}, "bots")).toBe("");
  });
});

describe("asistente: nominal", () => {
  it("con todo verificado el recorrido queda satisfecho y READY", async () => {
    const plan = await nominalPlan();
    expect(plan.blockers).toEqual([]);
    expect(plan.verdict).toBe("READY");
    expect(plan.unresolvedConfusions).toEqual([]);
    expect(plan.missingChecks).toEqual([]);
    for (const s of plan.stages)
      expect([s.domain.id, s.state]).toEqual([s.domain.id, expect.stringMatching(/^(satisfied|off_by_design)$/)]);
  });

  it("las puertas quedan APAGADAS por diseño, no 'completadas'", async () => {
    const plan = await nominalPlan();
    for (const id of ["ejecucion", "spectator"]) {
      expect(plan.stages.find((s) => s.domain.id === id)!.state).toBe("off_by_design");
    }
    expect(plan.blockedGates).toEqual(["S9_ENABLE_REAL_BATTLE_RUNS", "S9_PUBLIC_SPECTATE_ENABLED"]);
  });

  it("el informe se puede renderizar sin filtrar secretos", async () => {
    const text = renderWizard(await nominalPlan());
    expect(text).toContain("VEREDICTO: READY");
    expect(text).not.toMatch(/changeme|BEGIN [A-Z ]*PRIVATE KEY/);
  });
});

describe("asistente: nada se aprueba por omisión", () => {
  it("una comprobación AUSENTE deja el dominio en unknown, nunca satisfecho", async () => {
    const ctx = nominalFirstRunContext();
    const report = await runReadiness(
      ALL_CHECKS.filter((c) => c.id !== "backup.restore_drill"),
      ctx,
    );
    const plan = planWizard({ resolution: resolveConfig(ctx.env), report });
    const restauracion = plan.stages.find((s) => s.domain.id === "restauracion")!;
    expect(restauracion.state).toBe("unknown");
    expect(plan.missingChecks).toContain("backup.restore_drill");
    expect(plan.verdict).toBe("NOT_READY");
  });

  it("ausencia de una comprobación cuya confusión SÍ cubre otra: aun así queda unknown", async () => {
    // Caso duro: `diagnostics.bundle_redacted` falta, pero su confusión
    // (secret_exists_vs_mounted) la cubre otra comprobación verificada. Si el
    // asistente aprobara por omisión, aquí saldría satisfecho. No debe.
    const ctx = nominalFirstRunContext();
    const report = await runReadiness(
      ALL_CHECKS.filter((c) => c.id !== "diagnostics.bundle_redacted"),
      ctx,
    );
    const plan = planWizard({ resolution: resolveConfig(ctx.env), report });
    expect(plan.unresolvedConfusions).toEqual([]);
    expect(plan.stages.find((s) => s.domain.id === "seguridad")!.state).toBe("unknown");
    expect(plan.verdict).toBe("NOT_READY");
  });

  it("un `not_exercised` cuenta como NO listo (un skipped no es un aprobado)", async () => {
    const ctx = nominalFirstRunContext();
    ctx.probes.backupRestoreDrill = async () => ({
      attempted: false,
      restoredBytes: 0,
      canaryFound: false,
      reason: "sin infraestructura",
    });
    const plan = planWizard({ resolution: resolveConfig(ctx.env), report: await runReadiness(ALL_CHECKS, ctx) });
    expect(plan.stages.find((s) => s.domain.id === "restauracion")!.state).toBe("unknown");
    expect(plan.verdict).toBe("NOT_READY");
    expect(plan.unresolvedConfusions).toContain("backed_up_vs_recovery_verified");
  });

  it("un fallo en un cimiento BLOQUEA el piso de arriba aunque su evidencia esté verde", async () => {
    const ctx = nominalFirstRunContext();
    ctx.probes.dataDirWrite = async () => ({
      bytesWritten: 0,
      readBack: false,
      sameContent: false,
      reason: "EACCES",
    });
    const plan = planWizard({ resolution: resolveConfig(ctx.env), report: await runReadiness(ALL_CHECKS, ctx) });
    expect(plan.stages.find((s) => s.domain.id === "almacenamiento")!.state).toBe("unknown");
    for (const id of ["almacenamiento-bots", "almacenamiento-replays"]) {
      const stage = plan.stages.find((s) => s.domain.id === id)!;
      expect(stage.state).toBe("blocked");
      expect(stage.gaps.join(" ")).toContain("requisitos no satisfechos");
    }
  });

  it("un error de configuración hace fallar preflight y arrastra readiness", async () => {
    const ctx = nominalFirstRunContext();
    ctx.env.S9_DATA_DIR = "/tmp";
    const plan = planWizard({ resolution: resolveConfig(ctx.env), report: await runReadiness(ALL_CHECKS, ctx) });
    expect(plan.stages.find((s) => s.domain.id === "preflight")!.state).toBe("failed");
    expect(plan.verdict).toBe("NOT_READY");
  });

  it("una confusión sin cubrir quita el READY aunque TODOS los dominios evaluados estén satisfechos", async () => {
    // Recorrido reducido a un solo dominio: su evidencia está verificada y no
    // hay ningún dominio en rojo. Lo único que falta es que seis de las siete
    // confusiones no las cubre ninguna comprobación verificada. Eso, por sí
    // solo, tiene que impedir el READY.
    const ctx = nominalFirstRunContext();
    const report = await runReadiness([READINESS_CHECKS.find((c) => c.id === "security.deployed_version")!], ctx);
    const sistema = DOMAINS.filter((d) => d.id === "sistema");
    const plan = planWizard({ resolution: resolveConfig(ctx.env), report, domains: sistema });
    expect(plan.stages.map((s) => s.state)).toEqual(["satisfied"]);
    expect(plan.unresolvedConfusions.length).toBe(6);
    expect(plan.verdict).toBe("NOT_READY");
    expect(plan.blockers.every((b) => b.startsWith("confusión sin cubrir"))).toBe(true);
  });

  it("cada una de las siete confusiones, si se rompe, aparece sin cubrir y quita el READY", async () => {
    const breakers: Array<[string, (c: FirstRunContext) => void]> = [
      [
        "healthy_vs_ready",
        (c) =>
          (c.probes.backupLastRun = async () => ({
            ranAt: "2026-08-30T02:00:00Z",
            exitCode: 1,
            snapshotCount: 0,
            lastSnapshotBytes: 0,
            ageHours: 1,
          })),
      ],
      [
        "backed_up_vs_recovery_verified",
        (c) =>
          (c.probes.backupRestoreDrill = async () => ({ attempted: true, restoredBytes: 4096, canaryFound: false })),
      ],
      [
        "tag_vs_deployed_version",
        (c) =>
          (c.probes.deployedVersion = async () => ({
            imageTag: "t",
            taggedCommit: "aaa",
            builtFromCommit: "bbb",
            runningImageId: "sha256:x",
            imageIdPresentInDaemon: true,
          })),
      ],
      [
        "secret_exists_vs_mounted",
        (c) =>
          (c.probes.secretMounted = async () => ({ existsOnHost: true, mountedInProcess: false, readableBytes: 0 })),
      ],
      [
        "storage_exists_vs_writable",
        (c) => {
          c.probes.dataDirWrite = async () => ({
            bytesWritten: 0,
            readBack: false,
            sameContent: false,
            reason: "EACCES",
          });
          c.probes.storageWriteAsProcess = async (_k, dir) => ({
            dir,
            uid: 1000,
            gid: 1000,
            bytesWritten: 0,
            readBack: false,
            sameContent: false,
            cleanedUp: false,
            reason: "EACCES",
          });
        },
      ],
      [
        "process_alive_vs_job_success",
        (c) =>
          (c.probes.backupLastRun = async () => ({
            ranAt: null,
            exitCode: null,
            snapshotCount: 0,
            lastSnapshotBytes: 0,
            ageHours: null,
            reason: "el planificador vive, nunca lanzó nada",
          })),
      ],
      [
        "exit_zero_vs_effect_verified",
        (c) => {
          c.probes.dbCanary = async () => ({ queryExecuted: true, canaryRowsSeen: 0, rowsAffected: 0 });
          c.probes.adminIdentity = async () => ({ queried: true, adminCount: 0, seededWithRepoCredentials: 0 });
          c.probes.storageWriteAsProcess = async (_k, dir) => ({
            dir,
            uid: 1000,
            gid: 1000,
            bytesWritten: 0,
            readBack: false,
            sameContent: false,
            cleanedUp: false,
          });
          c.probes.backupLastRun = async () => ({
            ranAt: "2026-08-30T02:00:00Z",
            exitCode: 0,
            snapshotCount: 1,
            lastSnapshotBytes: 0,
            ageHours: 1,
          });
        },
      ],
    ];

    for (const [confusion, apply] of breakers) {
      const ctx = nominalFirstRunContext();
      apply(ctx);
      const report = await runReadiness(ALL_CHECKS, ctx);
      const plan = planWizard({ resolution: resolveConfig(ctx.env), report });
      expect([confusion, coveredConfusions(report).has(confusion as never)]).toEqual([confusion, false]);
      expect([confusion, plan.verdict]).toEqual([confusion, "NOT_READY"]);
    }
  });
});

describe("activación: acto explícito y separado", () => {
  it("una puerta BLOQUEADA no se concede jamás, ni con la instalación READY y el acto perfecto", async () => {
    const plan = await nominalPlan();
    expect(plan.verdict).toBe("READY");
    for (const gateKey of ["S9_ENABLE_REAL_BATTLE_RUNS", "S9_PUBLIC_SPECTATE_ENABLED"]) {
      const decision = requestActivation(
        {
          gateKey,
          actor: "operador",
          reason: "primera batalla real",
          acknowledgement: requiredAcknowledgement(gateKey),
          evidenceAgeMinutes: 1,
        },
        plan,
      );
      expect(decision.granted).toBe(false);
      expect(decision.refusal).toBe("gate_blocked_by_operator");
      expect(decision.auditLine).toContain("activation.refused");
    }
  });

  it("sin frase exacta, sin actor o sin motivo no hay acto explícito", async () => {
    const plan = await nominalPlan();
    const gateKey = "S9_ENABLE_REAL_BATTLE_RUNS";
    const base = {
      gateKey,
      actor: "operador",
      reason: "pruebas",
      acknowledgement: requiredAcknowledgement(gateKey),
      evidenceAgeMinutes: 1,
    };
    // Sin el bloqueo del operador, para poder observar las OTRAS negativas.
    const unblocked = { ...plan, blockedGates: [] as string[] };
    for (const variant of [
      { ...base, acknowledgement: "sí" },
      { ...base, actor: "  " },
      { ...base, reason: "" },
    ]) {
      const d = requestActivation(variant, unblocked, []);
      expect(d.granted).toBe(false);
      expect(d.refusal).toBe("no_explicit_act");
    }
  });

  it("con acto perfecto pero instalación NO READY se rechaza, y con evidencia rancia también", async () => {
    const ctx = nominalFirstRunContext();
    ctx.probes.dbCanary = async () => ({ queryExecuted: false, canaryRowsSeen: 0, rowsAffected: 0 });
    const notReady = planWizard({ resolution: resolveConfig(ctx.env), report: await runReadiness(ALL_CHECKS, ctx) });
    const gateKey = "S9_ENABLE_REAL_BATTLE_RUNS";
    const act = {
      gateKey,
      actor: "operador",
      reason: "pruebas",
      acknowledgement: requiredAcknowledgement(gateKey),
      evidenceAgeMinutes: 1,
    };

    expect(requestActivation(act, { ...notReady, blockedGates: [] }, []).refusal).toBe("not_ready");

    const ready = { ...(await nominalPlan()), blockedGates: [] as string[] };
    const stale = requestActivation({ ...act, evidenceAgeMinutes: MAX_EVIDENCE_AGE_MINUTES + 1 }, ready, []);
    expect(stale.refusal).toBe("stale_evidence");
  });

  it("una puerta no modelada no se activa", async () => {
    const plan = { ...(await nominalPlan()), blockedGates: [] as string[] };
    const gateKey = "S9_MODO_TURBO";
    const d = requestActivation(
      {
        gateKey,
        actor: "operador",
        reason: "x",
        acknowledgement: requiredAcknowledgement(gateKey),
        evidenceAgeMinutes: 1,
      },
      plan,
      [],
    );
    expect(d.refusal).toBe("gate_unknown");
  });

  it("aun concedida, la decisión NO aplica el cambio: sólo autoriza y deja traza", async () => {
    const plan = { ...(await nominalPlan()), blockedGates: [] as string[] };
    const gateKey = "S9_ENABLE_REAL_BATTLE_RUNS";
    const d = requestActivation(
      {
        gateKey,
        actor: "operador",
        reason: "torneo",
        acknowledgement: requiredAcknowledgement(gateKey),
        evidenceAgeMinutes: 5,
      },
      plan,
      [],
    );
    expect(d.granted).toBe(true);
    expect(d.message).toContain("NO la aplica");
    expect(d.auditLine).toContain("activation.granted");
  });
});
