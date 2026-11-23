#!/usr/bin/env node
/**
 * V1 REPLAYS PR-3 · calibración por mutantes del cableado ReplaySink → S9R/1.
 * Para cada mutante: aplica el cambio (uno o varios reemplazos, cada patrón con UNA aparición),
 * ejecuta SÓLO el test nombrado y exige que se ponga en ROJO; restaura siempre los ficheros.
 * Línea base: cada test se ejecuta antes sin mutar y debe estar en VERDE.
 * Uso: node apps/replay-service/scripts/replay-pr3-mutants.mjs [id...]   (serie, nunca en paralelo)
 * Commitea antes: el script reescribe ficheros del árbol y los restaura al terminar cada mutante.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REC = "apps/replay-service/tests/s9r/recorder.test.ts";
const WIRE = "apps/tournament-worker/src/v1-replay-pr3-wiring.test.ts";
const MIG = "apps/api/src/db/migration-024.test.ts";
const EXEC = "apps/tournament-worker/src/engine-executor.ts";
const RUNNER = "apps/tournament-worker/src/battle-runner.ts";
const RECORDER = "apps/replay-service/src/s9r/recorder.ts";
const ART = "apps/replay-service/src/artifacts.ts";

export const MUTANTS = [
  {
    id: "M-W1-fault-ignored",
    why: "el ejecutor no mira recordingFault (sólo quedaría el fallo del cierre)",
    test: WIRE,
    t: "W1 ",
    edits: [{ file: EXEC, find: "if (engine.recordingFault) {", replace: "if (false) {" }],
  },
  {
    id: "M-W1-fault-and-close-ignored",
    why: "fallo de grabación tratado como batalla normal: acabaría finished (completed/empate)",
    test: WIRE,
    t: "W1 ",
    edits: [
      { file: EXEC, find: "if (engine.recordingFault) {", replace: "if (false) {" },
      {
        file: EXEC,
        find: "          recording = await recorder.finish(result as unknown as Record<string, unknown>);",
        replace:
          "          recording = await recorder.finish(result as unknown as Record<string, unknown>).catch(() => null);",
      },
    ],
  },
  {
    id: "M-W2-async-fault-dropped",
    why: "un ENOSPC asíncrono del escritor no se registra (el sink no para a mitad)",
    test: WIRE,
    t: "W2 ",
    edits: [
      {
        file: RECORDER,
        find: "        s.pending -= bytes;\n        this.setFault(e);",
        replace: "        s.pending -= bytes;",
      },
    ],
  },
  {
    id: "M-RC3-async-fault-dropped",
    why: "ídem, en el test unitario del grabador",
    test: REC,
    t: "RC3 ",
    edits: [
      {
        file: RECORDER,
        find: "        s.pending -= bytes;\n        this.setFault(e);",
        replace: "        s.pending -= bytes;",
      },
    ],
  },
  {
    id: "M-W3-publish-error-swallowed",
    why: "un fallo de publicación no hace rollback: batalla finished con replay_ref a un fichero inexistente",
    test: WIRE,
    t: "W3 ",
    edits: [
      {
        file: RUNNER,
        find: '      } catch (err) {\n        throw new InfrastructureFailure(\n          "storage_unavailable",\n          `replay_publish_failed:',
        replace:
          '      } catch (err) {\n        if (Date.now() < 0) throw new InfrastructureFailure(\n          "storage_unavailable",\n          `replay_publish_failed:',
      },
    ],
  },
  {
    id: "M-RC7-no-proof",
    why: "publicación sin prueba de cierre (unsafeSkipProof): una copia del summary publicaría",
    test: REC,
    t: "RC7 ",
    edits: [{ file: ART, find: "{ proof: r, viewProof: v,", replace: "{ unsafeSkipProof: true," }],
  },
  {
    id: "M-W4-ref-not-written",
    why: "battles.replay_ref/replay_hash no apuntan a la receta publicada",
    test: WIRE,
    t: "W4 ",
    edits: [
      {
        file: ART,
        find: "update({ replay_ref: rec.recipe.final, replay_hash: r.sha256 })",
        replace: "update({ replay_ref: rec.recipe.partial, replay_hash: r.sha256 })",
      },
    ],
  },
  {
    id: "M-W5-partials-kept",
    why: "los .part del intento sobreviven a un cierre que no casa",
    test: WIRE,
    t: "W5 ",
    edits: [
      {
        file: RUNNER,
        find: "        if (rec) {\n          await discardRecordingFiles(",
        replace: "        if (rec && Date.now() < 0) {\n          await discardRecordingFiles(",
      },
    ],
  },
  // M-W6 (guarda de verify de PR-3) retirado en PR-4: la guarda «sólo S9R» vive ahora en
  // `readableS9r` (routes/replays.ts) y la calibra M-E8-legacy-guard-removed (replay-pr4-mutants.mjs).
  {
    id: "M-RC2-unbounded-queue",
    why: "la cola no tiene tope: crecería en RAM con el disco atascado",
    test: REC,
    t: "RC2 ",
    edits: [{ file: RECORDER, find: "if (s.pending + bytes > s.maxPending) {", replace: "if (false) {" }],
  },
  {
    id: "M-RC5-no-stall",
    why: "drain espera para siempre a un escritor atascado",
    test: REC,
    t: "RC5 ",
    edits: [{ file: RECORDER, find: "if (!progressed) this.setFault(", replace: "if (Date.now() < 0) this.setFault(" }],
  },
  {
    id: "M-RC8-retains-lines",
    why: "el grabador retiene cada línea en memoria (la causa raíz de RAM)",
    test: REC,
    t: "RC8 ",
    edits: [
      {
        file: RECORDER,
        find: "    s.records++;",
        replace: "    s.records++;\n    ((this as any).__keep ??= []).push(line);",
      },
    ],
  },
  {
    id: "M-RC1-elision-wrong",
    why: "la elisión «=» se aplica aunque el comando cambie",
    test: REC,
    t: "RC1 ",
    edits: [
      {
        file: RECORDER,
        find: "const same = this.lastCmd.get(rec.vehicleId) === c;",
        replace: "const same = this.lastCmd.has(rec.vehicleId);",
      },
    ],
  },
  {
    id: "M-MIG-state-unchecked",
    why: "replay_artifacts.state admite cualquier valor",
    test: MIG,
    t: "invariantes",
    edits: [
      {
        file: "apps/api/src/db/migrations.ts",
        find: "state            text NOT NULL DEFAULT 'published' CHECK (state IN ('published', 'trashed', 'purged')),",
        replace: "state            text NOT NULL DEFAULT 'published',",
      },
    ],
  },
];

function run(test, t) {
  const r = spawnSync("nice", ["-n", "19", "npx", "vitest", "run", test, "-t", t, "--maxWorkers=1"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, S9_PR3_TICKS: process.env.S9_PR3_TICKS ?? "45000" },
  });
  return r.status;
}

const only = new Set(process.argv.slice(2));
const base = new Map();
let survivors = 0;
for (const m of MUTANTS) {
  if (only.size && !only.has(m.id)) continue;
  const key = `${m.test}::${m.t}`;
  if (!base.has(key)) base.set(key, run(m.test, m.t));
  if (base.get(key) !== 0) {
    console.log(`${m.id}: BASE ROJA (rc ${base.get(key)}), no calibrable`);
    survivors++;
    continue;
  }
  const originals = new Map();
  let ok = true;
  for (const e of m.edits) {
    const f = join(root, e.file);
    if (!originals.has(f)) originals.set(f, readFileSync(f, "utf8"));
  }
  const current = new Map(originals);
  for (const e of m.edits) {
    const f = join(root, e.file);
    const src = current.get(f);
    const k = src.split(e.find).length - 1;
    if (k !== 1) {
      console.log(`${m.id}: patrón con ${k} apariciones en ${e.file}`);
      ok = false;
      break;
    }
    current.set(
      f,
      src.replace(e.find, () => e.replace),
    );
  }
  if (!ok) {
    survivors++;
    continue;
  }
  try {
    for (const [f, s] of current) writeFileSync(f, s);
    const rc = run(m.test, m.t);
    const killed = rc !== 0;
    if (!killed) survivors++;
    console.log(`${m.id}: ${killed ? "MUERTO (test en rojo, rc " + rc + ")" : "SOBREVIVE (rc 0)"} · ${m.why}`);
  } finally {
    for (const [f, s] of originals) writeFileSync(f, s);
  }
}
console.log(`supervivientes/errores: ${survivors}`);
process.exit(survivors ? 1 : 0);
