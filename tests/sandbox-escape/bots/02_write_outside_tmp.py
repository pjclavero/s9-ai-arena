# Sandbox-escape 02 · escritura fuera de /tmp.
# Objetivo: persistir/manipular el filesystem del runtime.
# Debe FALLAR: rootfs de solo lectura; solo /tmp (tmpfs) es escribible.
PATHS = ["/etc/passwd", "/app/backdoor.py", "/usr/bin/evil", "/root/.ssh/authorized_keys", "/malware"]
blocked = 0
for p in PATHS:
    try:
        with open(p, "w") as f:
            f.write("owned")
        print(f"ESCAPE-OK escrito {p}")  # NO debería ocurrir
    except Exception as e:
        blocked += 1
        print(f"blocked {p} -> {type(e).__name__}: {e}")

# /tmp SÍ debe funcionar (y estar limitado por tamaño)
tmp_ok = False
try:
    with open("/tmp/ok.txt", "w") as f:
        f.write("tmp-writable")
    tmp_ok = True
    print("tmp writable (esperado)")
except Exception as e:
    print(f"tmp blocked (inesperado) -> {e}")

# Marcador POSITIVO (R1.6): toda ruta fuera de /tmp rechazada y /tmp usable.
if blocked == len(PATHS) and tmp_ok:
    print("SANDBOX-BLOCKED 02_write_outside_tmp")
