// @vitest-environment jsdom
/**
 * EQ3 · Centro de Ayuda en la web (#/help/...). Cada bloque se pone ROJO sin su fix:
 *  - TODAS las hojas se pintan sin sesión y sin pedir nada fuera del mismo origen
 *    (fetch interceptado: cualquier URL absoluta externa es un fallo);
 *  - con la API caída la ayuda se lee entera (sólo la tabla de rulesets lo dice);
 *  - el contenido sale de las fuentes: catálogo, rulesets, modos, esquema de mapas,
 *    SDK; nombres humanos; estado vacío del ranking del encargo;
 *  - alias #/ayuda y #/docs con subruta; ruta desconocida avisa y no rompe;
 *  - índice con aria-current, buscador, foco al título al cambiar de hoja;
 *  - ⓘ dentro de la ayuda funciona (abre/cierra) sin perder el buscador.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "../src/App.js";
import { HelpPage } from "../src/pages/HelpPage.js";
import { HELP_TREE, helpHref, parseHelpHash } from "../src/help/tree.js";
import { CATALOG, VERSIONS } from "../src/help/sources.js";
import { RULESETS } from "../../../packages/game-rules/index.js";
import { RANKING_EMPTY_LINES } from "../src/help/sections/tournaments.js";

function jsonRes(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (h: string) => (h.toLowerCase() === "content-type" && body !== undefined ? "application/json" : null),
    },
    json: async () => body,
  };
}

let requested: string[] = [];
function installFetch(rulesets: "ok" | "down") {
  requested = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      requested.push(u);
      if (/^https?:\/\//.test(u) && !u.startsWith(window.location.origin)) throw new Error(`petición EXTERNA: ${u}`);
      if (u.includes("/rulesets")) {
        if (rulesets === "down") throw new TypeError("Failed to fetch");
        return jsonRes(200, {
          modes: ["deathmatch", "team_deathmatch", "capture_the_flag", "zone_control"],
          items: [
            {
              id: "mvp-default",
              name: "Ruleset MVP por defecto",
              mode: null,
              engineRulesetId: null,
              budgetCredits: 1000,
            },
            {
              id: "zone-control-mvp",
              name: "Control de zona (MVP)",
              mode: "zone_control",
              engineRulesetId: "zc_mvp@1",
              budgetCredits: 1000,
            },
          ],
        });
      }
      if (u.includes("/auth/refresh")) return jsonRes(401, { message: "sin sesión" });
      return jsonRes(404, { message: "no" });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

/** Referencias internas que no deben verse: «E5/T5.1», «(D8)», «cap. 12.2», «T3.4», «combat.ts:198»… */
const INTERNAL_REF = /\bE\d{1,2}\b|\bT\d+\.\d+|\bD\d{1,2}\b|\bcap\.\s?\d|\bERR-[A-Z]+|\bTD-\d+|\b[\w-]+\.ts:\d+/g;

/** Texto visible SIN código (los ejemplos y los ids se enseñan tal cual a propósito). */
function proseOf(root: Element): string {
  const out: string[] = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest("pre, code") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walk.nextNode(); n; n = walk.nextNode()) out.push(n.textContent ?? "");
  return out.join(" ");
}

async function show(hash: string) {
  window.location.hash = hash;
  const r = render(<HelpPage loggedIn={false} />);
  await screen.findByTestId("help-page");
  return r;
}

describe("EQ3 Centro de Ayuda · offline y sin GitHub", () => {
  it("TODAS las hojas se pintan sin sesión, con título, y sin una sola petición externa", async () => {
    installFetch("ok");
    for (const g of HELP_TREE) {
      for (const l of g.leaves) {
        cleanup();
        await show(helpHref(g.id, l.id));
        const art = screen.getByTestId("help-article");
        expect(within(art).getByRole("heading", { level: 3 }).textContent).toBe(l.title);
        expect(screen.getByTestId("help-page").getAttribute("data-help-section")).toBe(`${g.id}/${l.id}`);
        expect(art.textContent!.length, `${g.id}/${l.id} sin contenido`).toBeGreaterThan(80);
        // EQ6-P3 · sin referencias internas del proyecto en el texto visible (fuera de código).
        const prose = proseOf(art);
        expect(prose.match(INTERNAL_REF) ?? [], `${g.id}/${l.id}: referencias internas`).toEqual([]);
      }
    }
    expect(requested.filter((u) => /^https?:\/\//.test(u) && !u.startsWith(window.location.origin))).toEqual([]);
    // Sólo se consulta la API propia, y sólo /rulesets.
    expect(requested.every((u) => u.includes("/api/v1/rulesets"))).toBe(true);
  });

  it("con la API caída la hoja de un modo se lee entera y sólo la tabla de rulesets avisa", async () => {
    installFetch("down");
    await show("#/help/modos/zone_control");
    expect(await screen.findByTestId("help-platform-rulesets-unavailable")).toBeTruthy();
    expect(screen.getByTestId("help-zone-control-rules").querySelectorAll("li").length).toBe(6);
    expect(screen.getByTestId("help-mode-rulesets-zone_control")).toBeTruthy();
  });

  it("con la API viva enseña los rulesets REALES de la instalación (GET /rulesets)", async () => {
    installFetch("ok");
    await show("#/help/modos/zone_control");
    const t = await screen.findByTestId("help-platform-rulesets");
    expect(t.textContent).toContain("Control de zona (MVP)");
    expect(t.textContent).toContain("zc_mvp@1");
    expect(t.textContent).toContain("las por defecto del modo elegido");
  });

  it("los enlaces externos de la portada son opcionales (código fuente), en otra pestaña", async () => {
    installFetch("ok");
    await show("#/help");
    const docs = screen.getByTestId("help-docs");
    for (const a of docs.querySelectorAll("a")) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toContain("noopener");
    }
    expect(screen.getByText(/funciona sin conexión/)).toBeTruthy();
    // Fuera de esa sección, ningún enlace sale del sitio.
    const outside = [...screen.getByTestId("help-page").querySelectorAll("a")].filter(
      (a) => !docs.contains(a) && /^https?:/.test(a.getAttribute("href") ?? ""),
    );
    expect(outside).toEqual([]);
  });
});

describe("EQ3 Centro de Ayuda · contenido desde las fuentes de verdad", () => {
  it("Equipamiento → Chasis: cada chasis del catálogo con sus ranuras en nombre humano", async () => {
    installFetch("ok");
    await show("#/help/equipamiento/chassis");
    for (const m of CATALOG.filter((x) => x.category === "chassis")) {
      const card = screen.getByTestId(`help-module-${m.id}@${m.version}`);
      expect(card.textContent).toContain(m.name);
      expect(card.textContent).toContain(`${m.hullHp} PV`);
    }
    const slots = screen.getByTestId("help-slots-chassis.medium@2");
    expect(slots.textContent).toContain("Torreta principal");
    expect(slots.textContent).toContain("turret_main");
    expect(slots.textContent).toContain("Compartimento de minas");
    expect(slots.textContent).toContain("Blindaje trasero");
    expect(slots.textContent).toContain("Propulsión");
  });

  it("Armas: «Efecto real» dice la verdad del motor (rangeM no se usa)", async () => {
    installFetch("ok");
    await show("#/help/equipamiento/weapon");
    const cannon = screen.getByTestId("help-module-weapon.cannon@1");
    expect(cannon.textContent).toMatch(/Alcance.*60 m.*Aún sin efecto en la batalla/s);
    expect(cannon.textContent).toMatch(/Daño.*45.*Cambia la batalla/s);
  });

  it("Referencia → Catálogo: una fila por definición del catálogo", async () => {
    installFetch("ok");
    await show("#/help/referencia/catalogo");
    expect(screen.getByTestId("help-catalog-table").querySelectorAll("tbody tr").length).toBe(CATALOG.length);
  });

  it("Referencia → Reglas: una fila por ruleset del motor con su duración y respawn", async () => {
    installFetch("ok");
    await show("#/help/referencia/reglas");
    for (const id of Object.keys(RULESETS)) expect(screen.getByTestId(`help-ruleset-${id}`)).toBeTruthy();
    expect(screen.getByTestId("help-ruleset-dm_practice@1").textContent).toContain("sin reaparición");
    expect(screen.getByTestId("help-ruleset-zc_mvp@1").textContent).toMatch(/5 min \(9000 ticks\)/);
  });

  it("SDK Python/JS: versión real, ejemplo copiable y sin aviso de desajuste", async () => {
    installFetch("ok");
    await show("#/help/bots/sdk-python");
    expect(screen.getByTestId("help-sdk-version").textContent).toContain(VERSIONS.sdkPython);
    expect(screen.queryByTestId("help-sdk-mismatch")).toBeNull();
    expect(screen.getByTestId("help-code-py-tutorial").textContent).toContain("class TutorialBot(ArenaBot)");
    expect(screen.getByRole("button", { name: /Copiar código: Bot tutorial \(Python\)/ })).toBeTruthy();
    cleanup();
    await show("#/help/bots/sdk-javascript");
    expect(screen.getByTestId("help-sdk-version").textContent).toContain(VERSIONS.sdkJs);
    expect(screen.getByTestId("help-code-js-tutorial").textContent).toContain("extends ArenaBot");
  });

  it("copiar: usa el portapapeles y lo anuncia; sin portapapeles lo dice", async () => {
    installFetch("ok");
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await show("#/help/bots/sdk-python");
    fireEvent.click(screen.getByRole("button", { name: /Copiar código: Bot tutorial \(Python\)/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(String((writeText.mock.calls[0] as unknown[])[0])).toContain("class TutorialBot");
    expect(await screen.findByText("Copiado.")).toBeTruthy();
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  });

  it("Comandos/Observaciones: tabla generada desde el esquema del protocolo", async () => {
    installFetch("ok");
    await show("#/help/bots/comandos");
    const t = screen.getByTestId("help-schema-command");
    for (const f of [
      "forTick",
      "move.throttle",
      "move.steer",
      "turret.targetPoint",
      "fire",
      "deployMine.slot",
      "radio[].data",
    ])
      expect(t.textContent).toContain(f);
    cleanup();
    await show("#/help/bots/observaciones");
    expect(screen.getByTestId("help-schema-observation").textContent).toContain("sensors.radar[].contacts[].position");
  });

  it("Control de zona: semántica exacta y diferencia con Dominación", async () => {
    installFetch("ok");
    await show("#/help/modos/zone_control");
    const rules = screen.getByTestId("help-zone-control-rules").textContent!;
    expect(rules).toMatch(/UN único bando.*controla y puntúa/);
    expect(rules).toMatch(/disputada: no puntúa nadie/);
    expect(rules).toMatch(/vacía, no puntúa nadie/);
    expect(screen.getByTestId("help-zc-vs-domination").textContent).toMatch(/Dominación.*aunque la abandones/);
  });

  it("Ranking: Elo 1000, sólo torneo, V-D-E, por modo, y el texto exacto del estado vacío", async () => {
    installFetch("ok");
    await show("#/help/torneos/ranking");
    const facts = screen.getByTestId("help-ranking-facts").textContent!;
    expect(facts).toMatch(/Elo/);
    expect(facts).toMatch(/1000/);
    expect(facts).toMatch(/Sólo las batallas oficiales de torneo/);
    expect(facts).toMatch(/Victorias - Derrotas - Empates/);
    expect(facts).toMatch(/ranking independiente/);
    expect(facts).toMatch(/por enfrentamientos \(no por batallas\) y sumados en todos los torneos de la temporada/);
    expect(facts).toMatch(/Para el rating, una descalificación cuenta como derrota/);
    expect(RANKING_EMPTY_LINES).toEqual([
      "Todavía no hay clasificación oficial para este modo.",
      "La clasificación sólo incluye batallas oficiales de torneo.",
      "Las batallas creadas mediante «Nueva batalla» no modifican el rating.",
      "Inscribirse en un torneo no te hace aparecer: hace falta disputar al menos un enfrentamiento oficial.",
    ]);
    const empty = screen.getByTestId("ranking-empty-help");
    for (const l of RANKING_EMPTY_LINES) expect(empty.textContent).toContain(l);
  });

  it("Desempates: registro de modos (clásicos) y los oficiales de docs/user/rules.json (EQ2, motor 0.4.0)", async () => {
    installFetch("ok");
    await show("#/help/batallas/desempates");
    expect(screen.getByTestId("help-tiebreak-modes").textContent).toMatch(/Control de zona.*más puntos.*empate/);
    expect(screen.queryByTestId("help-pending-tiebreaks")).toBeNull();
    const steps = (fam: string) =>
      [...screen.getByTestId(`help-tiebreak-${fam}`).querySelectorAll("li")].map((l) => l.textContent);
    expect(steps("elimination")).toEqual([
      "más bots vivos",
      "más vidas/reapariciones restantes",
      "más bajas",
      "empate",
    ]);
    expect(steps("limited_respawn")).toEqual([
      "más puntos",
      "más bots vivos",
      "más reapariciones restantes",
      "más bajas",
      "empate",
    ]);
    expect(steps("deathmatch")).toEqual(["más puntos", "más bajas", "empate"]);
    expect(steps("capture_the_flag").join(" ")).toMatch(/siguiente captura gana/);
    expect(steps("capture_the_flag").join(" ")).not.toMatch(/3 min/);
    const tl = screen.getByTestId("help-technical-limit-note").textContent ?? "";
    expect(tl).toMatch(/Detenida por límite técnico.*no es un empate/);
    expect(tl).toMatch(/SIN resultado deportivo/);
  });

  it("CTF: prórroga sin tope y salvaguarda técnica sin resultado deportivo; respawn limitado ya no pendiente", async () => {
    installFetch("ok");
    await show("#/help/modos/capture_the_flag");
    const ot = screen.getByTestId("help-ctf-overtime").textContent ?? "";
    expect(ot).toMatch(/siguiente captura gana/);
    expect(ot).toMatch(/no tiene límite de tiempo competitivo/);
    expect(screen.getByTestId("help-technical-limit").textContent).toMatch(
      /sin resultado deportivo|SIN resultado deportivo/,
    );
    expect(screen.getByTestId("help-preset-ctf").textContent).toContain("ctf@1");
    cleanup();
    await show("#/help/modos/respawn-limitado");
    expect(screen.queryByTestId("help-pending-limited-respawn")).toBeNull();
    expect(screen.getByTestId("help-max-respawns").textContent).toMatch(/maxRespawns/);
  });

  it("Mapas: la paleta es la del editor real", async () => {
    installFetch("ok");
    await show("#/help/mapas/editor");
    const pal = screen.getByTestId("help-map-palette");
    for (const t of ["Muro", "Caja", "Zona de daño", "Zona de captura", "Base roja", "Bandera azul"])
      expect(pal.textContent).toContain(t);
  });
});

describe("EQ3 API estable para EQ4 (ModeHelpTip)", () => {
  it("ModeHelpTip: un ⓘ por modo, enlace a su hoja y nombre accesible SIN la palabra «modo» (los specs usan getByLabel('modo'))", async () => {
    const { ModeHelpTip, modeHelpHref } = await import("../src/help/sections/rules.js");
    const { parseHelpHash } = await import("../src/help/tree.js");
    const { MODES } = await import("../src/help/sources.js");
    for (const m of Object.keys(MODES)) {
      cleanup();
      render(<ModeHelpTip mode={m} />);
      const btn = screen.getByTestId(`tip-mode-${m}-trigger`);
      expect(btn.getAttribute("aria-label")).not.toMatch(/modo/i);
      fireEvent.click(btn);
      const href = screen.getByRole("link", { name: "Más en el Centro de Ayuda" }).getAttribute("href")!;
      expect(href).toBe(modeHelpHref(m));
      expect(parseHelpHash(href).notFound, `${m} enlaza a una hoja que existe`).toBe(false);
    }
    // Y ningún ⓘ de la propia ayuda usa «modo» en su nombre accesible.
    installFetch("ok");
    cleanup();
    await show("#/help/batallas/nueva");
    for (const b of document.querySelectorAll(".infotip-trigger"))
      expect(b.getAttribute("aria-label")).not.toMatch(/modo/i);
  });
});

describe("EQ3 Centro de Ayuda · texto público", () => {
  it("publicText quita las referencias internas sin romper la frase", async () => {
    const { publicText } = await import("../src/help/blocks.js");
    expect(publicText("El motor acepta como máximo un COMMAND por ciclo (E5/T5.1); los siguientes se descartan.")).toBe(
      "El motor acepta como máximo un COMMAND por ciclo; los siguientes se descartan.",
    );
    expect(publicText("Ajuste de balance T3.4: más casco.")).toBe("Ajuste de balance: más casco.");
    expect(publicText("Encender o apagar módulos (estado offline, cap. 12.2). Reactivar")).toBe(
      "Encender o apagar módulos (estado offline). Reactivar",
    );
    expect(publicText("Límites iguales al techo de D8: no hay margen")).toBe("Límites iguales al techo: no hay margen");
    expect(publicText("El alcance real lo fija un TTL de 90 ticks (combat.ts:198), no rangeM.")).toBe(
      "El alcance real lo fija un TTL de 90 ticks, no rangeM.",
    );
    expect(publicText("Versiones exactas (cap. 8, 'versión fija').")).toBe("Versiones exactas ('versión fija').");
    expect(publicText("Pruebas E2E del radar")).toBe("Pruebas E2E del radar");
  });
});

describe("EQ3 Centro de Ayuda · navegación, accesibilidad y alias", () => {
  it("parseHelpHash: alias, grupo sin hoja y ruta desconocida", () => {
    expect(parseHelpHash("#/ayuda/modos/zone_control").leaf.id).toBe("zone_control");
    expect(parseHelpHash("#/docs/bots").leaf.id).toBe("conceptos");
    expect(parseHelpHash("#/help").group.id).toBe("inicio");
    expect(parseHelpHash("#/help/nada").notFound).toBe(true);
    expect(parseHelpHash("#/help/modos/nada")).toMatchObject({ notFound: true, group: { id: "modos" } });
  });

  it("App enruta #/ayuda/<grupo>/<hoja> a la ayuda (sin sesión)", async () => {
    installFetch("ok");
    window.location.hash = "#/ayuda/torneos/ranking";
    render(<App />);
    const page = await screen.findByTestId("help-page");
    expect(page.getAttribute("data-help-section")).toBe("torneos/ranking");
    expect(screen.getByRole("navigation", { name: "principal" })).toBeTruthy();
  });

  it("ruta desconocida: aviso y contenido, no 404", async () => {
    installFetch("ok");
    await show("#/help/no-existe");
    expect(screen.getByTestId("help-not-found")).toBeTruthy();
    expect(screen.getByTestId("help-journey")).toBeTruthy();
  });

  it("índice: aria-current en la hoja actual; al cambiar de hoja el foco va a su título", async () => {
    installFetch("ok");
    await show("#/help/modos/deathmatch");
    const nav = screen.getByRole("navigation", { name: "Índice de la ayuda" });
    expect(within(nav).getByTestId("help-nav-modos-deathmatch").getAttribute("aria-current")).toBe("page");
    await act(async () => {
      window.location.hash = "#/help/modos/zone_control";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(within(nav).getByTestId("help-nav-modos-zone_control").getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByTestId("help-nav-modos-deathmatch").getAttribute("aria-current")).toBeNull();
    expect(document.activeElement?.id).toBe("help-leaf-title");
    expect(document.activeElement?.textContent).toBe("Control de zona");
  });

  it("índice plegable en móvil: botón con aria-expanded", async () => {
    installFetch("ok");
    await show("#/help");
    // En escritorio (jsdom no tiene media queries de móvil) el botón está oculto por CSS: hidden: true.
    const btn = screen.getByText("Índice de la ayuda", { selector: "button" });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("help-index").getAttribute("data-open")).toBe("true");
  });

  it("buscador: sin tildes ni mayúsculas, resultados con enlace", async () => {
    installFetch("ok");
    await show("#/help");
    fireEvent.change(screen.getByLabelText("Buscar en la ayuda"), { target: { value: "ZONA" } });
    const res = screen.getByTestId("help-search-results");
    expect(
      within(res)
        .getByRole("link", { name: /Control de zona/ })
        .getAttribute("href"),
    ).toBe("#/help/modos/zone_control");
    fireEvent.change(screen.getByLabelText("Buscar en la ayuda"), { target: { value: "energia" } });
    expect(screen.getByTestId("help-search-results").textContent).toMatch(/Energía/);
    fireEvent.change(screen.getByLabelText("Buscar en la ayuda"), { target: { value: "xyzzy" } });
    expect(screen.getByTestId("help-search-count").textContent).toBe("Sin resultados.");
  });

  it("un ⓘ dentro de la ayuda abre y cierra con Escape sin borrar lo escrito en el buscador", async () => {
    installFetch("ok");
    await show("#/help/torneos/ranking");
    fireEvent.change(screen.getByLabelText("Buscar en la ayuda"), { target: { value: "elo" } });
    fireEvent.click(screen.getByTestId("tip-vde-trigger"));
    const dlg = screen.getByRole("dialog", { name: "V-D-E" });
    // EQ2 · política official_played_not_reverted: V-D-E cuenta ENFRENTAMIENTOS oficiales disputados; el bye no suma.
    expect(dlg.textContent).toMatch(/enfrentamientos OFICIALES disputados de los torneos de la temporada/);
    expect(dlg.textContent).toMatch(/bye\) no suma en esta clasificación/);
    expect(dlg.textContent).not.toMatch(/descalificación/);
    expect(dlg.textContent).not.toMatch(/batallas oficiales/);
    fireEvent.keyDown(dlg, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((screen.getByLabelText("Buscar en la ayuda") as HTMLInputElement).value).toBe("elo");
  });
});
