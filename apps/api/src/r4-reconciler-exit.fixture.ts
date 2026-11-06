/**
 * Revisión independiente · ronda 4 de #227 (NO MERGEAR). Fixture de
 * r4-streaming-break.test.ts: un proceso REAL arma el reconciliador como
 * server.ts, deja correr varios ticks contra la URL dada y debe TERMINAR SOLO
 * (el timer va con unref y nada más queda vivo). La BD es un espía que cuenta
 * cualquier uso. Salida: `status=<n> db=<n>` o `not_armed`.
 */
import { startOrphanReconciler } from "./routes/streaming.js";
import { HttpStreamerClient, type StreamerClient } from "./services/streamer-client.js";
import type { Db } from "./db/connection.js";

let dbUses = 0;
const db = new Proxy(() => undefined, {
  apply() {
    dbUses++;
    throw new Error("la BD no debe tocarse");
  },
  get() {
    dbUses++;
    return undefined;
  },
}) as unknown as Db;

const inner = new HttpStreamerClient(process.argv[2] || null, undefined);
let status = 0;
const client: StreamerClient = {
  get configured() {
    return inner.configured;
  },
  call(method, path, body) {
    if (path === "/status") status++;
    return inner.call(method, path, body);
  },
};

const t = startOrphanReconciler(db, client, 40);
if (!t) {
  console.log("not_armed");
} else {
  // Un temporizador CON ref para dejar correr ~8 ticks; al vencer, nada debe retener el proceso.
  setTimeout(() => {
    process.on("exit", () => console.log(`status=${status} db=${dbUses}`));
  }, 350);
}
