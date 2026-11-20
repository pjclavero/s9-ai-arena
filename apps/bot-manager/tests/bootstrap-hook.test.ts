/**
 * UX-04 (G-05) · el bootstrap Python REAL (sandbox-bootstrap/bootstrap.py) rechaza
 * un bot que no sobrescribe el hook efectivo `on_observation` — p. ej. porque está
 * mal escrito — y acepta un bot quieto que sí lo implementa y devuelve {}.
 *
 * Se ejecuta el fichero del repo con el SDK REAL (sdks/python) en un python3 del
 * anfitrión, cortando sólo la llamada final a `main()` (que descargaría un
 * artefacto) y sustituyendo `fail` (que lo notificaría al anfitrión del sandbox)
 * por una salida observable. La prueba de extremo a extremo con la imagen de
 * runtime está en build-sandbox-docker.test.ts (opt-in Docker).
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP = readFileSync(join(here, "..", "src", "sandbox-bootstrap", "bootstrap.py"), "utf8");
const SDK = join(here, "..", "..", "..", "sdks", "python");

function checkHook(userCode: string): { kind: string; detail: string } | { ok: true } {
  const body = BOOTSTRAP.replace(/\nmain\(\)\s*$/, "\n");
  expect(body).not.toBe(BOOTSTRAP); // el corte de main() tiene que haber ocurrido
  const harness = `${body}
import json as _json
def fail(kind, detail, code):
    print(_json.dumps({"kind": kind, "detail": str(detail)}))
    sys.exit(0)
# El transporte no interviene en la comprobación: si websocket-client no está
# instalado en el anfitrión de CI, basta un módulo vacío para importar el SDK.
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
print(_json.dumps({"ok": True}))
`;
  const r = spawnSync("python3", ["-c", harness], {
    env: { PYTHONPATH: SDK, PATH: process.env.PATH ?? "" },
    encoding: "utf8",
  });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

describe("UX-04 · bootstrap.py exige el hook on_observation", () => {
  it("hook mal escrito (on_observaton) → rechazo con sugerencia", () => {
    const r = checkHook(`from arena_sdk import ArenaBot
class Torpe(ArenaBot):
    def on_observaton(self, observation):
        return {"move": {"throttle": 1.0}}
`);
    expect(r).toMatchObject({ kind: "hook" });
    const detail = (r as { detail: string }).detail;
    expect(detail).toMatch(/tu clase Torpe no implementa on_observation/);
    expect(detail).toMatch(/¿Quisiste decir «on_observaton»\?/);
  });

  it("estilo JS en Python (onObservation) → rechazo con sugerencia", () => {
    const r = checkHook(`from arena_sdk import ArenaBot
class Camello(ArenaBot):
    def onObservation(self, observation):
        return {}
`);
    expect((r as { detail: string }).detail).toMatch(/¿Quisiste decir «onObservation»\?/);
  });

  it("clase vacía → rechazo sin sugerencia inventada", () => {
    const r = checkHook(`from arena_sdk import ArenaBot
class Vacio(ArenaBot):
    pass
`);
    expect(r).toMatchObject({ kind: "hook" });
    expect((r as { detail: string }).detail).not.toMatch(/Quisiste/);
  });

  it("bot quieto que SÍ implementa el hook y devuelve {} → pasa", () => {
    expect(
      checkHook(`from arena_sdk import ArenaBot
class Quieto(ArenaBot):
    def on_observation(self, observation):
        return {}
`),
    ).toEqual({ ok: true });
  });

  it("hook heredado de una clase intermedia del usuario → pasa", () => {
    expect(
      checkHook(`from arena_sdk import ArenaBot
class Base(ArenaBot):
    def on_observation(self, observation):
        return {"move": {"throttle": 0.5}}
class Hijo(Base):
    pass
`),
    ).toEqual({ ok: true });
  });

  it("hook asignado en la instancia (__init__) → pasa", () => {
    expect(
      checkHook(`from arena_sdk import ArenaBot
class Dinamico(ArenaBot):
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.on_observation = lambda observation: {}
`),
    ).toEqual({ ok: true });
  });
});
