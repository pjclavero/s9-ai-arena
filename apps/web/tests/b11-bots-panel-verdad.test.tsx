// @vitest-environment jsdom
/**
 * B11 · El panel de versiones debe decir LA VERDAD.
 *
 * Escenario REAL (verificado contra la BD de producción el 2026-07-27): un mismo
 * bot con v1 rejected (node), v2 rejected (python), v3 draft y v4 rejected. El
 * panel enseñaba "v1 validating · static_analysis: src/bot.js (parece
 * TypeScript)" y un "Pipeline de build" con todas las etapas en pending para
 * siempre. El usuario creyó dos veces que su subida no había funcionado.
 *
 * Estos tests montan ese escenario contra un backend falso y comprueban QUÉ SE
 * RENDERIZA (no qué cadenas contiene el fichero fuente).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../src/api.js", () => ({
  api: vi.fn(),
  setToken: vi.fn(),
  getToken: vi.fn(() => "tok"),
  onSessionExpired: vi.fn(),
  bootstrapSession: vi.fn(),
  logout: vi.fn(),
  ApiRequestError: class extends Error {},
}));

import { api } from "../src/api.js";
import { BotsPage, workInProgress, rejectionToShow, pendingActionFor } from "../src/pages/BotsPage.js";
import { loadCatalog, CATALOG_VERSION } from "../../../packages/module-catalog/loadCatalog.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const ME = { id: "u1", displayName: "Ana", email: "a@a.es", roles: ["user"], twoFactorEnabled: false };
const catalog = loadCatalog();

const LOADOUT = {
  revision: 7,
  catalogVersion: CATALOG_VERSION,
  chassis: "chassis.medium@1",
  modules: [
    { slot: "drive", moduleId: "movement.tracks@1" },
    { slot: "power", moduleId: "power.battery@1" },
  ],
};

interface VersionRow {
  version: number;
  state: string;
  runtime: string;
  loadoutRevision: number;
  rejectionReason?: string;
}
interface BuildRow {
  id: string;
  version: number;
  status: string;
  stages: { name: string; status: string; message?: string }[];
}

/**
 * Backend falso con estado mutable: las respuestas cambian con el tiempo, igual
 * que el servidor real cuando el worker del bot-manager termina el pipeline.
 */
function fakeBackend(init: { versions: VersionRow[]; builds?: BuildRow[]; latencyMs?: number }) {
  const state = {
    versions: init.versions,
    builds: init.builds ?? [],
    calls: [] as string[],
    buildsShouldFail: false,
    versionsShouldFail: false,
    nextVersionNumber: Math.max(0, ...init.versions.map((v) => v.version)) + 1,
  };
  apiMock.mockImplementation(async (method: string, path: string) => {
    state.calls.push(`${method} ${path}`);
    // Latencia REAL: con un mock instantáneo el remonte del panel es invisible
    // porque el placeholder de carga no llega a pintarse nunca.
    if (init.latencyMs) await new Promise((r) => setTimeout(r, init.latencyMs));
    if (method === "GET" && path.startsWith("/bots?")) {
      return { items: [{ id: "b1", name: "Tanque", visibility: "private" }] };
    }
    if (method === "GET" && path === "/bots/b1/versions") {
      if (state.versionsShouldFail) throw new Error("gateway caído");
      return state.versions.map((v) => ({ ...v }));
    }
    if (method === "GET" && path === "/bots/b1/loadouts") return [LOADOUT];
    const m = /^\/bots\/b1\/versions\/(\d+)\/builds$/.exec(path);
    if (method === "GET" && m) {
      if (state.buildsShouldFail) throw new Error("gateway caído");
      const n = Number(m[1]);
      return state.builds.filter((b) => b.version === n).map((b) => ({ ...b }));
    }
    if (method === "POST" && path === "/bots/b1/versions") {
      const version = state.nextVersionNumber++;
      state.versions = [
        ...state.versions,
        { version, state: "draft", runtime: "python", loadoutRevision: LOADOUT.revision },
      ];
      return { version, state: "draft", runtime: "python", loadoutRevision: LOADOUT.revision };
    }
    const s = /^\/bots\/b1\/versions\/(\d+)\/actions\/submit$/.exec(path);
    if (method === "POST" && s) {
      const n = Number(s[1]);
      state.versions = state.versions.map((v) => (v.version === n ? { ...v, state: "validating" } : v));
      const build: BuildRow = {
        id: `build-${n}`,
        version: n,
        status: "queued",
        stages: [
          { name: "structure", status: "pending" },
          { name: "static_analysis", status: "pending" },
        ],
      };
      state.builds = [build, ...state.builds];
      return build;
    }
    throw new Error(`inesperado: ${method} ${path}`);
  });
  return state;
}

function renderPage(overrides: { pollIntervalMs?: number; maxPolls?: number } = {}) {
  return render(
    <BotsPage
      me={ME}
      catalog={catalog}
      catalogVersion={CATALOG_VERSION}
      budgetCredits={1000}
      pollIntervalMs={overrides.pollIntervalMs ?? 5}
      maxPolls={overrides.maxPolls ?? 4}
    />,
  );
}

async function selectBot() {
  await userEvent.click(await screen.findByRole("button", { name: "Tanque" }));
}

/** El estado exacto que había en producción para el bot del usuario. */
const PRODUCCION: VersionRow[] = [
  {
    version: 1,
    state: "rejected",
    runtime: "node",
    loadoutRevision: 1,
    rejectionReason: "static_analysis: src/bot.js (el fichero parece TypeScript)",
  },
  {
    version: 2,
    state: "rejected",
    runtime: "python",
    loadoutRevision: 1,
    rejectionReason: "static_analysis: sintaxis",
  },
  { version: 3, state: "draft", runtime: "python", loadoutRevision: 1 },
  {
    version: 4,
    state: "rejected",
    runtime: "python",
    loadoutRevision: 7,
    rejectionReason: "dependencies: falta requirements.txt",
  },
];

afterEach(cleanup);
beforeEach(() => {
  apiMock.mockReset();
});

describe("B11 · qué versión y qué error se enseñan", () => {
  it("con v1..v4 en BD, el resumen destacado es el de v4 y NUNCA el error de v1", async () => {
    fakeBackend({ versions: PRODUCCION });
    renderPage();
    await selectBot();

    const resumen = await screen.findByTestId("focused-version");
    // Lo que el usuario ve arriba del todo es SU última versión.
    expect(within(resumen).getByRole("heading").textContent).toContain("v4");
    expect(within(resumen).getByRole("heading").textContent).toContain("rejected");
    const motivo = within(resumen).getByTestId("focused-rejection").textContent ?? "";
    expect(motivo).toContain("falta requirements.txt");
    // El síntoma exacto que sufrió el dueño: el error de v1 destacado como si
    // fuera el actual.
    expect(motivo).not.toContain("parece TypeScript");
    expect(motivo).not.toContain("v1");
  });

  it("cada fila lleva SU propio motivo de rechazo (no el de otra versión)", async () => {
    fakeBackend({ versions: PRODUCCION });
    renderPage();
    await selectBot();

    const fila1 = await screen.findByTestId("version-row-1");
    const fila4 = screen.getByTestId("version-row-4");
    expect(fila1.textContent).toContain("parece TypeScript");
    expect(fila1.textContent).not.toContain("requirements.txt");
    expect(fila4.textContent).toContain("requirements.txt");
    expect(fila4.textContent).not.toContain("parece TypeScript");
  });

  it("al subir una versión nueva el foco pasa a ELLA (v5), no se queda en v4", async () => {
    fakeBackend({ versions: PRODUCCION });
    renderPage();
    await selectBot();
    await screen.findByTestId("focused-version");

    await userEvent.click(screen.getByRole("button", { name: "Subir como versión nueva" }));

    await waitFor(() => expect(screen.getByTestId("focused-version").querySelector("h2")?.textContent).toContain("v5"));
    const resumen = screen.getByTestId("focused-version");
    expect(resumen.textContent).toContain("draft");
    // Ningún motivo de rechazo heredado de v4.
    expect(within(resumen).queryByTestId("focused-rejection")).toBeNull();
  });

  it("la subida usa la revisión de loadout VIGENTE, no un 1 fijo", async () => {
    const st = fakeBackend({ versions: PRODUCCION });
    renderPage();
    await selectBot();
    await screen.findByTestId("focused-version");

    await userEvent.click(screen.getByRole("button", { name: "Subir como versión nueva" }));
    await waitFor(() => expect(st.versions.some((v) => v.version === 5)).toBe(true));

    const fd = apiMock.mock.calls.find((c) => c[0] === "POST" && c[1] === "/bots/b1/versions")?.[3]
      ?.formData as FormData;
    expect(fd.get("loadoutRevision")).toBe(String(LOADOUT.revision));
  });
});

describe("B11 · el pipeline refleja el resultado final", () => {
  it("un build que TERMINÓ se ve terminado, sin recargar a ciegas", async () => {
    fakeBackend({
      versions: [{ version: 4, state: "rejected", runtime: "python", loadoutRevision: 7, rejectionReason: "no pasa" }],
      builds: [
        {
          id: "b-4",
          version: 4,
          status: "failed",
          stages: [
            { name: "structure", status: "passed" },
            { name: "static_analysis", status: "failed", message: "sintaxis" },
          ],
        },
      ],
    });
    renderPage();
    await selectBot();

    const card = await screen.findByTestId("build-result");
    expect(card.querySelector("h3")?.textContent).toContain("v4");
    expect(card.querySelector("h3")?.textContent).toContain("failed");
    expect(card.textContent).toContain("sintaxis");
    // NO puede quedarse anunciando "en curso" un trabajo terminado.
    expect(within(card).queryByTestId("pipeline-running")).toBeNull();
  });

  it("tras enviar a validación, el sondeo alcanza el resultado final del worker", async () => {
    const st = fakeBackend({ versions: [{ version: 1, state: "draft", runtime: "python", loadoutRevision: 7 }] });
    renderPage({ pollIntervalMs: 5, maxPolls: 40 });
    await selectBot();
    await screen.findByTestId("focused-version");

    await userEvent.click(screen.getByRole("button", { name: "Enviar a validación v1" }));
    await screen.findByTestId("pipeline-running", {}, { timeout: 5000 });

    // El worker termina DESPUÉS, como en producción: el panel debe enterarse solo.
    st.versions = [
      { version: 1, state: "rejected", runtime: "python", loadoutRevision: 7, rejectionReason: "static_analysis" },
    ];
    st.builds = [
      {
        id: "build-1",
        version: 1,
        status: "failed",
        stages: [{ name: "static_analysis", status: "failed", message: "el fichero parece TypeScript" }],
      },
    ];

    await waitFor(
      () => expect(screen.getByTestId("build-result").querySelector("h3")?.textContent).toContain("failed"),
      { timeout: 3000 },
    );
    // El estado de la versión llega en la revalidación que dispara el final del
    // build (una sola, no una por ciclo).
    await waitFor(() => expect(screen.getByTestId("focused-version").textContent).toContain("rejected"), {
      timeout: 3000,
    });
    expect(screen.getByTestId("focused-rejection").textContent).toContain("static_analysis");
    expect(screen.queryByTestId("pipeline-running")).toBeNull();
  });

  it("el sondeo TIENE FIN: agotado el presupuesto dice «estado desconocido», no miente", async () => {
    fakeBackend({
      versions: [{ version: 1, state: "validating", runtime: "python", loadoutRevision: 7 }],
      builds: [{ id: "b-1", version: 1, status: "running", stages: [{ name: "structure", status: "running" }] }],
    });
    renderPage({ pollIntervalMs: 2, maxPolls: 3 });
    await selectBot();

    const aviso = await screen.findByTestId("pipeline-unknown", {}, { timeout: 3000 });
    expect(aviso.textContent).toContain("estado desconocido");
    expect(screen.getByTestId("build-result").querySelector("h3")?.textContent).toContain("estado desconocido");
    // Y no se ha inventado un "passed"/"failed".
    expect(screen.getByTestId("build-result").querySelector("h3")?.textContent).not.toContain("passed");
  });

  it("si no se pueden leer los builds NO se pinta un pipeline falso", async () => {
    const st = fakeBackend({ versions: [{ version: 1, state: "validating", runtime: "python", loadoutRevision: 7 }] });
    st.buildsShouldFail = true;
    renderPage();
    await selectBot();

    const card = await screen.findByTestId("build-result");
    expect(card.querySelector("h3")?.textContent).toContain("estado desconocido");
    expect(within(card).getByTestId("pipeline-unknown")).toBeTruthy();
    expect(card.querySelector("table")).toBeNull(); // ni una etapa inventada
  });

  it("una versión sin builds dice que no se ha enviado, no «queued» con todo pending", async () => {
    fakeBackend({ versions: [{ version: 3, state: "draft", runtime: "python", loadoutRevision: 7 }] });
    renderPage();
    await selectBot();

    const card = await screen.findByTestId("build-result");
    expect(card.textContent).toContain("no se ha enviado a validación");
    expect(card.querySelector("h3")?.textContent).not.toContain("queued");
    expect(card.querySelector("table")).toBeNull();
  });
});

describe("B11 · un draft sin enviar es visible como tal", () => {
  it("v3 draft sale marcada SIN ENVIAR y con la acción que falta", async () => {
    fakeBackend({ versions: PRODUCCION });
    renderPage();
    await selectBot();

    const fila3 = await screen.findByTestId("version-row-3");
    expect(fila3.textContent).toContain("SIN ENVIAR");
    expect(fila3.textContent).toContain("pulsa «Enviar a validación»");
    expect(within(fila3).getByRole("button", { name: "Enviar a validación v3" })).toBeTruthy();
    // Y las que NO son draft no llevan esa marca.
    expect(screen.getByTestId("version-row-4").textContent).not.toContain("SIN ENVIAR");
  });

  it("«Ver v3» enfoca esa versión concreta y su pipeline", async () => {
    fakeBackend({ versions: PRODUCCION });
    renderPage();
    await selectBot();
    await screen.findByTestId("focused-version");

    await userEvent.click(screen.getByRole("button", { name: "Ver v3" }));
    await waitFor(() => expect(screen.getByTestId("focused-version").querySelector("h2")?.textContent).toContain("v3"));
    expect(screen.getByTestId("build-result").querySelector("h3")?.textContent).toContain("v3");
    expect(screen.getByTestId("focused-version").textContent).toContain("pulsa «Enviar a validación»");
  });
});

describe("B11 · lógica pura de apoyo", () => {
  it("workInProgress solo es cierto si HAY trabajo en curso", () => {
    expect(workInProgress(undefined, null)).toBe(false);
    expect(workInProgress("validating", null)).toBe(true);
    expect(workInProgress("rejected", { list: [], known: true })).toBe(false);
    // Build en cola con la versión ya en estado terminal: sigue habiendo trabajo.
    expect(workInProgress("draft", { list: [{ id: "b", status: "queued", stages: [] }], known: true })).toBe(true);
    expect(workInProgress("rejected", { list: [{ id: "b", status: "failed", stages: [] }], known: true })).toBe(false);
    // Si no se conocen los builds no se sondea a ciegas: se dice "desconocido".
    expect(workInProgress("draft", { list: [], known: false })).toBe(false);
  });

  it("rejectionToShow solo devuelve el motivo cuando la versión está rejected", () => {
    const reason = "static_analysis: src/bot.js (el fichero parece TypeScript)";
    expect(rejectionToShow({ state: "rejected", rejectionReason: reason })).toBe(reason);
    // Una versión REENVIADA conserva el motivo del intento anterior en la fila:
    // pintarlo mientras valida es contar un error viejo como si fuera el actual.
    expect(rejectionToShow({ state: "validating", rejectionReason: reason })).toBeUndefined();
    expect(rejectionToShow({ state: "validated", rejectionReason: reason })).toBeUndefined();
    expect(rejectionToShow({ state: "draft", rejectionReason: reason })).toBeUndefined();
    expect(rejectionToShow(undefined)).toBeUndefined();
  });

  it("pendingActionFor nombra la acción pendiente de cada estado", () => {
    expect(pendingActionFor("draft")).toContain("Enviar a validación");
    expect(pendingActionFor("validated")).toContain("publicar");
    expect(pendingActionFor("published")).toBe("");
  });
});

/* -------------------------------------------------------------------------
 * Bloqueantes encontrados por el Supervisor sobre la primera versión de B11.
 * ---------------------------------------------------------------------- */

describe("B11-fix · el motivo de rechazo pertenece SOLO al estado rejected", () => {
  const REENVIADA: VersionRow[] = [
    {
      version: 1,
      state: "validating",
      runtime: "node",
      loadoutRevision: 7,
      // Residuo del intento anterior (la API lo limpia desde B11, pero el panel
      // no debe depender de ello: hay filas antiguas con el dato sucio).
      rejectionReason: "static_analysis: src/bot.js (el fichero parece TypeScript)",
    },
  ];

  it("al reenviar una rechazada NO se pinta el error del intento anterior", async () => {
    fakeBackend({
      versions: REENVIADA,
      builds: [{ id: "b-1", version: 1, status: "running", stages: [{ name: "structure", status: "running" }] }],
    });
    renderPage({ pollIntervalMs: 5, maxPolls: 2 });
    await selectBot();

    const resumen = await screen.findByTestId("focused-version");
    expect(resumen.textContent).toContain("validating");
    expect(resumen.textContent).toContain("Validación en curso");
    // La cadena EXACTA que engañó al dueño del proyecto no puede aparecer.
    expect(within(resumen).queryByTestId("focused-rejection")).toBeNull();
    expect(document.body.textContent).not.toContain("parece TypeScript");
    expect(document.body.textContent).not.toContain("Motivo del rechazo");
  });

  it("tampoco en la fila de la tabla", async () => {
    fakeBackend({ versions: REENVIADA });
    renderPage();
    await selectBot();
    const fila = await screen.findByTestId("version-row-1");
    expect(fila.textContent).toContain("validating");
    expect(fila.textContent).not.toContain("parece TypeScript");
  });

  it("cuando vuelve a rejected, el motivo NUEVO sí se pinta", async () => {
    const st = fakeBackend({
      versions: REENVIADA,
      builds: [{ id: "b-1", version: 1, status: "running", stages: [{ name: "structure", status: "running" }] }],
    });
    renderPage({ pollIntervalMs: 5, maxPolls: 40 });
    await selectBot();
    await screen.findByTestId("focused-version");

    st.versions = [
      { version: 1, state: "rejected", runtime: "node", loadoutRevision: 7, rejectionReason: "dependencies: faltan" },
    ];
    st.builds = [{ id: "b-1", version: 1, status: "failed", stages: [{ name: "dependencies", status: "failed" }] }];

    const motivo = await screen.findByTestId("focused-rejection", {}, { timeout: 3000 });
    expect(motivo.textContent).toContain("dependencies: faltan");
    expect(motivo.textContent).not.toContain("parece TypeScript");
  });
});

describe("B11-fix · el sondeo no desmonta el panel ni tira trabajo del usuario", () => {
  /** Escenario de sondeo activo con latencia realista de red. */
  function enCurso() {
    return fakeBackend({
      versions: [{ version: 1, state: "validating", runtime: "python", loadoutRevision: 7 }],
      builds: [{ id: "b-1", version: 1, status: "running", stages: [{ name: "structure", status: "running" }] }],
      latencyMs: 30,
    });
  }

  it("no aparece NUNCA el placeholder de carga durante el sondeo", async () => {
    enCurso();
    renderPage({ pollIntervalMs: 10, maxPolls: 8 });
    await selectBot();
    await screen.findByTestId("build-result");

    let vistoPlaceholder = false;
    const observer = new MutationObserver(() => {
      if (document.body.textContent?.includes("Cargando el detalle de Tanque")) vistoPlaceholder = true;
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    await new Promise((r) => setTimeout(r, 200)); // varios ciclos de sondeo
    observer.disconnect();

    expect(vistoPlaceholder).toBe(false);
  });

  it("conserva el foco, el nodo del área de código y los cambios SIN GUARDAR del editor", async () => {
    enCurso();
    renderPage({ pollIntervalMs: 10, maxPolls: 8 });
    await selectBot();
    await screen.findByTestId("build-result");

    // El usuario cambia el chasis (sin guardar) y escribe código.
    const chasis = screen.getByLabelText("chasis") as HTMLSelectElement;
    await userEvent.selectOptions(chasis, "chassis.heavy@1");
    const area = screen.getByLabelText("codigo") as HTMLTextAreaElement;
    await userEvent.type(area, "print('hola')");
    area.focus();
    expect(document.activeElement).toBe(area);

    await new Promise((r) => setTimeout(r, 200)); // varios ciclos de sondeo

    // Mismo nodo del DOM: el subárbol no se ha remontado.
    expect(screen.getByLabelText("codigo")).toBe(area);
    expect(document.activeElement).toBe(area);
    expect(area.value).toBe("print('hola')");
    // Y la elección sin guardar del usuario sigue siendo la suya.
    expect((screen.getByLabelText("chasis") as HTMLSelectElement).value).toBe("chassis.heavy@1");
  });

  it("el sondeo NO vuelve a pedir los loadouts (es lo que remontaba el editor)", async () => {
    const st = enCurso();
    renderPage({ pollIntervalMs: 10, maxPolls: 8 });
    await selectBot();
    await screen.findByTestId("build-result");

    const loadoutsAlPrincipio = st.calls.filter((c) => c.endsWith("/loadouts")).length;
    const buildsAlPrincipio = st.calls.filter((c) => c.includes("/builds")).length;
    await new Promise((r) => setTimeout(r, 200));

    expect(st.calls.filter((c) => c.endsWith("/loadouts")).length).toBe(loadoutsAlPrincipio);
    // …y sí ha sondeado los builds, que es de lo que se trata.
    expect(st.calls.filter((c) => c.includes("/builds")).length).toBeGreaterThan(buildsAlPrincipio);
  });

  it("cuando el build TERMINA, la revalidación de versiones tampoco desmonta el panel", async () => {
    // El momento crítico: el usuario está escribiendo justo cuando el worker
    // acaba. Ahí se dispara la revalidación de versiones; si no es silenciosa,
    // se lleva por delante lo que el usuario tenía a medias.
    const st = fakeBackend({
      versions: [{ version: 1, state: "validating", runtime: "python", loadoutRevision: 7 }],
      builds: [{ id: "b-1", version: 1, status: "running", stages: [{ name: "structure", status: "running" }] }],
      latencyMs: 30,
    });
    // Presupuesto GRANDE a propósito (issue #95): estos tests afirman qué hace el
    // sondeo mientras está VIVO, no que se agote. Con `maxPolls: 40` y ciclos de
    // 10 ms el presupuesto se consumía en ~400 ms de RELOJ, así que bajo contención
    // —la suite entera en paralelo— se agotaba antes de que el panel llegara a
    // pintar `pipeline-running`: el estado pasaba a `unknown` y el `findByTestId`
    // moría a los 5 s, dejando `unit` en rojo sin que nada hubiera cambiado. El
    // agotamiento del presupuesto tiene su propio test ("gasta UNA petición por
    // ciclo", `maxPolls: 6`), que no se toca.
    renderPage({ pollIntervalMs: 10, maxPolls: 5_000 });
    await selectBot();
    await screen.findByTestId("pipeline-running", {}, { timeout: 5000 });

    const chasis = screen.getByLabelText("chasis") as HTMLSelectElement;
    await userEvent.selectOptions(chasis, "chassis.heavy@1");
    const area = screen.getByLabelText("codigo") as HTMLTextAreaElement;
    await userEvent.type(area, "sin guardar");
    area.focus();

    st.versions = [
      { version: 1, state: "rejected", runtime: "python", loadoutRevision: 7, rejectionReason: "no compila" },
    ];
    st.builds = [{ id: "b-1", version: 1, status: "failed", stages: [{ name: "build", status: "failed" }] }];

    await waitFor(() => expect(screen.getByTestId("focused-version").textContent).toContain("rejected"), {
      timeout: 3000,
    });
    // Mismo nodo, mismo foco, mismo trabajo sin guardar.
    expect(screen.getByLabelText("codigo")).toBe(area);
    expect(document.activeElement).toBe(area);
    expect(area.value).toBe("sin guardar");
    expect((screen.getByLabelText("chasis") as HTMLSelectElement).value).toBe("chassis.heavy@1");
  });

  it("si la revalidación de versiones FALLA, se avisa y no se borra lo que ya había", async () => {
    // Conservar los datos previos no puede convertirse en callar el fallo: se
    // mantiene lo último bueno Y se dice que puede estar desfasado.
    const st = fakeBackend({
      versions: [{ version: 1, state: "validating", runtime: "python", loadoutRevision: 7 }],
      builds: [{ id: "b-1", version: 1, status: "running", stages: [{ name: "structure", status: "running" }] }],
      latencyMs: 5,
    });
    // Presupuesto GRANDE a propósito (issue #95): estos tests afirman qué hace el
    // sondeo mientras está VIVO, no que se agote. Con `maxPolls: 40` y ciclos de
    // 10 ms el presupuesto se consumía en ~400 ms de RELOJ, así que bajo contención
    // —la suite entera en paralelo— se agotaba antes de que el panel llegara a
    // pintar `pipeline-running`: el estado pasaba a `unknown` y el `findByTestId`
    // moría a los 5 s, dejando `unit` en rojo sin que nada hubiera cambiado. El
    // agotamiento del presupuesto tiene su propio test ("gasta UNA petición por
    // ciclo", `maxPolls: 6`), que no se toca.
    renderPage({ pollIntervalMs: 10, maxPolls: 5_000 });
    await selectBot();
    await screen.findByTestId("pipeline-running", {}, { timeout: 5000 });

    st.versionsShouldFail = true;
    st.builds = [{ id: "b-1", version: 1, status: "failed", stages: [{ name: "build", status: "failed" }] }];

    const aviso = await screen.findByTestId("versions-stale", {}, { timeout: 3000 });
    expect(aviso.textContent).toContain("puede estar desfasado");
    // El panel sigue en pie con lo último que sí se supo (no una pantalla de error).
    expect(screen.getByTestId("focused-version").textContent).toContain("validating");
    expect(screen.getByTestId("version-row-1")).toBeTruthy();
    expect(screen.queryByText(/No se pudo cargar el detalle/)).toBeNull();
  });

  it("una lectura OBSOLETA con éxito no borra el aviso de una lectura posterior fallida", async () => {
    // N1 · Disparador realista: el usuario ansioso pulsa «Actualizar estado» dos
    // veces seguidas. Las dos lecturas de /versions se solapan y resuelven FUERA
    // DE ORDEN: la segunda (B) falla y la primera (A), ya obsoleta, llega con
    // éxito después. Si la marca de desfase la fijara el loader, A borraría el
    // aviso de B y quedarían datos viejos con cara de sanos.
    const deferred: { resolve: (v: unknown) => void; reject: (e: Error) => void }[] = [];
    let versionCalls = 0;
    const VERSIONES = [{ version: 1, state: "rejected", runtime: "python", loadoutRevision: 7, rejectionReason: "x" }];

    apiMock.mockImplementation(async (method: string, path: string) => {
      if (method === "GET" && path.startsWith("/bots?")) {
        return { items: [{ id: "b1", name: "Tanque", visibility: "private" }] };
      }
      if (method === "GET" && path === "/bots/b1/loadouts") return [LOADOUT];
      if (method === "GET" && path.includes("/builds")) return [];
      if (method === "GET" && path === "/bots/b1/versions") {
        versionCalls += 1;
        if (versionCalls === 1) return VERSIONES; // carga inicial
        // A (2ª) y B (3ª) quedan en manos del test.
        return new Promise((resolve, reject) => deferred.push({ resolve, reject }));
      }
      throw new Error(`inesperado: ${method} ${path}`);
    });

    renderPage({ pollIntervalMs: 10_000, maxPolls: 0 });
    await selectBot();
    await screen.findByTestId("focused-version");

    const actualizar = screen.getByRole("button", { name: "Actualizar estado" });
    await userEvent.click(actualizar); // lanza A
    await waitFor(() => expect(deferred).toHaveLength(1));
    await userEvent.click(actualizar); // lanza B (A queda obsoleta)
    await waitFor(() => expect(deferred).toHaveLength(2));

    // B falla ⇒ aparece el aviso.
    deferred[1].reject(new Error("gateway caído"));
    const aviso = await screen.findByTestId("versions-stale", {}, { timeout: 3000 });
    expect(aviso.textContent).toContain("puede estar desfasado");

    // Llega A, OBSOLETA, con éxito: no puede borrar el aviso de B.
    deferred[0].resolve(VERSIONES);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("versions-stale")).not.toBeNull();
    // Y el panel sigue en pie con lo último bueno.
    expect(screen.getByTestId("version-row-1")).toBeTruthy();
  });

  it("una revalidación posterior CON ÉXITO sí retira el aviso", async () => {
    // El aviso no puede quedarse pegado para siempre: es información, no adorno.
    const st = fakeBackend({
      versions: [{ version: 1, state: "rejected", runtime: "python", loadoutRevision: 7, rejectionReason: "x" }],
      latencyMs: 5,
    });
    renderPage({ pollIntervalMs: 10_000, maxPolls: 0 });
    await selectBot();
    await screen.findByTestId("focused-version");

    st.versionsShouldFail = true;
    await userEvent.click(screen.getByRole("button", { name: "Actualizar estado" }));
    await screen.findByTestId("versions-stale", {}, { timeout: 3000 });

    st.versionsShouldFail = false;
    await userEvent.click(screen.getByRole("button", { name: "Actualizar estado" }));
    await waitFor(() => expect(screen.queryByTestId("versions-stale")).toBeNull(), { timeout: 3000 });
  });

  it("gasta UNA petición por ciclo, no tres", async () => {
    const st = enCurso();
    renderPage({ pollIntervalMs: 10, maxPolls: 6 });
    await selectBot();
    await screen.findByTestId("build-result");
    st.calls.length = 0;

    await new Promise((r) => setTimeout(r, 250)); // el presupuesto se agota
    await screen.findByTestId("pipeline-unknown");

    const builds = st.calls.filter((c) => c.includes("/builds")).length;
    const otras = st.calls.filter((c) => !c.includes("/builds")).length;
    expect(builds).toBeGreaterThan(0);
    expect(builds).toBeLessThanOrEqual(6); // presupuesto respetado
    expect(otras).toBe(0); // ni versiones ni loadouts por ciclo
  });

  it("al terminar el build revalida las versiones UNA vez y muestra el estado final", async () => {
    const st = fakeBackend({
      versions: [{ version: 1, state: "validating", runtime: "python", loadoutRevision: 7 }],
      builds: [{ id: "b-1", version: 1, status: "running", stages: [{ name: "structure", status: "running" }] }],
      latencyMs: 5,
    });
    // Presupuesto GRANDE a propósito (issue #95): estos tests afirman qué hace el
    // sondeo mientras está VIVO, no que se agote. Con `maxPolls: 40` y ciclos de
    // 10 ms el presupuesto se consumía en ~400 ms de RELOJ, así que bajo contención
    // —la suite entera en paralelo— se agotaba antes de que el panel llegara a
    // pintar `pipeline-running`: el estado pasaba a `unknown` y el `findByTestId`
    // moría a los 5 s, dejando `unit` en rojo sin que nada hubiera cambiado. El
    // agotamiento del presupuesto tiene su propio test ("gasta UNA petición por
    // ciclo", `maxPolls: 6`), que no se toca.
    renderPage({ pollIntervalMs: 10, maxPolls: 5_000 });
    await selectBot();
    await screen.findByTestId("pipeline-running", {}, { timeout: 5000 });
    st.calls.length = 0;

    st.versions = [
      { version: 1, state: "rejected", runtime: "python", loadoutRevision: 7, rejectionReason: "no compila" },
    ];
    st.builds = [{ id: "b-1", version: 1, status: "failed", stages: [{ name: "build", status: "failed" }] }];

    await waitFor(() => expect(screen.getByTestId("focused-version").textContent).toContain("rejected"), {
      timeout: 3000,
    });
    expect(screen.getByTestId("focused-rejection").textContent).toContain("no compila");
    // Exactamente una revalidación de versiones, no una por ciclo.
    expect(st.calls.filter((c) => c.endsWith("/versions")).length).toBe(1);
  });
});

describe("B11-fix · sin resultado fiable no se pinta ninguna etapa", () => {
  it("con el sondeo agotado no queda ni una fila `pending` bajo «estado desconocido»", async () => {
    fakeBackend({
      versions: [{ version: 1, state: "validating", runtime: "python", loadoutRevision: 7 }],
      builds: [
        {
          id: "b-1",
          version: 1,
          status: "queued",
          stages: [
            { name: "structure", status: "pending" },
            { name: "static_analysis", status: "pending" },
          ],
        },
      ],
    });
    renderPage({ pollIntervalMs: 2, maxPolls: 3 });
    await selectBot();

    const card = await screen.findByTestId("build-result");
    await within(card).findByTestId("pipeline-unknown", {}, { timeout: 3000 });
    expect(card.querySelector("h3")?.textContent).toContain("estado desconocido");
    expect(card.querySelector("table")).toBeNull();
    expect(card.textContent).not.toContain("pending");
    expect(within(card).queryByTestId("pipeline-running")).toBeNull();
  });
});
