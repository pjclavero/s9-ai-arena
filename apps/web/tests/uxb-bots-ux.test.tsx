// @vitest-environment jsdom
/**
 * UX-B · lo que ve y puede hacer el usuario en «Mis bots» y en el detalle del bot:
 *
 *  - B3: el editor de código arranca con una plantilla VÁLIDA del runtime
 *    (ver también build-sandbox-docker.test.ts: estas plantillas pasan el build real);
 *  - B1: crear un bot (vacío, demasiado largo, duplicado, doble clic);
 *  - UX-02: diagnóstico del build (fase, fichero, línea, NO publicada, usuario vs
 *    infraestructura) y el botón para corregir el código;
 *  - B6: qué versión se edita y cuál usan las batallas;
 *  - G-15: el editor web no destruye un paquete multi-fichero.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/react";
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
import { BotsPage, botNameProblem, versionInBattles } from "../src/pages/BotsPage.js";
import { BotDetailPage } from "../src/pages/BotDetailPage.js";
import { diagnoseBuild, locateInMessage } from "../src/build-diagnosis.js";
import { BOT_TEMPLATES, JAVASCRIPT_TEMPLATE, PYTHON_TEMPLATE } from "../src/bot-templates.js";
import { analyze } from "../../bot-manager/src/static-analysis.js";
import { DEFAULT_CONFIG } from "../../bot-manager/src/config.js";
import { wrapSingleFile } from "../../api/src/services/source-package.js";
import { loadCatalog, CATALOG_VERSION } from "../../../packages/module-catalog/loadCatalog.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const ME = { id: "u1", displayName: "Ana", email: "a@a.es", roles: ["user"], twoFactorEnabled: false };
const catalog = loadCatalog();
const LOADOUT = { revision: 2, catalogVersion: CATALOG_VERSION, chassis: "chassis.medium@1", modules: [] };

afterEach(() => {
  cleanup();
  apiMock.mockReset();
  window.location.hash = "";
});

function renderBots() {
  return render(<BotsPage me={ME} catalog={catalog} catalogVersion={CATALOG_VERSION} budgetCredits={1000} />);
}

describe("B3 · plantillas del editor", () => {
  it("las dos plantillas pasan el análisis estático REAL del build e implementan el hook", () => {
    for (const [runtime, code] of [
      ["python", PYTHON_TEMPLATE],
      ["node", JAVASCRIPT_TEMPLATE],
    ] as const) {
      const res = analyze(runtime, wrapSingleFile(runtime, code), DEFAULT_CONFIG);
      expect(res.parseErrors, runtime).toEqual([]);
      expect(res.dynamicFindings, runtime).toEqual([]);
      expect(res.disallowedImports, runtime).toEqual([]);
    }
    expect(PYTHON_TEMPLATE).toMatch(/def on_observation\(self, observation\):/);
    expect(JAVASCRIPT_TEMPLATE).toMatch(/export default class Bot extends ArenaBot/);
    expect(JAVASCRIPT_TEMPLATE).toMatch(/\n {2}onObservation\(observation\) \{/);
  });

  it("el área de código NO empieza vacía y cambia de plantilla con el runtime si no se ha tocado", async () => {
    apiMock.mockImplementation(async (method: string, path: string) => {
      if (path.startsWith("/bots?")) return { items: [{ id: "b1", name: "Tanque", visibility: "private" }] };
      if (path === "/bots/b1/versions") return [];
      if (path === "/bots/b1/loadouts") return [LOADOUT];
      return [];
    });
    renderBots();
    await userEvent.click(await screen.findByRole("button", { name: "Tanque" }));
    const area = (await screen.findByLabelText("codigo")) as HTMLTextAreaElement;
    expect(area.value).toBe(BOT_TEMPLATES.python);
    expect(screen.getByTestId("hook-help").textContent).toMatch(/on_observation/);
    await userEvent.selectOptions(screen.getByLabelText("runtime"), "node");
    expect((screen.getByLabelText("codigo") as HTMLTextAreaElement).value).toBe(BOT_TEMPLATES.node);
    expect(screen.getByTestId("hook-help").textContent).toMatch(/TypeScript no se acepta/);
    // Con código propio, cambiar de runtime NO lo borra.
    fireEvent.change(screen.getByLabelText("codigo"), { target: { value: "mi código" } });
    await userEvent.selectOptions(screen.getByLabelText("runtime"), "python");
    expect((screen.getByLabelText("codigo") as HTMLTextAreaElement).value).toBe("mi código");
    expect(screen.getByTestId("upload-target").textContent).toMatch(/v1 con la revisión 2 del loadout/);
  });
});

describe("B1 · crear bot", () => {
  it("validación en cliente: vacío, largo y duplicado con mensajes legibles", () => {
    expect(botNameProblem("   ")).toBe("Escribe un nombre para el bot.");
    expect(botNameProblem("x".repeat(49))).toBe("El nombre admite como máximo 48 caracteres (tiene 49).");
    expect(botNameProblem("Tanque", ["Tanque"])).toBe("Ya tienes un bot llamado «Tanque».");
    expect(botNameProblem("  Nuevo ")).toBeNull();
  });

  it("doble clic: un solo POST /bots, sin envíos mientras hay uno en vuelo; abre el bot creado", async () => {
    let release!: () => void;
    const posts: unknown[] = [];
    apiMock.mockImplementation(async (method: string, path: string, body?: unknown) => {
      if (method === "POST" && path === "/bots") {
        posts.push(body);
        await new Promise<void>((r) => (release = r));
        return { id: "b2", name: "Nuevo", visibility: "private" };
      }
      if (path.startsWith("/bots?")) return { items: [] };
      if (path === "/bots/b2/versions") return [];
      if (path === "/bots/b2/loadouts") return [];
      return [];
    });
    renderBots();
    await screen.findByText(/Aún no tienes bots/);
    await userEvent.type(screen.getByLabelText("nuevo-bot"), "  Nuevo ");
    const button = screen.getByRole("button", { name: "Crear bot" });
    await userEvent.click(button);
    await userEvent.click(button);
    fireEvent.submit(button.closest("form")!);
    expect(posts).toEqual([{ name: "Nuevo" }]);
    expect(screen.getByRole("button", { name: "Creando…" })).toHaveProperty("disabled", true);
    release();
    await screen.findByText(/Guarda antes una configuración/); // el bot creado queda abierto
    expect(posts).toHaveLength(1);
  });

  it("nombre vacío: no llama a la API y lo dice junto al formulario", async () => {
    apiMock.mockImplementation(async (_m: string, path: string) => (path.startsWith("/bots?") ? { items: [] } : []));
    renderBots();
    await screen.findByText(/Aún no tienes bots/);
    await userEvent.click(screen.getByRole("button", { name: "Crear bot" }));
    expect(screen.getByTestId("create-bot-error").textContent).toMatch(/Escribe un nombre para el bot/);
    expect(apiMock.mock.calls.some(([m, p]) => m === "POST" && p === "/bots")).toBe(false);
  });
});

describe("UX-02 · diagnóstico del build", () => {
  const stagesFailing = (name: string, message: string) => [
    { name: "structure", status: "passed" },
    { name, status: "failed", message },
  ];

  it("error de sintaxis Python: fase, fichero y línea; culpa del usuario", () => {
    const d = diagnoseBuild({
      state: "rejected",
      rejectionReason: "static_analysis: …",
      stages: stagesFailing(
        "static_analysis",
        "fichero(s) no analizables (AST), se rechaza fail-closed: src/bot.py (SyntaxError: expected ':' (linea 4))",
      ),
    })!;
    expect(d.fault).toBe("user");
    expect(d.stageLabel).toBe("análisis estático del código");
    expect(d.location).toEqual({ file: "src/bot.py", line: 4 });
  });

  it("error de sintaxis JS (acorn) y excepción del bot (sandbox): fichero y línea", () => {
    expect(
      locateInMessage("fichero(s) no analizables (AST), se rechaza fail-closed: src/bot.js (Unexpected token (3:14))"),
    ).toEqual({
      file: "src/bot.js",
      line: 3,
    });
    expect(
      locateInMessage(
        "ningún COMMAND válido en 9 observaciones (runtime: src/bot.py, línea 6: NameError: name 'v' is not defined)",
      ),
    ).toEqual({ file: "src/bot.py", line: 6 });
  });

  it("hook ausente: fallo del usuario en la prueba de protocolo, sin marca técnica", () => {
    const d = diagnoseBuild({
      state: "rejected",
      stages: stagesFailing(
        "protocol_test",
        "tu clase Bot no implementa on_observation(self, observation): sin él el bot no hace nada en la batalla. ¿Quisiste decir «on_observaton»? Renómbralo a «on_observation». [timeout_reason=bot_crash]",
      ),
    })!;
    expect(d.fault).toBe("user");
    expect(d.detail).toMatch(/¿Quisiste decir «on_observaton»\?/);
    expect(d.detail).not.toMatch(/timeout_reason/);
  });

  it("NUNCA culpa al código de un fallo de la plataforma", () => {
    for (const rejectionReason of [
      "build no verificable: [sandbox_start_timeout] el sandbox no arrancó",
      "sandbox no verificado: etapa(s) de ejecución no ejecutable(s) [protocol_test]",
    ]) {
      expect(diagnoseBuild({ state: "rejected", rejectionReason, stages: [] })!.fault, rejectionReason).toBe(
        "infrastructure",
      );
    }
    expect(
      diagnoseBuild({ state: "rejected", stages: stagesFailing("sign", "no hay artefacto que firmar") })!.fault,
    ).toBe("infrastructure");
    expect(
      diagnoseBuild({ state: "rejected", stages: stagesFailing("dependencies", "error interno en etapa: boom") })!
        .fault,
    ).toBe("infrastructure");
  });

  it("sólo hay diagnóstico para versiones rechazadas", () => {
    expect(diagnoseBuild({ state: "validated", stages: [] })).toBeNull();
  });

  it("en «Mis bots»: dice que la vN NO está publicada, qué versión sigue en batallas y carga el código para corregirlo", async () => {
    const versions = [
      { version: 1, state: "published", runtime: "python", loadoutRevision: 2 },
      {
        version: 2,
        state: "rejected",
        runtime: "python",
        loadoutRevision: 2,
        rejectionReason: "static_analysis: src/bot.py (SyntaxError: invalid syntax (linea 3))",
      },
    ];
    apiMock.mockImplementation(async (method: string, path: string) => {
      if (path.startsWith("/bots?")) return { items: [{ id: "b1", name: "Tanque", visibility: "private" }] };
      if (path === "/bots/b1/versions") return versions;
      if (path === "/bots/b1/loadouts") return [LOADOUT];
      if (path === "/bots/b1/versions/2/builds")
        return [
          {
            id: "bd2",
            version: 2,
            status: "failed",
            stages: [
              {
                name: "static_analysis",
                status: "failed",
                message:
                  "fichero(s) no analizables (AST), se rechaza fail-closed: src/bot.py (SyntaxError: invalid syntax (linea 3))",
              },
            ],
          },
        ];
      if (path === "/bots/b1/versions/2/files")
        return { version: 2, packaged: false, files: [{ path: "src/bot.py", content: "codigo roto" }] };
      return [];
    });
    renderBots();
    await userEvent.click(await screen.findByRole("button", { name: "Tanque" }));
    const diag = await screen.findByTestId("build-diagnosis");
    expect(diag.getAttribute("data-fault")).toBe("user");
    expect(within(diag).getByTestId("build-diagnosis-location").textContent).toMatch(/src\/bot\.py, línea 3/);
    expect(within(diag).getByTestId("build-diagnosis-not-published").textContent).toMatch(
      /v2 NO está publicada.*Sigue en juego la v1 publicada/,
    );
    expect(screen.getByTestId("in-battles-1")).toBeTruthy();
    expect(screen.getByTestId("in-battles").textContent).toMatch(/usan la v1/);
    await userEvent.click(within(diag).getByTestId("build-diagnosis-fix"));
    await waitFor(() => expect((screen.getByLabelText("codigo") as HTMLTextAreaElement).value).toBe("codigo roto"));
    expect(screen.getByTestId("editing-from").textContent).toMatch(
      /código de v2: al subirlo se crea la v3; v2 no cambia/,
    );
  });
});

describe("B6 · versionado", () => {
  it("la versión en batallas es la publicada más alta, aunque la última esté rechazada", () => {
    expect(
      versionInBattles([
        { version: 1, state: "published" },
        { version: 2, state: "rejected" },
        { version: 3, state: "published" },
        { version: 4, state: "draft" },
      ]),
    ).toBe(3);
    expect(versionInBattles([{ version: 1, state: "rejected" }])).toBeUndefined();
  });
});

describe("G-15 · el editor web no destruye un paquete multi-fichero", () => {
  function detailBackend(packaged: boolean) {
    apiMock.mockImplementation(async (_m: string, path: string) => {
      if (path === "/bots/b1") return { id: "b1", name: "Tanque", ownerId: "u1", visibility: "private", createdAt: "" };
      if (path === "/bots/b1/versions")
        return [{ botId: "b1", version: 1, state: "published", runtime: "python", loadoutRevision: 2, createdAt: "" }];
      if (path === "/bots/b1/loadouts") return [];
      if (path === "/bots/b1/versions/1")
        return { version: 1, state: "published", runtime: "python", canReadSource: true, childVersions: [] };
      if (path === "/bots/b1/versions/1/files")
        return {
          version: 1,
          packaged,
          files: [
            { path: "requirements.txt", content: "arena-sdk==0.1.0\n" },
            { path: "src/bot.py", content: "from util import x" },
            ...(packaged ? [{ path: "src/util.py", content: "x = 1" }] : []),
          ],
        };
      return [];
    });
  }

  it("paquete subido como {files}: no se ofrece «Guardar como versión nueva» y se explica por qué", async () => {
    detailBackend(true);
    render(<BotDetailPage botId="b1" meId="u1" initialTab="code" />);
    expect((await screen.findByTestId("multi-file-locked")).textContent).toMatch(/perdería el resto/);
    expect(screen.queryByTestId("save-as-new")).toBeNull();
  });

  it("código pegado (un fichero): sí se puede editar en una versión nueva", async () => {
    detailBackend(false);
    render(<BotDetailPage botId="b1" meId="u1" initialTab="code" />);
    expect(await screen.findByTestId("save-as-new")).toBeTruthy();
    expect(screen.queryByTestId("multi-file-locked")).toBeNull();
  });
});
