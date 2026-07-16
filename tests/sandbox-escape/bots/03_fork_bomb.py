# Sandbox-escape 03 · fork bomb.
# Objetivo: agotar los PIDs del host y degradar a otras batallas.
# Debe FALLAR/contenerse: --pids-limit acota los procesos; el resto de forks fallan y el
# contenedor se mata por deadline sin afectar al motor.
import os

count = 0
try:
    while True:
        pid = os.fork()
        count += 1
        if count > 100000:
            print("ESCAPE-OK fork sin límite: PIDs no acotados")  # NO debería ocurrir
            break
except Exception as e:
    print(f"fork limitado tras {count} -> {type(e).__name__}: {e}")
