# Sandbox-escape 07 · intento de abrir el socket de Docker.
# Objetivo: si /var/run/docker.sock estuviera montado, controlar el daemon = escape total
# del host (crear un contenedor privilegiado con el rootfs del host montado).
# Debe FALLAR: el socket NUNCA se monta en contenedores de bot.
import socket
import os

SOCK = "/var/run/docker.sock"
if os.path.exists(SOCK):
    print("ESCAPE-CRITICAL docker.sock existe en el contenedor")  # NO debería ocurrir
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect(SOCK)
        s.sendall(b"GET /version HTTP/1.0\r\n\r\n")
        print("ESCAPE-CRITICAL respuesta:", s.recv(256))
    except Exception as e:
        print(f"docker.sock presente pero no usable -> {e}")
else:
    print("blocked docker.sock ausente (esperado)")
