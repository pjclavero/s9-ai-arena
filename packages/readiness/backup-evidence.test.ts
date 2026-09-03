/**
 * CARRIL E · Suite del modelo de evidencia de la copia.
 *
 * Lo que de verdad se juzga aquí son las MUTACIONES: cada una reproduce una
 * forma concreta de mentir sobre la copia y debe salir ROJA. Una comprobación
 * que no puede ponerse roja no es una comprobación.
 *
 * Las tres obligatorias del encargo están marcadas con `OBLIGATORIA`:
 *   1. hacer pasar `process_alive` como si fuera `last_run_success`;
 *   2. aprobar un snapshot inexistente;
 *   3. dar por bueno un manifest sin checksum del volcado.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  BACKUP_SIGNALS,
  assessBackupEvidence,
  detectManifestContract,
  findPgDumpPath,
  observationsFromEvidenceJson,
  parseManifestSha256,
  parsePromTextfile,
  renderBackupEvidence,
  type BackupEvidenceReport,
  type BackupObservations,
  type BackupSignalId,
} from "./backup-evidence.ts";

const NOW = Date.parse("2026-09-02T21:00:00Z");
const DUMP = "pgdump-20260902041500.dump";
const DUMP_BYTES = "PGDMP-carga-de-verdad-no-un-fichero-vacio\n";
const DUMP_SHA = createHash("sha256").update(DUMP_BYTES).digest("hex");
const REPLAY = "replays/e2e-real-smoke.replay";
const REPLAY_SHA = createHash("sha256").update('{"tick":1}\n').digest("hex");

const PROM_NOMINAL = `# HELP s9_backup_last_exit_code Código de salida del último backup.
# TYPE s9_backup_last_exit_code gauge
s9_backup_last_exit_code 0
s9_backup_duration_seconds 6
s9_backup_last_success_timestamp_seconds ${Math.floor(NOW / 1000) - 3600 * 6}
s9_backup_run_success 1
s9_backup_postgres_success 1
s9_backup_restic_snapshot_created 1
s9_backup_source_files{source="replays"} 2
`;

/** Escenario nominal: cadena completa observada, contrato nuevo (`schema:2`). */
function nominal(): BackupObservations {
  return {
    nowMs: NOW,
    process: { probed: true, running: true },
    metrics: { probed: true, present: true, values: parsePromTextfile(PROM_NOMINAL) },
    repository: { probed: true, accessible: true, snapshotCount: 36 },
    snapshot: {
      probed: true,
      id: "1c11b1c41417553d9ab7857af5eaae99267829671312dfc9cc65861882663f6c",
      timeIso: "2026-09-02T04:15:01Z",
      files: ["manifest.json", "manifest.sha256", DUMP, REPLAY],
    },
    manifest: {
      probed: true,
      jsonRaw: '{"schema":2,"postgres":{"status":"ok","files":1},"replays":{"status":"ok","files":1}}',
      sha256Raw: `${DUMP_SHA}  ${DUMP}\n${REPLAY_SHA}  ${REPLAY}\n`,
    },
    pgDump: { probed: true, recomputedSha256: DUMP_SHA, bytes: DUMP_BYTES.length },
  };
}

/** El mundo tal y como está HOY en producción: 35 snapshots de contrato legacy. */
function legacyProduccion(): BackupObservations {
  const o = nominal();
  o.manifest.jsonRaw =
    '{"postgres":{"status":"ok","files":1},"secrets":{"status":"ok","files":15},"replays":{"status":"ok","files":1}}';
  // El backup.sh desplegado excluye el dump del manifest (`! -path './pgdump-*'`).
  o.manifest.sha256Raw = `${REPLAY_SHA}  ${REPLAY}\n`;
  return o;
}

function status(r: BackupEvidenceReport, id: BackupSignalId) {
  const o = r.outcomes.find((x) => x.spec.id === id);
  if (!o) throw new Error(`señal ausente del informe: ${id}`);
  return o;
}

describe("modelo de señales", () => {
  it("las nueve señales del encargo están declaradas, sin duplicados", () => {
    const ids = BACKUP_SIGNALS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(
      [
        "backup.last_run_started",
        "backup.last_run_success",
        "backup.last_snapshot_id",
        "backup.last_snapshot_timestamp",
        "backup.manifest_verified",
        "backup.pg_dump_present",
        "backup.pg_dump_sha256",
        "backup.process_alive",
        "backup.repository_accessible",
      ].sort(),
    );
  });

  it("cada señal declara fuente, método, qué demuestra, qué NO y por qué es o no elegible", () => {
    for (const s of BACKUP_SIGNALS) {
      for (const campo of ["source", "method", "proves", "doesNotProve", "eligibilityRationale"] as const) {
        expect(s[campo].length, `${s.id}.${campo}`).toBeGreaterThan(30);
      }
    }
  });

  it("INVARIANTE: process_alive NO es elegible para readiness, ni sola ni sumada", () => {
    expect(BACKUP_SIGNALS.find((s) => s.id === "backup.process_alive")!.readinessEligible).toBe(false);
    // Y ninguna señal de la familia `scheduler` lo es: la regla es de familia,
    // no de una señal concreta, para que añadir mañana "systemd timer activo"
    // no reabra el mismo agujero.
    for (const s of BACKUP_SIGNALS.filter((x) => x.family === "scheduler")) {
      expect(s.readinessEligible, s.id).toBe(false);
      expect(s.required, s.id).toBe(false);
    }
  });

  it("ninguna señal se aprueba con una sola familia de evidencia", () => {
    const elegibles = BACKUP_SIGNALS.filter((s) => s.readinessEligible);
    expect(new Set(elegibles.map((s) => s.family))).toEqual(new Set(["producer", "repository"]));
  });
});

describe("parseadores", () => {
  it("el textfile collector se lee ignorando comentarios y métricas etiquetadas", () => {
    const v = parsePromTextfile(PROM_NOMINAL);
    expect(v.s9_backup_run_success).toBe(1);
    expect(v.s9_backup_last_exit_code).toBe(0);
    expect(v["s9_backup_source_files"]).toBeUndefined();
  });

  it("el contrato se decide por `schema` de PRIMER nivel", () => {
    expect(detectManifestContract('{"schema":2,"postgres":{"status":"ok"}}')).toBe("schema2");
    expect(detectManifestContract('{"postgres":{"status":"ok"}}')).toBe("legacy");
    // Un `schema` anidado no puede suplantar al de primer nivel.
    expect(detectManifestContract('{"postgres":{"schema":2,"status":"ok"}}')).toBe("legacy");
    expect(detectManifestContract("{}")).toBe("unknown");
    expect(detectManifestContract("no soy json")).toBe("unknown");
    expect(detectManifestContract(null)).toBe("unknown");
  });

  it("el pg_dump se busca en la RAÍZ del staging, no por nombre en todo el árbol", () => {
    expect(findPgDumpPath([REPLAY, DUMP])).toBe(DUMP);
    // Un fichero de usuario llamado así dentro de maps/ no es el volcado.
    expect(findPgDumpPath(["maps/pgdump-trampa.dump"])).toBeNull();
  });

  it("manifest.sha256 se parsea en formato portable de sha256sum", () => {
    const m = parseManifestSha256(`${DUMP_SHA}  ${DUMP}\nlinea basura\n`);
    expect(m.get(DUMP)).toBe(DUMP_SHA);
    expect(m.size).toBe(1);
  });
});

describe("escenario nominal", () => {
  it("la cadena completa observada da READY con las dos familias corroborando", () => {
    const r = assessBackupEvidence(nominal());
    expect(r.blockers).toEqual([]);
    expect(r.verdict).toBe("READY");
    expect(r.contract).toBe("schema2");
    expect(r.corroboratingFamilies.sort()).toEqual(["producer", "repository"]);
    expect(r.corroboratingFamilies).not.toContain("scheduler");
  });

  it("el informe nombra siempre qué NO demuestra cada señal", () => {
    const texto = renderBackupEvidence(assessBackupEvidence(nominal()));
    expect(texto).toContain("NO demuestra");
    expect(texto).toContain("(no alimenta el veredicto)");
    expect(texto).toContain("no-ejercida NO es aprobada");
  });
});

describe("el mundo real: contrato LEGACY de los snapshots de producción", () => {
  it("dice la verdad sobre CUÁL contrato está mirando", () => {
    expect(assessBackupEvidence(legacyProduccion()).contract).toBe("legacy");
  });

  it("el checksum del volcado queda NO EJERCIDO CON MOTIVO, nunca verificado ni aprobado", () => {
    const r = assessBackupEvidence(legacyProduccion());
    const s = status(r, "backup.pg_dump_sha256");
    expect(s.status).toBe("not_exercised");
    expect(s.status).not.toBe("verified");
    expect(s.evidence).toContain("LEGACY");
    expect(r.verdict).toBe("NOT_READY");
    expect(r.blockers.join("\n")).toContain("backup.pg_dump_sha256");
  });

  it("pero el manifest legacy NO se declara corrupto: es coherente con SU contrato", () => {
    // El falso diagnóstico contrario (llamar "manifest truncado" a un legacy
    // perfecto) fue un fallo real documentado en backup.sh (D3-R2).
    expect(status(legacyAssess(), "backup.manifest_verified").status).toBe("verified");
    expect(status(legacyAssess(), "backup.pg_dump_present").status).toBe("verified");
  });

  function legacyAssess() {
    return assessBackupEvidence(legacyProduccion());
  }
});

// ── MUTACIONES ───────────────────────────────────────────────────────────────

interface Mutacion {
  senal: BackupSignalId | "veredicto";
  nombre: string;
  aplicar(o: BackupObservations): void;
  /** Estado exigido a esa señal tras la mutación. */
  esperado?: "failed" | "not_exercised";
}

const MUTACIONES: readonly Mutacion[] = [
  {
    senal: "veredicto",
    nombre: "OBLIGATORIA · process_alive haciéndose pasar por last_run_success",
    // El escenario EXACTO de producción hoy: crond vivo, contenedor `healthy`,
    // y ni una sola evidencia de que la copia se haya hecho.
    aplicar: (o) => {
      o.process = { probed: true, running: true };
      o.metrics = { probed: true, present: false, values: {} };
      o.repository = { probed: true, accessible: false, snapshotCount: 0, reason: "repositorio inalcanzable" };
      o.snapshot = { probed: false, id: null, timeIso: null, files: [] };
      o.manifest = { probed: false, jsonRaw: null, sha256Raw: null };
      o.pgDump = { probed: false, recomputedSha256: null, bytes: 0 };
    },
  },
  {
    senal: "backup.last_snapshot_id",
    nombre: "OBLIGATORIA · aprobar un snapshot inexistente (repositorio vacío, productor cantando éxito)",
    aplicar: (o) => {
      o.repository = { probed: true, accessible: true, snapshotCount: 0 };
      o.snapshot = { probed: true, id: null, timeIso: null, files: [] };
    },
    esperado: "failed",
  },
  {
    senal: "backup.pg_dump_sha256",
    nombre: "OBLIGATORIA · manifest sin checksum del volcado dado por bueno bajo contrato schema2",
    aplicar: (o) => {
      // Contrato NUEVO (promete cobertura completa) y el dump sin línea.
      o.manifest.sha256Raw = `${REPLAY_SHA}  ${REPLAY}\n`;
    },
    esperado: "failed",
  },
  {
    senal: "backup.last_run_success",
    nombre: "contenedor healthy con la copia fallando cada noche (exit != 0)",
    aplicar: (o) => {
      o.metrics.values = { ...o.metrics.values, s9_backup_last_exit_code: 1, s9_backup_run_success: 0 };
    },
    esperado: "failed",
  },
  {
    senal: "backup.last_run_success",
    nombre: "exit 0 sin snapshot creado: EXIT 0 != BEHAVIOR EXERCISED",
    aplicar: (o) => {
      o.metrics.values = { ...o.metrics.values, s9_backup_restic_snapshot_created: 0 };
    },
    esperado: "failed",
  },
  {
    senal: "backup.last_run_success",
    nombre: "métricas congeladas: éxito declarado hace 40 h",
    aplicar: (o) => {
      o.metrics.values = {
        ...o.metrics.values,
        s9_backup_last_success_timestamp_seconds: Math.floor(NOW / 1000) - 3600 * 40,
      };
    },
    esperado: "failed",
  },
  {
    senal: "backup.last_run_started",
    nombre: "el planificador vive y no ha ejecutado NADA jamás",
    aplicar: (o) => {
      o.metrics = { probed: true, present: false, values: {} };
    },
    esperado: "failed",
  },
  {
    senal: "backup.repository_accessible",
    nombre: "destino inalcanzable (clave, red o known_hosts)",
    aplicar: (o) => {
      o.repository = { probed: true, accessible: false, snapshotCount: 0, reason: "rc=1" };
    },
    esperado: "failed",
  },
  {
    senal: "backup.last_snapshot_timestamp",
    nombre: "copia rancia: el snapshot más nuevo del destino tiene 3 días",
    aplicar: (o) => {
      o.snapshot.timeIso = "2026-08-30T04:15:01Z";
    },
    esperado: "failed",
  },
  {
    senal: "backup.pg_dump_present",
    nombre: "snapshot sin el activo crítico (el incidente #110b: el dump se perdía en silencio)",
    aplicar: (o) => {
      o.snapshot.files = ["manifest.json", "manifest.sha256", REPLAY];
      o.manifest.sha256Raw = `${REPLAY_SHA}  ${REPLAY}\n`;
      o.pgDump = { probed: false, recomputedSha256: null, bytes: 0 };
    },
    esperado: "failed",
  },
  {
    senal: "backup.pg_dump_sha256",
    nombre: "volcado de 0 bytes: un dump vacío hashea perfectamente y no respalda nada",
    aplicar: (o) => {
      const vacio = createHash("sha256").update("").digest("hex");
      o.manifest.sha256Raw = `${vacio}  ${DUMP}\n${REPLAY_SHA}  ${REPLAY}\n`;
      o.pgDump = { probed: true, recomputedSha256: vacio, bytes: 0 };
    },
    esperado: "failed",
  },
  {
    senal: "backup.pg_dump_sha256",
    nombre: "los bytes almacenados no coinciden con el checksum declarado",
    aplicar: (o) => {
      o.pgDump.recomputedSha256 = createHash("sha256").update("otra-cosa").digest("hex");
    },
    esperado: "failed",
  },
  {
    senal: "backup.pg_dump_sha256",
    nombre: "checksum declarado pero jamás contrastado contra los bytes (creer al productor otra vez)",
    aplicar: (o) => {
      o.pgDump = { probed: false, recomputedSha256: null, bytes: 0, reason: "no se leyó el dump" };
    },
    esperado: "not_exercised",
  },
  {
    senal: "backup.manifest_verified",
    nombre: "manifest.sha256 vacío con el snapshot lleno",
    aplicar: (o) => {
      o.manifest.sha256Raw = "";
    },
    esperado: "failed",
  },
  {
    senal: "backup.manifest_verified",
    nombre: "manifest truncado: falta el checksum de una fuente que sí viajó",
    aplicar: (o) => {
      o.manifest.sha256Raw = `${DUMP_SHA}  ${DUMP}\n`;
    },
    esperado: "failed",
  },
  {
    senal: "backup.manifest_verified",
    nombre: "manifest de OTRO árbol: declara ficheros que el snapshot no tiene",
    aplicar: (o) => {
      o.manifest.sha256Raw = `${DUMP_SHA}  ${DUMP}\n${REPLAY_SHA}  ${REPLAY}\n${REPLAY_SHA}  maps/inventado.json\n`;
    },
    esperado: "failed",
  },
  {
    senal: "backup.manifest_verified",
    nombre: "contrato indeterminado: manifest.json ilegible",
    aplicar: (o) => {
      o.manifest.jsonRaw = "}{ roto";
    },
    esperado: "not_exercised",
  },
];

describe("mutaciones", () => {
  it("hay mutación para cada señal que puede fallar", () => {
    const cubiertas = new Set(MUTACIONES.map((m) => m.senal));
    for (const s of BACKUP_SIGNALS) {
      if (s.id === "backup.process_alive") continue; // se cubre con la del veredicto
      expect(cubiertas.has(s.id), `sin mutación: ${s.id}`).toBe(true);
    }
  });

  for (const m of MUTACIONES) {
    it(`ROJA · ${m.nombre}`, () => {
      const base = assessBackupEvidence(nominal());
      expect(base.verdict, "el escenario base debe estar verde antes de mutarlo").toBe("READY");

      const obs = nominal();
      m.aplicar(obs);
      const r = assessBackupEvidence(obs);

      expect(r.verdict).toBe("NOT_READY");
      expect(r.blockers.length).toBeGreaterThan(0);
      if (m.senal !== "veredicto") {
        const s = status(r, m.senal);
        expect(s.status, `${m.senal}: ${s.evidence}`).toBe(m.esperado);
        expect(s.status).not.toBe("verified");
      }
    });
  }

  it("OBLIGATORIA · con crond vivo y CERO evidencia, el veredicto es NOT_READY y lo dice sin rodeos", () => {
    const obs = nominal();
    MUTACIONES[0].aplicar(obs);
    const r = assessBackupEvidence(obs);

    // El demonio está verde...
    expect(status(r, "backup.process_alive").status).toBe("verified");
    // ...y no compra absolutamente nada.
    expect(r.verdict).toBe("NOT_READY");
    expect(r.corroboratingFamilies).toEqual([]);
    expect(r.blockers.join("\n")).toContain("corroboración de productor Y repositorio");
    // Ninguna señal elegible pudo verificarse por el simple hecho de que crond viva.
    for (const o of r.outcomes.filter((x) => x.spec.readinessEligible)) {
      expect(o.status, o.spec.id).not.toBe("verified");
    }
  });

  it("un repositorio no observable deja las señales del repositorio NO EJERCIDAS, no fallidas", () => {
    // Un falso fallo por "no pude mirar" entierra los fallos de verdad.
    const obs = nominal();
    obs.repository = { probed: false, accessible: false, snapshotCount: 0, reason: "sin restic en el entorno" };
    const r = assessBackupEvidence(obs);
    for (const id of [
      "backup.last_snapshot_id",
      "backup.last_snapshot_timestamp",
      "backup.pg_dump_present",
      "backup.manifest_verified",
      "backup.pg_dump_sha256",
    ] as BackupSignalId[]) {
      expect(status(r, id).status, id).toBe("not_exercised");
    }
    expect(r.verdict).toBe("NOT_READY");
  });
});

describe("contrato con evidence.sh", () => {
  it("un documento JSON del recolector se traduce a observaciones sin inventar nada", () => {
    const doc = {
      schemaVersion: 1,
      process: { probed: true, running: true },
      metrics: { probed: true, present: true, values: { s9_backup_run_success: 1 } },
      repository: { probed: true, accessible: true, snapshotCount: 36, reason: "" },
      snapshot: { probed: true, id: "abc", time: "2026-09-02T04:15:01Z", files: [DUMP], reason: "" },
      manifest: { probed: true, json: '{"schema":2}', sha256: `${DUMP_SHA}  ${DUMP}`, reason: "" },
      pgDump: { probed: true, sha256: DUMP_SHA, bytes: 42, reason: "" },
    };
    const o = observationsFromEvidenceJson(doc, NOW);
    expect(o.snapshot.id).toBe("abc");
    expect(o.snapshot.timeIso).toBe("2026-09-02T04:15:01Z");
    expect(o.pgDump.bytes).toBe(42);
    expect(o.manifest.jsonRaw).toBe('{"schema":2}');
    // Las cadenas vacías del script no se convierten en motivos falsos.
    expect(o.repository.reason).toBeUndefined();
  });

  it("un documento vacío o corrupto no aprueba nada: todo queda sin sondear", () => {
    const o = observationsFromEvidenceJson({}, NOW);
    const r = assessBackupEvidence(o);
    expect(r.verdict).toBe("NOT_READY");
    expect(r.counts.verified).toBe(0);
    expect(observationsFromEvidenceJson(null, NOW).repository.probed).toBe(false);
  });
});
