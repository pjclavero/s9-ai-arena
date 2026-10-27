/**
 * UX-F (DEF-R4) · política del hook según DÓNDE arranca el bot.
 *
 *  - BUILD (`S9_HOOK_POLICY` ausente o `reject`): una versión NUEVA sin hook se
 *    rechaza (UX-04), con el informe `hook`.
 *  - BATALLA (`warn`): una versión YA publicada sin hook NO falla: sigue
 *    arrancando (jugará quieta, como hasta ahora) y deja el aviso `hook_missing`
 *    para el diagnóstico de su dueño.
 *  - Alineación Python/JS: sobrescribir el despachador (`_handle_observation` /
 *    `handleObservation`) cuenta en los dos.
 *
 * Se ejecuta el código REAL de los dos bootstraps: el de Python con el SDK de
 * sdks/python en un python3 del anfitrión (como bootstrap-hook.test.ts); el de
 * Node, el bloque de checkHook tal cual con el ArenaBot real de sdks/javascript.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ArenaBot } from "../../../sdks/javascript/src/index.js";
import { SandboxHost } from "../src/sandbox-host.js";
import { launchSpecForBot } from "../src/bot-launch.js";

const here = dirname(fileURLToPath(import.meta.url));
const BOOT_PY = readFileSync(join(here, "..", "src", "sandbox-bootstrap", "bootstrap.py"), "utf8");
const BOOT_MJS = readFileSync(join(here, "..", "src", "sandbox-bootstrap", "bootstrap.mjs"), "utf8");
const SDK_PY = join(here, "..", "..", "..", "sdks", "python");

type Outcome = { failed?: { kind: string; detail: string }; reports: { kind: string; detail: string }[] };

function pyCheck(userCode: string, policy?: string): Outcome {
  const body = BOOT_PY.replace(/\nmain\(\)\s*$/, "\n");
  expect(body).not.toBe(BOOT_PY);
  const harness = `${body}
import json as _json
_reports = []
def report(kind, detail):
    _reports.append({"kind": kind, "detail": str(detail)})
def fail(kind, detail, code):
    print(_json.dumps({"failed": {"kind": kind, "detail": str(detail)}, "reports": _reports}))
    sys.exit(0)
import types as _types
try:
    import websocket  # noqa: F401
except ImportError:
    sys.modules["websocket"] = _types.ModuleType("websocket")
from arena_sdk import ArenaBot
_ns = {}
exec(compile(${JSON.stringify(userCode)}, "bot.py", "exec"), _ns)
_cls = [v for v in _ns.values() if isinstance(v, type) and issubclass(v, ArenaBot) and v is not ArenaBot][-1]
check_hook(_cls("bot_test"), ArenaBot)
print(_json.dumps({"reports": _reports}))
`;
  const r = spawnSync("python3", ["-c", harness], {
    env: { PYTHONPATH: SDK_PY, PATH: process.env.PATH ?? "", ...(policy ? { S9_HOOK_POLICY: policy } : {}) },
    encoding: "utf8",
  });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

/** El bloque checkHook de bootstrap.mjs, ejecutado tal cual. */
async function jsCheck(chosen: new (id: string) => ArenaBot, policy?: string): Promise<Outcome> {
  const start = BOOT_MJS.indexOf("const HOOK = ");
  const end = BOOT_MJS.indexOf("\nlet bot;");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const out: Outcome = { reports: [] };
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor;
  const run = new AsyncFunction(
    "env",
    "report",
    "fail",
    "chosen",
    "ArenaBot",
    "bot",
    `${BOOT_MJS.slice(start, end)}\nawait checkHook(bot);`,
  );
  await run(
    policy ? { S9_HOOK_POLICY: policy } : {},
    async (kind: string, detail: string) => void out.reports.push({ kind, detail }),
    async (kind: string, detail: string) => void (out.failed = { kind, detail }),
    chosen,
    ArenaBot,
    new chosen("bot_test"),
  );
  return out;
}

const PY_SIN_HOOK = `from arena_sdk import ArenaBot
class Torpe(ArenaBot):
    def on_observaton(self, observation):
        return {"move": {"throttle": 1.0}}
`;

class TorpeJs extends ArenaBot {
  onObservaton() {
    return { move: { throttle: 1 } };
  }
}

describe("DEF-R4 · BUILD: una versión nueva sin hook se rechaza", () => {
  it("Python sin S9_HOOK_POLICY (build) → fail(hook)", () => {
    const r = pyCheck(PY_SIN_HOOK);
    expect(r.failed?.kind).toBe("hook");
  });
  it("Python con S9_HOOK_POLICY=reject → fail(hook)", () => {
    expect(pyCheck(PY_SIN_HOOK, "reject").failed?.kind).toBe("hook");
  });
  it("Node sin política (build) → fail(hook)", async () => {
    expect((await jsCheck(TorpeJs)).failed?.kind).toBe("hook");
  });
  it("launchSpecForBot: el build arranca con S9_HOOK_POLICY=reject por defecto", () => {
    const spec = launchSpecForBot({
      runtime: "python",
      imageDigest: `ghcr.io/example/runtime-python@sha256:${"1a".repeat(32)}`,
      botId: "b",
      version: 1,
      sessionId: "build-x",
      network: "arena",
      wsUrl: "ws://h:1",
      battleToken: "t",
      botHandle: "bot_0",
      offer: { url: "http://h/s9/artifact/x", token: "k", sha256: "0".repeat(64) },
    });
    expect(spec.env.S9_HOOK_POLICY).toBe("reject");
  });
});

describe("DEF-R4 · BATALLA: una versión publicada sin hook juega y avisa", () => {
  it("Python con S9_HOOK_POLICY=warn → no falla; aviso hook_missing con la explicación", () => {
    const r = pyCheck(PY_SIN_HOOK, "warn");
    expect(r.failed).toBeUndefined();
    expect(r.reports).toHaveLength(1);
    expect(r.reports[0].kind).toBe("hook_missing");
    expect(r.reports[0].detail).toMatch(/no implementa on_observation\(self, observation\): tu código no decide nada/);
  });
  it("Node con S9_HOOK_POLICY=warn → no falla; aviso hook_missing", async () => {
    const r = await jsCheck(TorpeJs, "warn");
    expect(r.failed).toBeUndefined();
    expect(r.reports.map((x) => x.kind)).toEqual(["hook_missing"]);
    expect(r.reports[0].detail).toMatch(/no implementa onObservation\(observation\): tu código no decide nada/);
  });
  it("SandboxHost: el aviso NO es un fallo de arranque; se expone en warnings()", async () => {
    const host = await SandboxHost.start({ advertiseHost: "127.0.0.1", bindHost: "127.0.0.1", port: 0 });
    try {
      const offer = host.offerArtifact(Buffer.from("x"), "0".repeat(64));
      const post = (kind: string) =>
        fetch(offer.url + "/report", {
          method: "POST",
          headers: { "x-s9-artifact-token": offer.token, "content-type": "application/json" },
          body: JSON.stringify({ kind, detail: "tu clase Torpe no implementa on_observation" }),
        });
      expect((await post("hook_missing")).status).toBe(204);
      expect(offer.signals.failure()).toBeNull();
      expect(offer.signals.warnings?.().map((w) => w.kind)).toEqual(["hook_missing"]);
      // Un fallo de verdad sigue siendo un fallo.
      await post("import");
      expect(offer.signals.failure()?.kind).toBe("import");
    } finally {
      await host.close();
    }
  });
});

describe("DEF-R4 · alineación Python/JS: el despachador también cuenta", () => {
  it("Python que sobrescribe _handle_observation → pasa", () => {
    const r = pyCheck(`from arena_sdk import ArenaBot
class Bajo(ArenaBot):
    def _handle_observation(self, observation):
        pass
`);
    expect(r).toEqual({ reports: [] });
  });
  it("Node que sobrescribe handleObservation → pasa (antes se rechazaba)", async () => {
    class BajoJs extends ArenaBot {}
    (BajoJs.prototype as unknown as Record<string, unknown>).handleObservation = function () {};
    const r = await jsCheck(BajoJs);
    expect(r.failed).toBeUndefined();
    expect(r.reports).toEqual([]);
  });
});
