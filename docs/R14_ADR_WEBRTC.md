# R14 · ADR — WebRTC para espectadores: decisión

**Estado**: decidido (bloque 8 del programa, 2026-07-20). Sustituye la fase de
implementación propuesta en `docs/R14_WEBRTC_STREAMING.md`, que se conserva como
contexto histórico del diseño evaluado.

**Decisión**: **WEBRTC NO JUSTIFICADO; ALTERNATIVA APROBADA** — el canal de
espectadores sigue siendo el gateway WebSocket existente (endurecido en R13.2), y la
ruta de escalado documentada abajo no requiere P2P.

## Contexto

La propuesta R14 planteaba distribuir el feed de espectadores por WebRTC P2P
(datachannel) para "reducir carga del servidor". Desde que se escribió, el terreno
cambió:

- **R11 (mergeado)**: descubrimiento público `GET /public/battles/live` + `#/live`,
  gateado por `S9_PUBLIC_SPECTATE_ENABLED` (off por defecto), con el visor ya montado
  sobre el gateway WS de tickets de un solo uso.
- **R13.2 (mergeado)**: el gateway quedó endurecido — `maxPayload` 64 KiB, tope de
  **100 espectadores por batalla** (`maxClientsPerBattle`, configurable), tickets de un
  solo uso con jti consumido, cuota anónima en el endpoint de descubrimiento.

## Análisis: por qué WebRTC no se sostiene aquí

1. **El problema que resuelve no existe a esta escala.** Lo que viaja a un espectador
   son snapshots públicos JSON (posiciones/eventos), no vídeo: pocos KB/s por cliente.
   Con el tope vigente de 100 espectadores/batalla, el coste de fan-out del servidor es
   trivial; el ahorro de ancho de banda que motiva un mesh P2P solo aparecería a una
   escala (miles de espectadores simultáneos) que este proyecto no tiene ni está
   autorizado a abrir.

2. **Rompe el modelo de autoridad del servidor.** En un fan-out P2P los pares
   redistribuyen el estado a otros pares. Un espectador malicioso podría alterar los
   snapshots que reenvía (marcadores falsos, posiciones falsas) y el receptor no tiene
   forma barata de verificarlo: habría que firmar cada frame y validar cadenas de
   reenvío — infraestructura criptográfica nueva cuyo único propósito sería recuperar la
   integridad que el canal servidor→cliente actual ya da gratis.

3. **NAT traversal choca con las reglas duras de la infraestructura.** WebRTC real
   necesita STUN y, para la mayoría de pares domésticos (NAT simétrico/CGNAT), TURN.
   Eso significa desplegar/contratar infraestructura externa nueva o abrir puertos —
   ambas cosas prohibidas en este programa ("no abrir puertos", "no cambiar dominios",
   "sin dependencia de red externa"). Sin TURN, el P2P falla para una fracción grande de
   usuarios reales y habría que mantener el canal WS **además** como fallback: doble
   superficie, doble mantenimiento, cero beneficio.

4. **Superficie de ataque nueva sin contrapartida.** Señalización (ofertas/answers/ICE)
   es un canal bidireccional nuevo que hay que autenticar, limitar y auditar (fugas de
   IPs internas en candidatos ICE incluidas). El gateway actual acaba de pasar por un
   ciclo de hardening específico; duplicar el plano de entrega desharía ese trabajo.

5. **El propio plan R14 ya lo intuía**: dejaba TURN/STUN como "tema futuro", exigía
   fallback SSE/polling y flag off. Es decir: la versión honesta de R14 implementable
   hoy sería un P2P que casi nunca negocia más un fallback que es… el canal que ya
   tenemos.

## Alternativa aprobada (ruta de escalado sin P2P)

El canal de espectadores es y sigue siendo **el gateway WS con tickets de un solo uso**.
Si algún día el aforo real se acerca a los límites, la escalera es servidor-side,
incremental y sin superficie nueva:

1. **Subir `maxClientsPerBattle`** (configurable desde R13.2) tras medir memoria/CPU
   reales por conexión.
2. **Réplicas del gateway** detrás del mismo nginx (el estado por batalla es un feed
   que puede replicarse por batalla; sharding natural por `battleId`).
3. **Reducir cadencia/tamaño de snapshot para espectadores** (throttling servidor-side,
   ya existe el patrón de throttling en el visor).
4. **SSE de solo lectura como transporte alternativo** si algún entorno bloquea WS —
   mismo origen, misma autenticación por ticket, sin señalización nueva. Solo si una
   necesidad real lo pide.

Nada de esta escalera requiere decisión ahora: son palancas conocidas sobre código que
ya existe.

## Condiciones de reapertura

Reabrir R14 (con diseño nuevo, no este) solo si se dan **las dos**:

- Demanda real y sostenida de espectadores muy por encima del alcance del gateway
  escalado (punto anterior agotado con mediciones, no con estimaciones).
- Autorización expresa del operador para la infraestructura que WebRTC exige de verdad
  (TURN gestionado o puertos/dominios nuevos) — hoy prohibida.

RTMP/YouTube/Twitch siguen explícitamente fuera de alcance, como en el plan original.

## Consecuencias

- No se añade código: este bloque es solo documental (ADR + roadmap).
- `docs/R14_WEBRTC_STREAMING.md` queda como registro del diseño evaluado, con nota de
  remisión a este ADR.
- El roadmap deja de listar R14 como bloque de implementación pendiente.
