// @vitest-environment jsdom
/**
 * ELIG · H9/H14.9 · La UI distingue PUBLICADA de NO ELEGIBLE sin esconderla:
 * en el selector de nueva batalla la versión aparece DESHABILITADA con su motivo, la
 * versión por defecto es la más reciente ELEGIBLE, y la ficha del bot explica motivo
 * y acción sugerida.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../src/api.js", () => ({ api: vi.fn() }));
import { api } from "../src/api.js";
import { BattleNewPage, botEligibility } from "../src/pages/BattleNewPage.js";
import { VersionEligibilityNote } from "../src/version-eligibility.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const ME = { id: "u1", displayName: "Op", roles: ["user"] } as never;
afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

const NOT_ELIGIBLE = {
  eligible: false,
  reason: "loadout_no_longer_valid",
  category: "INVALID_AMMO",
  message:
    "Esta versión se conserva para el histórico, pero ya no puede utilizarse en nuevas batallas porque su loadout no cumple la validación actual: El módulo weapon.cannon@1 no admite ammo.standard@1.",
};
const ADEF = [
  { version: 1, state: "published", battleEligibility: NOT_ELIGIBLE },
  { version: 2, state: "published", battleEligibility: NOT_ELIGIBLE },
  { version: 3, state: "published", battleEligibility: { eligible: true, category: "VALID" } },
];

describe("botEligibility", () => {
  it("A-DEF: juega v3; v1/v2 publicadas pero bloqueadas con motivo", () => {
    const e = botEligibility({ id: "a", name: "A-DEF" }, ADEF);
    expect(e.eligible).toBe(true);
    expect(e.playable).toEqual([3]);
    expect(e.defaultVersion).toBe(3);
    expect(e.blocked.map((b) => b.version)).toEqual([2, 1]);
    expect(e.blocked[0].reason).toMatch(/Munición incompatible/);
  });

  it("sin ninguna versión elegible: no elegible, y se dice por qué y qué hacer", () => {
    const e = botEligibility({ id: "a", name: "A-DEF" }, ADEF.slice(0, 2));
    expect(e.eligible).toBe(false);
    expect(e.summary).toMatch(/v2, v1 publicada · no elegible/);
    expect(e.summary).toMatch(/Munición incompatible/);
    expect(e.summary).toMatch(/nueva versión/);
  });

  it("sin campo battleEligibility (API antigua) nada cambia: publicada = seleccionable", () => {
    const e = botEligibility({ id: "a", name: "x" }, [{ version: 1, state: "published" }]);
    expect(e).toMatchObject({ eligible: true, playable: [1], blocked: [] });
  });
});

describe("selector de nueva batalla", () => {
  it("muestra v1/v2 deshabilitadas con «Publicada · No elegible» y el motivo; v3 seleccionada", async () => {
    apiMock.mockImplementation((method: string, path: string) => {
      if (path === "/maps?limit=100")
        return Promise.resolve({
          items: [{ mapId: "m", version: 1, state: "published", supportedModes: ["deathmatch"] }],
        });
      if (path === "/bots?limit=100")
        return Promise.resolve({
          items: [
            { id: "adef", name: "A-DEF", ownerId: "u1", latestPublishedVersion: 3 },
            { id: "atk", name: "A-ATK", ownerId: "u1", latestPublishedVersion: 1 },
          ],
        });
      if (path === "/rulesets")
        return Promise.resolve({
          modes: ["deathmatch"],
          items: [{ id: "deathmatch-mvp", name: "DM", mode: "deathmatch", budgetCredits: 1000 }],
        });
      if (path === "/teams?limit=100") return Promise.resolve({ items: [] });
      if (path === "/bots/adef/versions") return Promise.resolve(ADEF);
      if (path === "/bots/atk/versions") return Promise.resolve([{ version: 1, state: "published" }]);
      return Promise.reject(new Error(`unexpected ${method} ${path}`));
    });
    render(<BattleNewPage me={ME} />);
    await screen.findByLabelText("bot rojo");
    await screen.findAllByRole("option", { name: /A-DEF \(v3\)/ });
    await userEvent.selectOptions(screen.getByLabelText("bot rojo"), "adef");
    const sel = (await screen.findByLabelText("versión rojo")) as HTMLSelectElement;
    expect(sel.value).toBe("3");
    const opts = Array.from(sel.options);
    const v2 = opts.find((o) => o.textContent?.startsWith("v2"))!;
    expect(v2.disabled).toBe(true);
    expect(v2.textContent).toMatch(/Publicada · No elegible — Munición incompatible con el arma principal/);
    expect(opts.find((o) => o.textContent?.startsWith("v1"))!.disabled).toBe(true);
    expect(opts.find((o) => o.textContent?.startsWith("v3"))!.disabled).toBe(false);
  });
});

describe("ficha del bot", () => {
  it("explica estado, motivo y acción sugerida", () => {
    render(<VersionEligibilityNote version={2} be={NOT_ELIGIBLE} suggestVersion={3} />);
    const note = screen.getByTestId("version-not-eligible-2");
    expect(note.textContent).toMatch(/Publicada · No elegible/);
    expect(note.textContent).toMatch(/Motivo: Munición incompatible con el arma principal/);
    expect(note.textContent).toMatch(/Acción sugerida: usa v3 o crea una nueva versión/);
    expect(note.textContent).toMatch(/histórico/);
  });

  it("una versión elegible no muestra nada", () => {
    const { container } = render(<VersionEligibilityNote version={3} be={{ eligible: true }} />);
    expect(container.textContent).toBe("");
  });
});
