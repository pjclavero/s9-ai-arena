// @vitest-environment jsdom
/**
 * UX-E · Regresiones de los componentes TRANSVERSALES de la web (api.ts,
 * errors.ts, ErrorBoundary, primitivas y gestión de foco). Cada bloque se pone
 * ROJO si se revierte su corrección:
 *  - C-G13: una carga anónima ya no hace POST /auth/refresh (400 en consola);
 *  - un refresh que falla por RED/5xx/429 no echa al usuario al login (no se
 *    desmonta el panel ni se pierde lo no guardado);
 *  - 429 dice cuánto esperar (Retry-After);
 *  - ningún error pinta «[object Object]», JSON crudo ni mensajes del motor JS;
 *  - foco al contenido tras navegar; campo con error ligado por aria-describedby;
 *  - borrador local del texto en edición que sobrevive a un desmontaje.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { useState } from "react";
import {
  api,
  bootstrapSession,
  logout,
  setToken,
  onSessionExpired,
  SESSION_HINT_KEY,
  ApiRequestError,
  describeApiError,
} from "../src/api.js";
import { ErrorBoundary, userFacingMessage } from "../src/ErrorBoundary.js";
import { ErrorState, FormError, Field, LiveStatus } from "../src/ui/primitives.js";
import { installRouteFocus, ROUTE_FOCUS_ATTR } from "../src/ui/route-focus.js";
import { useSessionDraft, DRAFT_PREFIX } from "../src/ui/draft.js";

function jsonRes(status: number, body?: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (h: string) => {
        const k = h.toLowerCase();
        if (k === "content-type" && body !== undefined) return "application/json";
        return headers[k] ?? null;
      },
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  setToken(null);
  onSessionExpired(null);
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.location.hash = "";
});

describe("UX-E · C-G13: arranque anónimo sin POST /auth/refresh", () => {
  it("sin marca de sesión el arranque NO llama a /auth/refresh y devuelve null", async () => {
    const f = vi.fn(async () => jsonRes(400, { message: "falta el refresh token" }));
    vi.stubGlobal("fetch", f);
    await expect(bootstrapSession()).resolves.toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("el login (setToken) deja la marca y el siguiente arranque SÍ pregunta", async () => {
    setToken("tok");
    expect(window.localStorage.getItem(SESSION_HINT_KEY)).toBe("1");
    setToken(null);
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(String(url));
        if (String(url).endsWith("/auth/refresh")) return jsonRes(200, { accessToken: "nuevo" });
        return jsonRes(200, {
          id: "u1",
          displayName: "Ana",
          email: "a@a.es",
          roles: ["user"],
          twoFactorEnabled: false,
        });
      }),
    );
    const me = await bootstrapSession();
    expect(me?.displayName).toBe("Ana");
    expect(urls[0]).toMatch(/\/auth\/refresh$/);
  });

  it("si el servidor dice «no hay sesión» (400/401) la marca se borra: el próximo arranque no pregunta", async () => {
    window.localStorage.setItem(SESSION_HINT_KEY, "1");
    const f = vi.fn(async () => jsonRes(400, { message: "sin cookie" }));
    vi.stubGlobal("fetch", f);
    await expect(bootstrapSession()).resolves.toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(SESSION_HINT_KEY)).toBeNull();
    await bootstrapSession();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("logout borra la marca", async () => {
    setToken("tok");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes(204)),
    );
    await logout();
    expect(window.localStorage.getItem(SESSION_HINT_KEY)).toBeNull();
  });

  it("sin almacenamiento (modo privado estricto) se intenta el refresh como antes", async () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const f = vi.fn(async () => jsonRes(401, {}));
    vi.stubGlobal("fetch", f);
    await expect(bootstrapSession()).resolves.toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("UX-E · un refresh que falla por red/5xx/429 NO caduca la sesión", () => {
  it.each([
    ["red caída", () => Promise.reject(new TypeError("Failed to fetch")), "network"],
    ["502 del gateway", () => Promise.resolve(jsonRes(502)), "unavailable"],
    ["429", () => Promise.resolve(jsonRes(429, undefined, { "retry-after": "20" })), "unavailable"],
  ] as const)("%s: se lanza el fallo transitorio y NO se avisa de sesión caducada", async (_n, refresh, kind) => {
    setToken("caducado");
    const expired = vi.fn();
    onSessionExpired(expired);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/auth/refresh") ? refresh() : jsonRes(401, { message: "x" }),
      ),
    );
    const e = await api("POST", "/bots/b1/versions", { code: "mucho trabajo" }).catch((x) => x);
    expect(describeApiError(e).kind).toBe(kind);
    expect(expired).not.toHaveBeenCalled();
  });

  it("refresh 401 (sesión muerta de verdad) sí avisa", async () => {
    setToken("caducado");
    const expired = vi.fn();
    onSessionExpired(expired);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes(401, {})),
    );
    await api("GET", "/bots").catch(() => {});
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("un POST con cuerpo que da 401 por token caducado (15 min) se REENVÍA con el mismo cuerpo tras renovar", async () => {
    setToken("caducado");
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (String(url).endsWith("/auth/refresh")) return jsonRes(200, { accessToken: "nuevo" });
        bodies.push(String(init.body));
        const auth = (init.headers as Record<string, string>).Authorization;
        return auth === "Bearer nuevo" ? jsonRes(201, { ok: true }) : jsonRes(401, { message: "jwt expired" });
      }),
    );
    await expect(api("POST", "/bots/b1/versions", { code: "x = 1" })).resolves.toEqual({ ok: true });
    expect(bodies).toEqual([JSON.stringify({ code: "x = 1" }), JSON.stringify({ code: "x = 1" })]);
  });
});

describe("UX-E · mensajes de error sin basura técnica", () => {
  it("429 con Retry-After dice cuántos segundos esperar", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes(429, { message: "Límite de peticiones superado" }, { "retry-after": "30" })),
    );
    const e = await api("GET", "/bots").catch((x) => x);
    expect(describeApiError(e)).toMatchObject({ kind: "unavailable", retryable: true });
    expect(describeApiError(e).title).toContain("espera 30 s");
  });

  it("429 sin Retry-After pide esperar un momento", () => {
    expect(describeApiError(new ApiRequestError(429, { message: "x" })).title).toContain("espera un momento");
  });

  it("un error que no es Error (objeto suelto) no se pinta como «[object Object]»", () => {
    const d = describeApiError({ foo: 1 });
    expect(d.detail).not.toContain("[object");
    expect(d.detail).toBe("error desconocido");
  });

  it("un cuerpo con `message` objeto/lista se aplana a texto legible", () => {
    const e1 = new ApiRequestError(422, { message: { message: "el nombre es obligatorio" } });
    expect(e1.message).toBe("el nombre es obligatorio");
    const e2 = new ApiRequestError(422, { message: ["a obligatorio", "b muy largo"] });
    expect(e2.message).toBe("a obligatorio; b muy largo");
    const e3 = new ApiRequestError(500, { message: { code: 7 } });
    expect(e3.message).toBe("HTTP 500");
  });

  it("FormError con detalles objeto: «campo: mensaje», sin JSON ni [object Object]", () => {
    const err = new ApiRequestError(422, {
      message: "validación",
      details: [
        { path: "/name", message: "obligatorio" },
        { field: "mode", message: "no válido" },
      ],
      fieldErrors: undefined,
    });
    render(<FormError error={err} />);
    const el = screen.getByTestId("form-error");
    expect(el.textContent).toContain("name: obligatorio");
    expect(el.textContent).toContain("mode: no válido");
    expect(el.textContent).not.toMatch(/[{}]|\[object/);
    cleanup();
    render(<FormError error={new ApiRequestError(422, { message: "v", details: { budget: { max: 1000 } } })} />);
    expect(screen.getByTestId("form-error").textContent).not.toContain("[object");
    expect(screen.getByTestId("form-error").textContent).toContain("budget: max: 1000");
  });

  it("ErrorState 403 ofrece volver al inicio (no deja al usuario sin salida)", () => {
    render(<ErrorState label="el sistema" error={new ApiRequestError(403, { message: "Requiere rol admin" })} />);
    expect(screen.getByText("No tienes permiso para esto")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Volver al inicio" }).getAttribute("href")).toBe("#/bots");
  });
});

describe("UX-E · ErrorBoundary", () => {
  function boom(err: Error) {
    const Bomb = () => {
      throw err;
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary label="el editor">
        <Bomb />
      </ErrorBoundary>,
    );
    spy.mockRestore();
  }

  it("un TypeError del motor NO pinta su mensaje (undefined, nombres internos)", () => {
    boom(new TypeError("Cannot read properties of undefined (reading 'modules')"));
    const box = screen.getByTestId("error-boundary");
    expect(box.textContent).not.toMatch(/undefined|Cannot read|modules/);
    expect(box.textContent).toContain("Algo ha fallado en el editor");
    expect(screen.getByRole("link", { name: "Volver al inicio" })).toBeTruthy();
  });

  it("el foco va al aviso para que se anuncie", () => {
    boom(new Error("catálogo corrupto"));
    expect(document.activeElement?.textContent).toContain("Algo ha fallado en el editor");
    expect(screen.getByTestId("error-boundary-detail").textContent).toContain("catálogo corrupto");
  });

  it("userFacingMessage filtra lo técnico y deja lo escrito para el usuario", () => {
    expect(userFacingMessage(new Error("catálogo corrupto"))).toBe("catálogo corrupto");
    expect(userFacingMessage(new Error("x is not a function"))).toBeNull();
    expect(userFacingMessage(new RangeError("Invalid array length"))).toBeNull();
    expect(userFacingMessage(new Error("valor null"))).toBeNull();
  });
});

describe("UX-E · foco tras navegar y «Saltar al contenido»", () => {
  it("tras un hashchange el foco va al primer encabezado del <main>", () => {
    document.body.innerHTML = `<nav><a id="l" href="#/teams">Equipos</a></nav><main><h2>Equipos</h2><p>x</p></main>`;
    const queue: Array<() => void> = [];
    const off = installRouteFocus(window, (fn) => queue.push(fn));
    (document.getElementById("l") as HTMLElement).focus();
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    queue.forEach((fn) => fn());
    expect(document.activeElement?.tagName).toBe("H2");
    expect(document.activeElement?.hasAttribute(ROUTE_FOCUS_ATTR)).toBe(true);
    expect(document.activeElement?.getAttribute("tabindex")).toBe("-1");
    off();
  });

  it("sin encabezado, el foco va al <main>; con el foco ya dentro del contenido no se roba", () => {
    document.body.innerHTML = `<main><p>Cargando…</p><input id="i"/></main>`;
    const queue: Array<() => void> = [];
    const off = installRouteFocus(window, (fn) => queue.push(fn));
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    queue.splice(0).forEach((fn) => fn());
    expect(document.activeElement?.tagName).toBe("MAIN");
    (document.getElementById("i") as HTMLElement).focus();
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    queue.splice(0).forEach((fn) => fn());
    expect(document.activeElement?.id).toBe("i");
    off();
  });

  it("el enlace «Saltar al contenido» enfoca <main> sin cambiar la ruta", () => {
    document.body.innerHTML = `<a data-skip-link href="#/">Saltar</a><main><h2>X</h2></main>`;
    window.location.hash = "#/teams";
    const off = installRouteFocus(window, () => {});
    fireEvent.click(document.querySelector("[data-skip-link]")!);
    expect(document.activeElement?.tagName).toBe("MAIN");
    expect(window.location.hash).toBe("#/teams");
    off();
  });
});

describe("UX-E · Field y LiveStatus", () => {
  it("el error del campo queda ligado al control (aria-describedby + aria-invalid)", () => {
    render(
      <Field label="Nombre" hint="3-40 caracteres" error="El nombre ya existe">
        {(c) => <input {...c} />}
      </Field>,
    );
    const input = screen.getByLabelText("Nombre");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const ids = (input.getAttribute("aria-describedby") ?? "").split(" ");
    const texts = ids.map((id) => document.getElementById(id)?.textContent);
    expect(texts).toEqual(["3-40 caracteres", "El nombre ya existe"]);
  });

  it("sin error no hay aria-invalid", () => {
    render(<Field label="Nombre">{(c) => <input {...c} />}</Field>);
    expect(screen.getByLabelText("Nombre").hasAttribute("aria-invalid")).toBe(false);
  });

  it("LiveStatus anuncia cambios (role=status, aria-live=polite, aria-busy)", () => {
    render(<LiveStatus busy>Build en curso: compilando…</LiveStatus>);
    const s = screen.getByRole("status");
    expect(s.getAttribute("aria-live")).toBe("polite");
    expect(s.getAttribute("aria-busy")).toBe("true");
  });
});

describe("UX-E · borrador local del texto en edición", () => {
  function Editor(props: { id: string; initial: string }) {
    const d = useSessionDraft(`bot:${props.id}:code`, props.initial);
    return (
      <div>
        {d.restored && <p data-testid="restored">Borrador recuperado</p>}
        <textarea aria-label="código" value={d.value} onChange={(e) => d.setValue(e.target.value)} />
        <button type="button" onClick={d.clear}>
          guardado
        </button>
      </div>
    );
  }
  function Host() {
    const [on, setOn] = useState(true);
    return (
      <>
        <button type="button" onClick={() => setOn((x) => !x)}>
          alternar
        </button>
        {on && <Editor id="b1" initial="servidor" />}
      </>
    );
  }

  it("el texto no guardado sobrevive a un desmontaje (p. ej. sesión caducada → login → volver)", () => {
    render(<Host />);
    fireEvent.change(screen.getByLabelText("código"), { target: { value: "mi trabajo" } });
    act(() => fireEvent.click(screen.getByText("alternar")));
    expect(screen.queryByLabelText("código")).toBeNull();
    act(() => fireEvent.click(screen.getByText("alternar")));
    expect((screen.getByLabelText("código") as HTMLTextAreaElement).value).toBe("mi trabajo");
    expect(screen.getByTestId("restored")).toBeTruthy();
    fireEvent.click(screen.getByText("guardado"));
    expect(window.sessionStorage.getItem(`${DRAFT_PREFIX}bot:b1:code`)).toBeNull();
  });
});
