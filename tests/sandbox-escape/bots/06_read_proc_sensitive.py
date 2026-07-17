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
# Rutas que existir es normal y no filtran nada del host: no cuentan como fuga.
BENIGN = {"/proc/self/status", "/proc/sys/kernel/random/boot_id"}

import os
leaks = 0
for p in TARGETS:
    try:
        if os.path.isdir(p):
            entries = os.listdir(p)
            if entries:
                leaks += 1
                print(f"LEAK {p} -> {entries}")
            else:
                print(f"dir {p} vacío (sin secretos montados)")
            continue
        with open(p, "rb") as f:
            data = f.read(256)
        if p in BENIGN:
            print(f"legible pero inocuo {p}")
        else:
            leaks += 1
            print(f"LEAK {p} -> {data[:64]!r}")  # NO debería ocurrir
    except Exception as e:
        print(f"blocked {p} -> {type(e).__name__}: {e}")

# Marcador POSITIVO (R1.6): ninguna ruta sensible reveló contenido del host.
if leaks == 0:
    print("SANDBOX-BLOCKED 06_read_proc_sensitive")
