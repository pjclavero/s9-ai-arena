// @vitest-environment jsdom
/**
 * 4v4 · Orden estable dentro del bando. Visto en la CI (functional-e2e, run
 * 40842987350): la API devolvió el bando azul como «B-DEF-4, B-DEF-1, B-DEF-2,
 * B-DEF-3» (los participantes se leen sin ORDER BY), y el título del detalle cambiaba
 * de una lectura a otra. La UI ordena por nombre dentro de cada bando.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { botLabel, sideResults, sidesTitle } from "../src/battle-result.js";
import { participantsTitle, rosterFromMeta } from "../src/viewer/art-direction.js";
import { RosterList } from "../src/viewer/RosterList.js";

afterEach(cleanup);

const SHUFFLED = ["A-ATK-1", "A-ATK-2", "A-ATK-3", "A-ATK-4", "B-DEF-4", "B-DEF-1", "B-DEF-2", "B-DEF-3"];
const participants = SHUFFLED.map((name) => ({
  botId: `bot_${name}`,
  botName: name,
  version: 1,
  team: name.startsWith("A") ? "red" : "blue",
}));
const roster = SHUFFLED.map((name, i) => ({ id: `veh_${i}`, name, team: name.startsWith("A") ? "red" : "blue" }));
const EXPECTED = "A-ATK-1, A-ATK-2, A-ATK-3, A-ATK-4 (rojo) vs B-DEF-1, B-DEF-2, B-DEF-3, B-DEF-4 (azul)";

describe("4v4 · el orden de la API no cambia lo que se enseña", () => {
  it("título del detalle y de la lista, resultado por bando y título del visor", () => {
    expect(sidesTitle(participants, botLabel)).toBe(EXPECTED);
    expect(sidesTitle([...participants].reverse(), botLabel)).toBe(EXPECTED);
    const sides = sideResults({ id: "b", status: "finished", participants, result: { winner: "red" } });
    expect(sides[1].bots).toEqual(["B-DEF-1 v1", "B-DEF-2 v1", "B-DEF-3 v1", "B-DEF-4 v1"]);
    expect(participantsTitle(roster)).toBe(EXPECTED);
    expect(participantsTitle([...roster].reverse())).toBe(EXPECTED);
    // Orden numérico: A-10 va después de A-9.
    expect(
      sidesTitle(
        ["A-10", "A-9", "B-1", "B-2"].map((n) => ({ botId: n, botName: n, team: n[0] === "A" ? "red" : "blue" })),
        botLabel,
      ),
    ).toBe("A-9, A-10 (rojo) vs B-1, B-2 (azul)");
  });

  it("la nómina del visor/replay sale ordenada por nombre dentro de cada bando", () => {
    render(<RosterList roster={rosterFromMeta(roster)} testId="r" />);
    const blue = within(screen.getByTestId("r")).getAllByTestId("roster-side")[1];
    expect(
      within(blue)
        .getAllByTestId("roster-vehicle")
        .map((v) => v.textContent?.replace(/^, /, "")),
    ).toEqual(["B-DEF-1", "B-DEF-2", "B-DEF-3", "B-DEF-4"]);
  });
});
