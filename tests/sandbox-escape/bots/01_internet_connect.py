# Sandbox-escape 01 · intento de conexión a Internet.
# Objetivo del atacante: exfiltrar datos / recibir órdenes desde fuera de la red arena.
# Debe FALLAR: la red del contenedor es solo 'arena' sin DNS externo ni ruta a Internet.
import socket

TARGETS = [("1.1.1.1", 53), ("8.8.8.8", 443), ("example.com", 80)]
for host, port in TARGETS:
    try:
        s = socket.create_connection((host, port), timeout=3)
        print(f"ESCAPE-OK conectado a {host}:{port}")  # NO debería ocurrir
        s.close()
    except Exception as e:
        print(f"blocked {host}:{port} -> {type(e).__name__}: {e}")
