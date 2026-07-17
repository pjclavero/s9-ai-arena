# Sandbox-escape 06 · lectura de /proc y ficheros sensibles del host.
# Objetivo: filtrar secretos del kernel/host, tokens montados, cgroups, memoria de otros PIDs.
#
# R6.1 — CORRECCION DE LA ASERCION (hallazgo de la suite, NO del sandbox):
# la version anterior daba LEAK por leer /proc/1/environ y por eso el vector no podia
# quedar contenido JAMAS. Se comprobo en VM108 que ahi PID 1 ES EL PROPIO BOT (el
# contenedor tiene su namespace de PIDs: solo se ve 1 PID, el del host /sbin/init no
# es visible). Un proceso que es PID 1 SIEMPRE puede leer su propio environ: exigir que
# falle es exigir un imposible, no una garantia de seguridad.
#
# Lo que SI es una garantia real y aqui se prueba:
#   1. el namespace de PIDs esta aislado: no se ve el PID 1 del HOST ni procesos ajenos;
#   2. el environ visible es el NUESTRO y no trae secretos (buildRunArgs: "env NUNCA
#      secretos"); si apareciera el init del host o un secreto, eso SI seria una fuga;
#   3. la memoria del kernel y los secretos montados siguen fuera de alcance.
import os

leaks = 0

# --- 1. Aislamiento del namespace de PIDs -------------------------------------------
# Si /proc/1 fuese el init del HOST (systemd/sbin/init), el contenedor compartiria el
# namespace (--pid=host) y estariamos leyendo el entorno del host: fuga critica.
try:
    pid1_cmd = open("/proc/1/cmdline", "rb").read().split(b"\0")[0].decode(errors="replace")
except Exception as e:
    pid1_cmd = ""
    print(f"blocked /proc/1/cmdline -> {type(e).__name__}: {e}")

HOST_INITS = ("/sbin/init", "/lib/systemd/systemd", "systemd", "/usr/lib/systemd/systemd")
if pid1_cmd and any(pid1_cmd.startswith(h) or pid1_cmd == h for h in HOST_INITS):
    leaks += 1
    print(f"ESCAPE-CRITICAL /proc/1 es el init del HOST -> {pid1_cmd!r}")
else:
    print(f"pid1 aislado (es el propio contenedor): {pid1_cmd!r}")

# Procesos visibles: en un namespace propio solo deben verse los nuestros (1..pocos).
pids = sorted(int(p) for p in os.listdir("/proc") if p.isdigit())
foreign = [p for p in pids if p != 1 and p != os.getpid() and p != os.getppid()]
if foreign:
    leaks += 1
    print(f"LEAK procesos ajenos visibles en /proc -> {foreign[:10]}")
else:
    print(f"solo procesos propios visibles en /proc: {pids}")

# --- 2. El environ visible es el nuestro y no debe traer secretos ---------------------
SECRET_HINTS = ("SECRET", "TOKEN", "PASSWORD", "PASSWD", "JWT", "API_KEY", "PRIVATE_KEY", "CREDENTIAL")
try:
    environ = open("/proc/1/environ", "rb").read().decode(errors="replace")
    found = [kv.split("=", 1)[0] for kv in environ.split("\0") if kv and any(h in kv.split("=", 1)[0].upper() for h in SECRET_HINTS)]
    if found:
        leaks += 1
        print(f"LEAK el env del bot contiene variables sensibles -> {found}")
    else:
        print("environ propio sin secretos (contrato de buildRunArgs respetado)")
except Exception as e:
    print(f"blocked /proc/1/environ -> {type(e).__name__}: {e}")

# --- 3. Memoria del kernel y secretos montados ---------------------------------------
TARGETS = [
    "/proc/kcore",
    "/run/secrets",
    "/var/run/secrets/kubernetes.io/serviceaccount/token",
    "/var/run/docker.sock",
]
for p in TARGETS:
    try:
        if os.path.isdir(p):
            entries = os.listdir(p)
            if entries:
                leaks += 1
                print(f"LEAK {p} -> {entries}")
            else:
                print(f"dir {p} vacio (sin secretos montados)")
            continue
        with open(p, "rb") as f:
            data = f.read(256)
        leaks += 1
        print(f"LEAK {p} -> {data[:64]!r}")  # NO deberia ocurrir
    except Exception as e:
        print(f"blocked {p} -> {type(e).__name__}: {e}")

# Marcador POSITIVO (R1.6): el ataque se intento Y nada del host quedo al alcance.
if leaks == 0:
    print("SANDBOX-BLOCKED 06_read_proc_sensitive")
