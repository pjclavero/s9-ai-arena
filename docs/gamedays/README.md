# Game days — E12 · T12.3

Pruebas de caos guionizadas y repetibles. Un game day por hito desde M3: se
ejecutan los guiones aplicables, se levanta acta en `docs/gamedays/` con el
resultado observado, y **toda desviación se convierte en issue con equipo
asignado que debe cerrarse antes de la puerta del hito siguiente** (regla de
proceso; verificación en la puerta).

Cómo se ejecutan en este repo:

- Los guiones con versión **en proceso** están automatizados en
  `tests/gamedays/gameday-m3.test.ts` (motor, cola y pipeline reales sobre
  PostgreSQL embebido) y corren con
  `npx vitest run tests/gamedays --maxWorkers=2`.
- Los guiones marcados **[staging]** requieren el stack de Compose (E10) en una
  máquina con Docker: el guion define igualmente el comportamiento esperado
  ANTES de ejecutarse (DoD), y el acta los deja como pendientes de staging.

## Los 7 guiones base

Comportamiento esperado definido ANTES de la ejecución, con la referencia del
dosier técnico que lo manda (9.4 recursos/ticks, 19.2 clasificación de fallos,
24 operación/recuperación).

### GD-1 · Matar el motor a mitad de batalla de torneo

- **Inyección:** el proceso del motor muere después de arrancar la batalla
  (primer intento falla con `engine_start_failure`).
- **Esperado (19.2):** fallo de INFRAESTRUCTURA: la batalla vuelve a
  `scheduled`, la cola reintenta con límite y la batalla termina en un intento
  posterior. Nada se pierde, nada se ejecuta dos veces, el torneo continúa.
- **Ejecución:** en proceso (executor real de E9 envuelto en un fallo 1 vez).

### GD-2 · Matar el worker con la cola llena

- **Inyección:** el worker muere con N batallas encoladas y UNA reclamada a
  medias (lock cogido, ejecución nunca completada) — el peor caso.
- **Esperado (19.2 `worker_died` + 9.4):** un worker nuevo reanuda tras el
  `lockTimeoutMs`: todas las batallas terminan exactamente UNA vez (dedupe +
  `FOR UPDATE SKIP LOCKED`), incluida la huérfana; `process_result` una vez por
  batalla.
- **Ejecución:** en proceso con el MOTOR REAL (variante del test de caos de E9,
  que usa executor guionizado).

### GD-3 · Llenar el disco de replays

- **Inyección:** el directorio de replays no admite escrituras (disco lleno /
  ruta inválida) en el momento de persistir el replay de una batalla terminada.
- **Esperado (19.2 + 23.1):** fallo de INFRAESTRUCTURA: el trabajo se reintenta
  o queda en revisión manual; la batalla NO queda en un estado intermedio
  irrecuperable ni se publica un resultado sin replay oficial.
- **Ejecución:** en proceso (replaysDir apuntando bajo un archivo).

### GD-4 · Caída de Redis

- **Inyección:** Redis no disponible (conexión rechazada).
- **Esperado (arquitectura de cola E9):** Redis es SOLO el timbre (aviso +
  candado auxiliar); la cola vive en PostgreSQL. El worker degrada a polling y
  el sistema sigue procesando batallas sin pérdida — solo aumenta la latencia
  de despertar.
- **Ejecución:** en proceso (RedisSignal contra puerto muerto + worker sin señal).

### GD-5 · Caída y recuperación de PostgreSQL **[staging]**

- **Inyección:** parada del contenedor de PostgreSQL durante un torneo; arranque
  a los 2 minutos.
- **Esperado (24 + 19.2):** los workers fallan el claim con error de BD y
  REINTENTAN con espera (bucle `start()` ya lo contempla: espera y reintenta);
  al volver la BD, el torneo continúa desde el estado persistido, sin batallas
  duplicadas (idempotencia por estado `finished`). Los healthchecks del Compose
  marcan la API como no-sana mientras tanto.
- **Ejecución:** requiere staging con Docker (matar el contenedor postgres).
  En proceso solo se cubre el contrato parcialmente (el bucle del worker
  tolera errores de claim); queda para el game day de staging.

### GD-6 · Latencia artificial en la red arena

- **Inyección:** un bot conectado por el protocolo real (WebSocket, SDK JS)
  responde sistemáticamente más tarde que la ventana de decisión.
- **Esperado (9.4/D2):** el motor NUNCA espera: aplica acción segura al que
  llega tarde, el tick se mantiene estable, y al exceder
  `maxConsecutiveTimeouts` el bot es DESCALIFICADO; la batalla termina limpia
  y el rival gana. El motor no se detiene ni se corrompe.
- **Ejecución:** en proceso con ProtocolServer real + bot SDK real retrasado.

### GD-7 · Bot hostil NUEVO (no incluido en la suite conocida de E6)

- **Inyección:** un bot Python escrito por E12 (ajeno a E6 — regla de
  independencia de la DoD) que intenta: abrir sockets arbitrarios, leer
  archivos del sistema y exfiltrar variables de entorno.
- **Esperado (cap. 28 bots):** el pipeline de E6 lo RECHAZA antes de ejecutarlo
  (análisis estático); la versión queda `rejected` con motivo; la plataforma
  sigue operando (la siguiente batalla legítima corre sin verse afectada).
- **Ejecución:** en proceso por la API real (pipeline E6 completo salvo etapas
  containerizadas, `skipped` sin Docker).

## Actas

| Game day | Hito | Acta |
|---|---|---|
| 2026-07-16 | M3 (primero) | [acta-2026-07-16-m3.md](acta-2026-07-16-m3.md) |
