# Sandbox-escape 03 · fork bomb.
# Objetivo: agotar los PIDs del host y degradar a otras batallas.
# Debe FALLAR/contenerse: --pids-limit acota los procesos; el resto de forks fallan y el
# contenedor se mata por deadline sin afectar al motor.
import os
import sys

count = 0
limited = False
try:
    while True:
        pid = os.fork()
        if pid == 0:
            # El hijo no debe seguir bombardeando: sale de inmediato para que el
            # marcador lo emita solo el proceso original.
            os._exit(0)
        count += 1
        if count > 100000:
            print("ESCAPE-OK fork sin límite: PIDs no acotados")  # NO debería ocurrir
            break
except Exception as e:
    limited = True
    print(f"fork limitado tras {count} -> {type(e).__name__}: {e}")

# Marcador POSITIVO (R1.6). Si el contenedor muere por el límite antes de llegar aquí,
# el harness lo acepta por el código de salida declarado en manifest.json (killExitCodes).
if limited:
    print("SANDBOX-BLOCKED 03_fork_bomb")
    sys.stdout.flush()
