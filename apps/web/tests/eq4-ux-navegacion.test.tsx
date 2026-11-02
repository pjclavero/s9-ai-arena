// @vitest-environment jsdom
/**
 * EQ4 · UX, navegación y organización. Cada bloque se pone ROJO sin su cambio:
 *  - Administración: UNA entrada en la barra + subnavegación; lo que se oculta
 *    sale del RBAC del CONTRATO (apps/api/openapi.yaml, x-min-role) y de la misma
 *    jerarquía de roles del servidor (deriva = rojo);
 *  - «Bots y equipos» agrupa Mis bots y Equipos;
 *  - En directo: vacío ≠ sin permiso;
 *  - «Nueva batalla» (sin cambiar la semántica: sigue siendo no oficial);
 *  - nombres humanos de los slots (todos los del catálogo real);
 *  - ⓘ de Rating y V-D-E, de modos y del editor; Ancho/Largo en el editor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { setToken, onSessionExpired, SESSION_HINT_KEY } from "../src/api.js";
import { App, isNavActive } from "../src/App.js";
import { ADMIN_SECTIONS, ROLE_ORDER, roleRank, userRank, visibleAdminSections } from "../src/admin-nav.js";
import { ROLES } from "../../api/src/db/migrations.js";
import { LivePage, LIVE_EMPTY_TEXT, LIVE_PUBLIC_OFF_TEXT } from "../src/pages/LivePage.js";
import { SLOT_INFO, slotName } from "../src/slot-names.js";
import { RankingPage } from "../src/pages/RankingPage.js";
import { MODE_HELP, ModeHelp } from "../src/mode-help.js";
import { MODE_NAME } from "../src/battle-result.js";
import { ELEMENT_HELP, TOOLS } from "../src/map-editor/objects.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

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
type Routes = Record<string, () => ReturnType<typeof jsonRes>>;
let calls: string[] = [];
function installFetch(routes: Routes) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const key = `${(init?.method ?? "GET").toUpperCase()} ${String(url).replace(/^.*\/api\/v1/, "")}`;
      calls.push(key);
      for (const [k, fn] of Object.entries(routes)) if (key.startsWith(k)) return fn();
      return jsonRes(404, { message: `sin ruta de prueba: ${key}` });
    }),
  );
}
function session(roles: string[], extra: Routes = {}): Routes {
  return {
    ...extra,
    "POST /auth/refresh": () => jsonRes(200, { accessToken: "tok" }),
    "GET /users/me": () =>
      jsonRes(200, { id: "u1", displayName: "Ana", email: "a@a.es", roles, twoFactorEnabled: false }),
    "GET /catalog/versions": () => jsonRes(200, []),
    "GET /bots": () => jsonRes(200, { items: [] }),
    "GET /teams": () => jsonRes(200, { items: [] }),
    "GET /battles": () => jsonRes(200, { items: [] }),
    "GET /public/battles/live": () => jsonRes(200, { enabled: false, battles: [] }),
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  setToken(null);
  onSessionExpired(null);
  window.location.hash = "";
  window.localStorage.setItem(SESSION_HINT_KEY, "1");
});

describe("EQ4 · RBAC del apartado Administración = contrato del servidor", () => {
  const doc = parse(readFileSync(join(ROOT, "apps", "api", "openapi.yaml"), "utf8")) as {
    paths: Record<string, Record<string, { operationId?: string; "x-min-role"?: string }>>;
  };
  const minRoleOf = new Map<string, string>();
  for (const methods of Object.values(doc.paths))
    for (const op of Object.values(methods))
      if (op && typeof op === "object" && op.operationId) minRoleOf.set(op.operationId, op["x-min-role"] ?? "user");

  it("la jerarquía de roles de la web es la del servidor (ROLES)", () => {
    expect([...ROLE_ORDER]).toEqual([...ROLES]);
  });

  it("cada pantalla declara el máximo x-min-role de las operaciones que consume", () => {
    for (const s of ADMIN_SECTIONS) {
      expect(s.operations.length, s.href).toBeGreaterThan(0);
      for (const op of s.operations) expect(minRoleOf.has(op), `${s.href}: ${op} no existe en el contrato`).toBe(true);
      const max = Math.max(...s.operations.map((op) => roleRank(minRoleOf.get(op)!)));
      expect(roleRank(s.minRole), s.href).toBe(max);
    }
  });

  it("rango = máximo de los roles (como authenticate.ts); roles desconocidos no suben", () => {
    expect(userRank({ roles: ["user", "admin"] })).toBe(roleRank("admin"));
    expect(userRank({ roles: ["superadmin"] })).toBe(0);
    expect(visibleAdminSections({ roles: ["moderator"] })).toEqual([]);
    expect(visibleAdminSections({ roles: ["user", "admin"] }).map((s) => s.href)).toEqual([
      "#/admin",
      "#/system",
      "#/audit",
      "#/roles",
    ]);
  });

  it("«Administración» está activa en sus cuatro pantallas", () => {
    for (const r of ["#/admin", "#/system", "#/audit", "#/roles"]) expect(isNavActive("#/admin", r)).toBe(true);
    expect(isNavActive("#/admin", "#/bots")).toBe(false);
  });
});

describe("EQ4 · barra principal agrupada", () => {
  it("admin: UNA entrada «Administración» (sin Sistema/Auditoría/Roles sueltos) y subnavegación", async () => {
    installFetch(
      session(["user", "admin"], {
        "GET /admin/audit-log": () => jsonRes(200, []),
      }),
    );
    window.location.hash = "#/audit";
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "principal" });
    await waitFor(() => expect(within(nav).getByRole("link", { name: "Administración" })).toBeTruthy());
    expect(within(nav).getByRole("link", { name: "Administración" }).getAttribute("aria-current")).toBe("page");
    for (const n of ["Sistema", "Auditoría", "Roles", "Roles y permisos"])
      expect(within(nav).queryByRole("link", { name: n })).toBeNull();
    const sub = await screen.findByRole("navigation", { name: "Administración" });
    const links = within(sub).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual([
      "Usuarios y seguridad",
      "Sistema",
      "Auditoría",
      "Roles y permisos",
    ]);
    expect(within(sub).getByRole("link", { name: "Auditoría" }).getAttribute("aria-current")).toBe("page");
  });

  it("usuario normal: ni entrada ni subnavegación (el servidor sigue siendo quien deniega)", async () => {
    installFetch(session(["user"]));
    window.location.hash = "#/system";
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "principal" });
    await waitFor(() => expect(within(nav).getByRole("link", { name: "Mis bots" })).toBeTruthy());
    expect(within(nav).queryByRole("link", { name: "Administración" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Administración" })).toBeNull();
  });

  it("«Bots y equipos» agrupa Mis bots y Equipos", async () => {
    installFetch(session(["user"]));
    render(<App />);
    const group = await screen.findByRole("group", { name: "Bots y equipos" });
    expect(
      within(group)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual(["#/bots", "#/teams"]);
  });
});

describe("EQ4 · En directo: vacío ≠ sin permiso", () => {
  it("visitante y emisión pública apagada ⇒ el aviso de visitantes", async () => {
    installFetch({ "GET /public/battles/live": () => jsonRes(200, { enabled: false, battles: [] }) });
    render(<LivePage />);
    expect((await screen.findByTestId("live-disabled")).textContent).toContain(LIVE_PUBLIC_OFF_TEXT);
    expect(calls.some((c) => c.startsWith("GET /battles"))).toBe(false);
  });

  it("usuario sin batallas visibles ⇒ «No hay ninguna batalla en directo…», NO el aviso de permiso", async () => {
    setToken("tok");
    installFetch({
      "GET /public/battles/live": () => jsonRes(200, { enabled: false, battles: [] }),
      "GET /battles?status=running": () => jsonRes(200, { items: [] }),
    });
    render(<LivePage loggedIn />);
    expect((await screen.findByTestId("live-empty")).textContent).toBe(LIVE_EMPTY_TEXT);
    expect(screen.queryByTestId("live-disabled")).toBeNull();
  });

  it("usuario con una batalla propia en curso la ve aunque la emisión pública esté apagada", async () => {
    setToken("tok");
    installFetch({
      "GET /public/battles/live": () => jsonRes(200, { enabled: false, battles: [] }),
      "GET /battles?status=running": () =>
        jsonRes(200, { items: [{ id: "b-1", mode: "team_deathmatch", mapName: "Arena" }] }),
    });
    render(<LivePage loggedIn />);
    const list = await screen.findByTestId("live-battles");
    expect(list.querySelector("a")!.getAttribute("href")).toBe("#/viewer/b-1");
    expect(screen.getByTestId("live-public-off-note")).toBeTruthy();
  });
});

describe("EQ4 · nombres humanos de los slots", () => {
  it("todos los slots de los chasis del catálogo real tienen nombre explícito", () => {
    const dir = join(ROOT, "packages", "module-catalog", "data");
    const ids = new Set<string>();
    for (const f of readdirSync(dir).filter((n) => n.startsWith("chassis."))) {
      const c = JSON.parse(readFileSync(join(dir, f), "utf8")) as { slots?: { id: string }[] };
      for (const s of c.slots ?? []) ids.add(s.id);
    }
    expect(ids.size).toBeGreaterThan(5);
    for (const id of ids) expect(SLOT_INFO[id], `slot sin nombre: ${id}`).toBeTruthy();
  });

  it("los del encargo y un slot nuevo no muestran el id crudo", () => {
    expect(slotName("drive")).toBe("Propulsión");
    expect(slotName("mine_bay")).toBe("Compartimento de minas");
    expect(slotName("armor_rear")).toBe("Blindaje trasero");
    expect(slotName("turret_main")).toBe("Torreta principal");
    expect(slotName("sensor_c")).toBe("Sensor C");
  });
});

describe("EQ4 · ⓘ del ranking y de los modos", () => {
  it("Rating y V-D-E llevan ⓘ y las celdas conservan su etiqueta móvil limpia", async () => {
    installFetch({
      "GET /standings": () =>
        jsonRes(200, [{ rank: 1, botId: "b1", botName: "Tanque", rating: 1012, wins: 2, losses: 1, draws: 0 }]),
    });
    render(<RankingPage />);
    await screen.findByTestId("ranking-row");
    fireEvent.click(screen.getByRole("button", { name: "Ayuda: Rating" }));
    expect(screen.getByTestId("ranking-help-rating-panel").textContent).toMatch(/oficiales/);
    expect(screen.getByRole("button", { name: "Ayuda: V-D-E" })).toBeTruthy();
    const cells = screen.getByTestId("ranking-row").querySelectorAll("td");
    expect([...cells].map((c) => c.getAttribute("data-label"))).toEqual(["#", "Bot", "Rating", "V-D-E"]);
    expect(screen.getByRole("button", { name: "Ayuda: Tipos de partida" })).toBeTruthy();
  });

  it("todos los modos tienen explicación; Control de zona dice cuándo se puntúa", () => {
    for (const m of Object.keys(MODE_NAME)) expect(MODE_HELP[m], m).toBeTruthy();
    expect(MODE_HELP.zone_control).toMatch(/sin ningún rival/);
    // CI #209: «Ayuda: Modos de juego» casaba con getByLabel("modo") de los specs
    // (subcadena, sin mayúsculas) y rompía el golden. El ⓘ junto a un selector no
    // puede contener el nombre del selector.
    render(<ModeHelp modes={["deathmatch"]} />);
    const name = screen.getByRole("button", { name: /^Ayuda: / }).getAttribute("aria-label")!.toLowerCase();
    for (const l of ["modo", "mapa", "ruleset", "bot rojo", "bot azul", "chasis"]) expect(name).not.toContain(l);
  });
});

describe("EQ4 · editor de mapas: ayuda de elementos", () => {
  it("muro, caja, zona de daño, zona de captura, spawn, base y bandera tienen descripción", () => {
    expect(ELEMENT_HELP.map((e) => e.key)).toEqual([
      "wall",
      "destructible",
      "damage",
      "capture",
      "spawn",
      "base",
      "flag",
    ]);
    expect(ELEMENT_HELP[0].text).toMatch(/movimiento, la visión/);
    expect(ELEMENT_HELP[1].text).toMatch(/mientras existe/);
    expect(TOOLS.find((t) => t.tool === "crate")!.help).toMatch(/mientras existe/);
  });
});
