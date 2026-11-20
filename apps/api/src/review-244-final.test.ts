// RESCATE B3 (2026-11) · origen: PR #248 (rama review/visibilidad-244-final, commit a1f52d4d), test de revisión no integrado.
// Verificado contra main 8f380eb; mutante asociado en scripts/rescue-mutants.{json,mjs}.
/**
 * REVISIÓN FINAL #244 @ 470482f (NO MERGEAR) · pruebas del revisor independiente.
 *
 *  - RVF-1 · P2-1: la lista cerrada de `rollbackNamed` sigue cerrada tras añadir la 019.
 *    Nombres raros, prefijos (`019`), con espacios, de prototipo o fuera de la lista se
 *    rechazan SIN tocar la BD (la BD es un Proxy que revienta al primer uso).
 *  - RVF-2 · P3-6: `winnerBotName` sigue la MISMA regla que `winnerBotId` (hiddenBotIds).
 *    Defecto documentado con `it.fails` (issue #306): el rol `organizer` es «replay staff»
 *    (isReplayStaff ≥ organizer), así que `hiddenBotIds` no le oculta nada y recibe el NOMBRE
 *    del ganador privado también en un torneo SIN broadcast, lo que contradice docs/user/visibility.md
 *    («La organización de torneos no ve tu bot privado»). El test afirma la política documentada.
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

/** BD falsa: `bots` devuelve un bot privado de OTRO usuario; cualquier otra consulta (p. ej. torneo con broadcast) no encuentra nada. */
function privateBotDb(botId: string): never {
  const rows = [{ id: botId, owner_id: "otro-usuario", visibility: "private", team_id: null }];
  const chain = (): unknown =>
    new Proxy(function () {}, {
      get(_t, p) {
        if (p === "first") return () => Promise.resolve(undefined);
        if (p === "select") return () => Promise.resolve(rows);
        if (p === "then") return undefined;
        return () => chain();
      },
      apply: () => chain(),
    });
  return chain() as never;
}

describe("RVF-1 · P2-1 · lista cerrada de rollback:name con la 019", () => {
  it("la lista cerrada incluye la 019, sólo contiene migraciones >= 016, no tiene repetidos y está congelada", () => {
    // (El PR original fijaba «exactamente 016..019»; main añadió después la 020, 021 y 022, cada una con
    // su test de vuelta atrás. Se conserva la garantía, no el recuento.)
    const list = [...NAMED_ROLLBACK_ALLOWED];
    expect(list).toContain("019_visibility_broadcast");
    expect(
      list.every((n) => /^0(1[6-9]|[2-9]\d)_/.test(n)),
      list.join(),
    ).toBe(true);
    expect(new Set(list).size).toBe(list.length);
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
  const names = new Map([[PRIV, "BOT-SINTETICO"]]);

  it("oculto ⇒ ni id ni nombre aunque el mapa de nombres lo traiga (defensa en la proyección)", () => {
    const j = tournamentMatchToJson(match, new Set([PRIV]), false, names);
    expect(j.winnerBotId).toBeNull();
    expect(j).not.toHaveProperty("winnerBotName");
    expect(JSON.stringify(j)).not.toContain("BOT-SINTETICO");
  });

  // DEFECTO VIGENTE (issue #306): la doc (docs/user/visibility.md) dice que la organización de torneos
  // NO ve un bot privado, pero el rol `organizer` cuenta como «replay staff» y recibe el NOMBRE del
  // ganador privado en un torneo SIN broadcast. Este test afirma la política DOCUMENTADA y por eso
  // falla hoy: `it.fails` se pone ROJO cuando se corrija el código (entonces, quitar `.fails`); si en
  // cambio se decide corregir la doc, hay que reescribirlo. No consolida el defecto como garantía.
  it.fails("organizer NO debería recibir el nombre de un ganador privado en un torneo sin broadcast (#306)", async () => {
    const organizer = { userId: "u", sessionId: "s", roles: ["organizer"], rank: ROLE_RANK.organizer };
    const hidden = await hiddenBotIds(privateBotDb(PRIV), organizer as never, [PRIV], { tournamentId: "t-sin-broadcast" });
    const j = tournamentMatchToJson(match, hidden, false, names);
    expect(hidden.has(PRIV)).toBe(true);
    expect(j.winnerBotId).toBeNull();
    expect(j).not.toHaveProperty("winnerBotName");
  });
});
