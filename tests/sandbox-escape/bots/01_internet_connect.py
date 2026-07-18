# Sandbox-escape 01 · intento de conexión a Internet.
# Objetivo del atacante: exfiltrar datos / recibir órdenes desde fuera de la red arena.
# Debe FALLAR: la red del contenedor es solo 'arena' sin DNS externo ni ruta a Internet.
import socket

TARGETS = [("1.1.1.1", 53), ("8.8.8.8", 443), ("example.com", 80)]
blocked = 0
for host, port in TARGETS:
    try:
        s = socket.create_connection((host, port), timeout=3)
        print(f"ESCAPE-OK conectado a {host}:{port}")  # NO debería ocurrir
        s.close()
    except Exception as e:
        blocked += 1
        print(f"blocked {host}:{port} -> {type(e).__name__}: {e}")

# Marcador POSITIVO (R1.6): prueba de que el ataque se intentó Y fue contenido. Si el
# bot no llega a ejecutarse, esta línea no aparece y el harness declara el vector NO
# PROBADO en vez de darlo por bueno (ERR-SEC-04).
if blocked == len(TARGETS):
    print("SANDBOX-BLOCKED 01_internet_connect")
