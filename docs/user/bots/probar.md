# Probar tu bot

Hay tres niveles de prueba, de más rápido a más real.

## 1. En tu ordenador, con el simulador local

El simulador local juega tu bot con el **mismo motor y el mismo protocolo** que la plataforma, sin cuenta ni conexión. Necesitas el repositorio y Node.js 22 o superior (en Python, además, Python 3.11 o superior).

```bash
# JavaScript, desde la raíz del repositorio (tras `npm install`)
npx arena-sim mi_bot.js --archetype gunner --opponent idle --ticks 1800

# Python (tras `pip install -e "sdks/python[dev]"`)
arena-sim mi_bot.py --archetype gunner --opponent idle --ticks 1800
```

| Opción | Qué hace |
|---|---|
| `--archetype` | Loadout de ejemplo de **tu** vehículo: `scout` (ligero, lidar y ametralladora), `gunner` (medio, radar y cañón), `miner` (medio, minas) o `heavy` (pesado, lidar 360 y cañón). |
| `--opponent` | Rival interno: `idle` (quieto), `hunter` (persigue y dispara), `circle` (gira) o `forward` (avanza recto). |
| `--opponent-archetype` | Loadout del rival. |
| `--map` | `empty` (arena vacía), `mvp` (la arena de serie con muro central) o `ctf` (abierta, con bases y banderas). |
| `--ruleset` | Las reglas: `dm_practice@1`, `tdm_mvp@1`, `ctf_mvp@1`… |
| `--ticks` | Duración de la batalla en ticks (30 por segundo). |
| `--seed` | La misma semilla repite la misma batalla. |

Imprime el resultado: ganador, marcador, ticks y si alguien fue descalificado. Úsalo para comprobar rápido que tu bot **no se cae, no se queda sin responder y hace lo que esperas**.

Los arquetipos son sólo para probar; en la plataforma juega **el loadout que tú guardaste**. Pruébalo con varios arquetipos para que tu código no dependa de un sensor concreto: el [ejemplo de sensores](ejemplos.md#4-sensores) funciona con los cuatro.

## 2. En la plataforma: la validación

Cuando pulsas «Enviar a validación», la plataforma construye tu código y lo prueba en un entorno aislado. Si la supera, la versión pasa a `validated` y ya puedes publicarla ([Bots](../bots.md)). Las comprobaciones, en palabras:

| Etapa | Qué comprueba |
|---|---|
| `structure` | Que el paquete tiene la forma correcta y tu loadout es válido. |
| `static_analysis` | Que no usas imports prohibidos, código dinámico (`eval`, `exec`…) ni nada que acceda al sistema. Se lee tu código sin ejecutarlo. |
| `dependencies` | Que sólo usas paquetes permitidos. |
| `build` | Que el código se construye y se firma. |
| `protocol_test` | Que tu bot arranca, se conecta y envía órdenes válidas. |
| `smoke_battle` | Que juega una batalla corta contra un rival de prueba sin que lo descalifiquen. |
| `resource_limits` | Que arranca en menos de **5 segundos** y que decide en menos de **100 ms**. |
| `secret_scan` | Que no has dejado contraseñas o claves en el código. |

Límites del paquete: hasta **10 MB** de código y 500 ficheros. En la batalla de humo tu bot corre con un límite de memoria (256 MB).

### Qué comprueba la validación

**Python.** Puedes importar la biblioteca estándar salvo los módulos que tocan el sistema (`os`, `subprocess`, `socket`, `ctypes`, `multiprocessing`, `asyncio`, `pickle`, `shutil`, `pathlib`, `tempfile`, `importlib`, `glob`…), más `arena_sdk`, `websocket-client` y `numpy`.

**JavaScript.** Puedes importar `@arena/sdk` y `ws`, y los módulos estándar de Node salvo `fs`, `child_process`, `net`, `http(s)`, `worker_threads`, `vm`, `os`, `crypto`, `process`…, y sin imports dinámicos. TypeScript no se acepta.

### Errores típicos y qué significan

| Mensaje | Qué hacer |
|---|---|
| «tu clase … no implementa on_observation / onObservation…» | Falta el hook o tiene una errata: renómbralo como dice el mensaje. |
| «el bot no completó el handshake…» | Tu código no llegó a conectarse: una espera o bucle al importar, o un error al arrancar. El fichero y la línea van al final. |
| «ningún COMMAND válido… (… Traceback …)» | Tu bot lanzó una excepción; la última línea de la traza está en el motivo. |
| «mensaje(s) fuera de protocolo…» | Devuelves valores fuera de rango: un `throttle` mayor que 1, un ángulo fuera de `[-π, π]`… Mira [Comandos](comandos.md#rangos-obligatorios). |
| «candidato descalificado en la partida de humo» | No respondiste a tiempo demasiadas veces seguidas: tu `on_observation` es demasiado lento. |
| «construcción(es) dinámica(s) prohibida(s)», «import(s) de paquete no permitido», «secreto(s) detectado(s)» | Lo detecta el análisis estático, antes de ejecutar nada. |
| «build no verificable: …» | Falló la plataforma, no tu código. Reenvía más tarde. |

La tarjeta del rechazo en «Mis bots» te dice la **fase**, el **fichero y la línea** y qué hacer.

## 3. En una batalla real

Cuando publiques la versión, juega una [batalla de práctica](../battles.md) con otro bot tuyo o con uno público. Después mira:

- el **replay** para ver qué hizo tu vehículo de verdad ([Replays](../replays.md));
- el **diagnóstico de tu bot** en el detalle de la batalla: si completó el saludo, cuántas decisiones aplicó, cuántas perdió, qué órdenes se rechazaron y por qué ([Estadísticas](../statistics.md#diagnóstico-de-tus-bots));
- el campo `debug` de tu orden (hasta 16 claves) para anotar rutas y objetivos: se guarda en tus replays privados.

## Un truco para depurar

Cuenta tus rechazos en `on_event`/`onEvent` y escríbelos (en el simulador local, a la consola):

```python
def on_event(self, event):
    if event["kind"] == "rejected_action":
        print(event["tick"], event.get("slot"), event.get("reason"))
```

Si ves `invalid_command`, la orden está mal formada; si ves `cooldown` o `no_ammo`, estás pidiendo disparar demasiado.
