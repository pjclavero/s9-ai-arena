/**
 * UX-B · B4 — matriz de builds: cada caso con su mensaje y su categoría
 * (usuario / infraestructura), tal como lo verá el usuario en la web.
 *
 * Las etapas PURAS se ejecutan con el pipeline REAL de E6 (BuildPipeline) y se
 * diagnostica el build que produce. Las de EJECUCIÓN (sandbox) necesitan Docker:
 * sus mensajes se comprueban de extremo a extremo en
 * apps/bot-manager/tests/build-sandbox-docker.test.ts (job docker-e2e de la CI) y
 * aquí se usa el texto EXACTO que produce build-sandbox.ts para cada caso.
 */
import { describe, it, expect } from "vitest";
import { BuildPipeline } from "../../bot-manager/src/pipeline.js";
import { InMemoryBuildStore } from "../../bot-manager/src/store.js";
import { withConfig } from "../../bot-manager/src/config.js";
import { generateServiceKeypair } from "../../bot-manager/src/signing.js";
import { wrapSingleFile } from "../../api/src/services/source-package.js";
import type { SourceFile } from "../../bot-manager/src/types.js";
import { diagnoseBuild } from "../src/build-diagnosis.js";
import { PYTHON_TEMPLATE } from "../src/bot-templates.js";

const signer = generateServiceKeypair();

async function realBuild(files: SourceFile[], runtime: "python" | "node" = "python") {
  const b = await new BuildPipeline({ store: new InMemoryBuildStore(), config: withConfig(), signer }).run({
    botId: "bot_matrix",
    version: 1,
    ownerUserId: "u1",
    runtime,
    archetype: "gunner",
    files,
  });
  return diagnoseBuild({ state: b.botVersionState, rejectionReason: b.rejectionReason, stages: b.stages });
}

const py = (code: string) => wrapSingleFile("python", code);

describe("B4 · matriz de builds con el pipeline REAL (etapas puras)", () => {
  it("syntax error Python → usuario · análisis estático · fichero y línea", async () => {
    const d = await realBuild(py("from arena_sdk import ArenaBot\n\n\nclass Bot(ArenaBot)\n    pass\n"));
    expect(d).toMatchObject({ fault: "user", stage: "static_analysis", location: { file: "src/bot.py", line: 4 } });
  });

  it("syntax error JS → usuario · fichero y línea", async () => {
    const d = await realBuild(wrapSingleFile("node", "export default class Bot {\n  onObservation( {\n}\n"), "node");
    expect(d?.fault).toBe("user");
    expect(d?.location?.file).toBe("src/bot.js");
  });

  it("TypeScript pegado como JS → usuario · con la pista de TypeScript", async () => {
    const d = await realBuild(
      wrapSingleFile(
        "node",
        'import { ArenaBot, type CommandIntent } from "@arena/sdk";\nexport default class B extends ArenaBot {}\n',
      ),
      "node",
    );
    expect(d?.fault).toBe("user");
    expect(d?.detail).toMatch(/TypeScript/);
  });

  it("import prohibido → usuario · análisis estático · nombra el import", async () => {
    const d = await realBuild(py("import requests\nfrom arena_sdk import ArenaBot\n"));
    expect(d).toMatchObject({ fault: "user", stage: "static_analysis" });
    expect(d?.detail).toMatch(/requests/);
  });

  it("dependencia prohibida → usuario · dependencias · nombra la dependencia", async () => {
    const files = py(PYTHON_TEMPLATE).map((f) =>
      f.path.startsWith("requirements") ? { ...f, content: "arena-sdk==0.1.0\nrequests==2.32.3\n" } : f,
    );
    const d = await realBuild(files);
    expect(d).toMatchObject({ fault: "user", stage: "dependencies" });
    expect(d?.detail).toMatch(/requests/);
  });

  it("bot válido SIN sandbox disponible → INFRAESTRUCTURA («sandbox no verificado»), nunca culpa del código", async () => {
    const d = await realBuild(py(PYTHON_TEMPLATE));
    expect(d?.fault).toBe("infrastructure");
    expect(d?.title).toMatch(/no de tu código/);
  });
});

describe("B4 · matriz de builds · etapas de ejecución (texto exacto de build-sandbox.ts)", () => {
  const sandboxStage = (name: string, message: string) => [
    { name: "structure", status: "passed" },
    { name, status: "failed", message },
  ];
  const cases: { caso: string; reason?: string; stage?: string; message?: string; fault: string; expect?: RegExp }[] = [
    {
      caso: "hook incorrecto",
      stage: "protocol_test",
      message:
        "tu clase Bot no implementa on_observation(self, observation): sin él el bot no hace nada en la batalla. ¿Quisiste decir «on_observaton»? Renómbralo a «on_observation». [timeout_reason=bot_crash]",
      fault: "user",
      expect: /Quisiste decir/,
    },
    {
      caso: "timeout (bucle infinito al importar)",
      stage: "protocol_test",
      message:
        "el bot no completó el handshake (HELLO): el código del bot no completó el HELLO en 5000 ms desde que el agente estuvo listo (BOT_EXECUTION_TIMEOUT_MS) [timeout_reason=bot_execution_timeout]",
      fault: "user",
      expect: /HELLO/,
    },
    {
      caso: "excepción en tiempo de ejecución",
      stage: "protocol_test",
      message:
        "ningún COMMAND válido en 10 observaciones (el proceso salió con código 9; runtime: src/bot.py, línea 6: NameError: name 'velocidad' is not defined)",
      fault: "user",
      expect: /NameError/,
    },
    {
      caso: "COMMAND inválido",
      stage: "protocol_test",
      message:
        "mensaje(s) fuera de protocolo (3): COMMAND no cumple el esquema arena/1: /payload/move/throttle must be <= 1",
      fault: "user",
      expect: /throttle/,
    },
    {
      caso: "sandbox caído, reintentos agotados",
      reason:
        "build no verificable: el sandbox no pudo lanzar el contenedor: connect ECONNREFUSED [sandbox_start_failed]",
      fault: "infrastructure",
    },
  ];
  for (const c of cases) {
    it(`${c.caso} → ${c.fault}`, () => {
      const d = diagnoseBuild({
        state: "rejected",
        rejectionReason: c.reason ?? `${c.stage}: ${c.message}`,
        stages: c.stage ? sandboxStage(c.stage, c.message!) : [],
      })!;
      expect(d.fault).toBe(c.fault);
      if (c.expect) expect(d.detail).toMatch(c.expect);
      expect(d.detail).not.toMatch(/timeout_reason/);
    });
  }

  it("la excepción de ejecución señala fichero y línea", () => {
    const d = diagnoseBuild({
      state: "rejected",
      stages: sandboxStage("protocol_test", cases[2].message!),
    })!;
    expect(d.location).toEqual({ file: "src/bot.py", line: 6 });
  });
});
