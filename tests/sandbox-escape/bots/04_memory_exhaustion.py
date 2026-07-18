# Sandbox-escape 04 · agotamiento de memoria.
# Objetivo: consumir toda la RAM del host (DoS).
# Debe FALLAR/contenerse: --memory acota la RAM; el OOM killer mata SOLO a este contenedor.
import sys

blobs = []
limited = False
try:
    while True:
        blobs.append(bytearray(50 * 1024 * 1024))  # 50 MB por iteración
        allocated = len(blobs) * 50
        print(f"asignados {allocated} MB")
        if allocated > 4096:  # > 4 GB pese al --memory 256m
            print("ESCAPE-OK memoria sin límite")  # NO debería ocurrir
            break
except Exception as e:
    limited = True
    print(f"memoria limitada -> {type(e).__name__}: {e}")

# Marcador POSITIVO (R1.6). Lo normal es que el OOM killer mate el contenedor antes de
# llegar aquí: ese caso lo cubre killExitCodes (137) en manifest.json.
if limited:
    print("SANDBOX-BLOCKED 04_memory_exhaustion")
    sys.stdout.flush()
