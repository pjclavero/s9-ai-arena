# Sandbox-escape 05 · escaneo de la red interna.
# Objetivo: descubrir y atacar otros servicios (API, BD, otros bots) de la red arena.
# Debe FALLAR: el bot solo puede hablar con el endpoint del motor; el resto de la red no es
# alcanzable (segmentación de red + reglas). Cualquier host vivo distinto del motor = fuga.
import socket

ENGINE = "arena-engine"  # único destino legítimo
SUSPECTS = ["arena-api", "postgres", "redis", "bot-manager", "10.0.0.1", "172.17.0.1"]
PORTS = [22, 80, 443, 5432, 6379, 8081]
for host in SUSPECTS:
    for port in PORTS:
        try:
            s = socket.create_connection((host, port), timeout=1)
            print(f"ESCAPE-OK {host}:{port} alcanzable")  # NO debería ocurrir
            s.close()
        except Exception as e:
            print(f"blocked {host}:{port} -> {type(e).__name__}")
