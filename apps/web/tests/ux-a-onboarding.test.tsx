// @vitest-environment jsdom
/**
 * UX-A · onboarding y navegación. Cada bloque se pone ROJO sin su fix:
 *  - G-01: portada pública (qué es S9 + cómo empezar) y #/help con recorrido,
 *    glosario y documentación; #/docs y #/ayuda ya no son 404;
 *  - checklist de primeros pasos calculada con datos REALES de la API;
 *  - C-G10: la barra de navegación existe en las pantallas públicas;
 *  - C-G12: el registro sin nombre visible no muestra «displayName obligatorio»;
 *  - 404 sin sesión (antes: formulario de acceso para cualquier hash).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { setToken, onSessionExpired } from "../src/api.js";
import { App, isNavActive, matchPublicRoute, matchStaticPanelRoute } from "../src/App.js";
import { computeFirstSteps, type FirstStepsFacts } from "../src/pages/HomePage.js";
import { humanizeAuthError, validateAuthForm } from "../src/pages/LoginPage.js";
import { GLOSSARY, JOURNEY, REPO_URL } from "../src/help/content.js";

const ME = { id: "u1", displayName: "Ana", email: "a@a.es", roles: ["user"], twoFactorEnabled: false };

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
/** fetch falso por «MÉTODO /ruta» (prefijo); lo no previsto es un 404 visible. */
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
const anonymous: Routes = { "POST /auth/refresh": () => jsonRes(401, { message: "sin sesión" }) };
function loggedIn(extra: Routes = {}): Routes {
  return {
    ...extra,
    "POST /auth/refresh": () => jsonRes(200, { accessToken: "tok" }),
    "GET /users/me": () => jsonRes(200, ME),
    "GET /catalog/versions": () => jsonRes(200, []),
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
});

describe("UX-A · rutas de ayuda y portada", () => {
  it("#/help, #/ayuda y #/docs son la guía (antes: «Página no encontrada»)", () => {
    expect(matchPublicRoute("#/help")).toEqual({ kind: "help" });
    expect(matchPublicRoute("#/ayuda")).toEqual({ kind: "help" });
    expect(matchPublicRoute("#/docs")).toEqual({ kind: "help" });
    expect(matchPublicRoute("#/helpX")).toBeNull();
  });

  it("la raíz es «Inicio» y «Mis bots» es #/bots", () => {
    expect(matchStaticPanelRoute("")).toBe("home");
    expect(matchStaticPanelRoute("#/")).toBe("home");
    expect(matchStaticPanelRoute("#/bots")).toBe("bots");
    expect(isNavActive("#/", "")).toBe(true);
    expect(isNavActive("#/battles", "#/battles/new")).toBe(true);
    expect(isNavActive("#/bots", "#/battles")).toBe(false);
  });

  it("visitante sin sesión: la portada explica qué es S9 y cómo empezar, junto al acceso", async () => {
    installFetch(anonymous);
    render(<App />);
    const landing = await screen.findByTestId("landing");
    expect(landing.textContent).toMatch(/arena de programación/);
    expect(within(landing).getByTestId("landing-steps").querySelectorAll("li").length).toBeGreaterThanOrEqual(3);
    expect(within(landing).getByRole("link", { name: /guía/ }).getAttribute("href")).toBe("#/help");
    // El acceso sigue en la misma pantalla (los helpers E2E dependen de ello).
    expect(screen.getByText("Iniciar sesión")).toBeTruthy();
    expect(screen.getByLabelText("email")).toBeTruthy();
    // Y la barra ofrece lo público y la ayuda.
    const nav = screen.getByRole("navigation", { name: "principal" });
    expect(within(nav).getByRole("link", { name: "Ayuda" }).getAttribute("href")).toBe("#/help");
    expect(within(nav).queryByRole("button", { name: "Salir" })).toBeNull();
  });

  it("#/help sin sesión: recorrido completo, glosario y enlaces al repositorio público", async () => {
    installFetch(anonymous);
    window.location.hash = "#/help";
    render(<App />);
    const help = await screen.findByTestId("help-page");
    expect(within(help).getByTestId("help-journey").querySelectorAll("li")).toHaveLength(JOURNEY.length);
    const glossary = within(help).getByTestId("help-glossary");
    for (const t of [
      "Runtime",
      "Loadout",
      "Chasis y módulos",
      "Estados de una versión",
      "Artifact",
      "Ruleset",
      "Modo",
    ]) {
      expect(within(glossary).getByText(t)).toBeTruthy();
    }
    expect(glossary.textContent).toMatch(/draft.*validating.*validated.*rejected.*published/s);
    expect(glossary.textContent).toMatch(/bando/);
    expect(GLOSSARY.length).toBeGreaterThanOrEqual(10);
    const docs = within(help).getByTestId("help-docs").querySelectorAll("a");
    expect(docs.length).toBeGreaterThan(0);
    for (const a of docs) {
      expect(a.getAttribute("href")!.startsWith(REPO_URL)).toBe(true);
      expect(a.getAttribute("rel")).toContain("noopener");
    }
    // Sin sesión los enlaces del panel avisan de que piden cuenta.
    expect(within(help).getByRole("link", { name: /Ir a Mis bots \(requiere iniciar sesión\)/ })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "principal" })).toBeTruthy();
  });

  it("C-G10: Ranking y En directo tienen barra de navegación", async () => {
    installFetch({
      ...anonymous,
      "GET /standings": () => jsonRes(200, { items: [] }),
      "GET /battles/live": () => jsonRes(200, { items: [] }),
    });
    window.location.hash = "#/ranking";
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "principal" });
    expect(within(nav).getByRole("link", { name: "Ranking" }).getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByRole("link", { name: "Inicio" })).toBeTruthy();
  });

  it("sin sesión, un hash desconocido es un 404 con Inicio y Ayuda (no el login)", async () => {
    installFetch(anonymous);
    window.location.hash = "#/esto-no-existe";
    render(<App />);
    const nf = await screen.findByTestId("not-found");
    expect(within(nf).getByRole("link", { name: "Inicio" }).getAttribute("href")).toBe("#/");
    expect(within(nf).getByRole("link", { name: "Ayuda" }).getAttribute("href")).toBe("#/help");
    expect(within(nf).queryByRole("link", { name: "Mis bots" })).toBeNull();
    expect(screen.queryByLabelText("email")).toBeNull();
  });

  it("sin sesión, una pantalla del panel pide iniciar sesión y lo dice", async () => {
    installFetch(anonymous);
    window.location.hash = "#/bots";
    render(<App />);
    expect((await screen.findByTestId("login-required")).textContent).toMatch(/inicia sesión/);
    expect(screen.getByLabelText("email")).toBeTruthy();
  });
});

describe("UX-A · checklist de primeros pasos (estado real)", () => {
  const none: FirstStepsFacts = {
    bots: 0,
    botsWithLoadout: 0,
    botsWithCode: 0,
    botsValidated: 0,
    botsPublished: 0,
    inTeam: false,
    battles: 0,
  };
  const doneIds = (f: FirstStepsFacts) =>
    computeFirstSteps(f)
      .filter((s) => s.done)
      .map((s) => s.id);

  it("usuario recién registrado: sólo la cuenta; el siguiente paso es crear un bot", () => {
    expect(doneIds(none)).toEqual(["account"]);
  });
  it("publicar implica loadout, código y validación; dos publicados cierran «segundo bot»", () => {
    expect(doneIds({ ...none, bots: 1, botsPublished: 1 })).toEqual([
      "account",
      "bot",
      "loadout",
      "code",
      "validated",
      "published",
    ]);
    expect(doneIds({ ...none, bots: 2, botsPublished: 2 })).toContain("secondBot");
    expect(doneIds({ ...none, bots: 2, botsPublished: 1 })).not.toContain("secondBot");
    expect(doneIds({ ...none, bots: 1, botsWithLoadout: 1, botsWithCode: 1 })).not.toContain("validated");
  });

  it("la home lee bots, loadouts, versiones, equipos y batallas de la API y marca el siguiente paso", async () => {
    installFetch(
      loggedIn({
        "GET /bots?ownerId=u1": () =>
          jsonRes(200, { items: [{ id: "b1", name: "uno", latestPublishedVersion: null }] }),
        "GET /bots/b1/loadouts": () => jsonRes(200, [{ revision: 1 }]),
        "GET /bots/b1/versions": () => jsonRes(200, [{ version: 1, state: "rejected" }]),
        "GET /teams": () => jsonRes(200, { items: [{ isMember: false }] }),
        // Una batalla AJENA no cuenta como «tu primera batalla».
        "GET /battles": () => jsonRes(200, { items: [{ participants: [{ botId: "otro" }] }] }),
      }),
    );
    render(<App />);
    const list = await screen.findByTestId("first-steps");
    expect(within(list).getByTestId("first-step-bot").getAttribute("data-done")).toBe("true");
    expect(within(list).getByTestId("first-step-loadout").getAttribute("data-done")).toBe("true");
    expect(within(list).getByTestId("first-step-code").getAttribute("data-done")).toBe("true");
    expect(within(list).getByTestId("first-step-validated").getAttribute("data-done")).toBe("false");
    expect(within(list).getByTestId("first-step-battle").getAttribute("data-done")).toBe("false");
    expect(within(list).getByTestId("first-step-validated").getAttribute("aria-current")).toBe("step");
    expect(within(list).getByTestId("first-steps-next").textContent).toBe("Valida la versión");
    expect(within(list).getByTestId("first-steps-progress").textContent).toMatch(/^4 de 9 completados/);
    expect(calls).toContain("GET /bots/b1/versions");
  });

  it("si la API falla, la checklist lo dice y ofrece reintentar (no se inventa el estado)", async () => {
    installFetch(loggedIn({ "GET /teams": () => jsonRes(500, { message: "boom" }) }));
    render(<App />);
    const err = await screen.findByTestId("resource-error-tus-primeros-pasos");
    expect(err.textContent).toMatch(/No se pudo cargar tus primeros pasos/);
    expect(within(err).getByRole("button", { name: "Reintentar" })).toBeTruthy();
    expect(screen.queryByTestId("first-steps")).toBeNull();
  });

  it("con sesión la barra tiene Inicio, Ayuda y Salir", async () => {
    installFetch(
      loggedIn({
        "GET /bots?ownerId=u1": () => jsonRes(200, { items: [] }),
        "GET /teams": () => jsonRes(200, { items: [] }),
        "GET /battles": () => jsonRes(200, { items: [] }),
      }),
    );
    render(<App />);
    await screen.findByTestId("first-steps");
    const nav = screen.getByRole("navigation", { name: "principal" });
    expect(within(nav).getByRole("link", { name: "Inicio" }).getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByRole("link", { name: "Ayuda" }).getAttribute("href")).toBe("#/help");
    expect(within(nav).getByRole("button", { name: "Salir" })).toBeTruthy();
    expect(screen.getByTestId("first-steps-next").textContent).toBe("Crea tu primer bot");
  });
});

describe("UX-A · C-G12 registro sin «displayName obligatorio»", () => {
  it("validación local: nombre, email y contraseña con mensajes de pantalla", () => {
    const ok = { displayName: "Ana", email: "a@b.es", password: "x".repeat(12) };
    expect(validateAuthForm("register", ok)).toBeNull();
    expect(validateAuthForm("register", { ...ok, displayName: "   " })?.field).toBe("displayName");
    expect(validateAuthForm("register", { ...ok, email: "nope" })?.field).toBe("email");
    expect(validateAuthForm("register", { ...ok, password: "corta" })?.field).toBe("password");
    expect(validateAuthForm("login", { displayName: "", email: "a@b.es", password: "x" })).toBeNull();
    expect(humanizeAuthError("displayName obligatorio (máx. 48)")).not.toMatch(/displayName/);
    expect(humanizeAuthError("Ya existe una cuenta con ese email")).toBe("Ya existe una cuenta con ese email");
  });

  it("registrarse sin nombre visible no llama a la API, explica el campo y le da el foco", async () => {
    installFetch(anonymous);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Crear cuenta" }));
    fireEvent.change(screen.getByLabelText("email"), { target: { value: "nuevo@example.invalid" } });
    fireEvent.change(screen.getByLabelText("contraseña"), { target: { value: "una-clave-larga-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Registrarse y entrar" }));
    const err = await screen.findByTestId("login-error");
    expect(err.getAttribute("role")).toBe("alert");
    expect(err.textContent).toMatch(/nombre visible/);
    expect(err.textContent).not.toMatch(/displayName/);
    const name = screen.getByLabelText("nombre");
    expect(document.activeElement).toBe(name);
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(calls.some((c) => c.startsWith("POST /auth/register"))).toBe(false);
  });

  it("si la API rechaza el nombre, el mensaje usa la etiqueta visible", async () => {
    installFetch({
      ...anonymous,
      "POST /auth/register": () => jsonRes(400, { error: "bad_request", message: "displayName obligatorio (máx. 48)" }),
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Crear cuenta" }));
    fireEvent.change(screen.getByLabelText("nombre"), { target: { value: "Ana" } });
    fireEvent.change(screen.getByLabelText("email"), { target: { value: "nuevo@example.invalid" } });
    fireEvent.change(screen.getByLabelText("contraseña"), { target: { value: "una-clave-larga-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Registrarse y entrar" }));
    await waitFor(() => expect(calls).toContain("POST /auth/register"));
    const err = await screen.findByTestId("login-error");
    expect(err.textContent).toMatch(/nombre visible/);
    expect(err.textContent).not.toMatch(/displayName/);
  });
});
