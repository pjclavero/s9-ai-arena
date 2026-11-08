/**
 * REVISIÓN FINAL #244 @ 470482f (NO MERGEAR) · pruebas del revisor independiente.
 *
 *  - RVF-1 · P2-1: la lista cerrada de `rollbackNamed` sigue cerrada tras añadir la 019.
 *    Nombres raros, prefijos (`019`), con espacios, de prototipo o fuera de la lista se
 *    rechazan SIN tocar la BD (la BD es un Proxy que revienta al primer uso).
 *  - RVF-2 · P3-6: `winnerBotName` sigue la MISMA regla que `winnerBotId` (hiddenBotIds).
 *    Documenta un límite: el rol `organizer` es «replay staff» (isReplayStaff ≥ organizer),
 *    así que `hiddenBotIds` no le oculta nada y recibe el NOMBRE del ganador privado
 *    también en un torneo SIN broadcast. Es la política previa de replays (TD-004), no una
 *    vía nueva, pero contradice el titular de docs/user/visibility.md («La organización
 *    de torneos no ve tu bot privado»).
 */
import { describe, it, expect } from "vitest";
import { NAMED_ROLLBACK_ALLOWED, rollbackNamed } from "./db/migrations.js";
import { hiddenBotIds } from "./battle-access.js";
import { tournamentMatchToJson } from "./routes/tournaments.js";
import { ROLE_RANK } from "./openapi.js";

const explodingDb = new Proxy(
  {},
  {
    get(_t, p) {
      throw new Error(`BD tocada: ${String(p)}`);
    },
    apply() {
      throw new Error("BD tocada");
    },
  },
) as never;

describe("RVF-1 · P2-1 · lista cerrada de rollback:name con la 019", () => {
  it("la lista es exactamente 016..019 y está congelada", () => {
    expect([...NAMED_ROLLBACK_ALLOWED]).toEqual([
      "016_battle_rules",
      "017_streaming_admin",
      "018_battle_reverted",
      "019_visibility_broadcast",
    ]);
    expect(Object.isFrozen(NAMED_ROLLBACK_ALLOWED)).toBe(true);
  });

  for (const n of [
    "019",
    "19",
    "019_visibility",
    " 019_visibility_broadcast",
    "019_visibility_broadcast ",
    "019_VISIBILITY_BROADCAST",
    "../019_visibility_broadcast",
    "__proto__",
    "constructor",
    "",
  ]) {
    it(`nombre raro ${JSON.stringify(n)} se rechaza sin tocar la BD`, async () => {
      await expect(rollbackNamed(explodingDb, n)).rejects.toThrow(/Migración desconocida/);
    });
  }

  for (const n of ["001_identity", "012_bot_versioning", "015_bot_retired"]) {
    it(`${n} (existe pero fuera de la lista) se rechaza sin tocar la BD`, async () => {
      await expect(rollbackNamed(explodingDb, n)).rejects.toThrow(/no se puede revertir por nombre/);
    });
  }
});

describe("RVF-2 · P3-6 · winnerBotName y el rol organizer", () => {
  const PRIV = "0f3a9c1e-1111-4222-8333-444455556666";
  const match = {
    id: "m",
    round: 1,
    slot: "r1m1",
    pairing: { home: PRIV, away: "bye" },
    state: "finished",
    winner_bot_id: PRIV,
    winner_team_id: null,
    final: true,
  };
  const names = new Map([[PRIV, "A-DEF"]]);

  it("oculto ⇒ ni id ni nombre aunque el mapa de nombres lo traiga (defensa en la proyección)", () => {
    const j = tournamentMatchToJson(match, new Set([PRIV]), false, names);
    expect(j.winnerBotId).toBeNull();
    expect(j).not.toHaveProperty("winnerBotName");
    expect(JSON.stringify(j)).not.toContain("A-DEF");
  });

  it("LÍMITE · organizer: hiddenBotIds no oculta nada (sin consultar la BD) ⇒ recibe el nombre en un torneo SIN broadcast", async () => {
    const organizer = { userId: "u", sessionId: "s", roles: ["organizer"], rank: ROLE_RANK.organizer };
    const hidden = await hiddenBotIds(explodingDb, organizer as never, [PRIV], { tournamentId: "t-sin-broadcast" });
    expect(hidden.size).toBe(0);
    const j = tournamentMatchToJson(match, hidden, false, names);
    expect(j.winnerBotName).toBe("A-DEF");
  });
});
