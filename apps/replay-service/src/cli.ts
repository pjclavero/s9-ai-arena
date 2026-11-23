/**
 * T8.1 · CLI del replay-service.
 *
 *   npx tsx apps/replay-service/src/cli.ts verify <battleId> [--dir <dir>]
 *   npx tsx apps/replay-service/src/cli.ts verify --file <receta.s9r>
 *
 * `verify` es el criterio del cap. 28: re-simula con la versión de motor registrada en la
 * cabecera y comprueba que resultado, hashes intermedios y checkpoints coinciden con el oficial.
 * V1 REPLAYS PR-4 · lee la RECETA S9R/1 por fragmentos (`<dir>/<battleId>.<intento>.s9r`; si hay
 * varias, la del intento más alto). `ingest`, `sweep` y `serve` trabajaban con el formato JSONL
 * anterior (corte D-OP-30): están RETIRADOS y responden con error (PR-4b los quita del código).
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { verifyFile } from "./s9r/verify.js";
import { verifyRecipePath } from "./recipe-verify.js";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const DEFAULT_DIR = process.env.ARENA_REPLAYS_DIR ?? "data/arena_replays";

/** Receta publicada de una batalla en `dir` (intento más alto), o null. */
function recipeFileFor(dir: string, battleId: string): string | null {
  let best: { n: number; f: string } | null = null;
  for (const f of readdirSync(dir)) {
    const m = /^(.+)\.(\d+)\.s9r$/.exec(f);
    if (!m || m[1] !== battleId) continue;
    const n = Number(m[2]);
    if (!best || n > best.n) best = { n, f };
  }
  return best ? join(dir, best.f) : null;
}

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  const dir = flag(args, "--dir") ?? DEFAULT_DIR;

  switch (cmd) {
    case "verify": {
      const file = flag(args, "--file") ?? (args[0] && !args[0].startsWith("--") ? recipeFileFor(dir, args[0]) : null);
      if (!file) throw new Error("uso: verify <battleId> [--dir <dir>] | verify --file <receta.s9r>");
      const integrity = await verifyFile(file);
      if (!integrity.ok) {
        console.log(JSON.stringify({ file, valid: false, reason: integrity.reason ?? integrity.error?.code }, null, 2));
        return 1;
      }
      const { verification } = await verifyRecipePath(file);
      const valid = verification.rejected === null;
      console.log(
        JSON.stringify({ file, sha256: integrity.sha256, valid, reason: verification.rejected, verification }, null, 2),
      );
      return valid && verification.matches ? 0 : 1;
    }
    case "ingest":
    case "sweep":
    case "serve":
      console.error(`'${cmd}' retirado: trabajaba con el formato de replay anterior (corte D-OP-30).`);
      return 2;
    default:
      console.error("comandos: verify");
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e.message);
    process.exit(2);
  });
