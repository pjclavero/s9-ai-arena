// @vitest-environment jsdom
/**
 * UX-MOBILE · bloque D fuera del visor y del editor. Cada bloque se pone ROJO sin su cambio:
 *  - index.html: `.page-wide` anula el max-width de <main> (acordado con UX-VIEW);
 *    barra plegable ≤1024 px; tablas `stack-table` apiladas ≤720 px; 44 px táctiles;
 *  - ShellNav: botón «Menú» con aria-expanded/aria-controls, Escape devuelve el
 *    foco, cambiar de pantalla y pulsar fuera cierran; usuario y «Salir» dentro;
 *  - stack-table: cada celda recibe la etiqueta de su columna (colSpan incluido)
 *    sin pisar la escrita a mano, y las filas montadas después también;
 *  - las páginas de tablas usan la clase y conservan los data-testid de fila.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { setToken, onSessionExpired, SESSION_HINT_KEY } from "../src/api.js";
import { App } from "../src/App.js";
import { applyStackLabels, labelStackTable, observeStackTables } from "../src/ui/stack-table.js";
import { ReplaysPage } from "../src/pages/ReplaysPage.js";

const WEB = join(process.cwd(), "apps", "web");
const INDEX_HTML = readFileSync(join(WEB, "index.html"), "utf8");

/** Reglas CSS de index.html parseadas por el CSSOM (no por texto). */
function cssRules(): { media: string | null; rule: CSSStyleRule }[] {
  const doc = new DOMParser().parseFromString(INDEX_HTML, "text/html");
  const style = doc.querySelector("style")!;
  const host = document.createElement("style");
  host.textContent = style.textContent;
  document.head.appendChild(host);
  const out: { media: string | null; rule: CSSStyleRule }[] = [];
  const walk = (rules: CSSRuleList, media: string | null) => {
    for (const r of Array.from(rules)) {
      if (r instanceof CSSMediaRule) walk(r.cssRules, r.media.mediaText);
      else if (r instanceof CSSStyleRule) out.push({ media, rule: r });
    }
  };
  walk(host.sheet!.cssRules, null);
  host.remove();
  return out;
}
function find(selector: string, media: string | null) {
  return cssRules().filter(
    (x) =>
      x.media?.replace(/\s+/g, "") === media?.replace(/\s+/g, "") &&
      x.rule.selectorText
        .split(",")
        .map((s) => s.trim())
        .includes(selector),
  );
}

describe("UX-MOBILE · CSS global (index.html)", () => {
  it(".page-wide anula el max-width de main (clase en main o en un descendiente)", () => {
    for (const sel of ["main.page-wide", "main:has(.page-wide)"]) {
      const r = find(sel, null);
      expect(r.length, sel).toBe(1);
      expect(r[0].rule.style.maxWidth).toBe("none");
    }
    // y main sigue limitado a 960 px por defecto
    expect(find("main", null).some((x) => x.rule.style.maxWidth === "960px")).toBe(true);
  });

  it("barra: en escritorio sin botón ni cajas; ≤1024 px menú plegado salvo data-open", () => {
    expect(find(".shell-nav .nav-toggle", null)[0].rule.style.display).toBe("none");
    expect(find(".shell-nav .nav-menu", null)[0].rule.style.display).toBe("contents");
    const m = "(max-width: 1024px)";
    expect(find(".shell-nav .nav-menu", m)[0].rule.style.display).toBe("none");
    expect(find('.shell-nav[data-open="true"] .nav-menu', m)[0].rule.style.display).toBe("grid");
    expect(find(".shell-nav .nav-toggle", m)[0].rule.style.minHeight).toBe("44px");
    expect(find(".shell-nav .nav-menu a", m)[0].rule.style.minHeight).toBe("44px");
    expect(find("button", m)[0].rule.style.minHeight).toBe("44px");
  });

  it("≤720 px: stack-table apila filas como tarjetas con la etiqueta de columna", () => {
    const m = "(max-width: 720px)";
    expect(find("table.stack-table tr", m)[0].rule.style.display).toBe("block");
    expect(find("table.stack-table thead", m)[0].rule.style.position).toBe("absolute");
    const before = find("table.stack-table td[data-label]::before", m);
    expect(before.length).toBe(1);
    expect(before[0].rule.style.getPropertyValue("content")).toMatch(/attr\(data-label\)/);
  });
});

describe("UX-MOBILE · etiquetas de stack-table", () => {
  function table(html: string): HTMLTableElement {
    const d = document.createElement("div");
    d.innerHTML = html;
    document.body.appendChild(d);
    return d.querySelector("table")!;
  }
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("cada celda recibe el encabezado de su columna, respetando colSpan", () => {
    const t =
      table(`<table class="stack-table"><thead><tr><th>Bot</th><th colspan="2">Daño</th><th>Ver</th></tr></thead>
      <tbody><tr data-testid="r"><td>a</td><td>1</td><td>2</td><td>x</td></tr>
      <tr><td colspan="3">largo</td><td>y</td></tr></tbody></table>`);
    labelStackTable(t);
    const [r1, r2] = Array.from(t.tBodies[0].rows);
    expect(Array.from(r1.cells).map((c) => c.getAttribute("data-label"))).toEqual(["Bot", "Daño", "Daño", "Ver"]);
    expect(Array.from(r2.cells).map((c) => c.getAttribute("data-label"))).toEqual(["Bot", "Ver"]);
    expect(r1.getAttribute("data-testid")).toBe("r");
  });

  it("no pisa un data-label escrito a mano; sin thead no pone etiquetas; sin la clase no toca nada", () => {
    const t = table(`<table class="stack-table"><thead><tr><th>A</th><th>B</th></tr></thead>
      <tbody><tr><td data-label="Propio">1</td><td>2</td></tr></tbody></table>`);
    labelStackTable(t);
    expect(t.rows[1].cells[0].getAttribute("data-label")).toBe("Propio");
    expect(t.rows[1].cells[1].getAttribute("data-label")).toBe("B");
    const k = table(`<table class="stack-table"><tbody><tr><td>k</td><td>v</td></tr></tbody></table>`);
    labelStackTable(k);
    expect(k.rows[0].cells[0].hasAttribute("data-label")).toBe(false);
    document.body.innerHTML = "";
    const plain = table(`<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>`);
    applyStackLabels(document.body);
    expect(plain.rows[1].cells[0].hasAttribute("data-label")).toBe(false);
  });

  it("observeStackTables etiqueta filas y tablas montadas después", async () => {
    const stop = observeStackTables(document.body);
    const t = table(`<table class="stack-table"><thead><tr><th>Mapa</th></tr></thead><tbody></tbody></table>`);
    const tr = document.createElement("tr");
    tr.innerHTML = "<td>arena</td>";
    t.tBodies[0].appendChild(tr);
    await waitFor(() => expect(tr.cells[0].getAttribute("data-label")).toBe("Mapa"));
    stop();
  });
});

describe("UX-MOBILE · páginas de tablas", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  it("#/replays: tabla apilable con las filas replay-row y sus etiquetas", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              items: [
                {
                  battleId: "btl_a",
                  ticks: 300,
                  winner: "red",
                  official: false,
                  createdAt: "2026-07-19T00:00:00.000Z",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      ) as unknown as typeof fetch,
    );
    const { container } = render(<ReplaysPage />);
    const rows = await screen.findAllByTestId("replay-row");
    const t = rows[0].closest("table")!;
    expect(t.classList.contains("stack-table")).toBe(true);
    applyStackLabels(container);
    expect(within(rows[0]).getByTestId("replay-open").closest("td")!.getAttribute("data-label")).toBe("Ver");
  });

  it("las páginas del encargo marcan sus tablas como stack-table", () => {
    const pages = ["Battles", "Replays", "Ranking", "Bots", "Teams", "Admin", "Maps", "BattleDetail"];
    for (const p of pages) {
      const src = readFileSync(join(WEB, "src", "pages", `${p}Page.tsx`), "utf8");
      const tables = src.match(/<table\b[^>]*>/g) ?? [];
      expect(tables.length, p).toBeGreaterThan(0);
      for (const t of tables) expect(t, `${p}: ${t}`).toMatch(/className="stack-table"/);
    }
  });
});

// ── barra plegable ───────────────────────────────────────────────────────────
const ME = {
  id: "u1",
  displayName: "Ana Larga De Apellidos",
  email: "a@a.es",
  roles: ["user"],
  twoFactorEnabled: false,
};
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
function installFetch(routes: Record<string, () => ReturnType<typeof jsonRes>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const key = `${(init?.method ?? "GET").toUpperCase()} ${String(url).replace(/^.*\/api\/v1/, "")}`;
      for (const [k, fn] of Object.entries(routes)) if (key.startsWith(k)) return fn();
      return jsonRes(404, { message: `sin ruta de prueba: ${key}` });
    }),
  );
}

describe("UX-MOBILE · barra de navegación plegable", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  beforeEach(() => {
    setToken(null);
    onSessionExpired(null);
    window.location.hash = "";
    window.localStorage.setItem(SESSION_HINT_KEY, "1"); // hay sesión que recuperar
    installFetch({
      "POST /auth/refresh": () => jsonRes(200, { accessToken: "tok" }),
      "GET /users/me": () => jsonRes(200, ME),
      "GET /catalog/versions": () => jsonRes(200, []),
      "GET /bots?ownerId=u1": () => jsonRes(200, { items: [] }),
      "GET /teams": () => jsonRes(200, { items: [] }),
      "GET /battles": () => jsonRes(200, { items: [] }),
      "GET /replays": () => jsonRes(200, { items: [] }),
    });
  });

  it("botón «Menú» con aria-expanded/aria-controls; usuario y Salir dentro del menú", async () => {
    render(<App />);
    await screen.findByTestId("first-steps");
    const nav = screen.getByRole("navigation", { name: "principal" });
    const toggle = within(nav).getByRole("button", { name: /Menú/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const menu = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(menu).toBe(within(nav).getByTestId("nav-menu"));
    expect(within(menu).getByTestId("logout").textContent).toBe("Salir");
    expect(within(menu).getByTestId("nav-user").textContent).toContain("Ana Larga De Apellidos");
    expect(within(menu).getByRole("link", { name: "Batallas" })).toBeTruthy();
    expect(nav.getAttribute("data-open")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(nav.getAttribute("data-open")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("Escape cierra y devuelve el foco al botón; pulsar fuera y cambiar de pantalla cierran", async () => {
    render(<App />);
    await screen.findByTestId("first-steps");
    const nav = screen.getByRole("navigation", { name: "principal" });
    const toggle = within(nav).getByTestId("nav-toggle");
    fireEvent.click(toggle);
    within(nav).getByRole("link", { name: "Replays" }).focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);

    fireEvent.click(toggle);
    fireEvent.pointerDown(document.querySelector("main")!);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);
    await act(async () => {
      window.location.hash = "#/replays";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("false"));
  });
});
