# R14 · ADR — ¿Necesitamos WebRTC para el spectator?

**Estado**: decidido en esta ejecución (2026-08-08), a partir de medición directa del
código actual. **No implementa nada**: es un documento de arquitectura.

**Relación con decisiones previas**: este mismo tema ya se decidió el 2026-07-20 en
`docs/R14_ADR_WEBRTC.md` ("WebRTC no justificado; alternativa aprobada"), a partir de
un análisis cualitativo. Este documento repite el ejercicio de forma independiente,
citando fichero:línea y midiendo bytes reales en vez de argumentar en abstracto, y
llega a la **misma conclusión** con datos que la confirman en vez de solo repetirla.
Se recomienda tratar ambos como un único ADR a efectos prácticos: éste puede
sustituir a `docs/R14_ADR_WEBRTC.md` como referencia primaria por tener las cifras
detrás, o mantenerse como su anexo de medición — decisión del operador, sin urgencia.

**Veredicto**: **`R14-NOT-JUSTIFIED`**

---

## 1. Problema

R14 planteaba evaluar WebRTC (data channels o media streams) como transporte del
canal de espectador de una batalla, presumiblemente para reducir carga de servidor
o latencia. La pregunta que este documento responde con datos: ¿lo necesitamos
*hoy*, en esta infraestructura (una VM de homelab, sin CDN, sin balanceador
gestionado)?

## 2. Cómo se renderiza la batalla hoy (medido, no asumido)

El cliente **no recibe vídeo**. Recibe snapshots de estado en JSON por WebSocket y
los interpola localmente:

- `apps/web/src/viewer/spectator-client.ts:1-11` — cliente WS puro, sin Phaser ni
  códecs; consume mensajes `init`/`snapshot`/`event`/`debug`/`result`.
- `apps/web/src/viewer/spectator-client.ts:201` — el socket se abre con
  `new WS(wsUrl, ["spectate.v1", "ticket.<jwt>"])`: JSON sobre WS estándar, ticket
  como subprotocolo (nunca en la URL, para no acabar en logs de Nginx).
- `apps/web/src/viewer/live-feed.ts:91-127` (`LiveFeed`) + `DelayClock`
  (`live-feed.ts:24-84`) — cada snapshot llega fechado por su `tick`
  (`tickToMs`, ver `apps/web/src/viewer/replay-player.ts:65,73`, `TICK_HZ = 30`) y
  se reproduce con un retardo objetivo de ~2 intervalos de snapshot, deslizando el
  reloj de reproducción (±10 % del dt) para absorber jitter de red sin destello.
- El render en sí (`PhaserViewer.ts` y el resto de `apps/web/src/viewer/*`) pinta a
  partir de ese estado interpolado — no decodifica ningún flujo de vídeo.

Servidor: `apps/api/src/spectate/gateway.ts` (`SpectateGateway`) es un WebSocket
puro (`ws`), sin SFU, sin RTP, sin nada de WebRTC:

- `gateway.ts:1-24` (cabecera) — "sirve el canal de SOLO snapshots públicos (D8) a
  10 Hz + eventos públicos del motor".
- `gateway.ts:145` — `feed.timer = setInterval(() => this.pump(battleId, feed), opts.pollIntervalMs ?? 33)`:
  sondea cada ~33 ms los arrays públicos `battle.snapshots`/`battle.publicEvents`.
- `gateway.ts:279-294` (`pump()`) — por cada snapshot nuevo hace
  `broadcast(feed, { type: "snapshot", snapshot, serverTimeMs: Date.now() })`
  (`gateway.ts:282`); análogo para `event` (`gateway.ts:289`) y `result`
  (`gateway.ts:293`).
- `gateway.ts:299` (`broadcast()`) — recorre `feed.clients` y llama `sendTo()` por
  cada uno: fan-out servidor→cliente en O(n_espectadores), sin reenvío entre pares.

Conclusión de este apartado: el "vídeo" nunca existió como opción activa en este
proyecto para el canal de espectador — comparar WebRTC-media-stream contra el
sistema actual sería comparar contra algo que no está en producción ni planeado.
La comparación real y útil es **WebRTC data channel vs. el WebSocket que ya hay**.

### Nota aparte: `apps/streamer` sí hace vídeo, pero no es esto

`apps/streamer/src/ffmpeg.ts` y `apps/streamer/src/supervisor.ts` implementan un
pipeline real de vídeo: Chromium headless (Xvfb) capturando la página `/broadcast`
+ FFmpeg codificando a H.264 (software x264 o `h264_nvenc`) y empujando por RTMPS a
YouTube (`apps/streamer/src/streamer.test.ts:101`,
`rtmps://a.rtmps.youtube.com/live2/...`). Es un appliance tipo OBS de un solo
sentido (servidor → YouTube), documentado en `docs/streaming-runbook.md`. No tiene
relación con la entrega a espectadores del propio arena — consume la misma página
que ya renderiza el WS, no un protocolo distinto — y queda fuera de alcance de este
ADR (RTMP/YouTube/Twitch explícitamente fuera de alcance de R14 también en el ADR
previo).

## 3. Tamaño y frecuencia real de un snapshot

- **Frecuencia de snapshot**: 10 Hz efectivos. La simulación corre a
  `TICK_HZ = 30` (`apps/web/src/viewer/replay-player.ts:65`) y el motor decima a
  `snapEvery = this.config.snapshotEveryNTicks ?? 3` ticks
  (`apps/arena-engine/src/sim/battle.ts:480`), confirmado también por
  `apps/web/tests/replay-feed.test.ts:29` ("10 Hz con simulación a 30 Hz"). El
  gateway no vuelve a submuestrear: reenvía cada snapshot nuevo que encuentra en su
  sondeo de 33 ms (`gateway.ts:145`), así que 10 Hz de producción = 10 Hz de
  entrega.
- **Esquema real del snapshot público** — `Battle.publicSnapshot()`,
  `apps/arena-engine/src/sim/battle.ts:749-779`: `tick`, `vehicles[]` (id, team,
  alive, position{x,y} redondeada a 6 decimales, heading, turretHeading, hullHp,
  hullHpMax, carryingFlag, juggernaut, modules[]{slot, state}), `projectiles[]`
  (id, position), `score`, `objectives`. Las minas se excluyen a propósito
  (`battle.ts:775`: "información oculta hasta que explotan") — el propio esquema ya
  está diseñado para ser mínimo, no es un volcado bruto del estado interno.
- **No hay ningún fixture de snapshot real committeado** en este worktree
  (`data/replays/` solo tiene `.gitkeep`), así que no puedo citar una medición de un
  snapshot capturado en producción. En su lugar construí un objeto JSON que respeta
  exactamente el esquema de `battle.ts:749-779` (mismos campos, mismos tipos,
  precisión de coma flotante realista) y lo serialicé con
  `json.dumps(..., separators=(",",":"))` (el mismo formato compacto que
  `JSON.stringify` produce, sin espacios) para medir bytes reales de esa
  estructura:
  - 2 vehículos / 2 proyectiles (batalla 1v1 pequeña): **906 bytes/snapshot**.
  - 6 vehículos / 8 proyectiles (batalla 3v3 con fuego cruzado activo): **2600
    bytes/snapshot**.
  - Esto es una medición de un objeto *sintético pero fiel al esquema real*, no de
    tráfico capturado — lo digo explícitamente porque no tengo un snapshot real con
    el que contrastarlo.
- **Ancho de banda derivado** (cálculo directo, 10 Hz × tamaño anterior, sin
  overhead de framing WS/TLS que añadiría ~5-10 %):
  - 1v1: ~9.1 KB/s por espectador.
  - 3v3 con fuego cruzado: ~26 KB/s por espectador.
  - Con el tope actual de `DEFAULT_MAX_CLIENTS_PER_BATTLE = 100`
    (`gateway.ts:103`), el caso peor medido (100 espectadores × 26 KB/s) es
    **~2.6 MB/s de fan-out saliente para una sola batalla concurrida** — una cifra
    trivial para cualquier VM con NIC de 1 Gbps, y de las que HTTP/1.1 keep-alive o
    WS con compresión (`permessage-deflate`, no activado hoy pero disponible)
    reducirían más si hiciera falta.

## 4. Transporte actual y sus límites reales (medidos)

- Transporte: WebSocket puro (`ws` en Node, `WebSocket` nativo en navegador), sin
  polling ni SSE en el camino de producción.
- Auth: ticket JWT de un solo uso, TTL 60 s
  (`SPECTATE_TICKET_TTL_S = 60`, `apps/api/src/routes/battles.ts:26`), firmado en
  `apps/api/src/auth/tokens.ts` (`signSpectateTicket`, HKDF con info
  `"s9-arena/spectate-ticket/v1"`, línea 92-95), viaja como subprotocolo WS
  (nunca en URL/logs), y se consume por `jti` en el gateway
  (`usedTickets: Map<string, number>`, declarado ~`gateway.ts:108`).
- Rate limiting: cuota anónima en la emisión de tickets
  (`anonQuota(db, "spectate-ticket", quota)`, `apps/api/src/routes/battles.ts:278`)
  y tope de conexiones simultáneas por batalla
  (`DEFAULT_MAX_CLIENTS_PER_BATTLE = 100`, `gateway.ts:103`, configurable).
- Límite de frame entrante: `MAX_INCOMING_PAYLOAD_BYTES = 64 * 1024`
  (`gateway.ts:100`) — el canal es de solo lectura para el cliente, cualquier frame
  grande entrante es ruido.
- Reconexión: backoff exponencial con jitter
  (`backoffDelayMs`, `spectator-client.ts:58-66`) + watchdog de zombis a 10 s
  (`spectator-client.ts:246`) + recuperación de estado íntegro vía mensaje `init`
  con el último snapshot (`gateway.ts:242-259`), sin recargar página.
- **Límite real no resuelto por el código**: no encontré un límite de espectadores
  *totales en la VM* (solo por batalla). Con varias batallas concurrentes muy
  concurridas, 100 espectadores/batalla × N batallas podría acumular tráfico
  significativo — pero es un límite de *capacidad del servidor único de este
  gateway*, no algo que WebRTC arreglaría (ver §6).

## 5. Espectadores simultáneos plausibles en este homelab

No hay telemetría de producción citable en este worktree sobre picos reales de
espectadores (lo digo explícitamente en vez de inventar una cifra). Lo que sí es
medible/citable:

- El propio hardening (`DEFAULT_MAX_CLIENTS_PER_BATTLE = 100`) fue dimensionado
  para "un enjambre de espectadores en una sola batalla" sin agotar memoria/handles
  del proceso (`gateway.ts:96-102`, comentario R13.2).
- Esta es una VM de homelab sin CDN ni balanceador externo (contexto de la tarea,
  confirmado también por las reglas invioables de "no abrir puertos", "no tocar
  VM108/VM104", "no crear infraestructura productiva").
- A la escala de audiencia real de este proyecto (equipo interno + demos, no un
  servicio público con miles de usuarios), decenas de espectadores concurrentes por
  batalla es un techo generoso; cientos ya exceden lo que un homelab de una sola VM
  puede servir con garantías, independientemente del transporte elegido — ese techo
  lo pone la VM, no el protocolo.

## 6. Comparación con datos: polling / SSE / WS / WebRTC data channel / WebRTC media

| Opción | Latencia esperada @ 10 Hz snapshot | Ancho de banda (100 espectadores, 3v3) | Complejidad | Infraestructura nueva requerida | Auth/Authz | Fallback |
|---|---|---|---|---|---|---|
| **HTTP polling** | 1 RTT + intervalo de poll (típicamente ≥500 ms si se quiere no saturar) | Peor que WS: cabeceras HTTP completas en cada petición, sin mantener conexión | Baja | Ninguna | Reutiliza auth HTTP normal | Es el propio fallback de todo lo demás |
| **SSE** | Similar a WS (push real, sin poll), algo más de overhead de framing HTTP | Similar a WS + overhead de cabeceras SSE por evento | Baja-media | Ninguna (mismo origen, mismo Nginx) | Ticket en query string o cabecera (SSE no soporta subprotocolos como WS) | Ya identificado como escalón 4 de la escalera en `docs/R14_ADR_WEBRTC.md:70-71` |
| **WebSocket (actual)** | Push inmediato, medido: `pollIntervalMs` de 33 ms de sondeo interno + entrega — límite real es la cadencia de 10 Hz del motor, no el transporte | ~26 KB/s/espectador medido (§3), ~2.6 MB/s total en el peor caso con 100 espectadores | Baja (ya implementado y con tests, `apps/web/tests/spectator.e2e.test.ts`) | Ninguna adicional | Ticket JWT de un solo uso como subprotocolo (`gateway.ts`), ya endurecido R13.2 | N/A — es el sistema primario |
| **WebRTC data channel (P2P mesh)** | Similar o peor que WS para el primer salto (mismo servidor origina el estado); mejor solo si hay reenvío entre pares, lo que introduce el problema de integridad de abajo | Ahorro de servidor solo aparece si los pares reenvían entre sí — no aporta nada si sigue siendo servidor→cada cliente (SFU) | Alta: señalización (offer/answer/ICE), gestión de conexiones P2P, reconexión por par | **Signaling server** (nuevo canal bidireccional a autenticar), **STUN**, y para NAT simétrica/CGNAT casi seguro **TURN gestionado** (relay de tráfico real, no solo señalización) | Firmar/verificar cada frame reenviado por un par para no confiar en un espectador intermedio — infraestructura criptográfica que no existe hoy | Necesitaría mantener el WS igualmente como fallback (doble mantenimiento) |
| **WebRTC media stream (vídeo)** | Peor per-frame (codificación, jitter buffer de vídeo) para algo que hoy son datos estructurados, no píxeles | Órdenes de magnitud mayor: un flujo de vídeo 720p decente son cientos de KB/s a Mb/s por espectador, frente a ~26 KB/s de JSON — inversión de la ventaja que se buscaba | Muy alta: encoder por batalla (o SFU multiplexando), gestión de bitrate adaptativo | Encoder de vídeo (como ya existe en `apps/streamer` pero *por espectador*, no compartible), SFU o mesh, STUN/TURN | Igual que data channel, más DRM/anti-grabación si importara | Ídem, y además pierde la ventaja de "el cliente ya sabe interpolar el estado" que tiene hoy |

Puntos que no dependen de la tabla y son estructurales:

- **Puertos que exigiría WebRTC** (sin abrirlos, solo para que quede explícito qué
  pediría si se aprobara): un servidor STUN típicamente en UDP/3478 (y su variante
  TLS 5349), y un TURN relay que necesita un rango UDP amplio para los relays de
  medios (habitualmente 49152-65535, el rango dinámico/efímero) además del propio
  3478/5349 de señalización — es infraestructura de red nueva, no una librería que
  se añade al backend existente.
- **NAT**: la mayoría de espectadores domésticos están detrás de NAT simétrica o
  CGNAT del ISP. STUN solo resuelve NAT "fáciles" (full-cone/restricted); para el
  resto hace falta TURN, que además de puertos requiere **ancho de banda de relay
  pagado por nosotros** — el propio servidor termina retransmitiendo el tráfico
  igual que hace el WebSocket hoy, pero con una capa de complejidad (ICE, TURN,
  credenciales de turno) encima, no en vez de.
- **TURN y credenciales**: un TURN gestionado exige credenciales de corta duración
  por sesión (usuario/contraseña temporal derivados de un secreto compartido, tipo
  RFC 5766 REST API), otro secreto más que rotar y proteger, y o bien contratar un
  proveedor externo (dependencia de red externa, prohibida por las reglas de esta
  tarea) o desplegar coturn en la propia infraestructura (una VM/contenedor más que
  mantener, parchear y monitorizar).
- **Autenticación/autorización**: el sistema actual ya resuelve esto con un ticket
  de un solo uso de 60 s de vida atado al `battleId` y al rol (`debug` solo para
  moderadores) — WebRTC necesitaría replicar ese control en la capa de
  señalización sin ganar nada a cambio.
- **Observabilidad**: el WS actual es un único punto donde medir latencia
  (`serverTimeMs` en cada mensaje, ya presente: `gateway.ts` init y snapshot),
  contar clientes (`feed.clients.size`) y aplicar límites. Un mesh P2P dispersa esa
  observabilidad entre pares que no controlamos.

## 7. Coste

- **Coste de no hacer nada (mantener WS)**: cero — ya está implementado, probado
  (`apps/web/tests/spectator.e2e.test.ts`, `apps/api` tests del gateway) y
  endurecido (R13.2). El único coste futuro es escalar parámetros existentes
  (`maxClientsPerBattle`, réplicas de gateway) si la demanda lo exige.
- **Coste de WebRTC data channel**: desarrollo de señalización + gestión de
  conexiones P2P + firma/verificación de frames reenviados + infraestructura
  STUN/TURN (gestionada de pago o autoalojada) + el WS de fallback que igualmente
  hay que mantener. Coste no trivial para un beneficio que solo existe a escalas de
  espectadores que este proyecto no tiene ni está autorizado a servir.
- **Coste de WebRTC media stream**: todo lo anterior más un pipeline de
  codificación de vídeo por espectador o un SFU, con un consumo de ancho de banda
  que la propia tabla de §6 muestra que sería *mayor*, no menor, que el JSON actual
  — inviable en una VM de homelab sin CDN.

## 8. Escalabilidad (ruta sin P2P, si algún día hace falta)

Coincide con la escalera ya propuesta en `docs/R14_ADR_WEBRTC.md:64-72`, y esta
medición la refuerza en vez de sustituirla:

1. Subir `maxClientsPerBattle` (`gateway.ts:103`) tras medir memoria/CPU reales por
   conexión — sigue habiendo margen: 100 espectadores a ~26 KB/s son ~2.6 MB/s, muy
   lejos de saturar una NIC de 1 Gbps.
2. Réplicas del gateway detrás del mismo Nginx, shardeadas por `battleId` (el
   estado por batalla ya es un feed independiente en `feeds: Map<string, Feed>`,
   `gateway.ts`).
3. Reducir cadencia/tamaño de snapshot para espectadores (throttling
   servidor-side) si algún caso concreto lo pidiera — el propio esquema
   (`battle.ts:749-779`) ya es mínimo (sin minas, sin estado de sensores).
4. SSE de solo lectura como transporte alternativo si algún entorno bloquea WS —
   misma auth por ticket, sin señalización nueva.

Ninguno de estos pasos requiere abrir puertos, contratar TURN ni tocar
VM104/VM108.

## 9. Recomendación

Mantener el WebSocket con snapshots JSON como único canal de espectador. Es
suficiente para la escala medida (§3, §5), ya está endurecido (§4), y cualquier
alternativa evaluada en §6 añade complejidad e infraestructura (señalización,
STUN, TURN, credenciales de turno, puertos UDP nuevos) para resolver un problema
—coste de ancho de banda del servidor— que a día de hoy es del orden de unos pocos
MB/s en el peor caso, no un cuello de botella real.

## 10. Criterios de abandono de esta decisión

Reabrir R14 solo si se cumplen **las dos** condiciones (igual que en el ADR
previo, y por la misma razón: ninguna se puede satisfacer con estimaciones):

- Demanda real y sostenida de espectadores medida en producción por encima de lo
  que la escalera del §8 puede cubrir (no una proyección: telemetría real de
  `feed.clients.size` en el tiempo, memoria/CPU del gateway bajo esa carga).
- Autorización expresa del operador para desplegar o contratar la infraestructura
  que WebRTC exige de verdad (TURN gestionado, o puertos UDP nuevos en la propia
  VM) — hoy expresamente prohibida por las reglas de esta tarea y del programa.

RTMP/YouTube/Twitch (que sí existen en `apps/streamer`, ver §2) siguen fuera de
alcance de esta decisión: son un pipeline de difusión unidireccional distinto, no
el canal de espectador de la arena.

---

## Veredicto

**`R14-NOT-JUSTIFIED`**

No procede WebRTC ahora. El sistema actual (WebSocket + snapshots JSON a 10 Hz,
~9-26 KB/s por espectador según densidad de la batalla, tope de 100
espectadores/batalla, auth por ticket de un solo uso) resuelve el problema real
con la infraestructura que ya existe. Lo que haríamos en su lugar si la demanda
creciera es la escalera server-side del §8 — no P2P.
