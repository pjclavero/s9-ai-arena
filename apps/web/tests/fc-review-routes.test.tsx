// @vitest-environment jsdom
/**
 * REVIEW (cierre funcional, R4.7) · la 404 de D (STATIC_PANEL_ROUTES) no rompe las
 * rutas de A (`#/bots/<id>`, detalle del bot) ni de C (`#/maps/editor?map=&v=`).
 */
import { describe, expect, it } from "vitest";
import { matchStaticPanelRoute } from "../src/App.js";
import { matchBotDetailRoute } from "../src/pages/BotsPage.js";

const BOT = "6f1c2a3b-0000-4000-8000-00000000abcd";

describe("rutas de A y C conviven con la 404 de D", () => {
  it("#/bots/<id> entra por el panel de bots y resuelve el detalle de ESE bot", () => {
    expect(matchStaticPanelRoute(`#/bots/${BOT}`)).toBe("bots");
    expect(matchBotDetailRoute(`#/bots/${BOT}`)).toBe(BOT);
    expect(matchBotDetailRoute("#/bots")).toBeNull();
  });

  it("#/maps/editor?map=<id>&v=<n> entra por el editor (no por la lista ni por la 404)", () => {
    expect(matchStaticPanelRoute("#/maps/editor?map=mi-mapa&v=3")).toBe("mapEditor");
    expect(matchStaticPanelRoute("#/maps/editor")).toBe("mapEditor");
    expect(matchStaticPanelRoute("#/maps?x=1")).toBe("maps");
  });

  it("control negativo: lo que no es de nadie sigue cayendo en la 404", () => {
    expect(matchStaticPanelRoute("#/botsx")).toBeNull();
    expect(matchStaticPanelRoute("#/maps/editorx")).toBeNull();
    expect(matchStaticPanelRoute("#/maps/otra-cosa")).toBeNull();
  });
});
