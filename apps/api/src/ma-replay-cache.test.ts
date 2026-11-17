/**
 * OLA 2 · MA · Caché de replay proyectado (hallazgo P2-6): la subclave incluye un digest de
 * la nómina PÚBLICA (bando, botId, nombre). Renombrar un bot tras cachear no sirve el
 * nombre antiguo. Mutante: quitar el digest de la subclave ⇒ rojo.
 */
import { describe, expect, it } from "vitest";
import { projectedReplayStream, publicRosterDigest } from "./replay-projection.js";

const replay = { header: { battleId: "ma-cache" }, snapshots: [], events: [], result: { battleId: "ma-cache" } };
const meta = (name: string) => ({
  world: {},
  roster: [
    { id: "veh_1", botId: "bot_a", team: "red", name },
    { id: "veh_2", botId: "bot_b", team: "blue", name: "Beta" },
  ],
});

describe("projectedReplayStream · caché", () => {
  it("mismo sha y misma nómina: misma entrada (control SAME); nombre distinto: proyección nueva", () => {
    const sha = "a".repeat(64);
    const first = projectedReplayStream(replay, meta("Alfa"), sha);
    const names = (r: { roster: Record<string, unknown>[] }) => r.roster.map((e) => e.name).sort();
    expect(names(first)).toEqual(["Alfa", "Beta"]);
    expect(projectedReplayStream(replay, meta("Alfa"), sha)).toBe(first); // cacheado
    const renamed = projectedReplayStream(replay, meta("Alfa-2"), sha);
    expect(renamed).not.toBe(first);
    expect(names(renamed)).toEqual(["Alfa-2", "Beta"]);
    // y volver al nombre anterior sigue dando el nombre anterior
    expect(names(projectedReplayStream(replay, meta("Alfa"), sha))).toEqual(["Alfa", "Beta"]);
  });

  it("el digest de la nómina no depende del orden interno ni de los ids internos", () => {
    const a = publicRosterDigest(meta("X").roster);
    const b = publicRosterDigest([...meta("X").roster].reverse().map((r, i) => ({ ...r, id: `veh_${9 - i}` })));
    expect(b).toBe(a);
    expect(publicRosterDigest(meta("Y").roster)).not.toBe(a);
  });
});
