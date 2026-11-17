/**
 * OLA 2 · G2 · ronda 2 (P2-1) · el REAPER no se cuelga: cada llamada externa (listado y
 * borrado en el proxy, consulta a la BD) tiene plazo, y una batalla cuyo teardown no pudo
 * VERIFICARSE fuera del proceso se vuelve a verificar en la siguiente pasada.
 *
 * Sin BD real ni Docker: la BD es un doble mínimo de `db("battles").whereIn().select()`.
 */
import type { Knex } from "knex";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LABEL_BATTLE_ID,
  LABEL_ROLE,
  ROLE_BATTLE_BOT,
  type ManagedContainer,
} from "../../bot-manager/src/container-runner.js";
import { BattleResourceRegistry } from "./battle-resources.js";
import { DEFAULT_REAPER_CALL_DEADLINE_MS, reapOnce, type ReaperRunner } from "./battle-reaper.js";

const never = <T>() => new Promise<T>(() => undefined);

/** BD de pega: `battles` con las filas dadas (o una consulta que nunca contesta). */
function fakeDb(rows: { id: string; status: string; claimed_by: string | null }[] | "hang"): Knex {
  return ((table: string) => {
    expect(table).toBe("battles");
    return {
      whereIn: (_c: string, ids: string[]) => ({
        select: () => (rows === "hang" ? never() : Promise.resolve(rows.filter((r) => ids.includes(r.id)))),
      }),
    };
  }) as unknown as Knex;
}

const container = (id: string, battleId: string): ManagedContainer => ({
  id,
  labels: { [LABEL_ROLE]: ROLE_BATTLE_BOT, [LABEL_BATTLE_ID]: battleId },
  state: "exited",
  createdAtMs: 0,
});

/** Resuelve con el informe o con «hung» si `p` no termina en `ms`. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | "hung"> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<"hung">((r) => (t = setTimeout(() => r("hung"), ms)))]);
  } finally {
    clearTimeout(t);
  }
}

describe("G2 · ronda 2 · REAPER acotado: ninguna llamada externa lo cuelga", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("un listado del proxy que nunca contesta: la pasada acaba en su plazo y lo informa", async () => {
    const runner: ReaperRunner = { list: () => never(), removeById: async () => undefined };
    const out = await within(
      reapOnce({ db: fakeDb([]), runner, resources: new BattleResourceRegistry(), callDeadlineMs: 100 }),
      3_000,
    );
    expect(out, "el reaper quedó esperando al listado").not.toBe("hung");
    const r = out as Exclude<typeof out, "hung">;
    expect(r.errors.join(" ")).toMatch(/listado: listado del reaper sin respuesta del runner en 100 ms/);
    expect(r.removed).toEqual([]);
  });

  it("un borrado que nunca contesta no impide borrar los demás contenedores", async () => {
    const removed: string[] = [];
    const runner: ReaperRunner = {
      list: async () => [container("c-colgado", "b-1"), container("c-bueno", "b-2")],
      removeById: (id) => (id === "c-colgado" ? never() : (removed.push(id), Promise.resolve())),
    };
    const out = await within(
      reapOnce({ db: fakeDb([]), runner, resources: new BattleResourceRegistry(), callDeadlineMs: 100 }),
      3_000,
    );
    expect(out, "el reaper quedó esperando a un borrado").not.toBe("hung");
    const r = out as Exclude<typeof out, "hung">;
    expect(removed).toEqual(["c-bueno"]);
    expect(r.removed.map((x) => x.id)).toEqual(["c-bueno"]);
    expect(r.errors.join(" ")).toMatch(/c-colgado: borrado del reaper sin respuesta/);
  });

  it("una consulta a la BD que nunca contesta: la pasada acaba y NO borra nada (sin saber de quién es, fail-closed)", async () => {
    const removed: string[] = [];
    const runner: ReaperRunner = {
      list: async () => [container("c-1", "b-1")],
      removeById: async (id) => void removed.push(id),
    };
    const out = await within(
      reapOnce({ db: fakeDb("hang"), runner, resources: new BattleResourceRegistry(), callDeadlineMs: 100 }),
      3_000,
    );
    expect(out, "el reaper quedó esperando a la BD").not.toBe("hung");
    const r = out as Exclude<typeof out, "hung">;
    expect(removed).toEqual([]);
    expect(r.kept).toBe(1);
    expect(r.errors.join(" ")).toMatch(/consulta: consulta de batallas del reaper sin respuesta/);
  });

  it("verificación que venció en el teardown: la siguiente pasada del reaper la REPITE y, si el proxy ya contesta, la batalla queda verificada", async () => {
    const res = new BattleResourceRegistry({ verifyDeadlineMs: 100 });
    let hang = true;
    let calls = 0;
    res.setVerifier((battleId) => {
      calls++;
      return hang ? never<string[]>() : Promise.resolve(battleId === "b-v" ? [] : ["?"]);
    });
    const td = await res.cleanupBattleResources("b-v", "FAILED");
    expect(td.clean).toBe(false);
    expect(res.isUnverified("b-v")).toBe(true);
    expect(res.battleIds(), "control: no queda NADA registrado en el proceso").toEqual([]);

    // Pasada con el proxy aún colgado: acaba, lo reintenta y lo sigue informando.
    const r1 = await within(reapOnce({ db: fakeDb([]), resources: res, callDeadlineMs: 100 }), 3_000);
    expect(r1).not.toBe("hung");
    const p1 = r1 as Exclude<typeof r1, "hung">;
    expect(p1.inProcessRetried).toEqual(["b-v"]);
    expect(p1.errors.join(" ")).toMatch(/b-v\/verificación: verificación externa sin respuesta en 100 ms/);
    expect(res.isUnverified("b-v")).toBe(true);

    // El proxy se recupera: la siguiente pasada verifica y la marca desaparece.
    hang = false;
    const p2 = (await reapOnce({ db: fakeDb([]), resources: res })) as Awaited<ReturnType<typeof reapOnce>>;
    expect(p2.inProcessRetried).toEqual(["b-v"]);
    expect(p2.errors).toEqual([]);
    expect(res.isUnverified("b-v")).toBe(false);
    expect(res.retryIds()).toEqual([]);
    expect(calls).toBe(3);
    // Y ya no se repasa más.
    const p3 = await reapOnce({ db: fakeDb([]), resources: res });
    expect(p3.inProcessRetried).toEqual([]);
    expect(calls).toBe(3);
  });

  it("DEFAULT_REAPER_CALL_DEADLINE_MS = 15 s: sin inyectar el plazo, un listado colgado vence EXACTAMENTE a los 15 s", async () => {
    vi.useFakeTimers();
    const runner: ReaperRunner = { list: () => never(), removeById: async () => undefined };
    let done = false;
    const p = reapOnce({ db: fakeDb([]), runner, resources: new BattleResourceRegistry() }).then(
      (r) => ((done = true), r),
    );
    await vi.advanceTimersByTimeAsync(14_999);
    expect(done, "venció antes de 15 s").toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done, "no venció a los 15 s").toBe(true);
    expect((await p).errors.join(" ")).toMatch(/en 15000 ms/);
    expect(DEFAULT_REAPER_CALL_DEADLINE_MS).toBe(15_000);
  });
});
