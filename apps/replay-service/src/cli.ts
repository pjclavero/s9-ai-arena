/**
 * T8.1 · CLI del replay-service.
 *
 *   npx tsx apps/replay-service/src/cli.ts verify <battleId> [--dir <dir>]
 *   npx tsx apps/replay-service/src/cli.ts ingest <archivo.jsonl> [--dir <dir>] [--official]
 *   npx tsx apps/replay-service/src/cli.ts sweep [--dir <dir>]
 *   npx tsx apps/replay-service/src/cli.ts serve [--dir <dir>] [--port <n>]
 *
 * `verify <id>` es el criterio del cap. 28: re-simula con la versión de motor
 * registrada y comprueba que resultado y hashes coinciden con el oficial.
 */
import { readFileSync } from "node:fs";
import { fromJsonl } from "../../arena-engine/src/replay.js";
import { ingestReplay, sweepRetention, verifyStored } from "./store.js";
import { createReplayServer } from "./server.js";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const DEFAULT_DIR = process.env.ARENA_REPLAYS_DIR ?? "data/arena_replays";

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  const dir = flag(args, "--dir") ?? DEFAULT_DIR;

  switch (cmd) {
    case "verify": {
      const battleId = args[0];
      if (!battleId) throw new Error("uso: verify <battleId> [--dir <dir>]");
      const r = await verifyStored(dir, battleId);
      console.log(JSON.stringify(r, null, 2));
      return r.valid && r.verification?.matches ? 0 : 1;
    }
    case "ingest": {
      const file = args[0];
      if (!file) throw new Error("uso: ingest <archivo.jsonl> [--dir <dir>] [--official]");
      const replay = fromJsonl(readFileSync(file, "utf8"));
      const stored = ingestReplay(dir, replay, { official: args.includes("--official") });
      console.log(JSON.stringify({ battleId: stored.index.battleId, path: stored.path, sha256: stored.index.sha256 }, null, 2));
      return 0;
    }
    case "sweep": {
      console.log(JSON.stringify(sweepRetention(dir), null, 2));
      return 0;
    }
    case "serve": {
      const port = Number(flag(args, "--port") ?? process.env.PORT ?? 8082);
      createReplayServer({ dir }).listen(port, () => {
        console.log(`replay-service escuchando en :${port}, dir=${dir}`);
      });
      return -1; // no salir
    }
    default:
      console.error("comandos: verify | ingest | sweep | serve");
      return 2;
  }
}

main().then((code) => {
  if (code >= 0) process.exit(code);
}).catch((e) => {
  console.error(e.message);
  process.exit(2);
});
