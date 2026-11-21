# STREAMING_ARCHITECTURE_V2: Broadcast Manager (StreamSession, BroadcastItem y BroadcastQueue)

> **Estado:** DISEÑO (MS-1). No hay nada implementado. Este documento fija los modelos, las máquinas de
> estado, los contratos y el plan de PRs MS-2…MS-8. El código actual se describe en
> [streaming-architecture.md](streaming-architecture.md), que sigue siendo válido hasta que MS-2…MS-8
> lo sustituyan por partes.
>
> **Base del análisis:** `main` 7bddda9. Las referencias a código (`fichero:símbolo`) son de ese commit.
> Las dependencias con trabajo aún no integrado se citan por su PR: #269 (MG, ajustes de runtime y
> `broadcastAvailable`), #270 (MF, ciclo de vida de batalla), #271 (MD, replay v2), #272 (MA,
> `projectFrame`, `PublicEntityId` y `EQUIPMENT_PRIVATE`) y #274 (proxy interno de `/api/v1` en `web`).

## Índice

1. [Alcance y fuera de alcance](#1-alcance-y-fuera-de-alcance)
2. [El sistema actual y por qué no basta](#2-el-sistema-actual-y-por-qué-no-basta)
3. [Principios](#3-principios)
4. [Vocabulario: tres conceptos separados](#4-vocabulario-tres-conceptos-separados)
5. [Arquitectura objetivo](#5-arquitectura-objetivo)
6. [Modelos de datos](#6-modelos-de-datos)
7. [Máquinas de estado](#7-máquinas-de-estado)
8. [BROADCAST_READY y el start sincronizado](#8-broadcast_ready-y-el-start-sincronizado)
9. [Concurrencia y políticas de emisión](#9-concurrencia-y-políticas-de-emisión)
10. [YouTube continuo y handoff entre batallas](#10-youtube-continuo-y-handoff-entre-batallas)
11. [Reconexión y fallos durante la emisión](#11-reconexión-y-fallos-durante-la-emisión)
12. [Fuentes por batalla para producción externa (OBS)](#12-fuentes-por-batalla-para-producción-externa-obs)
13. [Replays y listas de reproducción](#13-replays-y-listas-de-reproducción)
14. [Errores: códigos técnicos y mensajes humanos; fallar de forma visible](#14-errores-códigos-técnicos-y-mensajes-humanos-fallar-de-forma-visible)
15. [Observabilidad: sesión frente a ítem](#15-observabilidad-sesión-frente-a-ítem)
16. [UI: Administración → Retransmisión](#16-ui-administración--retransmisión)
17. [Contratos de API](#17-contratos-de-api)
18. [Propiedad de recursos: MS, MF y MA](#18-propiedad-de-recursos-ms-mf-y-ma)
19. [Seguridad](#19-seguridad)
20. [Migración desde el sistema actual](#20-migración-desde-el-sistema-actual)
21. [Plan de pruebas](#21-plan-de-pruebas)
22. [Rollout](#22-rollout)
23. [Plan de PRs MS-2…MS-8](#23-plan-de-prs-ms-2ms-8)
24. [Decisiones abiertas](#24-decisiones-abiertas)
25. [Riesgos](#25-riesgos)
26. [Trazabilidad con el encargo (§18)](#26-trazabilidad-con-el-encargo-18)

---

## 1. Alcance y fuera de alcance

**Dentro.** Convertir el streaming en un subsistema de producto: una sesión de salida persistente, lo
que se muestra en cada momento como algo separado de esa sesión, una cola de emisión, el arranque de la
batalla sincronizado con la emisión, fuentes por batalla para OBS, replays y listas de replays, y un
único menú de administración.

**Fuera.**

- **El bug de #274** (el `nginx` de `web` devolvía `index.html` a `/api/v1/*` y el director se quedaba
  en «waiting»). Lo corrige #274 de forma independiente, con su propio gate
  `INTERNAL_BROADCAST_API_PROXY`. Este diseño **no lo rediseña**: lo da por cerrado y añade, aparte, la
  regla general de que un fallo de la fuente nunca se puede tragar (§14).
- El render visual (sprites, LOD, animaciones), el audio del juego y YouTube como producto (claves,
  cuentas). Los flags públicos `S9_PUBLIC_*` de producción no se tocan aquí.
- El motor y su determinismo. Nada de este diseño cambia la semilla, el orden de ticks ni el
  `stateHash`. El start sincronizado sólo **retrasa el momento en que el worker reclama** la batalla
  (§8.4).
- La implementación. MS-1 es documentación. Los tipos de §6 son contrato y se materializan en MS-2.

**Prioridad del encargo (§18.34).** Nada de este diseño se activa en producción antes de que haya
`BATTLE_VISIBLE_ON_STREAM=PASS`, es decir, una batalla real vista en YouTube con el sistema actual y
#274 desplegado. Los PRs MS-2…MS-8 pueden desarrollarse en paralelo, pero su activación está detrás de
ese hito (§22).

## 2. El sistema actual y por qué no basta

Resumen de lo que hay en 7bddda9 (detalle en [streaming-architecture.md](streaming-architecture.md)):

| Pieza | Dónde | Qué hace hoy |
|---|---|---|
| Sesión | `streaming_sessions` (migración 017), `routes/streaming.ts` | Una fila `active` como máximo (índice único parcial). La sesión guarda **un** destino: `target_kind` + `target_id` |
| Orden al streamer | `routes/streaming.ts:buildStartBody` → `services/streaming.ts:broadcastUrlFor` | La URL de `/broadcast?battle=…` o `?tournament=…` se fija **al arrancar** y va en el argv de Chromium (`ffmpeg.ts:buildChromiumArgs`, `--app=`) |
| Vista | `BroadcastPage.tsx`, `broadcast/director.ts` | Sondea la API pública cada 4 s y decide entre `waiting`, `live`, `intermission` y `finished` |
| Arranque de la batalla | `tournament-worker/battle-runner.ts:claimBattle` | `UPDATE … SET status='running' WHERE status='scheduled'` en cuanto hay un hueco libre del worker. No sabe nada de la emisión |
| Estado en pantalla | `routes/streaming.ts:uxState` | Un único estado que mezcla salida (relé), streamer y sesión |
| UI | `StreamingPage.tsx` (Administración → Streaming) y el bloque «Directo y retransmisión» de `BattleDetailPage.tsx` | Una página larga con tarjetas: estado, destino manual, servidores, clave, emisión, branding, grabaciones, auditoría |

Limitaciones que motivan la v2 (cada una se cierra en la sección indicada):

| # | Limitación | Consecuencia | Se cierra en |
|---|---|---|---|
| L1 | La sesión y lo que se muestra son la misma cosa: cambiar de batalla = `restartStreaming` = relanzar Chromium y ffmpeg | El RTMP se corta entre batallas; YouTube puede cerrar el directo | §10 |
| L2 | En modo torneo, `decideScreen` escoge `running[0]`: con varias batallas en paralelo, la emisión salta a una cualquiera y las demás no se ven | Un torneo no se puede emitir completo | §9 |
| L3 | La batalla arranca cuando el worker tiene hueco, no cuando la emisión está lista. Sin retardo de espectador, quien se conecta tarde recibe el último snapshot (`gateway.ts`, `init`) | Se pierde el principio de la batalla | §8 |
| L4 | `BroadcastDirector.tick` se traga cualquier error (`catch {}`) y conserva la última pantalla | La emisión se queda en «La batalla empieza en breve» sin que nadie lo sepa (#274 fue un caso) | §14 |
| L5 | `uxState` mezcla la salida y el contenido: `live` = el relé publica, aunque la pantalla esté en espera | «EN DIRECTO» con una pantalla vacía | §15 |
| L6 | No hay replays en la emisión (`REPLAY_STREAMING_SUPPORTED=NO`) ni listas | — | §13 |
| L7 | No hay fuentes por batalla para OBS documentadas como producto | — | §12 |
| L8 | La UI está en una página larga y parte del control vive en el detalle de la batalla | Difícil para alguien que no conoce la arquitectura | §16 |

Lo que **sí se conserva** (está probado y es la base): el streamer como espectador más sin canal al
motor ni a la BD; la credencial sellada atada a plataforma e ingesta; el relé RTMP en Node con la clave
fuera de ffmpeg; la puerta de render `BROADCAST_RENDER_READY` y el detector de frame blanco (#256); el
reconciliador de huérfanas con doble lectura; el cerrojo, el índice único y la compensación del START;
la política única de lectura (`battle-access.ts` / `replay-access.ts`) y el estado efectivo de #269.

## 3. Principios

- **P1 · La salida no conoce el contenido.** El streamer captura **una** URL durante toda la sesión: la
  del *programa* (§5.2). Cambiar lo que se ve nunca relanza Chromium ni ffmpeg. La continuidad del RTMP
  es así una propiedad de construcción, no de cuidado.
- **P2 · Lo que se emite es exactamente lo que ve un visitante.** Toda pantalla sale de la API pública
  y del canal de espectador con audiencia `broadcast`, que sirve `projectFrame()` (#272). Ninguna ruta
  de emisión lee el estado interno del motor. El programa no tiene más privilegios que un visitante,
  con una sola excepción acotada y firmada: el *pre-roll* de una batalla retenida (§8.5).
- **P3 · Tres máquinas de estado, tres dueños.** La sesión (salida) la gobierna MS con el streamer; el
  ítem (contenido) la gobierna MS con la página de programa; la ejecución de la batalla la gobierna el
  worker (MF). Ninguna infiere el estado de otra: lo lee de su dueño.
- **P4 · Retener nunca es iniciar.** Una batalla sincronizada sólo empieza por una orden explícita (del
  operador o de `AUTO_START_WHEN_READY` con el gate completo). Ningún fallo, timeout ni reconexión la
  inicia.
- **P5 · Iniciada nunca se pausa.** Una batalla que ya corre no se detiene ni se ralentiza por la
  emisión. La emisión pierde un tramo, lo registra y sigue.
- **P6 · Fallar de forma visible.** Un error de la fuente se convierte en un estado del ítem con un
  código técnico y un mensaje humano, y llega al panel. La pantalla pública puede mostrar una *slate*
  limpia, pero la administración siempre lo sabe.
- **P7 · El determinismo no se toca.** Retrasar el `claim` no cambia nada de la simulación. La emisión
  no escribe en la batalla, salvo la marca de retención (§8.4), que el motor no lee.
- **P8 · Sencillo para el operador.** Sin UUIDs fuera del modo avanzado, sin `.env`, sin shell. Cada
  estado tiene un texto humano y, plegado, el detalle técnico.

## 4. Vocabulario: tres conceptos separados

| Concepto | Qué es | Vida | Dueño |
|---|---|---|---|
| **StreamSession** | La salida persistente: RTMPS (YouTube u otra), grabación local o, más adelante, otra plataforma. Incluye Xvfb, Chromium del programa, ffmpeg y el relé | De PREPARAR EMISIÓN a DETENER EMISIÓN; atraviesa esperas, batallas, intermedios y la siguiente batalla | MS (orquestación), streamer (procesos) |
| **Program** (programa) | La página que captura la sesión: `/broadcast/program/{programId}`. Muestra el BroadcastItem actual y hace las transiciones | La de su sesión. Un programa por sesión | MS |
| **BroadcastItem** | Lo que se muestra ahora: batalla en directo, replay, intermedio, *slate*, espera o pantalla final | Del momento en que entra en la cola hasta que termina o se salta | MS |
| **BroadcastQueue** | La lista ordenada de ítems de una sesión: AHORA y SIGUIENTES | La de su sesión | MS |
| **PlaylistItem** | Una entrada de una lista guardada (plantilla) o de la cola: `live_battle`, `replay`, `intermission`, `slate` o `waiting` | La de la lista | MS |
| **Playlist** | Una lista guardada y reutilizable (sobre todo de replays) | Persistente | MS |
| **Source** (fuente) | La URL pública y estable de **una** batalla o replay para producción externa: `/broadcast/battle/{battleId}` | La de la batalla | MS (ruta), MA (contenido) |
| **BattleExecution** | La simulación real | De `claim` a `finish` | MF (worker) |
| **BattleBroadcastControl** | La relación entre una batalla y la emisión: si está retenida esperando a la emisión, lista para empezar o ya corriendo | De la asignación a la emisión hasta que la batalla termina | MS (escribe), MF (respeta) |

Regla de nombres: **«canal»** en la UI es la combinación plataforma + ingesta + clave (lo que hoy son
`settings.platform`, `ingests` y `credentials`). Un canal no es una sesión: una sesión **usa** un canal.

## 5. Arquitectura objetivo

### 5.1 Vista general

```
                         ┌──────────────── Administración → Retransmisión (web, admin) ───────────────┐
                         │ Directo · Cola · Batallas/Fuentes · Replays · Canales · Configuración · Diag │
                         └───────────────┬─────────────────────────────────────────────────────────────┘
                                         │ /admin/broadcast/*  (RBAC admin, auditoría)
                                         ▼
 ┌──────────────────────────── API ─────────────────────────────────────────────────────────────┐
 │ Broadcast Manager (MS)                                                                      │
 │  · SessionManager ── orden START/STOP ──► streamer (API interna de control, sin cambios de   │
 │  │                                        protocolo salvo la URL del programa)              │
 │  · QueueEngine (cola, políticas, handoff)                                                    │
 │  · ReadinessEvaluator (BROADCAST_READY) ◄── telemetría del programa, estado del streamer,    │
 │  │                                          suscriptores del gateway, política de acceso     │
 │  · StartGate ── escribe battle_broadcast_controls ──► el worker (MF) respeta la retención    │
 │  · ProgramFeed: GET /broadcast/programs/{programId} (público, sólo lo que ya se emite)       │
 └──────────────────────────────────────────────────────────────────────────────────────────────┘
         ▲ telemetría (token de programa)                ▲ ticket audiencia «broadcast»
         │                                                │ (+ claim de programa para el pre-roll)
 ┌───────┴───────── streamer (StreamSession) ─────────────┴──────────────────────────────────────┐
 │ Xvfb ─ Chromium --app=/broadcast/program/{programId}#t=… ─ ffmpeg x11grab ─ relé RTMPS        │
 │        └ página de programa: renderiza el BroadcastItem actual (live/replay/slate/…)         │
 └───────────────────────────────────────────────────────────────────────────────────────────────┘

 OBS / vMix (producción externa) ── /broadcast/battle/{battleId} ── sólo API pública + gateway
```

### 5.2 Decisión central: un programa estable por sesión

Hoy la URL que captura Chromium es la del contenido (`?battle=` o `?tournament=`). En v2 es la del
**programa**: `/broadcast/program/{programId}`. La página del programa:

1. Lee `GET /api/v1/broadcast/programs/{programId}` (público, sin cookies, §17.3), que le dice qué ítem
   está en el aire, cuál es el siguiente (si ya es público) y la marca de tiempo de la última orden.
2. Renderiza el ítem con los **mismos componentes** que hoy (`PhaserViewer`, `SpectatorClient`, HUD) y
   con las pantallas de espera, intermedio y final que ya existen en `BroadcastPage.tsx`.
3. Prepara el siguiente ítem **en una capa oculta** mientras el actual sigue en pantalla (doble buffer
   en el DOM) y sólo conmuta cuando la capa nueva ha pintado su primer frame (§10.2).
4. Informa de su estado al API con un *heartbeat* (§8.3).

Consecuencias:

- Cambiar de batalla, pasar a un intermedio, reproducir un replay o saltar en la cola es un cambio de
  **datos** en el API. El streamer no se entera. El RTMP no se corta (`YOUTUBE_CONTINUOUS_SESSION`).
- `restartStreaming` queda para lo que de verdad cambia la salida: plataforma, ingesta, códec,
  resolución o bitrate.
- El protocolo de control del streamer (`/control/start`, `/control/stop`, `/status`) **no cambia de
  forma**. Sólo cambia el valor de `broadcastUrl`, que sigue validándose contra SSRF en `session.ts`
  (la ruta permitida pasa a ser `/broadcast/program/…` además de la heredada).

### 5.3 Dónde corre el Broadcast Manager

En el **API**, como módulo nuevo `apps/api/src/broadcast/` (MS-2), junto al reconciliador actual. El
bucle del gestor (`tick` cada 1 s) corre con **un único líder** elegido con un *advisory lock* de
PostgreSQL, para que varias réplicas del API no tomen decisiones dobles. Toda transición se escribe en
BD con concurrencia optimista (`version`) y es idempotente: si el líder cambia a mitad de una
transición, el siguiente la reintenta sin duplicar efectos.

Alternativa descartada: ponerlo en el tournament-worker. El worker es de MF, su ciclo es por batalla y
no tiene la sesión, la credencial ni el reconciliador del streaming.

### 5.4 Componentes y ficheros previstos

| Componente | Fichero previsto | PR |
|---|---|---|
| Tipos de contrato | `packages/broadcast-contracts/src/index.ts` (sólo tipos y constantes) | MS-2 |
| SessionManager | `apps/api/src/broadcast/session-manager.ts` (absorbe `routes/streaming.ts:startLocked/stopSession`) | MS-2 |
| Resolución de destino y fuente | `apps/api/src/broadcast/targets.ts` (reutiliza `resolveTarget`, `broadcast-effective.ts` de #269) | MS-2 |
| ReadinessEvaluator + StartGate | `apps/api/src/broadcast/readiness.ts`, `start-gate.ts` | MS-3 |
| Retención en el worker | `tournament-worker/battle-runner.ts:claimBattle` (predicado) | MS-3 con MF |
| QueueEngine | `apps/api/src/broadcast/queue-engine.ts` | MS-4 |
| Página de programa | `apps/web/src/broadcast/program/*` | MS-4 |
| Handoff y conmutación manual | `queue-engine.ts`, `program/*` | MS-5 |
| Fuentes por batalla | `apps/web/src/broadcast/source/*`, `/admin/broadcast/sources` | MS-6 |
| Replays y listas | `apps/web/src/broadcast/replay/*`, `apps/api/src/broadcast/playlists.ts` | MS-7 |
| UI unificada | `apps/web/src/pages/broadcast-admin/*` (sustituye `StreamingPage.tsx`) | MS-8 |

## 6. Modelos de datos

Los tipos son el contrato. MS-2 los materializa en `packages/broadcast-contracts` (sin lógica) y la
migración SQL los persiste. Los nombres de estado son los del encargo (§18.23).

### 6.1 StreamSession

```ts
type OutputKind = "rtmps" | "record";                 // futuro: otras plataformas, sin cambiar el modelo
type OutputMode = "direct" | "external_production";   // §18.4: A) salida directa, B) producción externa

type StreamSessionState =
  | "OFF" | "PREPARING" | "CONNECTING" | "PUBLISHING" | "RECONNECTING" | "FAILED" | "STOPPING";

interface StreamSession {
  id: string;                    // = streaming_sessions.id (se reutiliza la tabla, §20)
  programId: string;             // aleatorio (128 bits), uno por sesión; no deriva de ningún otro id
  outputKind: OutputKind;
  channel: { platform: string; ingestLabel: string; backupAvailable: boolean }; // sin URL completa ni clave
  state: StreamSessionState;     // derivado: BD (active/stopped/failed) + /status del streamer (§7.1)
  policy: BroadcastPolicy;       // §9
  startMode: BattleStartMode;    // por defecto para los ítems de batalla de esta sesión (§8)
  startedAt: string | null;
  startedBy: string;             // actor (usuario), como hoy
  stoppedAt: string | null;
  stopReason: string | null;     // códigos actuales + "operator_stop", "queue_finished"
  lastError: HumanError | null;  // §14, redactado
  version: number;               // concurrencia optimista
}
```

En modo `external_production` **no hay StreamSession**: S9 no crea sesiones RTMP y OBS compone (§12).
La cola puede existir igualmente como «guion» del realizador (opcional, §12.4).

### 6.2 BroadcastItem

```ts
type BroadcastItemKind = "live_battle" | "replay" | "intermission" | "slate" | "waiting" | "final";

type BroadcastItemState =
  | "NONE" | "QUEUED" | "PREPARING" | "WAITING_FOR_SPECTATOR" | "WAITING_FOR_RENDER"
  | "READY" | "LIVE" | "FINISHED" | "FAILED";

type ItemEndReason =
  | "completed"          // la batalla terminó y se mostró el resultado; el replay llegó al final; la slate cumplió su tiempo
  | "skipped"            // el operador lo saltó
  | "cancelled"          // la batalla se canceló o falló antes de empezar
  | "preempted"          // el operador cambió a otro ítem (CAMBIAR A ESTA BATALLA)
  | "source_failed"      // la fuente falló de forma repetida (§14)
  | "session_stopped";   // se paró la sesión

interface BroadcastItem {
  id: string;
  sessionId: string | null;      // null en una cola de producción externa
  position: number;              // orden en la cola (denso; se recalcula al reordenar)
  kind: BroadcastItemKind;
  ref: ItemRef;                  // §6.4
  state: BroadcastItemState;
  endReason: ItemEndReason | null;
  readiness: ReadinessChecklist; // §8.1, sólo para live_battle y replay
  startMode: BattleStartMode | null; // sólo live_battle; hereda el de la sesión si es null
  durationMs: number | null;     // slate/intermission: fija; replay: la del índice; live: null
  enteredStateAt: string;
  lastError: HumanError | null;
  version: number;
}
```

`FINISHED` y `FAILED` son terminales. Los motivos (`skipped`, `cancelled`, `preempted`…) van en
`endReason` en lugar de multiplicar estados, para no salirse de la lista del encargo.

### 6.3 BroadcastQueue

```ts
interface BroadcastQueue {
  sessionId: string | null;
  paused: boolean;               // pausada: no avanza sola; el ítem LIVE sigue hasta su fin natural
  autoAdvance: boolean;          // continuar automáticamente al terminar el ítem actual
  current: BroadcastItem | null; // AHORA (el ítem LIVE o, si no hay, el que se está preparando)
  next: BroadcastItem[];         // SIGUIENTES, en orden
  history: BroadcastItem[];      // terminados de esta sesión (para Diagnóstico)
  source: QueueSource;           // de dónde salió: torneo, lista de replays o selección manual
  version: number;
}

type QueueSource =
  | { kind: "manual" }
  | { kind: "tournament"; tournamentId: string; followNewBattles: boolean }
  | { kind: "playlist"; playlistId: string };
```

Con `source.kind = "tournament"` y `followNewBattles`, el gestor añade al final las batallas que el
scheduler del torneo vaya materializando (rondas que dependen de resultados), en orden de juego
(el mismo de `GET /tournaments/{id}/battles`).

### 6.4 PlaylistItem e ItemRef (preparado para listas mixtas)

```ts
type ItemRef =
  | { kind: "live_battle"; battleId: string }
  | { kind: "replay"; battleId: string; fromTick?: number; toTick?: number }
  | { kind: "intermission"; afterItemId: string | null }    // muestra el resultado del anterior y el siguiente
  | { kind: "slate"; slateId: SlateId; text?: string }       // texto saneado, como el branding actual
  | { kind: "waiting"; untilItemId: string | null }          // «la batalla empieza en breve»
  | { kind: "final" };

type SlateId = "starting_soon" | "be_right_back" | "technical_difficulties" | "end_of_stream";

interface PlaylistItem {
  ref: ItemRef;
  durationMs?: number;           // slate/intermission; ignorado en live/replay
  transition?: "cut" | "fade";   // por defecto "fade" de 500 ms
}

interface Playlist {
  id: string;
  name: string;                  // nombre humano, lo que ve el operador
  items: PlaylistItem[];         // en la primera iteración sólo replay + slate/intermission
  createdBy: string;
  updatedAt: string;
  version: number;
}
```

La cola y la lista usan el **mismo** `ItemRef`. Mezclar directo y replay en una misma lista no se
implementa en la primera iteración (MS-7 sólo admite `replay`, `slate` e `intermission` en listas
guardadas), pero nada del modelo lo impide: una `live_battle` en una lista es simplemente un ítem que
pasa por el gate de §8.

### 6.5 BattleBroadcastControl

```ts
type BattleBroadcastControlState =
  | "SCHEDULED" | "WAITING_FOR_BROADCAST" | "READY_TO_START" | "RUNNING" | "FINISHED";

interface BattleBroadcastControl {
  battleId: string;
  itemId: string;
  sessionId: string | null;
  state: BattleBroadcastControlState;
  hold: boolean;                  // true ⇔ el worker NO puede reclamar la batalla (§8.4)
  releasedAt: string | null;
  releasedBy: string | null;      // usuario, o "auto_start_when_ready"
  releaseKind: "operator" | "auto_when_ready" | "operator_without_broadcast" | null;
  version: number;
}
```

### 6.6 Persistencia (migración de MS-2/MS-3)

Aditiva sobre la 017. El número exacto se fija al integrar (MG ya ocupa la 021).

| Tabla | Columnas principales | Notas |
|---|---|---|
| `streaming_sessions` (existe) | + `program_id uuid unique`, `output_mode`, `policy`, `start_mode`, `version` | La fila sigue siendo la sesión; el índice único `state='active'` se conserva |
| `broadcast_items` (nueva) | `id`, `session_id` (nullable), `queue_id`, `position`, `kind`, `ref jsonb`, `state`, `end_reason`, `readiness jsonb`, `start_mode`, `duration_ms`, `entered_state_at`, `last_error jsonb`, `version` | Índice parcial: como máximo un ítem `LIVE` por sesión |
| `broadcast_queues` (nueva) | `id`, `session_id` (nullable), `paused`, `auto_advance`, `source jsonb`, `version` | Una por sesión |
| `broadcast_playlists` (nueva) | `id`, `name`, `items jsonb`, `created_by`, `updated_at`, `version` | Sin datos de bots: sólo `battleId` y textos saneados |
| `battle_broadcast_controls` (nueva) | `battle_id pk`, `item_id`, `session_id`, `state`, `hold bool`, `released_at`, `released_by`, `release_kind`, `version` | La lee el worker (MF) en `claimBattle`; el motor no |
| `broadcast_events` (nueva) | `id`, `at`, `session_id`, `item_id`, `kind`, `code`, `detail jsonb` (redactado) | Bitácora de transiciones y errores para Diagnóstico; retención 30 días |

Las transiciones de auditoría (quién preparó, empezó, saltó, pausó o paró) siguen yendo a `audit_log`
con los prefijos `broadcast.*`, como hoy `streaming.*`.

## 7. Máquinas de estado

Notación: `ORIGEN → DESTINO [disparador] / efecto`. Toda transición no listada es inválida y el API
la rechaza con `409 invalid_transition`.

### 7.1 STREAM SESSION

```
OFF ──[admin: PREPARAR EMISIÓN]──────────────► PREPARING
PREPARING ──[streamer: procesos lanzados y puerta de render abierta]──► CONNECTING   (rtmps)
PREPARING ──[streamer: procesos lanzados y puerta de render abierta]──► PUBLISHING   (record)
CONNECTING ──[streamer: relay.state = publishing]──────────────► PUBLISHING
PUBLISHING ──[streamer: corte del relé o exit de ffmpeg/Chromium]──► RECONNECTING
RECONNECTING ──[streamer: relay.state = publishing]─────────────► PUBLISHING
RECONNECTING ──[streamer: reintentos agotados]─────────────────► FAILED
PREPARING|CONNECTING ──[streamer: render_not_ready, credencial rechazada, reintentos agotados]──► FAILED
FAILED ──[admin: REINTENTAR]──────────────────────────────────► PREPARING   (misma sesión, mismo programa)
* (salvo OFF) ──[admin: DETENER | ajustes: desactivar | reconciliador: huérfana]──► STOPPING
STOPPING ──[streamer: stop confirmado (wasActive) o streamer inalcanzable con force]──► OFF
```

| Estado | Fuente de verdad | Equivalencia actual (`uxState` / `SupervisorState`) |
|---|---|---|
| OFF | BD sin sesión activa | `ready` / `idle` |
| PREPARING | BD activa, streamer `streaming` sin ffmpeg (puerta de render cerrada) | `starting` |
| CONNECTING | streamer `streaming`, relé sin `publishing` | `starting` |
| PUBLISHING | relé `publishing` (rtmps) o ffmpeg grabando (record) | `live` / `recording` |
| RECONNECTING | streamer `retrying` | `retrying` |
| FAILED | streamer `failed` o BD activa con streamer sin emitir | `failed` / `interrupted` |
| STOPPING | BD `stopped` y streamer aún emitiendo | (transitorio, hoy invisible) |

Quién dispara: **admin** (preparar, detener, reintentar), **streamer** (todo lo relativo a procesos y
relé, leído por el SessionManager con `GET /status`), **reconciliador** (huérfanas, como hoy) y
**ajustes** (desactivar el streaming detiene, como hoy `confirmStop`).

Regla clave: **ningún evento de un ítem cambia el estado de la sesión.** Que una batalla termine,
falle o se cancele no lleva a STOPPING. Sólo `queue_finished` con la opción «detener al terminar la
cola» lleva a STOPPING, y lo dispara el QueueEngine como si fuera el operador (§10.4).

### 7.2 BROADCAST ITEM

```
NONE ──[admin/cola: añadir]──────────────────────────────► QUEUED
QUEUED ──[cola: es el siguiente y hay hueco de programa]──► PREPARING
PREPARING ──[gestor: destino resuelto y acceso público OK]──► WAITING_FOR_SPECTATOR
WAITING_FOR_SPECTATOR ──[gateway/programa: suscriptor conectado]──► WAITING_FOR_RENDER
WAITING_FOR_RENDER ──[programa: primer frame pintado en la capa del ítem]──► READY
READY ──[cola: conmutar al aire]──────────────────────────► LIVE
LIVE ──[fin natural: resultado mostrado, replay al final, duración cumplida]──► FINISHED (completed)
QUEUED|PREPARING|WAITING_*|READY ──[admin: SALTAR]────────► FINISHED (skipped)
LIVE ──[admin: SALTAR | CAMBIAR A OTRA]──────────────────► FINISHED (skipped | preempted)
QUEUED..READY ──[worker: batalla cancelada o failed antes de empezar]──► FINISHED (cancelled)
PREPARING|WAITING_* ──[timeout de preparación | error terminal de la fuente]──► FAILED
LIVE ──[fuente: N errores seguidos (§14.3)]──────────────► FAILED (source_failed)
* ──[sesión: STOPPING]────────────────────────────────────► FINISHED (session_stopped)
READY ──[pérdida de una condición del gate antes de empezar]──► WAITING_FOR_SPECTATOR | WAITING_FOR_RENDER
FAILED ──[admin: REINTENTAR ÍTEM]─────────────────────────► PREPARING
```

Ítems sin gate (`slate`, `intermission`, `waiting`, `final`): `QUEUED → PREPARING → READY → LIVE →
FINISHED`; WAITING_FOR_SPECTATOR se salta y WAITING_FOR_RENDER sólo exige el primer pintado.

Replay: WAITING_FOR_SPECTATOR significa «índice del replay y primer segmento descargados» (no hay
gateway, §13).

Quién dispara: **gestor** (resolución, timeouts, avance de cola), **programa** (render), **gateway**
(suscripción), **worker** (cancelación o fallo de la batalla, leído de `battles.status`) y **admin**.

### 7.3 BATTLE BROADCAST CONTROL

Sólo existe para batallas asignadas a la emisión. Una batalla sin control se ejecuta como hoy.

```
SCHEDULED ──[gestor: ítem en cola con START_WITH_BROADCAST]──► WAITING_FOR_BROADCAST   (hold = true)
SCHEDULED ──[gestor: ítem con START_INDEPENDENT]─────────────► SCHEDULED               (hold = false; se ejecuta sola)
WAITING_FOR_BROADCAST ──[gestor: ítem READY]─────────────────► READY_TO_START          (hold = true)
READY_TO_START ──[gestor: el ítem pierde READY]──────────────► WAITING_FOR_BROADCAST
READY_TO_START ──[admin: EMPEZAR BATALLA | gestor: AUTO_START_WHEN_READY]──► (hold = false) → RUNNING
WAITING_FOR_BROADCAST ──[admin: EMPEZAR SIN EMISIÓN (confirmación explícita)]──► (hold = false) → RUNNING
WAITING_FOR_BROADCAST|READY_TO_START ──[admin: SALTAR | ítem cancelado | sesión detenida]──► SCHEDULED (hold = false, control borrado) *
(hold = false) ──[worker: claimBattle gana el UPDATE]────────► RUNNING
RUNNING ──[worker: finishBattle | fallo | cancelación]───────► FINISHED
```

\* Al **soltar la retención por abandono** (saltar, sesión parada) la batalla vuelve a la planificación
normal **sólo si la política lo dice** (§24, D3). La opción segura y por defecto es
`on_abandon: "keep_held"`: la batalla se queda retenida (SCHEDULED con `hold = true`) y el panel lo
muestra con la acción «Liberar para jugar sin emisión». Así se cumple P4: abandonar la emisión no
inicia nada por sí solo.

Quién dispara: **gestor/admin** escriben `hold` y el estado hasta READY_TO_START; el **worker** es el
único que pone RUNNING (al reclamar) y FINISHED (al cerrar). MS nunca escribe `battles.status`.

### 7.4 Coherencia entre las tres máquinas

| Invariante | Comprobación (test, §21) |
|---|---|
| I1. Una batalla con `hold = true` nunca pasa a `running` | worker: `claimBattle` con control retenido devuelve null; mutante que quita el predicado ⇒ rojo |
| I2. Sólo un ítem LIVE por sesión | índice único parcial + test de carrera |
| I3. `BATTLE_FINISHED` no lleva la sesión a STOPPING | test de handoff con 3 batallas; contador de `stop` del streamer = 0 |
| I4. Un cambio de ítem no llama a `/control/start` ni a `/control/stop` | test con streamer falso que cuenta llamadas |
| I5. AUTO_START sólo con las condiciones de §8.1 a la vez | tabla de verdad completa de las 6 condiciones |
| I6. Ninguna transición de ítem inicia una batalla sin `releaseKind` registrado | auditoría obligatoria; test |

## 8. BROADCAST_READY y el start sincronizado

### 8.1 Las condiciones

```
BROADCAST_READY(item) =
      TARGET_RESOLVED      — la batalla existe, está SCHEDULED/RUNNING (o el replay existe) y es la del ítem
    ∧ PUBLIC_ACCESS        — broadcastAvailable = true (estado efectivo de #269, misma política que /broadcast)
    ∧ SPECTATOR_READY      — el programa tiene una suscripción viva al canal de la batalla (§8.5)
    ∧ RENDER_READY         — el programa pintó el primer frame del ítem en su capa
                             ∧ el detector de frame del streamer ve imagen (no blanca ni uniforme, #256)
    ∧ (output = rtmps ⇒ RTMP_CONNECTED ∧ RTMP_PUBLISHING)
```

| Condición | Quién la mide | Fuente | Fiabilidad |
|---|---|---|---|
| TARGET_RESOLVED | API | BD (`battles`, `replays`) | servidor |
| PUBLIC_ACCESS | API | `broadcast-effective.ts` (#269) con auth anónimo | servidor |
| SPECTATOR_READY | gateway | conexión con ticket de audiencia `broadcast` y claim `program = programId` (§8.5) | servidor |
| RENDER_READY (página) | programa | heartbeat con `renderedItemId` (§8.3) | cliente con token |
| RENDER_READY (vídeo) | streamer | `frame-check.ts` sobre el Xvfb (ya existe) | servidor |
| RTMP_CONNECTED / RTMP_PUBLISHING | streamer | `relay.state` en `/status` | servidor |

Cada condición se guarda en `item.readiness` con su instante y su último motivo de fallo, y la UI la
pinta como lista de comprobación (§16.3):

```ts
interface ReadinessChecklist {
  targetResolved: Check; publicAccess: Check; spectatorReady: Check; renderReady: Check;
  rtmpConnected: Check | null; rtmpPublishing: Check | null;   // null si la salida no es RTMP
}
interface Check { ok: boolean; since: string | null; reason: HumanError | null }
```

Ninguna condición depende **sólo** del cliente. La única que lleva dato del cliente (el render de la
página) exige además la comprobación del vídeo en el streamer, así que un heartbeat falsificado no
basta para iniciar una batalla (§19).

### 8.2 Modos de inicio

```ts
type BattleStartMode =
  | { sync: "START_WITH_BROADCAST"; trigger: "MANUAL" | "AUTO_START_WHEN_READY" }
  | { sync: "START_INDEPENDENT" };   // la batalla corre cuando el worker tenga hueco (comportamiento actual)
```

- **START_WITH_BROADCAST + MANUAL**: preparar, esperar READY y el operador pulsa [EMPEZAR BATALLA].
- **START_WITH_BROADCAST + AUTO_START_WHEN_READY**: preparar, verificar READY durante una ventana de
  estabilidad (por defecto 3 s seguidos, para no arrancar con un READY que parpadea) y S9 la inicia.
- **START_INDEPENDENT**: la emisión se engancha a una batalla que corre por su cuenta. Es lo que hay
  hoy, y lo que usa `manual` cuando el operador cambia a una batalla ya en curso (§9.3).

En la UI: «Empezar la batalla cuando la emisión esté lista: [Manual] [Automático]». Por defecto:
**Manual** para una batalla suelta y **Automático** para un torneo (decisión D2, §24).

### 8.3 La secuencia de START_WITH_BROADCAST (§18.7)

| Paso | Estado del control | Estado del ítem | Qué ocurre |
|---|---|---|---|
| 1 | SCHEDULED | — | la batalla existe (`battles.status = scheduled`) |
| 2 | WAITING_FOR_BROADCAST | QUEUED → PREPARING | el gestor la asigna y pone `hold = true` **en la misma transacción** en que crea el ítem |
| 3 | WAITING_FOR_BROADCAST | WAITING_FOR_SPECTATOR | el programa pide un ticket de pre-roll y se suscribe (§8.5) |
| 4 | WAITING_FOR_BROADCAST | WAITING_FOR_RENDER | el programa monta el visor en la capa oculta |
| 5 | — | — | BROADCAST_PAGE_READY: heartbeat con `renderedItemId` |
| 6 | — | — | BROADCAST_RENDER_READY: el streamer confirma frame visible |
| 7 | — | — | RTMP_PUBLISHING (la sesión ya estaba publicando con la *slate* de espera) |
| 8 | READY_TO_START | READY | BROADCAST_READY |
| 9 | READY_TO_START | READY → LIVE | se habilita [EMPEZAR BATALLA] (o AUTO_START); el programa conmuta a la capa de la batalla, que muestra «empieza en breve» con la nómina pública |
| 10 | RUNNING | LIVE | el operador (o el auto-start) suelta la retención; el worker la reclama; llega el tick 0 |

**Heartbeat del programa.** `POST /api/v1/broadcast/programs/{programId}/heartbeat`, cada 2 s, con el
token del programa en una cabecera. Cuerpo cerrado (esquema estricto, 1 KB máximo):

```ts
interface ProgramHeartbeat {
  programId: string;
  onAirItemId: string | null;
  preparingItemId: string | null;
  renderedItemId: string | null;     // último ítem cuya capa pintó su primer frame
  lastTick: number | null;           // tick público del ítem en el aire (observabilidad)
  errors: { code: SourceErrorCode; count: number; lastAt: string }[]; // §14
  pageVersion: string;
}
```

El token del programa (32 bytes aleatorios, uno por sesión) viaja en el **fragmento** de la URL que
captura Chromium (`#t=…`): no sale en `Referer` ni en los logs de acceso, y la página lo pasa a
cabecera. Es una credencial de **telemetría**: sólo permite escribir el heartbeat de su programa
mientras su sesión está activa, y no da lectura de nada. No es la clave de emisión ni deriva de ella.

### 8.4 Cómo se retiene una batalla sin tocar el motor

La retención vive **fuera** de `battles` y del motor: en `battle_broadcast_controls.hold`. El worker
la respeta con un predicado más en la reserva atómica:

```sql
-- battle-runner.ts:claimBattle (cambio de MF, contrato de MS)
WHERE id = :battleId
  AND ( status = 'scheduled' OR (status = 'running' AND lease caducado) )
  AND NOT EXISTS (SELECT 1 FROM battle_broadcast_controls c
                  WHERE c.battle_id = battles.id AND c.hold)          -- nuevo
```

Si el `claim` pierde por la retención, el trabajo `run_battle` **no cuenta como intento**: se
re-encola con `run_after = now() + 2 s` (o se despierta con la señal de Redis al soltar la retención).
No hay fallo de infraestructura ni `needs_review` por estar retenida. Soltar la retención es un
`UPDATE … SET hold = false` + señal; el worker la reclama en el siguiente ciclo (latencia esperada
≤ 1 s con señal, ≤ 2 s sin ella).

Por qué no se toca el determinismo: la semilla, el ruleset y los participantes se fijan al crear la
batalla; el motor no lee la tabla de control; `started_at` sólo es metadato. Test: el `stateHash` final
de una batalla retenida 30 s es idéntico al de la misma batalla sin retener (§21, T-DET).

Concurrencia: la retención no ocupa hueco del worker. Una batalla retenida no consume CPU ni
contenedores: los runners de bots se lanzan después del `claim`.

### 8.5 SPECTATOR_READY antes de que la batalla empiece (pre-roll)

Hoy un visitante no puede abrir el canal de una batalla `scheduled` (`battle-access.ts`, vía 5 sólo
`running`), y quien se conecta tarde sin retardo recibe el último snapshot. Para no perder el principio
hace falta estar suscrito **antes** del tick 0.

Diseño: el programa pide `POST /api/v1/broadcast/programs/{programId}/spectate-ticket` con el token del
programa. El API emite un ticket de audiencia `broadcast` (la audiencia firmada de #272) con un claim
adicional `program = programId`, válido sólo si:

- la batalla tiene un control `WAITING_FOR_BROADCAST`/`READY_TO_START` **de ese programa**, y
- la batalla es mostrable en público (`wherePubliclyShowable`).

El gateway acepta esa suscripción en `scheduled`, envía un `init` sin snapshot (o con la nómina pública
del WELCOME proyectado) y entrega los frames desde el tick 0 cuando empieza. El gateway informa al API
(o el API le pregunta) qué programas tienen suscripción viva: eso es SPECTATOR_READY, medido en el
servidor.

Lo que **no** se hace: abrir las batallas programadas a cualquier visitante. Una fuente de OBS
(`/broadcast/battle/{id}`) no tiene token y sigue la regla pública normal (§12). Decisión D1 (§24).

Retardo anti-coaching: si el ruleset tiene `spectator.delaySeconds > 0`, el gateway ya guarda la
ventana de historia y entrega desde `cutoff`. El tick 0 llega al programa `delaySeconds` después del
inicio real. El ítem pasa a LIVE en el paso 9 y el contador de la UI muestra «empieza en
≈ N s (retardo de emisión)». El retardo no se duplica en ffmpeg (sigue la regla de `ffmpeg.ts`).

### 8.6 Timeouts de preparación

| Fase | Plazo por defecto | Al vencer |
|---|---|---|
| PREPARING (resolución + acceso) | 10 s | ítem FAILED con el motivo humano de la condición que falla |
| WAITING_FOR_SPECTATOR | 30 s | FAILED `SPECTATOR_FAILED` |
| WAITING_FOR_RENDER | 30 s | FAILED `RENDER_FAILED` |
| Sesión CONNECTING (la primera vez) | el del relé actual (reintentos) | sesión FAILED; los ítems siguen QUEUED |

Un ítem FAILED **no inicia la batalla** (P4). La batalla sigue retenida y el panel ofrece: [Reintentar],
[Saltar] y [Empezar sin emisión] (con confirmación). Con AUTO_START, el gestor reintenta la
preparación una vez antes de dejarla FAILED.

## 9. Concurrencia y políticas de emisión

### 9.1 Dos números distintos

| Parámetro | Qué limita | Dónde vive | Ejemplo |
|---|---|---|---|
| `BATTLE_CONCURRENCY` | batallas ejecutándose a la vez en el worker | worker (MF), `computeConcurrency()` + configuración | 3 |
| `BROADCAST_CONCURRENCY` | programas emitiendo a la vez (= sesiones RTMP/grabación activas) | ajustes de emisión (MS) | 1 |

Con una sola salida (`BROADCAST_CONCURRENCY = 1`, el valor actual y el único que se implementa en
MS-2…MS-8), sólo hay un programa y un ítem LIVE. Subir `BROADCAST_CONCURRENCY` exigiría varias
sesiones simultáneas, que hoy impide el índice único de la 017. El modelo lo admite (todo cuelga de
`sessionId`), pero queda fuera de alcance.

### 9.2 `BROADCAST_POLICY = serial` (recomendada para YouTube)

- Sólo las batallas **de la cola de la sesión** quedan afectadas. El resto de la plataforma usa
  `BATTLE_CONCURRENCY` como hoy.
- De las batallas de la cola, como máximo **una** está sin retener a la vez: la del ítem que va a
  entrar o está en el aire. Las demás están en WAITING_FOR_BROADCAST.
- Cuando B1 termina: B1 FINISHED → intermedio LIVE → B2 PREPARING → … → BROADCAST_READY → B2 RUNNING.

Efecto sobre un torneo con `BATTLE_CONCURRENCY = 3`: sus batallas se juegan **de una en una**. Es el
precio de emitirlas completas. Alternativa (D3, §24): `serial_partial`, que deja correr sin retener
las que no caben y las ofrece después como replay.

### 9.3 `BROADCAST_POLICY = manual`

- No se retiene nada por defecto: las batallas corren cuando el worker puede.
- Batallas/Fuentes y Directo muestran las batallas en curso con [EMITIR] o, si ya hay emisión,
  [CAMBIAR A ESTA BATALLA]. Eso crea un ítem `live_battle` con `START_INDEPENDENT` y lo pone en el aire
  en cuanto está READY (la batalla ya corre: se ve desde donde va).
- Para una batalla `scheduled`, [PREPARAR] crea el ítem con START_WITH_BROADCAST y sí la retiene.

### 9.4 `OUTPUT_MODE = external_production`

- No hay StreamSession: S9 no abre RTMP (§12).
- Las batallas no se serializan: corren en paralelo con `BATTLE_CONCURRENCY`, cada una con su fuente.
- El start sincronizado es opcional y **siempre manual**: S9 no ve OBS, así que no puede medir
  SPECTATOR_READY ni RENDER_READY de la fuente. La lista de comprobación muestra «La fuente de OBS no
  informa a S9: confirma en OBS que se ve» y el operador pulsa [EMPEZAR BATALLA].

```ts
type BroadcastPolicy = "serial" | "manual" | "serial_partial"; // serial_partial: pendiente de D3
```

## 10. YouTube continuo y handoff entre batallas

### 10.1 Secuencia continua

```
StreamSession 123: OFF → PREPARING → CONNECTING → PUBLISHING ───────────────────────────────────► STOPPING → OFF
Programa:          [waiting] → [B1 LIVE] → [intermedio] → [B2 LIVE] → [intermedio] → [B3 LIVE] → [final]
RTMP:              ════════════════════ una sola conexión publish, sin cortes ════════════════════
```

La sesión arranca con la *slate* `starting_soon` (o el `waiting` del primer ítem) **antes** de la primera
batalla, para que RTMP_PUBLISHING sea cierto cuando se evalúa el primer BROADCAST_READY. Con
YouTube, eso da además tiempo a que el directo pase a «en vivo» en el estudio antes del tick 0.

### 10.2 Handoff A → B sin pantallazos blancos (§18.21)

1. A termina en el worker (`battles.status = finished`). El ítem A **no** termina aún: con retardo, el
   final llega al programa `delaySeconds` después.
2. El programa recibe `result` del gateway y lo muestra (marcador final, mínimo 8 s). Heartbeat:
   `onAirItemId = A`, evento `result_shown`.
3. El gestor marca A FINISHED (`completed`) y pone en el aire el ítem de intermedio (ya READY: sólo
   DOM).
4. Mientras el intermedio está en pantalla, B pasa por PREPARING → WAITING_FOR_SPECTATOR →
   WAITING_FOR_RENDER **en la capa oculta**.
5. B READY → (AUTO_START o operador) → B RUNNING → primer frame de B pintado en su capa.
6. El programa conmuta de la capa del intermedio a la de B con un `fade` de 500 ms. La capa del
   intermedio se desmonta **después** de la conmutación.

Reglas que evitan blancos:

- Siempre hay una capa pintada en el aire. La capa nueva sólo se muestra tras su primer frame
  (`requestAnimationFrame` después del primer `snapshot` dibujado).
- No hay recargas de página entre ítems. La navegación es interna de la SPA.
- Si B falla al prepararse, el intermedio pasa a la *slate* `be_right_back`; nunca a una pantalla
  vacía.
- El fondo de la página es el color de branding (no el blanco por defecto de Chromium), como ya exige
  #256.

### 10.3 Cambio manual sin reiniciar el RTMP (§18.12, §18.20)

[CAMBIAR A ESTA BATALLA] = crear el ítem B (START_INDEPENDENT si ya corre), prepararlo en la capa oculta
y, al estar READY, dejar A FINISHED (`preempted`) y conmutar. Ni `/control/start` ni `/control/stop`.
Test I4.

### 10.4 Fin de la cola

Al terminar el último ítem: ítem `final` LIVE. La sesión **sigue publicando** con la pantalla final
hasta que el operador pulsa [DETENER EMISIÓN], salvo que la sesión se preparase con «Detener la emisión
al terminar la cola» (por defecto activado para torneos, con 60 s de pantalla final). La parada la
dispara el QueueEngine como `queue_finished` y pasa por el mismo camino que la del operador.

## 11. Reconexión y fallos durante la emisión

### 11.1 Política (§18.22)

| Situación | Batalla aún no empezada (WAITING_FOR_BROADCAST / READY_TO_START) | Batalla ya RUNNING |
|---|---|---|
| RTMP cae (sesión RECONNECTING) | **No se inicia.** RTMP_PUBLISHING deja de cumplirse ⇒ el ítem vuelve a WAITING y el control a WAITING_FOR_BROADCAST; AUTO_START no dispara | **No se pausa.** El supervisor reconecta (como hoy); se registra `broadcast_gap` con inicio y fin |
| Espectador del programa cae | No se inicia; el programa pide ticket nuevo | Se reconecta (`SpectatorClient` ya lo hace); se registra el tramo perdido (`lastTick` antes y después) |
| Render no pinta | No se inicia | `RENDER_FAILED` tras N fallos; *slate* `technical_difficulties`; se sigue intentando |
| API inalcanzable desde el programa | No se inicia (no hay heartbeat ⇒ RENDER_READY caduca a los 6 s) | El programa sigue pintando lo que tiene; heartbeat atrasado ⇒ el panel avisa |
| Sesión FAILED | Los controles siguen retenidos; ninguna batalla empieza | La batalla sigue hasta el final; se ve después en el replay |

Lo que **nunca** se hace: pausar el worker, alargar el lease, cambiar la cadencia de ticks o reiniciar
una batalla para «recuperar» la emisión. El determinismo queda fuera de la emisión.

### 11.2 Registro de pérdida parcial

```ts
interface BroadcastGap {
  sessionId: string; itemId: string; battleId: string | null;
  cause: "rtmp" | "spectator" | "render" | "program_api";
  fromAt: string; toAt: string | null;
  fromTick: number | null; toTick: number | null;   // ticks públicos (los del projectFrame)
}
```

Se guarda en `broadcast_events` y se muestra en Diagnóstico («Se perdieron 14 s de la batalla A vs B:
del tick 1210 al 1630»). Para recuperar ese tramo en vídeo está el replay.

## 12. Fuentes por batalla para producción externa (OBS)

### 12.1 URLs estables y documentadas

| Fuente | URL canónica | Equivalente heredado |
|---|---|---|
| Batalla (directo y, al terminar, su resultado) | `/broadcast/battle/{battleId}` | `/broadcast?battle={battleId}` (se mantiene) |
| Replay | `/broadcast/replay/{battleId}` | — |
| Torneo (director automático de hoy) | `/broadcast/tournament/{tournamentId}` | `/broadcast?tournament={tournamentId}` |
| Programa de una sesión | `/broadcast/program/{programId}` | — (interna; la usa el streamer) |

Parámetros opcionales, ya saneados por `config.ts`: `event`, `logo`, `primary`, `accent` y, nuevos,
`layout=full|clean` (`clean`: sin cabecera ni ticker, para que el realizador ponga sus gráficos) y
`bg=transparent|brand` (fondo transparente para OBS). Nada más entra por la URL.

`battleId` es el identificador público que la API ya expone en `/battles/{id}` y `/replays/{id}`. No se
añade ningún otro identificador, y menos ids de entidades del motor.

### 12.2 Qué muestra una fuente

Exactamente lo que vería un visitante anónimo: la API pública y el canal de espectador con audiencia
`broadcast` (`projectFrame`, `PublicEntityId`, `EQUIPMENT_PRIVATE`, #272). Si la batalla no es
retransmisible, la fuente muestra una *slate* limpia («Esta batalla no está disponible para
retransmisión») y **no** un error HTTP.

Antes del inicio: «La batalla empieza en breve» con la nómina sólo si ya es pública. Las fuentes de OBS
no tienen pre-roll firmado (§8.5); por eso en producción externa el operador sincroniza a mano.

### 12.3 Pestaña Batallas/Fuentes

`GET /admin/broadcast/sources` devuelve, por batalla: nombre humano («A-SCOUT vs B-SCOUT»), estado,
`broadcastAvailable` + motivo (#269), la URL de la fuente (absoluta, con el origen público) y las
acciones posibles. La UI pinta BATALLA | ESTADO | RETRANSMISIBLE | FUENTE | ACCIÓN con [Copiar enlace],
[Ver], [Preparar], [Emitir]/[Cambiar a esta batalla] y [Replay].

### 12.4 Varias batallas a la vez

Con `external_production`, tres batallas simultáneas dan tres URLs independientes. Cada fuente es una
página aislada con su propio `SpectatorClient`; no comparten estado. S9 no crea sesiones RTMP. Puede
existir una cola de producción externa (sin sesión) como guion para el realizador, sin efecto sobre la
salida.

## 13. Replays y listas de reproducción

### 13.1 Replay único (REPLAY_SINGLE)

- Ítem `replay` con `battleId` (y opcionalmente `fromTick`/`toTick`).
- La página lee el replay **público** (índice y segmentos de `/public/replays/{battleId}*`, formato v2 de
  #271 proyectado por #272: `projection …v2`) y lo reproduce con el mismo visor, a velocidad 1×.
- Condiciones: TARGET_RESOLVED (replay existe y `finished`), PUBLIC_ACCESS (`publicReplaysEffective`
  de #269), SPECTATOR_READY = índice + primer segmento descargados y validados, RENDER_READY = primer
  frame pintado (+ vídeo en el streamer si hay sesión).
- Duración conocida por el índice ⇒ la UI enseña progreso y tiempo restante.
- No se usa el canal de espectador ni el motor: un replay en emisión no ejecuta nada.

### 13.2 Lista de replays (REPLAY_PLAYLIST)

- `Playlist` guardada (§6.4) con `replay`, `slate` e `intermission`. El operador la crea, la ordena y la
  inicia; al iniciarla se copia a la cola de la sesión (la lista guardada no cambia si luego se reordena
  la cola).
- Entre replays: transición `fade` y una pantalla breve (`intermission` con el resultado del que acaba
  y el título del siguiente; 5 s por defecto).
- Directo muestra: replay actual, siguiente, posición (2/5) y progreso.

### 13.3 Mezcla directo + replay

Prevista por el modelo (mismo `ItemRef`), no implementada en la primera iteración. La regla que la hará
posible: un `live_battle` en una lista pasa por el gate de §8 como cualquier otro.

## 14. Errores: códigos técnicos y mensajes humanos; fallar de forma visible

### 14.1 Forma común

```ts
interface HumanError {
  code: string;            // técnico, estable, para logs y tests (p. ej. "SPECTATOR_FAILED")
  message: string;         // humano, en español, sin jerga
  action?: string;         // qué puede hacer el operador
  detail?: string;         // técnico, plegado en la UI, redactado, ≤ 300 caracteres
  retryable: boolean;
}
```

### 14.2 Errores de la fuente (programa y fuentes de OBS)

| Código | Cuándo | Mensaje humano | Acción |
|---|---|---|---|
| `API_FETCH_FAILED` | red, timeout o 5xx al leer la API pública | «La emisión no puede consultar el estado de la batalla.» | «Revisa Diagnóstico; S9 sigue reintentando.» |
| `INVALID_JSON` | respuesta 2xx que no es `application/json` o no parsea (la clase de #274) | «La emisión recibe una respuesta que no entiende del servidor.» | «Es un fallo de configuración: avisa al responsable técnico.» |
| `TARGET_NOT_FOUND` | 404 de la batalla o del replay | «La batalla todavía no está disponible para retransmisión.» | «Comprueba que la batalla existe y que es pública.» |
| `ACCESS_DENIED` | `broadcastAvailable = false` | «Esta batalla no se puede mostrar en público: {motivo de #269}.» | enlace al ajuste correspondiente |
| `SPECTATOR_FAILED` | ticket rechazado o socket con cierre terminal | «No se puede mostrar esta batalla porque el espectador público no está disponible.» | «Comprueba Acceso público en Configuración.» |
| `RENDER_FAILED` | la capa no pinta en el plazo o el streamer ve blanco/uniforme | «La imagen de la emisión no se está generando.» | [Reintentar ítem] |
| `REPLAY_UNAVAILABLE` | replay sin índice/segmento válido | «Este replay no se puede reproducir.» | [Saltar] |

### 14.3 Regla de fallar de forma visible (sustituye al `catch {}` de `director.ts`)

- Toda lectura de la página clasifica el error con la tabla anterior. Se comprueba `Content-Type`
  antes de parsear: una respuesta HTML a una ruta de API es `INVALID_JSON`, nunca «sin datos».
- **1 fallo**: se conserva la última pantalla y se reintenta (como hoy).
- **3 fallos seguidos** (≈ 12 s con el sondeo de 4 s) **o** 1 error terminal (`TARGET_NOT_FOUND`,
  `ACCESS_DENIED`, `INVALID_JSON`): la pantalla pública pasa a una *slate* limpia (programa:
  `technical_difficulties`; fuente de OBS: la *slate* de la fuente) y el error va en el heartbeat.
- El gestor convierte el error del heartbeat en `item.lastError` y, si persiste 30 s, en ítem FAILED
  (`source_failed`) y en un aviso en el panel.
- **Si el heartbeat no llega** (por ejemplo, la API no es alcanzable desde la página, como en #274), el
  gestor lo detecta por **ausencia**: heartbeat con más de 10 s de antigüedad ⇒ `API_FETCH_FAILED`
  (deducido) en el panel. El panel nunca muestra «EN DIRECTO» sin más: muestra «Publicando, pero la
  página de emisión no responde».
- La *slate* pública nunca enseña códigos, ids ni rutas. Una fuente de OBS admite `?diag=1`, que
  añade una línea pequeña con el código técnico (sin ids ni rutas) para el realizador.

### 14.4 Errores del API de administración

Los códigos actuales (`already_active`, `credential_missing`, `credential_unbound`, `battle_not_public`,
`tournament_not_broadcastable`, `disk_low`, `streamer_unavailable`, …) se mantienen como `code` y
cada uno tiene su `message` humano en el servidor (hoy la traducción está en `StreamingPage.tsx:humanReason`;
pasa al API para que todas las vistas digan lo mismo). Nuevos: `invalid_transition`, `not_ready`,
`battle_already_running`, `queue_version_conflict`, `playlist_not_found`, `item_not_found`.

## 15. Observabilidad: sesión frente a ítem

### 15.1 Sesión (salida)

Ya existe casi todo (`stream_*` y `streamer_*`, `metrics.ts`): duración, fps, bitrate, frames, frames
descartados, reconexiones, ingesta (principal o respaldo) y último error. Se añade
`stream_session_state{state}` (gauge 0/1 por estado de §7.1).

### 15.2 Ítem (contenido)

| Métrica / campo | Dónde | Notas |
|---|---|---|
| `broadcast_item_state{kind,state}` | Prometheus (API) | sin ids en etiquetas (cardinalidad) |
| `broadcast_item_errors_total{code}` | Prometheus | códigos de §14.2 |
| `broadcast_ready_seconds` (histograma) | Prometheus | de PREPARING a READY |
| `broadcast_handoff_seconds` (histograma) | Prometheus | de FINISHED de A a primer frame de B |
| `broadcast_gap_seconds_total{cause}` | Prometheus | pérdida parcial (§11.2) |
| `broadcast_program_heartbeat_age_seconds` | Prometheus | alerta si > 10 s con sesión PUBLISHING |
| batalla/replay, fuente, acceso público, espectador, render, tick actual, posición en la cola | `GET /admin/broadcast/state` | con ids, sólo para admin |

### 15.3 Nada de un único «streaming=true»

`s9_streaming_session_active` sigue para compatibilidad, pero el panel y las alertas usan las dos
familias. Alerta nueva `BroadcastSourceStale`: sesión PUBLISHING ∧ heartbeat > 30 s (el caso #274 habría
saltado aquí).

## 16. UI: Administración → Retransmisión

### 16.1 Menú único

`admin-nav.tsx`: la entrada «Streaming» pasa a **«Retransmisión»** (`#/retransmision`, con redirección
desde `#/streaming`). Pestañas:

| Pestaña | Contenido | Sale de (hoy) |
|---|---|---|
| **Directo** | estado de la sesión y del ítem, AHORA/SIGUIENTE, lista de comprobación de READY, [PREPARAR EMISIÓN], [EMPEZAR BATALLA], [DETENER EMISIÓN] | `ReadyView`, `LiveView` |
| **Cola** | AHORA y SIGUIENTES; reordenar, saltar, pausar/continuar, añadir, «continuar automáticamente» | nuevo |
| **Batallas/Fuentes** | tabla BATALLA \| ESTADO \| RETRANSMISIBLE \| FUENTE \| ACCIÓN | `ManualTargetCard`, `listStreamingDestinations` |
| **Replays** | replays emitibles, listas guardadas, crear/ordenar/iniciar | nuevo |
| **Canales** | plataforma, servidores principal y de respaldo, clave (`****ABCD`), probar conexión, grabación local | `IngestsCard`, `CredentialsCard`, parte de `SettingsCard` |
| **Configuración** | activar, códec/preset/fps/bitrate, branding, política (serial/manual), modo de inicio por defecto, timeouts, retención; estado de Acceso público (de #269) con enlace a su ajuste | `SettingsCard`, `BrandingCard`, `RecordingsCard` (retención) |
| **Diagnóstico** | sesión y ítem por separado (§15), errores con detalle plegado, pérdidas parciales, grabaciones, auditoría | `MonitorCard`, `MonitorTable`, `RecordingsCard`, `AuditCard` |

El bloque «Directo y retransmisión» del detalle de batalla (`BattleDetailPage.tsx`) se queda en **un
enlace** a Retransmisión → Batallas/Fuentes con la batalla preseleccionada. Sin controles propios. El
interruptor de Acceso público de #269 sigue en Administración (afecta a más que la emisión);
Retransmisión lo muestra y enlaza.

UUIDs: ocultos. Se muestran nombres humanos («A-SCOUT vs B-SCOUT · Ronda 2»). El modo avanzado
(interruptor en Diagnóstico) enseña ids y el JSON de estado.

### 16.2 Directo

**Emitiendo:**

```
● EN DIRECTO · YouTube (principal)                       00:42:17
Mostrando:  A-SCOUT vs B-SCOUT  · tick 1830 · en el aire 03:12
Siguiente:  C-TANK vs D-TANK    · preparando (espectador ✓, imagen …)
[ DETENER EMISIÓN ]   [ Saltar actual ]   [ Pausar cola ]
```

**Sin emitir:**

```
QUÉ QUIERES EMITIR   ○ Batalla  ○ Torneo  ○ Replay  ○ Lista de replays
[ selector con búsqueda por nombre ]
Canal: [ YouTube (principal + respaldo) ▾ ]
Empezar la batalla cuando la emisión esté lista: [Manual] [Automático]
[ PREPARAR EMISIÓN ]
```

### 16.3 Lista de comprobación (§18.9)

```
Preparando emisión…
  ✓ Batalla seleccionada
  ✓ Acceso público
  ✓ Espectador conectado
  … Imagen preparada
  ✓ YouTube conectado
→ (al completarse) LISTO PARA EMPEZAR   [ EMPEZAR BATALLA ]
```

Un paso fallido muestra su mensaje humano y su acción (§14). El detalle técnico, plegado.

### 16.4 Flujos de los casos A-E (§18.35)

| Caso | Pasos del operador | Qué hace el sistema |
|---|---|---|
| **A. Una batalla en YouTube** | Directo → ○ Batalla → elegir «A vs B» → Canal YouTube → Manual → [PREPARAR EMISIÓN] → (lista de comprobación) → [EMPEZAR BATALLA] | sesión PREPARING→PUBLISHING con *slate*; ítem live_battle con retención; READY; suelta; LIVE; al final, pantalla final y la sesión sigue hasta [DETENER] |
| **B. Torneo completo en YouTube** | Directo → ○ Torneo → elegir → YouTube → Automático → [PREPARAR EMISIÓN] | cola desde el torneo (`followNewBattles`), política serial, cada batalla READY→auto-start, intermedios, final, parada al terminar la cola |
| **C. Realización con OBS** | Batallas/Fuentes → [Copiar enlace] en cada batalla → pegar en OBS como «Fuente de navegador» | nada que arrancar en S9; las batallas corren en paralelo; [Empezar batalla] manual si se quiere sincronizar |
| **D. Un replay** | Directo → ○ Replay → elegir → [PREPARAR EMISIÓN] → [EMITIR] (o auto) | ítem replay; READY = índice + primer segmento + imagen; reproducción 1×; pantalla final |
| **E. Varios replays** | Replays → [Nueva lista] → añadir y ordenar → [Iniciar] (o Directo → ○ Lista de replays) | cola desde la lista; intermedio de 5 s entre replays; progreso n/N |

En manual (B), el primer botón es [EMPEZAR PRIMERA BATALLA] y los siguientes [EMPEZAR SIGUIENTE BATALLA].

## 17. Contratos de API

Todas las rutas de administración: `x-min-role: admin`, auditoría en `audit_log` (`broadcast.*`),
`Cache-Control: no-store`, errores con la forma de §14.1. Las mutaciones llevan `version` (concurrencia
optimista, `409 version_conflict`) y son idempotentes por `(id, transición)`. Se versiona el contrato
OpenAPI como hoy (`apps/api/openapi.yaml`).

### 17.1 Sesión y estado

| Método y ruta | operationId | Cuerpo / respuesta |
|---|---|---|
| `GET /admin/broadcast/state` | `getBroadcastState` | `{ session: StreamSession \| null, queue: BroadcastQueue \| null, onAir: BroadcastItem \| null, preparing: BroadcastItem \| null, readiness, gaps, outputMode, policy }` |
| `POST /admin/broadcast/sessions` | `prepareBroadcast` | `{ content: { kind: "battle"\|"tournament"\|"replay"\|"playlist", id }, channel?: { platform } \| { record: true }, startMode?, policy?, stopWhenQueueEnds? }` → `201 { session, queue }`. Sustituye a `startStreaming` |
| `POST /admin/broadcast/sessions/{id}/stop` | `stopBroadcast` | `{ force?: boolean }` → `{ session, wasActive }` (misma semántica que `stopStreaming`) |
| `POST /admin/broadcast/sessions/{id}/retry` | `retryBroadcastSession` | desde FAILED |
| `POST /admin/broadcast/sessions/{id}/restart-output` | `restartBroadcastOutput` | sólo para cambios de salida (códec, ingesta). Avisa: «cortará el directo unos segundos» |

### 17.2 Cola, ítems y control de batalla

| Método y ruta | operationId | Notas |
|---|---|---|
| `GET /admin/broadcast/queue` | `getBroadcastQueue` | |
| `POST /admin/broadcast/queue/items` | `addBroadcastItems` | `{ items: PlaylistItem[], position?: number, version }` |
| `PATCH /admin/broadcast/queue/order` | `reorderBroadcastQueue` | `{ itemIds: string[], version }`; sólo ítems QUEUED |
| `POST /admin/broadcast/queue/pause` / `resume` | `pauseBroadcastQueue` / `resumeBroadcastQueue` | pausar no corta el ítem LIVE |
| `POST /admin/broadcast/items/{id}/skip` | `skipBroadcastItem` | aplica `on_abandon` a la batalla (§7.3) |
| `POST /admin/broadcast/items/{id}/retry` | `retryBroadcastItem` | desde FAILED |
| `POST /admin/broadcast/items/{id}/start-battle` | `startBroadcastBattle` | sólo con control READY_TO_START; si no, `409 not_ready` con la lista de comprobación |
| `POST /admin/broadcast/items/{id}/start-battle-without-broadcast` | `startBattleWithoutBroadcast` | requiere `{ confirm: true }`; suelta la retención y deja el ítem FINISHED (`skipped`) |
| `POST /admin/broadcast/switch` | `switchBroadcastTo` | `{ battleId }`: CAMBIAR A ESTA BATALLA (§10.3) |

### 17.3 Fuentes, replays y listas

| Método y ruta | operationId | Notas |
|---|---|---|
| `GET /admin/broadcast/sources` | `listBroadcastSources` | filtros `status`, `tournamentId`, búsqueda por nombre; incluye `sourceUrl`, `broadcastAvailable`, `reason` |
| `GET /admin/broadcast/replays` | `listBroadcastReplays` | replays emitibles (`publicReplaysEffective`) con duración |
| `GET/POST /admin/broadcast/playlists` | `listBroadcastPlaylists` / `createBroadcastPlaylist` | |
| `GET/PATCH/DELETE /admin/broadcast/playlists/{id}` | `getBroadcastPlaylist` / `updateBroadcastPlaylist` / `deleteBroadcastPlaylist` | `version` obligatoria en PATCH |

### 17.4 Rutas públicas (sin cookies, sin `Authorization`)

| Método y ruta | operationId | Qué devuelve / acepta |
|---|---|---|
| `GET /api/v1/broadcast/programs/{programId}` | `getBroadcastProgram` | `{ programVersion, onAir: PublicItemView \| null, next: PublicItemView \| null, slate?: SlateId }`. Sólo lo que ya se emite o es público; `404` uniforme si no hay sesión activa con ese programa |
| `POST /api/v1/broadcast/programs/{programId}/heartbeat` | `postBroadcastProgramHeartbeat` | cabecera `x-program-token`; cuerpo `ProgramHeartbeat` estricto; `204`; límite de tasa por programa |
| `POST /api/v1/broadcast/programs/{programId}/spectate-ticket` | `createProgramSpectateTicket` | cabecera `x-program-token`; `{ battleId }` → ticket de audiencia `broadcast` con claim `program` (§8.5) |

```ts
interface PublicItemView {
  itemId: string;                  // id opaco del ítem (no de la batalla en el motor)
  kind: BroadcastItemKind;
  battle?: { id: string; label: string; mode: string; status: "scheduled" | "running" | "finished" };
  replay?: { battleId: string; durationMs: number; position?: { index: number; total: number } };
  slate?: { id: SlateId; text?: string };
  startsInMs?: number | null;      // cuenta atrás informativa (retardo de emisión)
}
```

`label` es la proyección de competición de `battleToJson` (nombres públicos o «Bot privado»), nunca el
dueño ni el loadout.

### 17.5 Streamer (sin cambios de protocolo)

`/control/start` sigue recibiendo `broadcastUrl`; su validación (`session.ts`) admite la ruta
`/broadcast/program/{uuid}` con fragmento `#t=` además de la heredada. `/status` añade, si MF lo
integra (#270), `streamChildren`; MS sólo lo lee.

## 18. Propiedad de recursos: MS, MF y MA

**Contrato: `BATTLE_FINISHED ≠ STREAM_SESSION_FINISHED`.**

| Recurso | Vida | Crea | Libera | Nunca lo toca |
|---|---|---|---|---|
| Xvfb, Chromium del programa, ffmpeg, relé RTMP | StreamSession | streamer por orden de MS | streamer por orden de MS (STOP) o por su propio fallo | MF (`cleanupBattleResources` no los toca) |
| Ticket y suscripción del programa a la batalla B | BroadcastItem B | página del programa | página del programa al cambiar de ítem | MF |
| Capa del visor de B en la página | BroadcastItem B | programa | programa tras conmutar | — |
| Feed del espectador de B en el gateway | BattleExecution B | worker/gateway | `cleanupBattleResources` (fase streaming: feed, con drenaje en FINISHED, #270) | MS (sólo se suscribe) |
| Contenedores de bots, motor, lease | BattleExecution B | worker | `cleanupBattleResources` | MS |
| `battle_broadcast_controls` de B | de la asignación al FINISHED de B | MS | MS (al FINISHED o al abandonar) | MF lee `hold`, no escribe |
| Proyección pública (`projectFrame`, ids públicos, EQUIPMENT_PRIVATE) | por audiencia | MA | MA | MS no proyecta nada por su cuenta |

Reglas para MF (#270):

- El teardown de una batalla **no** llama al control del streamer ni toca procesos del streamer. La
  fase «streaming» de `cleanupBattleResources` se limita al feed del gateway de **esa** batalla, con
  drenaje (el programa tiene que recibir el `result` antes de cerrarse el feed: con retardo, el drenaje
  dura `delaySeconds`).
- El reaper no considera huérfanos los procesos del streamer mientras haya una sesión activa en BD.
- Xvfb a demanda (#270) encaja: Xvfb vive con la **sesión**, no con la batalla.
- `claimBattle` añade el predicado de retención (§8.4). Es el único cambio que MS pide a MF.

Reglas con MA (#272):

- Programa y fuentes consumen sólo el gateway con audiencia `broadcast` y la API pública: lo que sale
  de `projectFrame()`.
- El ticket de pre-roll (§8.5) es un ticket de audiencia `broadcast` con un claim más; no amplía lo
  que se ve, sólo **desde cuándo** se puede suscribir.
- Hasta que #272 esté integrado, MS desarrolla con la proyección actual (`publicSnapshot`) detrás de la
  misma interfaz, y las salidas definitivas se activan con #272 dentro (gate `PUBLIC_PROJECTION_ONLY`).

## 19. Seguridad

| Regla | Cómo se cumple | Prueba |
|---|---|---|
| La clave de emisión nunca sale | sin cambios: sellada en BD, abierta en memoria del streamer; ni el programa, ni las fuentes, ni el heartbeat, ni `/admin/broadcast/*` la llevan (sólo `last4`) | `NO_STREAM_KEY_LEAK`: búsqueda de la clave y sus fragmentos en todas las respuestas, logs y HTML de la página |
| Sin ids internos innecesarios | URLs públicas con `battleId` (ya público), `programId` e `itemId` opacos; ids de entidades del motor nunca (sólo `PublicEntityId` de #272) | test de forma de `PublicItemView` y del heartbeat |
| EQUIPMENT_PRIVATE | la página sólo pinta lo que trae el gateway de audiencia `broadcast`; el HUD de emisión deja de leer el loadout por slot si #272 lo retira | `PUBLIC_PROJECTION_ONLY` con el test de fugas de #272 aplicado a programa y fuente |
| Sólo `projectFrame` | ninguna ruta de MS lee el estado interno; los replays salen del endpoint público v2 | test de dependencias: `apps/web/src/broadcast/**` no importa nada de `arena-engine` |
| Token del programa | aleatorio, por sesión, en el fragmento, comparado en tiempo constante, inválido al parar la sesión; sólo telemetría y pre-roll de batallas de su cola | tests: token de otra sesión ⇒ 404; token caducado ⇒ 404; heartbeat con campos extra ⇒ 400 |
| Heartbeat falsificado no inicia batallas | RENDER_READY exige también el frame visible en el streamer; SPECTATOR_READY lo mide el gateway | test I5 con heartbeat «todo listo» y streamer sin frame ⇒ no READY |
| Programa público por id | `GET /broadcast/programs/{programId}` sólo devuelve lo que ya se emite; el siguiente sólo si es público; `404` uniforme | test con batalla privada en SIGUIENTES ⇒ no aparece |
| Entradas de URL | branding saneado como hoy (`config.ts`); `layout`/`bg` por lista cerrada | tests de `config.ts` ampliados |
| SSRF | la validación de `broadcastUrl` del streamer (`session.ts`) se mantiene y sólo amplía la ruta permitida | tests EQ5d/EQ6c ampliados |
| Repo público | el diseño no contiene direcciones, hosts ni rutas de despliegue; las URLs son relativas | revisión |

## 20. Migración desde el sistema actual

| Hoy | v2 | Compatibilidad |
|---|---|---|
| `streaming_sessions` (target único) | misma tabla + `program_id`, `output_mode`, `policy`, `start_mode`, `version`; el destino pasa a la cola | migración aditiva; las filas antiguas quedan con `program_id` nulo y se muestran como «sesión heredada» |
| `POST /admin/streaming/start {target}` | `POST /admin/broadcast/sessions` | durante MS-2…MS-7, `startStreaming` se implementa **encima** del nuevo gestor: crea una sesión con una cola de un ítem (`START_INDEPENDENT`) y la URL del programa. Se retira en MS-8 |
| `GET /admin/streaming` y `uxState` | `GET /admin/broadcast/state` (sesión e ítem separados) | `uxState` se sigue calculando desde la sesión (tabla de §7.1) hasta MS-8 |
| `/admin/streaming/settings`, `ingests`, `credentials`, `test`, `recordings`, `retention`, `audit` | sin cambios de semántica; la UI los muestra en Canales, Configuración y Diagnóstico | se mantienen las rutas (no hay motivo para moverlas) |
| `/broadcast?battle=`/`?tournament=` | `/broadcast/battle/{id}`, `/broadcast/tournament/{id}` | las dos formas funcionan; la heredada es un alias |
| `BroadcastDirector` con `catch {}` | clasificación de errores (§14.3) | MS-2, también en el director heredado |
| Reconciliador de huérfanas | igual, ampliado: una sesión con programa sin ítems no es huérfana | — |
| `StreamingPage.tsx` | `pages/broadcast-admin/*` con 7 pestañas | MS-8; hasta entonces, cada PR añade su pestaña detrás del flag y la página antigua sigue |
| Bloque de `BattleDetailPage` | enlace a Batallas/Fuentes | MS-8 |

Despliegue de la migración: aditiva, sin reescritura de datos. Rollback: las columnas y tablas nuevas
se pueden ignorar; `rollbackNamed` sólo si se añade a la lista cerrada (`NAMED_ROLLBACK_ALLOWED`).

## 21. Plan de pruebas

Niveles: **U** unitario (máquinas de estado puras, clasificador de errores, evaluador de READY);
**I** integración con PostgreSQL embebido y streamer falso (como `eq5*`/`eq6*`); **W** web con
`vitest` + DOM (página de programa y fuentes); **R** streamer real con ffmpeg y Chromium (como
`streamer-real.test.ts`); **E** E2E local con MediaMTX (`tests/streaming-e2e/`), en la máquina de pruebas. Ninguna
prueba depende de YouTube.

Cada gate cuenta como PASS sólo con una prueba capaz de ponerse roja (mutante indicado).

| # | Caso (§18.28) | Nivel | Qué se comprueba | Mutante que lo pone en rojo | Gate |
|---|---|---|---|---|---|
| T1 | 1 batalla manual: prepare → ready → start → live → finished | I + W | secuencia exacta de estados de las 3 máquinas; la batalla no corre antes de [EMPEZAR] | quitar el predicado `hold` de `claimBattle` | `SYNCED_BATTLE_START`, `BROADCAST_READY_GATE` |
| T2 | 1 batalla automática: prepare → ready → auto-start | I | auto-start sólo tras la ventana de estabilidad; tabla de verdad de las 6 condiciones | evaluar READY con `∨` en una condición | `AUTO_START_WHEN_READY` |
| T3 | 3 batallas en YouTube: B1 → B2 → B3 sin cortar | I + E | streamer falso: 1 `start`, 0 `stop`, 0 `restart`; E2E: una sola conexión publish en MediaMTX y vídeo continuo | conmutar ítem con `restartStreaming` | `YOUTUBE_CONTINUOUS_SESSION`, `MULTI_BATTLE_QUEUE` |
| T4 | 3 batallas simultáneas en producción externa | W + I | 3 URLs, 3 `SpectatorClient` independientes, sin sesión RTMP creada | compartir estado entre fuentes | `EXTERNAL_PRODUCTION_SOURCES`, `OBS_SOURCE_PER_BATTLE` |
| T5 | Cambio manual A → B sin reiniciar RTMP | I + W | A FINISHED `preempted`; capa de A visible hasta el primer frame de B | desmontar A antes de pintar B | `MANUAL_BATTLE_SELECTION`, `BATTLE_HANDOFF` |
| T6 | Torneo con la cola completa | I | cola desde torneo, `followNewBattles`, serial, intermedios, final, parada al terminar | `decideScreen` con `running[0]` | `MULTI_BATTLE_QUEUE`, `BROADCAST_MANAGER` |
| T7 | Replay único | W + I | índice, segmentos v2, progreso, final | leer replay privado en lugar del público | `REPLAY_STREAMING` |
| T8 | Playlist de replays | I + W | orden, intermedio de 5 s, posición n/N, reordenar la cola no cambia la lista | ignorar `position` | `REPLAY_PLAYLIST` |
| T9 | Reconexión RTMP | I + R | antes de empezar: no inicia; corriendo: no pausa, `BroadcastGap` registrado | auto-start sin RTMP_PUBLISHING | `BROADCAST_READY_GATE` |
| T10 | Fallo del espectador | W + I | `SPECTATOR_FAILED` en el panel; *slate* pública; batalla retenida no empieza | volver al `catch {}` | `BROADCAST_READY_GATE` |
| T11 | Fallo de la API | W + I | `API_FETCH_FAILED`; heartbeat ausente ⇒ aviso en panel | tragar el error | `BROADCAST_MANAGER` |
| T12 | JSON inválido (HTML con 200) | W | `INVALID_JSON` terminal al primer intento | parsear sin mirar `Content-Type` | `BROADCAST_MANAGER` |
| T13 | Fallo del render | R | página blanca ⇒ `RENDER_FAILED`, no READY (reutiliza el control negativo de `render-selftest.ts`) | RENDER_READY sólo con el heartbeat | `BROADCAST_READY_GATE` |
| T14 | Batalla cancelada | I | ítem FINISHED `cancelled`; la cola avanza | — | `MULTI_BATTLE_QUEUE` |
| T15 | El operador salta | I | `on_abandon = keep_held`: la batalla no empieza | soltar la retención al saltar | `MULTI_BATTLE_QUEUE` |
| T16 | El operador pausa la cola | I | el LIVE sigue; no se prepara el siguiente | — | `MULTI_BATTLE_QUEUE` |
| T-DET | Determinismo | I (worker) | `stateHash` y resultado idénticos con y sin 30 s de retención | — (control) | `SYNCED_BATTLE_START` |
| T-SEC1 | Sin clave | I + W + R | barrido de la clave y fragmentos en respuestas, HTML, logs | añadir la clave a `getBroadcastState` | `NO_STREAM_KEY_LEAK` |
| T-SEC2 | Sólo proyección pública | W + I | programa y fuente pasan el test de fugas de #272 | leer `hullHp` en el HUD | `PUBLIC_PROJECTION_ONLY` |
| T-SEC3 | Token de programa | I | otra sesión, caducado, campos extra, tasa | comparar token con `===` y sin sesión | `BROADCAST_MANAGER` |
| T-INV | Invariantes I1-I6 | U + I | §7.4 | los indicados en §7.4 | todos |
| T-FIRST | Primer tick visible | I + W | sin retardo, el primer snapshot que pinta el programa es el del tick 0 | suscribirse después del `claim` | `SYNCED_BATTLE_START` |

`INTERNAL_BROADCAST_API_PROXY` es de #274 (§18.27) y no se repite aquí; T12 cubre que, si vuelve a
pasar, se vea.

Ejecución: en la máquina de pruebas, nunca en producción. Cada PR declara el
comando exacto, el SHA y el `rc` real.

## 22. Rollout

1. **Precondición:** #274 desplegado y `BATTLE_VISIBLE_ON_STREAM=PASS` con el sistema actual. Sin
   eso no se activa nada de v2.
2. **Flag de runtime** `broadcastV2` en los ajustes persistidos (patrón de #269; no `.env`), apagado
   por defecto. Con el flag apagado, la API antigua y la UI antigua funcionan como hoy.
3. **Orden de activación** (cada paso tras su PR mergeado, CI verde y revisión): MS-2 (programa con un
   ítem, sin retención) → MS-3 (retención y READY) → MS-4 (cola y continuidad) → MS-5 → MS-6 → MS-7 →
   MS-8 (UI unificada; la antigua se retira).
4. **Prueba en producción** de cada paso, a mano y con un canal de pruebas (directo no listado), antes
   de usarlo en un evento: caso A, después B con 2 batallas, después C, D y E.
5. **Rollback:** apagar `broadcastV2` (sin redeploy). Las batallas retenidas se listan en el panel y se
   sueltan a mano; el apagado **no** las suelta solo (P4). Los datos nuevos se ignoran.
6. Sin auto-deploy. Cada despliegue lo decide el operador.

## 23. Plan de PRs MS-2…MS-8

Cada PR: pequeño, con tests y mutantes de su gate, revisión y CI en PASS. Draft hasta la revisión. Sin
merge ni deploy automáticos.

| PR | Alcance | Depende de | Gates | Fuera |
|---|---|---|---|---|
| **MS-1** (este) | Arquitectura y contratos (este documento) | — | revisión del diseño | código |
| **MS-2 · Gestor de fuente y destino** | `packages/broadcast-contracts`; `apps/api/src/broadcast/{session-manager,targets}.ts`; migración (columnas de sesión, `broadcast_items`, `broadcast_queues`, `broadcast_events`); `programId` y token; `GET /admin/broadcast/state`; rutas públicas del programa (sin pre-roll); página de programa con **un** ítem; clasificación de errores (§14.3) en programa y director heredado; `startStreaming` encima del gestor; flag `broadcastV2` | #274 desplegado; #269 (estado efectivo) | `BROADCAST_MANAGER`, `NO_STREAM_KEY_LEAK` | retención, cola |
| **MS-3 · Start sincronizado** | `battle_broadcast_controls`; StartGate; ReadinessEvaluator; heartbeat; ticket de pre-roll y suscripción en `scheduled`; [EMPEZAR BATALLA]; AUTO_START con ventana; timeouts; predicado en `claimBattle` (**commit acordado con MF**); T-DET y T-FIRST | MS-2; MF (#270 integrado o commit en su rama); MA para el claim del ticket | `BROADCAST_READY_GATE`, `SYNCED_BATTLE_START`, `AUTO_START_WHEN_READY` | cola |
| **MS-4 · Cola y YouTube continuo** | QueueEngine; cola desde torneo (`followNewBattles`); política serial; *slates*, intermedio y final; parada al terminar la cola; doble capa en el programa | MS-3 | `MULTI_BATTLE_QUEUE`, `YOUTUBE_CONTINUOUS_SESSION` | conmutación manual |
| **MS-5 · Selección manual y handoff** | política manual; `switchBroadcastTo`; skip, pause/resume, reordenar; handoff sin blancos; `BroadcastGap` | MS-4 | `MANUAL_BATTLE_SELECTION`, `BATTLE_HANDOFF` | OBS |
| **MS-6 · Fuentes OBS/externas** | rutas `/broadcast/battle/{id}`, `/broadcast/replay/{id}` y `/broadcast/tournament/{id}`; `layout`/`bg`; `listBroadcastSources`; modo `external_production` | MS-2 (puede ir en paralelo a MS-3…MS-5); **MA (#272) integrado** para activar | `EXTERNAL_PRODUCTION_SOURCES`, `OBS_SOURCE_PER_BATTLE`, `PUBLIC_PROJECTION_ONLY` | replays |
| **MS-7 · Replay y playlists** | ítem `replay` en el programa (segmentos v2 públicos); `broadcast_playlists`; API de listas; intermedios entre replays | MS-4; **MD (#271) y MA (#272)** integrados | `REPLAY_STREAMING`, `REPLAY_PLAYLIST` | mezcla directo+replay |
| **MS-8 · UI de admin unificada** | Administración → Retransmisión con 7 pestañas; flujos A-E; mensajes humanos desde el API; retirada de `StreamingPage.tsx`, de `startStreaming` y del bloque de `BattleDetailPage` | MS-2…MS-7 | todos en regresión; E2E de los casos A-E | — |

Las pestañas se van añadiendo con su PR detrás del flag (MS-3: lista de comprobación en Directo; MS-4:
Cola; MS-6: Batallas/Fuentes; MS-7: Replays). MS-8 es sobre todo reorganización y retirada.

## 24. Decisiones (DECIDED por el operador, 2026-11-12)

Las cuatro quedan **DECIDED**. Cualquier cambio requiere una nueva decisión explícita del operador.

| # | Decisión | Estado | Resolución |
|---|---|---|---|
| D1 | Cómo se suscribe el programa a una batalla aún no empezada | **DECIDED** | **(a)** Ticket de pre-roll firmado con claim `program`, para preparar una batalla `scheduled` antes de arrancarla. Sólo vale para las batallas de la cola de ESE programa. Las batallas programadas **no** se hacen públicas para visitantes normales; la política pública no cambia. |
| D2 | Modo de inicio por defecto | **DECIDED** | Batalla suelta → **MANUAL**; torneo → **AUTOMÁTICO**. Se puede cambiar en cada emisión. En manual, `BROADCAST_READY` habilita el botón `EMPEZAR BATALLA`; en automático, al llegar a `BROADCAST_READY` S9 inicia la batalla. |
| D3 | Torneo con una única salida YouTube y `BATTLE_CONCURRENCY > 1` | **DECIDED** | **En serie** (`serial`). No arrancan varias batallas a la vez para perder las que no se emiten: la siguiente queda retenida hasta que le toca y el broadcast está listo. Sólo afecta a las batallas que forman parte del programa retransmitido. El paralelismo se podrá permitir más adelante para las fuentes externas/OBS (`external_production`). `serial_partial` queda descartado por ahora. |
| D4 | Qué pasa con una batalla retenida si se abandona o cancela su emisión | **DECIDED** | **NO ARRANCA SOLA.** Sigue retenida hasta una acción explícita: reanudar o asignar la emisión, liberar la batalla o cancelarla. Cerrar una emisión nunca debe provocar el comienzo de una batalla (invariante P4, con su test y su mutante). |

## 25. Riesgos

| Riesgo | Impacto | Mitigación |
|---|---|---|
| El predicado de retención está en código de MF y el claim es crítico | una batalla bloqueada o, peor, iniciada sin gate | commit mínimo y aislado acordado con MF; mutante que quita el predicado; T-DET; las retenciones se ven en el panel |
| El pre-roll exige cambios en el gateway y en el ticket (área de MA) | retraso de MS-3 | interfaz acordada en MS-2; MS-3 puede probar con la proyección actual y activar con #272 |
| Chromium vivo horas en una misma página (torneo largo) | fugas de memoria, renderer colgado | navegación interna sin recargas; RSS de Chromium en Diagnóstico; si hay que recargar, sólo durante una *slate* y con la puerta de render del streamer (#256) antes de volver al aire |
| Retardo anti-coaching y handoff | resultado de A mostrado antes de tiempo o B en el aire antes de su tick 0 | el ítem termina por el `result` recibido en el programa, no por `battles.status`; T5 y T-FIRST con `delaySeconds > 0` |
| Heartbeat como única señal de vida de la página | falsos «todo bien» o falsos fallos | doble fuente para el render (página + streamer); alerta por ausencia |
| Un torneo serial tarda N veces más | eventos largos | D3; la UI muestra la duración estimada al preparar |
| Varias réplicas del API decidiendo a la vez | transiciones dobles | líder único por *advisory lock* + `version` en cada fila |
| Alcance grande frente a la prioridad de §18.34 | complejidad antes de demostrar que una batalla se ve | precondición `BATTLE_VISIBLE_ON_STREAM=PASS` y flag apagado (§22) |

## 26. Trazabilidad con el encargo (§18)

| § del encargo | Sección |
|---|---|
| 18.1, 18.27 (#274) | §1 (fuera de alcance), §14.3, T12 |
| 18.2 Objetivo | §3, §16 |
| 18.3 Tres conceptos | §4, §6 |
| 18.4 Modos de salida | §6.1, §9.4, §12 |
| 18.5 Una salida por batalla | §12 |
| 18.6, 18.20 YouTube continuo | §5.2, §10 |
| 18.7, 18.8, 18.9 Start sincronizado y READY | §8 |
| 18.10 Cola | §6.3, §17.2 |
| 18.11, 18.12, 18.13 Concurrencia y políticas | §9 |
| 18.14, 18.15 Replays y listas mixtas | §6.4, §13 |
| 18.16-18.19 Menú, Directo, flujo, Batallas/Fuentes | §16 |
| 18.21 Handoff | §10.2 |
| 18.22 Reconexión | §11 |
| 18.23 Estados | §7 |
| 18.24 Observabilidad | §15 |
| 18.25, 18.26 Errores | §14 |
| 18.28 Tests | §21 |
| 18.29 Seguridad | §19 |
| 18.30 MA | §18 |
| 18.31 MF | §18 |
| 18.32 Gates | §21, §23 |
| 18.33 Salida y PRs | §23 |
| 18.34 Prioridad | §1, §22 |
| 18.35 Casos A-E | §16.4 |
