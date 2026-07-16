# Sandbox-escape 04 · agotamiento de memoria.
# Objetivo: consumir toda la RAM del host (DoS).
# Debe FALLAR/contenerse: --memory acota la RAM; el OOM killer mata SOLO a este contenedor.
blobs = []
try:
    while True:
        blobs.append(bytearray(50 * 1024 * 1024))  # 50 MB por iteración
        allocated = len(blobs) * 50
        print(f"asignados {allocated} MB")
        if allocated > 4096:  # > 4 GB pese al --memory 256m
            print("ESCAPE-OK memoria sin límite")  # NO debería ocurrir
            break
except Exception as e:
    print(f"memoria limitada -> {type(e).__name__}: {e}")
