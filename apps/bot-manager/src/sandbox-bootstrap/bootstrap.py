# S9 AI Arena · arranque del código de usuario dentro del runtime Python (DEV-A, TD-001).
#
# Lo ejecuta el contenedor del sandbox como `python -c <este fichero>` (la imagen de
# runtime tiene ENTRYPOINT ["python"]). NO es código del usuario: es de la plataforma
# y no pasa por el análisis estático del pipeline.
#
# Contrato (entorno; nunca secretos de la plataforma):
#   ARTIFACT_URL     URL HTTP del artefacto en el SandboxHost (red arena)
#   ARTIFACT_TOKEN   token de esta sesión (cabecera x-s9-artifact-token)
#   ARTIFACT_SHA256  sha256 esperado de los bytes canónicos (arena-artifact/v1)
#   WS_URL, BATTLE_TOKEN, BOT_ID   conexión al ProtocolServer (arena/1)
#
# Pasos: descarga -> verifica sha256 -> materializa en /tmp/bot (tmpfs) -> carga el
# SDK -> señal `ready` (TD-034) -> carga el fichero de entrada -> instancia la
# subclase de ArenaBot -> run(WS_URL, BATTLE_TOKEN).
# Cualquier fallo se notifica a ARTIFACT_URL + "/report" (texto <= 4 KB) y sale != 0.
import hashlib
import importlib.util
import inspect
import json
import os
import sys
import traceback
import urllib.request

ROOT = "/tmp/bot"


def report(kind, detail):
    try:
        body = json.dumps({"kind": kind, "detail": str(detail)[-4000:]}).encode("utf-8")
        req = urllib.request.Request(
            os.environ["ARTIFACT_URL"] + "/report",
            data=body,
            method="POST",
            headers={
                "x-s9-artifact-token": os.environ.get("ARTIFACT_TOKEN", ""),
                "content-type": "application/json",
            },
        )
        urllib.request.urlopen(req, timeout=5).read()
    except Exception:
        pass


def signal_ready():
    try:
        req = urllib.request.Request(
            os.environ["ARTIFACT_URL"] + "/ready",
            data=b"",
            method="POST",
            headers={"x-s9-artifact-token": os.environ.get("ARTIFACT_TOKEN", "")},
        )
        urllib.request.urlopen(req, timeout=5).read()
    except Exception:
        pass


def fail(kind, detail, code):
    report(kind, detail)
    print("s9-bootstrap: %s: %s" % (kind, detail), file=sys.stderr)
    sys.exit(code)


def parse_artifact(data):
    magic = b"arena-artifact/v1\n"
    if not data.startswith(magic):
        raise ValueError("cabecera arena-artifact/v1 ausente")
    pos = len(magic)
    files = []

    def read_chunk(p):
        nl = data.index(b"\n", p)
        n = int(data[p:nl].decode("ascii"))
        start = nl + 1
        end = start + n
        if end + 1 > len(data) or data[end:end + 1] != b"\n":
            raise ValueError("entrada truncada")
        return data[start:end], end + 1

    while pos < len(data):
        path_b, pos = read_chunk(pos)
        body, pos = read_chunk(pos)
        files.append((path_b.decode("utf-8"), body))
    return files


def safe_path(rel):
    if not rel or rel.startswith("/") or "\\" in rel or any(c < " " for c in rel):
        raise ValueError("ruta no permitida: %r" % rel)
    for seg in rel.split("/"):
        if seg in ("", ".", ".."):
            raise ValueError("ruta no permitida: %r" % rel)
    return os.path.join(ROOT, rel)


# UX-04 (G-05) · hook efectivo. ArenaBot.on_observation devuelve {} («sin cambios»):
# una subclase que NO lo sobrescribe —p. ej. porque el método se llama
# `on_observaton`— arranca, hace HELLO y responde COMMAND válidos vacíos, y
# antes pasaba las 10 etapas sin hacer nada. Se exige que la clase (o un
# ancestro suyo distinto de ArenaBot) defina on_observation, o el despachador
# _handle_observation. Un bot quieto que SÍ lo implementa y devuelve {} pasa.
HOOK = "on_observation"
DISPATCH = "_handle_observation"


def _inherited(bot, base, name):
    # Sobre la INSTANCIA: un atributo asignado en __init__ también cuenta.
    bound = getattr(bot, name, None)
    return getattr(bound, "__func__", None) is getattr(base, name)


def check_hook(bot, base):
    cls = type(bot)
    if not (_inherited(bot, base, HOOK) and _inherited(bot, base, DISPATCH)):
        return
    import difflib

    own = sorted(
        {
            name
            for klass in cls.__mro__
            if klass is not base and klass is not object
            for name, value in vars(klass).items()
            if callable(value) and not name.startswith("__")
        }
        | {name for name, value in vars(bot).items() if callable(value)}
    )
    close = difflib.get_close_matches(HOOK, own, n=1, cutoff=0.6)
    hint = (" ¿Quisiste decir «%s»? Renómbralo a «%s»." % (close[0], HOOK)) if close else ""
    fail(
        "hook",
        "tu clase %s no implementa %s(self, observation): sin él el bot no hace nada en la batalla.%s"
        % (cls.__name__, HOOK, hint),
        11,
    )


def main():
    url = os.environ.get("ARTIFACT_URL")
    expected = os.environ.get("ARTIFACT_SHA256", "")
    if not url or not expected:
        fail("config", "faltan ARTIFACT_URL/ARTIFACT_SHA256", 2)
    try:
        req = urllib.request.Request(url, headers={"x-s9-artifact-token": os.environ.get("ARTIFACT_TOKEN", "")})
        data = urllib.request.urlopen(req, timeout=10).read()
    except Exception as e:
        fail("fetch", "no se pudo descargar el artefacto: %s" % e, 3)
    actual = hashlib.sha256(data).hexdigest()
    if actual != expected:
        fail("integrity", "sha256 del artefacto %s != esperado %s" % (actual, expected), 4)
    try:
        files = parse_artifact(data)
        for rel, body in files:
            dest = safe_path(rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "wb") as fh:
                fh.write(body)
    except Exception as e:
        fail("materialize", "artefacto inválido: %s" % e, 5)

    names = {rel for rel, _ in files}
    entry = None
    if "manifest.json" in names:
        try:
            with open(os.path.join(ROOT, "manifest.json"), "r", encoding="utf-8") as fh:
                entry = json.load(fh).get("entry")
        except Exception as e:
            fail("manifest", "manifest.json ilegible: %s" % e, 6)
    if not entry:
        entry = next((c for c in ("src/bot.py", "bot.py", "main.py") if c in names), None)
    if not entry or entry not in names:
        fail("entry", "no hay fichero de entrada (manifest.entry, src/bot.py, bot.py o main.py)", 6)

    entry_path = safe_path(entry)
    sys.path.insert(0, os.path.dirname(entry_path))
    sys.path.insert(0, ROOT)
    os.chdir(ROOT)
    try:
        from arena_sdk import ArenaBot
    except SystemExit:
        raise
    except BaseException:
        # El SDK es de la imagen de runtime: si no carga, es la plataforma (TD-034).
        fail("sdk", traceback.format_exc(), 10)

    # TD-034 · señal `ready`: runtime, artefacto verificado y SDK cargados. Se espera
    # la respuesta ANTES de ejecutar el código del usuario: lo anterior cuenta en el
    # reloj de la plataforma (SANDBOX_STARTUP_TIMEOUT_MS), lo posterior en el del bot
    # (BOT_EXECUTION_TIMEOUT_MS). Sin canal se sigue: el anfitrión lo tratará como
    # plataforma, nunca como culpa del bot.
    signal_ready()

    try:
        spec = importlib.util.spec_from_file_location("s9_user_bot", entry_path)
        module = importlib.util.module_from_spec(spec)
        sys.modules["s9_user_bot"] = module
        spec.loader.exec_module(module)
    except SystemExit:
        raise
    except BaseException:
        fail("import", traceback.format_exc(), 7)

    candidates = [
        obj
        for obj in vars(module).values()
        if inspect.isclass(obj)
        and issubclass(obj, ArenaBot)
        and obj is not ArenaBot
        and obj.__module__ == "s9_user_bot"
    ]
    chosen = getattr(module, "Bot", None)
    if not (inspect.isclass(chosen) and issubclass(chosen, ArenaBot) and chosen is not ArenaBot):
        if len(candidates) != 1:
            fail(
                "entry",
                "el fichero de entrada debe definir UNA subclase de arena_sdk.ArenaBot "
                "(o una llamada Bot); encontradas: %d" % len(candidates),
                8,
            )
        chosen = candidates[0]
    try:
        bot = chosen(os.environ.get("BOT_ID", "bot_sandbox"))
    except SystemExit:
        raise
    except BaseException:
        fail("runtime", traceback.format_exc(), 9)
    check_hook(bot, ArenaBot)
    try:
        bot.run(os.environ["WS_URL"], os.environ["BATTLE_TOKEN"])
    except SystemExit:
        raise
    except BaseException:
        fail("runtime", traceback.format_exc(), 9)


main()
