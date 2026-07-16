# Sandbox-escape 06 · lectura de /proc y ficheros sensibles del host.
# Objetivo: filtrar secretos del kernel/host, tokens montados, cgroups, memoria de otros PIDs.
# Debe FALLAR o no revelar nada útil: sin capabilities, con seccomp restrictivo y sin
# secretos montados, estas rutas o no existen, o no son legibles, o no contienen secretos.
TARGETS = [
    "/proc/1/environ",       # entorno del PID 1 (posibles secretos)
    "/proc/kcore",           # memoria del kernel
    "/proc/sys/kernel/random/boot_id",
    "/proc/self/status",
    "/run/secrets",          # secretos montados (no debe existir)
    "/var/run/secrets/kubernetes.io/serviceaccount/token",
]
import os
for p in TARGETS:
    try:
        if os.path.isdir(p):
            print(f"dir {p} -> {os.listdir(p)}")
            continue
        with open(p, "rb") as f:
            data = f.read(256)
        print(f"LEAK {p} -> {data[:64]!r}")  # inspeccionar manualmente si hay secretos
    except Exception as e:
        print(f"blocked {p} -> {type(e).__name__}: {e}")
