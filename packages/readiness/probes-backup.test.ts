/**
 * R17 · Suite de las sondas REALES de copias.
 *
 * Dos cosas que probar y no confundir:
 *  a) el núcleo puro interpreta bien lo que devuelve la instalación (incluidos
 *     los casos raros que se observaron de verdad en ella), y
 *  b) las sondas NO escriben: el ejecutor simulado registra cada comando y el
 *     test rechaza cualquier verbo que modifique algo.
 */
import { describe, expect, it } from "vitest";

import {
  backupLastRunProbe,
  backupLastSnapshotProbe,
  backupProcessAliveProbe,
  elegirUltimoSnapshot,
  interpretarMetricasCopia,
  interpretarProceso,
  leerGauge,
  parsearSnapshots,
  parsearTotalSize,
  TAG_SNAPSHOT_DATOS,
} from "./probes-backup.ts";
import type { EjecutorComando } from "./probes-docker.ts";

/** Ejecutor simulado que además guarda todo lo que se le pidió ejecutar. */
function ejecutorFalso(respuestas: Record<string, { rc: number; out: string; err?: string }>) {
  const vistos: string[][] = [];
  const run: EjecutorComando = (cmd, args) => {
    vistos.push([cmd, ...args]);
    for (const [clave, r] of Object.entries(respuestas)) {
      if (args.join(" ").includes(clave)) return { rc: r.rc, out: r.out, err: r.err ?? "" };
    }
    return { rc: 1, out: "", err: "sin respuesta simulada" };
  };
  return { run, vistos };
}

const PROM_OK = `# HELP s9_backup_last_exit_code Código de salida del último backup.
# TYPE s9_backup_last_exit_code gauge
s9_backup_last_exit_code 0
s9_backup_last_success_timestamp_seconds 1788322506
s9_backup_run_success 1
s9_backup_source_files{source="replays"} 2
`;

describe("lectura de métricas de la copia", () => {
  it("lee gauges escalares e ignora comentarios y series con etiquetas", () => {
    expect(leerGauge(PROM_OK, "s9_backup_last_exit_code")).toBe(0);
    expect(leerGauge(PROM_OK, "s9_backup_run_success")).toBe(1);
    // Una serie con etiquetas no es un escalar: no se confunde con el gauge.
    expect(leerGauge(PROM_OK, "s9_backup_source_files")).toBeNull();
    // Ausente NO es cero.
    expect(leerGauge(PROM_OK, "s9_backup_restore_ok")).toBeNull();
  });

  it("una copia reciente con éxito se interpreta como tal", () => {
    const r = interpretarMetricasCopia(PROM_OK, 1788322506000 + 6 * 3_600_000);
    expect(r.probed).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.ageHours).toBe(6);
    expect(r.ranAt).toBe(new Date(1788322506000).toISOString());
  });

  it("run_success=0 no se lee como éxito aunque el código escrito sea 0", () => {
    const r = interpretarMetricasCopia(
      PROM_OK.replace("s9_backup_run_success 1", "s9_backup_run_success 0"),
      Date.now(),
    );
    expect(r.probed).toBe(true);
    expect(r.exitCode).not.toBe(0);
  });

  it("un textfile sin métricas de copia es NO OBSERVADO, no 'nunca corrió'", () => {
    const r = interpretarMetricasCopia("# HELP otra_cosa\notra_cosa 1\n", Date.now());
    expect(r.probed).toBe(false);
    expect(r.reason).toBeDefined();
  });

  it("métricas presentes sin marca de éxito SÍ afirman que no consta ejecución", () => {
    const r = interpretarMetricasCopia("s9_backup_last_exit_code 1\n", Date.now());
    expect(r.probed).toBe(true);
    expect(r.ranAt).toBeNull();
  });
});

describe("estado del planificador de copias", () => {
  it("contenedor vivo y healthcheck sano = hay quien dispare la copia", () => {
    expect(interpretarProceso({ probed: true, running: true, healthStatus: "healthy" }).processRunning).toBe(true);
  });

  it("un servicio sin healthcheck declarado, corriendo, cuenta como vivo", () => {
    expect(interpretarProceso({ probed: true, running: true, healthStatus: "" }).processRunning).toBe(true);
  });

  it("contenedor parado o unhealthy no dispara nada", () => {
    expect(interpretarProceso({ probed: true, running: false, healthStatus: "healthy" }).processRunning).toBe(false);
    expect(interpretarProceso({ probed: true, running: true, healthStatus: "unhealthy" }).processRunning).toBe(false);
  });

  it("no poder consultar el daemon deja la observación sin hacer", () => {
    const r = interpretarProceso({ probed: false, running: false, healthStatus: "", reason: "daemon caído" });
    expect(r.probed).toBe(false);
    expect(r.reason).toContain("daemon");
  });
});

describe("selección del último snapshot", () => {
  const snaps = [
    { time: "2026-09-01T04:15:01Z", id: "aaa", hostname: "c1", tags: [TAG_SNAPSHOT_DATOS] },
    { time: "2026-09-02T04:15:01Z", id: "bbb", hostname: "c2", tags: [TAG_SNAPSHOT_DATOS] },
    { time: "2026-09-02T04:15:03Z", id: "ccc", hostname: "c2", tags: ["s9-arena-secrets"] },
  ];

  it("elige el más reciente con la etiqueta de datos, no el último del array", () => {
    const { total, ultimo } = elegirUltimoSnapshot([snaps[1], snaps[0], snaps[2]]);
    expect(total).toBe(2);
    expect(ultimo!.id).toBe("bbb");
  });

  it("no cuenta los snapshots de otra etiqueta como copia de datos", () => {
    expect(elegirUltimoSnapshot([snaps[2]]).total).toBe(0);
  });

  /**
   * Observación real de la instalación: `RESTIC_HOSTNAME` llega vacío, así que
   * restic etiqueta cada snapshot con el hostname del CONTENEDOR, que cambia en
   * cada recreación. Acotar por un host fijo devolvería cero snapshots en un
   * repositorio lleno, y "cero snapshots" es una acusación grave.
   */
  it("sin RESTIC_HOSTNAME se acota por etiqueta y NO se pierde el repositorio", () => {
    expect(elegirUltimoSnapshot(snaps, { host: "" }).total).toBe(2);
  });

  it("con RESTIC_HOSTNAME fijado sí se acota además por host", () => {
    expect(elegirUltimoSnapshot(snaps, { host: "c2" }).total).toBe(1);
  });

  it("una salida que no es JSON no se inventa un repositorio vacío", () => {
    expect(parsearSnapshots("no soy json")).toBeNull();
    expect(parsearSnapshots("{}")).toBeNull();
    expect(parsearSnapshots("[]")).toEqual([]);
  });

  it("el tamaño sale de restic stats y un JSON roto no vale 'algo'", () => {
    expect(parsearTotalSize('{"total_size":6126}')).toBe(6126);
    expect(parsearTotalSize("roto")).toBe(0);
  });
});

describe("las sondas de copias no escriben nada", () => {
  const VERBOS_QUE_ESCRIBEN = [
    "restart",
    "stop",
    "start",
    "rm",
    "up",
    "prune",
    "forget",
    "unlock",
    "restore",
    "check",
    "pull",
    "recreate",
  ];

  it("sólo ejecutan inspect y consultas de lectura con --no-lock", async () => {
    const { run, vistos } = ejecutorFalso({
      inspect: { rc: 0, out: "true\thealthy" },
      "cat ": { rc: 0, out: PROM_OK },
      snapshots: {
        rc: 0,
        out: JSON.stringify([{ time: "2026-09-02T04:15:01Z", id: "bbb", tags: [TAG_SNAPSHOT_DATOS] }]),
      },
      stats: { rc: 0, out: '{"total_size":6126}' },
    });
    await backupProcessAliveProbe("svc", run)();
    await backupLastRunProbe("svc", run)();
    await backupLastSnapshotProbe("svc", run, () => Date.parse("2026-09-02T10:15:01Z"), {})();

    expect(vistos.length).toBeGreaterThan(0);
    for (const cmd of vistos) {
      for (const verbo of VERBOS_QUE_ESCRIBEN) {
        expect(cmd, `comando que modifica el sistema: ${cmd.join(" ")}`).not.toContain(verbo);
      }
      if (cmd.includes("snapshots") || cmd.includes("stats")) {
        expect(cmd, "toda consulta a restic va con --no-lock").toContain("--no-lock");
      }
    }
  });

  it("sin contenedor declarado no se ejecuta NADA y queda sin observar", async () => {
    const { run, vistos } = ejecutorFalso({});
    expect((await backupProcessAliveProbe("", run)()).probed).toBe(false);
    expect((await backupLastRunProbe("", run)()).probed).toBe(false);
    expect((await backupLastSnapshotProbe("", run)()).probed).toBe(false);
    expect(vistos).toEqual([]);
  });

  it("un repositorio sin snapshots de datos se afirma como observado y vacío", async () => {
    const { run } = ejecutorFalso({
      snapshots: { rc: 0, out: "[]" },
    });
    const r = await backupLastSnapshotProbe("svc", run, Date.now, {})();
    expect(r.probed).toBe(true);
    expect(r.snapshotCount).toBe(0);
  });

  it("un repositorio inalcanzable NO se lee como repositorio vacío", async () => {
    const { run } = ejecutorFalso({ snapshots: { rc: 1, out: "", err: "connection refused" } });
    const r = await backupLastSnapshotProbe("svc", run, Date.now, {})();
    expect(r.probed).toBe(false);
    expect(r.snapshotCount).toBe(0);
    expect(r.reason).toContain("connection refused");
  });
});

describe("una salida de restic ilegible no se lee como repositorio vacío", () => {
  it("rc 0 con salida basura deja la comprobación SIN observar, no en 'cero snapshots'", async () => {
    const { run } = ejecutorFalso({ snapshots: { rc: 0, out: "esto no es json" } });
    const r = await backupLastSnapshotProbe("svc", run, Date.now, {})();
    expect(r.probed).toBe(false);
    expect(r.snapshotCount).toBe(0);
    expect(r.reason).toContain("JSON");
  });
});
