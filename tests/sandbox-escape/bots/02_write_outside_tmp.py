# Sandbox-escape 02 · escritura fuera de /tmp.
# Objetivo: persistir/manipular el filesystem del runtime.
# Debe FALLAR: rootfs de solo lectura; solo /tmp (tmpfs) es escribible.
PATHS = ["/etc/passwd", "/app/backdoor.py", "/usr/bin/evil", "/root/.ssh/authorized_keys", "/malware"]
for p in PATHS:
    try:
        with open(p, "w") as f:
            f.write("owned")
        print(f"ESCAPE-OK escrito {p}")  # NO debería ocurrir
    except Exception as e:
        print(f"blocked {p} -> {type(e).__name__}: {e}")

# /tmp SÍ debe funcionar (y estar limitado por tamaño)
try:
    with open("/tmp/ok.txt", "w") as f:
        f.write("tmp-writable")
    print("tmp writable (esperado)")
except Exception as e:
    print(f"tmp blocked (inesperado) -> {e}")
