/**
 * E9 · T9.1 — DoD de la cola y el worker:
 *  - Dos workers concurrentes nunca ejecutan la misma batalla (carrera con bloqueo).
 *  - Derrota por timeout del bot = derrota deportiva, sin reintento.
 *  - Fallo de infraestructura: reintentos con límite y luego revisión manual.
 *  - Caos: matar el worker a mitad de un torneo de 20 batallas y reanudar sin
 *    batallas duplicadas ni perdidas (cap. 28).
 *
 * BD: PostgreSQL 18 REAL embebido (harness de E7, ADR-E7-002). Prohibido tocar
 * bases del homelab.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:net";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev } from "../../api/src/db/seeds/dev.js";
import { claimJob, completeJob, enqueueJob, type JobRow } from "./queue.js";
import { TournamentWorker, computeConcurrency } from "./worker.js";
import { InfrastructureFailure, SportingFailure, classifyFailure } from "./errors.js";
import {
  makeRunBattleHandler,
  markBattleForReview,
  type BattleContext,
  type BattleExecution,
} from "./battle-runner.js";
import { createBots, insertScheduledBattle, type TestBot } from "./testing/fixtures.js";
import { RedisSignal } from "./redis-signal.js";

let h: TestDbHandle;
let bots: TestBot[];

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  bots = await createBots(h.db, 4, "q");
}, 120_000);

afterAll(async () => {
  await h.stop();
});

/** Ejecutor guionizado: cuenta ejecuciones por batalla y gana siempre el equipo A. */
function scriptedExecutor(log: Map<string, number>, fail?: (ctx: BattleContext) => void) {
  return async (ctx: BattleContext): Promise<BattleExecution> => {
    log.set(ctx.battle.id, (log.get(ctx.battle.id) ?? 0) + 1);
    fail?.(ctx);
    return {
      winner: "A",
      ticks: 100,
      score: { A: 3, B: 1 },
      finalStateHash: `hash-${ctx.battle.id}`,
      disqualified: [],
      versions: { engine: "test" },
    };
  };
}

function workerWith(executor: ReturnType<typeof scriptedExecutor>, workerId: string) {
  return new TournamentWorker({
    db: h.db,
    workerId,
    handlers: { run_battle: makeRunBattleHandler({ executor }) },
    onExhausted: (job) => markBattleForReview(h.db, job),
    lockTimeoutMs: 1000,
  });
}

describe("T9.1 · clasificación de fallos (19.2, E9.M)", () => {
  it("formaliza deportivo vs infraestructura como enumeración", () => {
    expect(classifyFailure("bot_timeout")).toBe("sporting");
    expect(classifyFailure("bot_crash")).toBe("sporting");
    expect(classifyFailure("engine_start_failure")).toBe("infrastructure");
    expect(classifyFailure("map_unavailable")).toBe("infrastructure");
    expect(classifyFailure("worker_died")).toBe("infrastructure");
  });

  it("la concurrencia se deriva de CPU/RAM configuradas (9.4)", () => {
    expect(computeConcurrency({ cpuCount: 8, memMb: 8192 })).toBe(4); // limita la RAM
    expect(computeConcurrency({ cpuCount: 4, memMb: 32768 })).toBe(3); // limita la CPU (n-1)
    expect(computeConcurrency({ cpuCount: 1, memMb: 1024 })).toBe(1); // mínimo 1
  });
});

describe("T9.1 · idempotencia y bloqueo distribuido", () => {
  it("encolar dos veces el mismo trabajo lógico inserta UNA fila (dedupe_key)", async () => {
    const first = await enqueueJob(h.db, "update_standings", { x: 1 }, { dedupeKey: "dedupe-test" });
    const second = await enqueueJob(h.db, "update_standings", { x: 1 }, { dedupeKey: "dedupe-test" });
    expect(first).toBeTruthy();
    expect(second).toBeNull();
    const rows = await h.db("jobs").where({ dedupe_key: "dedupe-test" });
    expect(rows.length).toBe(1);
  });

  it("DoD: dos workers concurrentes nunca reclaman la misma batalla (carrera)", async () => {
    const battleId = await insertScheduledBattle(h.db, bots[0], bots[1]);
    await enqueueJob(h.db, "run_battle", { battleId }, { dedupeKey: `race:${battleId}` });

    // 8 claims simultáneos sobre un único trabajo: exactamente uno gana.
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        claimJob(h.db, { workerId: `racer-${i}`, kinds: ["run_battle"], lockTimeoutMs: 60_000 }),
      ),
    );
    const winners = claims.filter((c): c is JobRow => c !== null && c.dedupe_key === `race:${battleId}`);
    expect(winners.length).toBe(1);
    // Limpieza: el trabajo reclamado se completa para no dejar un lock huérfano
    // que contaminaría los tests posteriores (eso es EXACTAMENTE lo que pasaría
    // en producción si el ganador muriera: lo cubre el test de caos).
    await completeJob(h.db, winners[0].id);
  });

  it("dos workers en paralelo sobre una cola de batallas: cada una se ejecuta UNA vez", async () => {
    const log = new Map<string, number>();
    const battleIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = await insertScheduledBattle(h.db, bots[i % 2], bots[2 + (i % 2)]);
      battleIds.push(id);
      await enqueueJob(h.db, "run_battle", { battleId: id }, { dedupeKey: `par:${id}` });
    }
    const w1 = workerWith(scriptedExecutor(log), "par-w1");
    const w2 = workerWith(scriptedExecutor(log), "par-w2");
    await Promise.all([w1.drain(), w2.drain()]);

    for (const id of battleIds) {
      expect(log.get(id)).toBe(1); // ni duplicada ni perdida
      const battle = await h.db("battles").where({ id }).first();
      expect(battle.status).toBe("finished");
    }
  });
});

describe("T9.1 · derrota deportiva (19.2): timeout del bot NO se reintenta", () => {
  it("un bot que se cuelga a propósito queda como derrota y el trabajo no se reintenta", async () => {
    const battleId = await insertScheduledBattle(h.db, bots[0], bots[1]);
    await enqueueJob(h.db, "run_battle", { battleId }, { dedupeKey: `timeout:${battleId}` });

    const log = new Map<string, number>();
    // El bot A (bots[0]) se cuelga: el ejecutor lo detecta como timeout deportivo.
    const w = workerWith(
      scriptedExecutor(log, (ctx) => {
        throw new SportingFailure(
          "bot_timeout",
          ctx.participants[0].bot_id,
          "el bot no responde (colgado a propósito)",
        );
      }),
      "sport-w",
    );
    await w.drain();

    const job = await h
      .db("jobs")
      .where({ dedupe_key: `timeout:${battleId}` })
      .first();
    expect(job.status).toBe("done"); // completado: NO vuelve a la cola
    expect(job.attempts).toBe(1); // ni un solo reintento
    expect(job.error_class).toBe("sporting");

    const battle = await h.db("battles").where({ id: battleId }).first();
    expect(battle.status).toBe("finished");
    expect(battle.failure_kind).toBe("bot_timeout");
    const culprit = await h.db("participants").where({ battle_id: battleId, bot_id: bots[0].botId }).first();
    const rival = await h.db("participants").where({ battle_id: battleId, bot_id: bots[1].botId }).first();
    expect(culprit.outcome).toBe("disqualified"); // derrota deportiva del culpable
    expect(rival.outcome).toBe("win");
    expect(log.get(battleId)).toBe(1); // una única ejecución
  });
});

describe("T9.1 · fallo de infraestructura: reintentos con límite y revisión manual", () => {
  it("motor que muere al arrancar: se reintenta hasta el límite y la batalla queda para revisión", async () => {
    const battleId = await insertScheduledBattle(h.db, bots[2], bots[3]);
    await enqueueJob(h.db, "run_battle", { battleId }, { dedupeKey: `infra:${battleId}`, maxAttempts: 3 });

    const log = new Map<string, number>();
    const w = workerWith(
      scriptedExecutor(log, () => {
        throw new InfrastructureFailure("engine_start_failure", "el motor murió al arrancar (simulado)");
      }),
      "infra-w",
    );

    // Cada intento respeta el backoff: avanzamos el reloj entre intentos.
    let now = new Date();
    for (let i = 0; i < 5; i++) {
      await w.runOnce(now);
      now = new Date(now.getTime() + 120_000);
    }

    expect(log.get(battleId)).toBe(3); // exactamente max_attempts ejecuciones
    const job = await h
      .db("jobs")
      .where({ dedupe_key: `infra:${battleId}` })
      .first();
    expect(job.status).toBe("needs_review"); // revisión manual, nunca reintento infinito
    expect(job.error_class).toBe("infrastructure");

    const battle = await h.db("battles").where({ id: battleId }).first();
    expect(battle.status).toBe("failed"); // marcada para revisión manual
    expect(battle.failure_kind).toBe("infrastructure");
  });

  it("un error NO clasificado (bug del worker) va directo a revisión, sin reintentos", async () => {
    await enqueueJob(h.db, "tournament_dry_run", {}, { dedupeKey: "bug-job" });
    const w = new TournamentWorker({
      db: h.db,
      workerId: "bug-w",
      handlers: {
        tournament_dry_run: async () => {
          throw new Error("TypeError inesperado (bug)");
        },
      },
    });
    await w.drain();
    const job = await h.db("jobs").where({ dedupe_key: "bug-job" }).first();
    expect(job.status).toBe("needs_review");
    expect(job.attempts).toBe(1);
  });
});

describe("T9.1 · caos (cap. 28): matar el worker a mitad de un torneo de 20 batallas", () => {
  it("el torneo se reanuda sin batallas duplicadas ni perdidas", async () => {
    const log = new Map<string, number>();
    const battleIds: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = await insertScheduledBattle(h.db, bots[i % 2], bots[2 + (i % 2)]);
      battleIds.push(id);
      await enqueueJob(h.db, "run_battle", { battleId: id }, { dedupeKey: `chaos:${id}` });
    }

    // El worker 1 procesa 7 batallas y "muere": además deja UNA batalla reclamada
    // a medias (lock cogido, ejecución nunca terminada) — el peor caso.
    const w1 = workerWith(scriptedExecutor(log), "chaos-w1");
    await w1.drain(7);
    const orphan = await claimJob(h.db, { workerId: "chaos-w1-muerto", kinds: ["run_battle"] });
    expect(orphan).not.toBeNull(); // batalla nº 8 secuestrada por el worker muerto

    // Reinicio: el worker 2 arranca DESPUÉS del lock timeout (worker_died, 19.2)
    // y debe terminar el torneo entero, incluida la batalla huérfana.
    const w2 = workerWith(scriptedExecutor(log), "chaos-w2");
    const later = new Date(Date.now() + 5_000); // > lockTimeoutMs=1000
    await w2.drain(1000, later);

    for (const id of battleIds) {
      const battle = await h.db("battles").where({ id }).first();
      expect(battle.status).toBe("finished"); // ninguna perdida
      expect(log.get(id)).toBe(1); // ninguna ejecutada dos veces
      // …y process_result encolado exactamente una vez (dedupe).
      const followUps = await h.db("jobs").where({ dedupe_key: `process_result:${id}` });
      expect(followUps.length).toBe(1);
    }
    const stuck = await h.db("jobs").whereIn("status", ["queued", "running"]).where("kind", "run_battle");
    expect(stuck.length).toBe(0);
  });

  it("re-entrega de un trabajo de batalla YA terminada: no re-ejecuta nada (idempotente)", async () => {
    // Batalla terminada + trabajo duplicado manual (simula doble entrega extrema).
    const id = await insertScheduledBattle(h.db, bots[0], bots[3]);
    const log = new Map<string, number>();
    const w = workerWith(scriptedExecutor(log), "idem-w");
    await enqueueJob(h.db, "run_battle", { battleId: id }, { dedupeKey: `idem:${id}:1` });
    await w.drain();
    expect(log.get(id)).toBe(1);
    // Segunda entrega del MISMO battleId con otra clave (p. ej. bug de un productor).
    await enqueueJob(h.db, "run_battle", { battleId: id }, { dedupeKey: `idem:${id}:2` });
    await w.drain();
    expect(log.get(id)).toBe(1); // el handler ve la batalla finished y no re-ejecuta
  });
});

describe("T9.1 · capa Redis (aviso + candado), contra stub RESP en proceso", () => {
  let server: Server;
  let port: number;
  const lists = new Map<string, string[]>();
  const kv = new Map<string, string>();

  beforeAll(async () => {
    // Stub RESP mínimo: LPUSH/BLPOP/SET(NX PX)/GET/DEL. No hay Redis real en
    // este entorno (sin docker/sudo): queda documentado en la entrega.
    server = createServer((socket) => {
      let buf = "";
      socket.on("data", (d) => {
        buf += d.toString();
        // parse naïf de comandos RESP completos
        while (true) {
          const lines = buf.split("\r\n");
          if (lines.length < 2 || !lines[0].startsWith("*")) return;
          const argc = Number(lines[0].slice(1));
          const needed = 1 + argc * 2;
          if (lines.length < needed + 1) return;
          const args: string[] = [];
          for (let i = 0; i < argc; i++) args.push(lines[2 + i * 2]);
          buf = lines.slice(needed).join("\r\n");
          const [cmd, key, ...rest] = args;
          switch (cmd) {
            case "LPUSH": {
              const l = lists.get(key) ?? [];
              l.unshift(rest[0]);
              lists.set(key, l);
              socket.write(`:${l.length}\r\n`);
              break;
            }
            case "BLPOP": {
              const l = lists.get(key) ?? [];
              if (l.length > 0) {
                const v = l.pop()!;
                socket.write(`*2\r\n$${key.length}\r\n${key}\r\n$${v.length}\r\n${v}\r\n`);
              } else {
                socket.write("*-1\r\n");
              }
              break;
            }
            case "SET": {
              const nx = rest.includes("NX");
              if (nx && kv.has(key)) socket.write("$-1\r\n");
              else {
                kv.set(key, rest[0]);
                socket.write("+OK\r\n");
              }
              break;
            }
            case "GET": {
              const v = kv.get(key);
              socket.write(v === undefined ? "$-1\r\n" : `$${v.length}\r\n${v}\r\n`);
              break;
            }
            case "DEL":
              socket.write(`:${kv.delete(key) ? 1 : 0}\r\n`);
              break;
            default:
              socket.write("-ERR unknown\r\n");
          }
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("notify/wait despiertan al worker; tryLock es NX (un solo poseedor)", async () => {
    const a = new RedisSignal(`redis://127.0.0.1:${port}`);
    const b = new RedisSignal(`redis://127.0.0.1:${port}`);
    await a.connect();
    await b.connect();

    await a.notify("jobs");
    expect(await b.wait("jobs", 1)).toBe(true);
    expect(await b.wait("jobs", 0)).toBe(false); // ya consumido

    expect(await a.tryLock("battle:x", "token-a", 5000)).toBe(true);
    expect(await b.tryLock("battle:x", "token-b", 5000)).toBe(false); // NX
    await a.unlock("battle:x", "token-a");
    expect(await b.tryLock("battle:x", "token-b", 5000)).toBe(true);

    await a.quit();
    await b.quit();
  });
});
