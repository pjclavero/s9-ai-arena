#!/usr/bin/env node
/**
 * V1 REPLAYS PR-4b · calibración por mutantes de lo que cambia al retirar el formato anterior:
 * lanzador HTTP sin ingesta (nunca `ingested:true`, estricto ⇒ `failed`, guardas intactas), capa de
 * depuración del replay retirada (`debugOpen`/`commandsAt`) y arnés de smoke sobre S9R/1.
 * Mismo procedimiento que replay-pr4-mutants.mjs: línea base en VERDE, mutante en ROJO, restaurar.
 * Uso: node apps/replay-service/scripts/replay-pr4b-mutants.mjs [id...]   (serie, nunca en paralelo)
 * Commitea antes: el script reescribe ficheros del árbol y los restaura al terminar cada mutante.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const LAUNCHER = "apps/api/src/services/battle-run-http-launcher.ts";
const LAUNCHER_T = "apps/api/src/services/battle-run-http-launcher.test.ts";
const PLAYER = "apps/web/src/viewer/replay-player.ts";
const PLAYER_T = "apps/web/tests/replay-player.test.ts";
const PRE1_T = "apps/api/src/pre1-replay-projection.test.ts";
const SMOKE = "scripts/e2e-real-battle-smoke.ts";
const SMOKE_T = "tests/e2e/e2e-real-battle-smoke.test.ts";

export const MUTANTS = [
  {
    id: "M-L-ingested-true",
    why: "el lanzador vuelve a afirmar ingested:true tras verificar",
    test: LAUNCHER_T,
    t: "NUNCA ingested:true ni una petición",
    edits: [
      {
        file: LAUNCHER,
        find: "    ingested: false,\n    verifyMatches: true,",
        replace: "    ingested: true,\n    verifyMatches: true,",
      },
    ],
  },
  {
    id: "M-L-posts-to-replay-service",
    why: "el lanzador vuelve a enviar el replay al replay-service",
    test: LAUNCHER_T,
    t: "NUNCA ingested:true ni una petición",
    edits: [
      {
        file: LAUNCHER,
        find: "  return {\n    ingested: false,\n    verifyMatches: true,",
        replace:
          '  await fetch(new URL(`/replays/${encodeURIComponent(battleId)}`, _replayServiceUrl), { method: "POST", body: "{}" }).catch(() => undefined);\n  return {\n    ingested: false,\n    verifyMatches: true,',
      },
    ],
  },
  {
    id: "M-L-strict-completes",
    why: "en modo estricto un replay que verifica se da por completed sin archivo",
    test: LAUNCHER_T,
    t: "replay que SÍ verifica → status failed",
    edits: [
      {
        file: LAUNCHER,
        find: "if (!outcome.ingested && cfg.replayIngestRequired) {",
        replace: "if (Date.now() < 0) {",
      },
    ],
  },
  {
    id: "M-L-strict-no-url-completes",
    why: "en modo estricto sin URL la batalla se da por completed",
    test: LAUNCHER_T,
    t: "modo estricto SIN replayServiceUrl",
    edits: [
      { file: LAUNCHER, find: "          if (cfg.replayIngestRequired) {", replace: "          if (Date.now() < 0) {" },
    ],
  },
  {
    id: "M-L-identity-guard-removed",
    why: "se quita la guarda de identidad: un replay de otra batalla pasa por verificado",
    test: LAUNCHER_T,
    t: "ATAQUE DEL SUPERVISOR 1",
    edits: [{ file: LAUNCHER, find: "if (replay.header?.battleId !== battleId) {", replace: "if (Date.now() < 0) {" }],
  },
  {
    id: "M-L-verify-guard-removed",
    why: "se quita verifyAndRecompute: un replay manipulado pasa por verificado",
    test: LAUNCHER_T,
    t: "MUTACIÓN DE INTEGRIDAD",
    edits: [{ file: LAUNCHER, find: "if (!outcome.verification.matches) {", replace: "if (Date.now() < 0) {" }],
  },
  {
    id: "M-W-debugOpen-getter",
    why: "el reproductor vuelve a exponer debugOpen",
    test: PLAYER_T,
    t: "no tiene debugOpen ni commandsAt",
    edits: [
      {
        file: PLAYER,
        find: "  play(): void {",
        replace:
          "  get debugOpen(): boolean {\n    return (this.index as any)?.debugOpen === true;\n  }\n\n  play(): void {",
      },
    ],
  },
  {
    id: "M-W-commands-retained",
    why: "el reproductor vuelve a guardar los comandos que le manda la fuente",
    test: PLAYER_T,
    t: "no tiene debugOpen ni commandsAt",
    edits: [
      {
        file: PLAYER,
        find: "    this.events.sort((a, b) => a.tick - b.tick);\n  }",
        replace:
          "    this.events.sort((a, b) => a.tick - b.tick);\n    (this as any).cmds = [...((this as any).cmds ?? []), ...((seg as any).commands ?? [])];\n  }",
      },
    ],
  },
  {
    id: "M-API-storeIndex-debugOpen",
    why: "el índice de almacén vuelve a anunciar debugOpen",
    test: PLAYER_T,
    t: "ni el índice ni los segmentos",
    edits: [
      {
        file: "apps/api/src/replay-s9r.ts",
        find: "      finalStateHash: battle.final_state_hash ?? null,\n    },\n  };",
        replace: "      finalStateHash: battle.final_state_hash ?? null,\n    },\n    debugOpen: false,\n  };",
      },
    ],
  },
  {
    id: "M-API-projectIndex-debugOpen",
    why: "el índice proyectado vuelve a anunciar debugOpen",
    test: PRE1_T,
    t: "un debugOpen:true de entrada no sale",
    edits: [
      {
        file: "apps/api/src/replay-projection.ts",
        find: '    ...(typeof index?.createdAt === "string" ? { createdAt: index.createdAt } : {}),\n',
        replace:
          '    ...(typeof index?.createdAt === "string" ? { createdAt: index.createdAt } : {}),\n    debugOpen: false,\n',
      },
    ],
  },
  {
    id: "M-SMOKE-publishes-other-battle",
    why: "el arnés publica un replay que no es la batalla jugada (sin comandos)",
    test: SMOKE_T,
    t: "EXACTAMENTE la batalla jugada",
    edits: [
      {
        file: SMOKE,
        find: "const fx = await writeS9rReplay(cfg.replayOutDir, replay, { validate: true });",
        replace: "const fx = await writeS9rReplay(cfg.replayOutDir, { ...replay, commands: [] }, { validate: true });",
      },
    ],
  },
  {
    id: "M-SMOKE-strict-ignored",
    why: "el modo estricto del arnés deja de leer REPLAY_INGEST_REQUIRED/REPLAY_VERIFY_REQUIRED",
    test: SMOKE_T,
    t: "el estricto se mantiene",
    edits: [
      {
        file: SMOKE,
        find: 'replayVerifyRequired: env.REPLAY_VERIFY_REQUIRED === "1" || env.REPLAY_INGEST_REQUIRED === "1",',
        replace: 'replayVerifyRequired: env.REPLAY_VERIFY_REQUIRED === "1",',
      },
    ],
  },
  {
    id: "M-VAL-gate-ignored",
    why: "la escritura validada (sustituta de la ingesta) almacena un replay incompleto",
    test: "apps/replay-service/tests/replay-service.test.ts",
    t: "sin checksum de mapa se rechaza y no se almacena",
    edits: [
      {
        file: "apps/replay-service/src/s9r/replay-file.ts",
        find: "    if (problems.length) throw",
        replace: "    if (Date.now() < 0) throw",
      },
    ],
  },
  {
    id: "M-VAL-checksum-not-checked",
    why: "validateReplay deja de exigir el checksum del mapa",
    test: "apps/replay-service/tests/replay-service.test.ts",
    t: "sin checksum de mapa se rechaza y no se almacena",
    edits: [
      {
        file: "apps/replay-service/src/s9r/completeness.ts",
        find: 'problems.push("mapa sin checksum");',
        replace: "void 0;",
      },
    ],
  },
  {
    id: "M-CLI-sweep-back",
    why: "la CLI vuelve a aceptar `sweep`",
    test: "apps/replay-service/tests/replay-service.test.ts",
    t: "los comandos retirados",
    edits: [
      {
        file: "apps/replay-service/src/cli.ts",
        find: "    default:",
        replace: '    case "sweep":\n      return 0;\n    default:',
      },
    ],
  },
  {
    id: "M-WORKER-completeness-gate-removed",
    why: "H-4b-1 · el worker publica una grabación incompleta (sin la puerta de completitud)",
    test: "apps/tournament-worker/src/v1-replay-pr3-wiring.test.ts",
    t: "W7 ",
    edits: [
      {
        file: "apps/tournament-worker/src/engine-executor.ts",
        find: "        if (problems.length) {",
        replace: "        if (Date.now() < 0) {",
      },
    ],
  },
  {
    id: "M-WORKER-hashes-not-counted",
    why: "H-4b-1 · el grabador deja de contar los hashes intermedios (la puerta los daría por ausentes o presentes sin mirar)",
    test: "apps/tournament-worker/src/v1-replay-pr3-wiring.test.ts",
    t: "W4 ",
    edits: [{ file: "apps/replay-service/src/s9r/recorder.ts", find: "    this.hashCount++;\n", replace: "" }],
  },
  {
    id: "M-IMG-replay-service-not-copied",
    why: "P2-1 · la imagen arena-engine deja de copiar apps/replay-service (la CLI no cargaría el formato)",
    test: "infrastructure/tests/image-entry-imports.test.ts",
    t: "arena-engine/Dockerfile · apps/arena-engine/src/cli.ts",
    edits: [
      {
        file: "infrastructure/docker/arena-engine/Dockerfile",
        find: "COPY apps/replay-service ./apps/replay-service\n",
        replace: "",
      },
    ],
  },
  {
    id: "M-SPECTATE-strict-first-ticket",
    why: "CI de #345 · se vuelve a exigir 201 al primer ticket anónimo aunque la batalla siga scheduled (la carrera, ahora determinista)",
    test: "apps/tournament-worker/src/spectate-live.test.ts",
    t: "EN DIRECTO con ticket",
    edits: [
      {
        file: "apps/tournament-worker/src/spectate-live.test.ts",
        find: "      if (tk.status === 404) {",
        replace: "      expect(tk.status).toBe(201);\n      if (tk.status === 404) {",
      },
    ],
  },
];

function run(test, t) {
  const r = spawnSync("nice", ["-n", "19", "npx", "vitest", "run", test, "-t", t, "--maxWorkers=1"], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  return r.status;
}

const only = new Set(process.argv.slice(2));

// Precomprobación: TODOS los mutantes seleccionados se aplican (cada patrón con UNA aparición) sobre
// el árbol limpio. Un mutante que no se aplica NO calibra nada: el script FALLA antes de ejecutar
// ningún test, en vez de contarlo como «no aplicable» (revisión de #345, P3-1).
const noAplicables = [];
for (const m of MUTANTS) {
  if (only.size && !only.has(m.id)) continue;
  const cur = new Map();
  for (const e of m.edits) {
    const f = join(root, e.file);
    const src = cur.get(f) ?? readFileSync(f, "utf8");
    const k = src.split(e.find).length - 1;
    if (k !== 1) {
      noAplicables.push(`${m.id}: patrón con ${k} apariciones en ${e.file}`);
      break;
    }
    cur.set(
      f,
      src.replace(e.find, () => e.replace),
    );
  }
}
const desconocidos = [...only].filter((id) => !MUTANTS.some((m) => m.id === id));
for (const id of desconocidos) noAplicables.push(`${id}: mutante desconocido`);
if (noAplicables.length) {
  for (const l of noAplicables) console.log(`FALLO (no aplicado) ${l}`);
  console.log(`mutantes no aplicables: ${noAplicables.length} · el script FALLA`);
  process.exit(2);
}

const base = new Map();
let survivors = 0;
let killedCount = 0;
let total = 0;
for (const m of MUTANTS) {
  if (only.size && !only.has(m.id)) continue;
  const key = `${m.test}::${m.t}`;
  if (!base.has(key)) base.set(key, run(m.test, m.t));
  total++;
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
    else killedCount++;
    console.log(`${m.id}: ${killed ? "MUERTO (test en rojo, rc " + rc + ")" : "SOBREVIVE (rc 0)"} · ${m.why}`);
  } finally {
    for (const [f, s] of originals) writeFileSync(f, s);
  }
}
console.log(`MUERTOS ${killedCount}/${total} · supervivientes/errores: ${survivors}`);
process.exit(survivors ? 1 : 0);
