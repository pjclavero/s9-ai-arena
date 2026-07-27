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
import { BotsPage, detailInProgress, pendingActionFor } from "../src/pages/BotsPage.js";
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
function fakeBackend(init: { versions: VersionRow[]; builds?: BuildRow[] }) {
  const state = {
    versions: init.versions,
    builds: init.builds ?? [],
    calls: [] as string[],
    buildsShouldFail: false,
    nextVersionNumber: Math.max(0, ...init.versions.map((v) => v.version)) + 1,
  };
  apiMock.mockImplementation(async (method: string, path: string) => {
    state.calls.push(`${method} ${path}`);
    if (method === "GET" && path.startsWith("/bots?")) {
      return { items: [{ id: "b1", name: "Tanque", visibility: "private" }] };
    }
    if (method === "GET" && path === "/bots/b1/versions") return state.versions.map((v) => ({ ...v }));
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
    await screen.findByTestId("pipeline-running");

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
    expect(screen.getByTestId("focused-version").textContent).toContain("rejected");
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
  it("detailInProgress solo es cierto si HAY trabajo en curso", () => {
    const base = { versions: [], loadouts: [], builds: [], buildsKnown: true };
    expect(detailInProgress(null)).toBe(false);
    expect(detailInProgress({ ...base, focusedVersion: undefined })).toBe(false);
    expect(
      detailInProgress({
        ...base,
        focusedVersion: 1,
        versions: [{ version: 1, state: "validating", runtime: "python", loadoutRevision: 1 }],
      }),
    ).toBe(true);
    expect(
      detailInProgress({
        ...base,
        focusedVersion: 1,
        versions: [{ version: 1, state: "rejected", runtime: "python", loadoutRevision: 1 }],
      }),
    ).toBe(false);
    // Build en cola con la versión ya en estado terminal: sigue habiendo trabajo.
    expect(
      detailInProgress({
        ...base,
        focusedVersion: 1,
        versions: [{ version: 1, state: "draft", runtime: "python", loadoutRevision: 1 }],
        builds: [{ id: "b", version: 1, status: "queued", stages: [] }],
      }),
    ).toBe(true);
    // Si no se conocen los builds no se sondea a ciegas: se dice "desconocido".
    expect(
      detailInProgress({
        ...base,
        focusedVersion: 1,
        versions: [{ version: 1, state: "draft", runtime: "python", loadoutRevision: 1 }],
        buildsKnown: false,
      }),
    ).toBe(false);
  });

  it("pendingActionFor nombra la acción pendiente de cada estado", () => {
    expect(pendingActionFor("draft")).toContain("Enviar a validación");
    expect(pendingActionFor("validated")).toContain("publicar");
    expect(pendingActionFor("published")).toBe("");
  });
});
