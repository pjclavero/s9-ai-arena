# Carril J · Gate de activación del espectador público

Preparación, **no activación**. `S9_PUBLIC_SPECTATE_ENABLED` y
`S9_PUBLIC_REPLAYS_ENABLED` siguen bloqueadas por decisión del operador. Este
documento describe el camino real del espectador, lo medido en el entorno
desplegado y las condiciones verificables previas a encender la puerta.

Las direcciones y nombres de máquina se sustituyen por placeholders y por rangos
de documentación (RFC 5737).

---

## 1. Camino del espectador, de extremo a extremo

```
navegador                 gateway nginx            tournament-worker
   │                      (único con puertos)      (SpectateGateway, :8081)
   │  POST /api/v1/battles/<id>/spectate-ticket
   ├──────────────────────────►  /api/v1/  ─────►  api:8080
   │                                                 │ firma JWT HS256
   │  ◄─── 201 {ticket, wsUrl, expiresAt} ───────────┘
   │
   │  Upgrade  /ws/spectate/<id>
   │  Sec-WebSocket-Protocol: spectate.v1, ticket.<jwt>
   ├──────────────────────────►  /ws/  (rewrite quita /ws) ─────► :8081
   │                                                 │ verifySpectateTicket
   │  ◄── init → snapshot* → event* → result ────────┘
```

- **Quién sirve `/ws/`**: `tournament-worker`, puerto 8081, clase
  `SpectateGateway` (`apps/api/src/spectate/gateway.ts`), instanciada en
  `apps/tournament-worker/src/main.ts`. Vive ahí porque la simulación corre en
  ese proceso: `attachBattle()` necesita el objeto `Battle` en memoria.
  `arena-engine` **no** interviene en el canal de espectador.
- **Emisión del ticket**: `getSpectateTicket` en `apps/api/src/routes/battles.ts`.
  JWT `HS256`, `iss=s9-ai-arena`, `aud=s9-arena/spectate`, TTL corto, `jti`
  único. El secreto es **distinto** del de sesión: si no se provisiona
  `SPECTATE_TICKET_SECRET*`, se deriva del de sesión por HKDF con separación de
  dominio. Un token de sesión no valida como ticket y viceversa.
- **Transporte del ticket**: subprotocolo WebSocket
  (`Sec-WebSocket-Protocol: spectate.v1, ticket.<jwt>`), nunca en la URL —
  las URLs acaban en el log de acceso de nginx. Un ticket en la query se
  rechaza aunque sea válido (`4400 ticket_in_url`).
- **Validación**: firma + algoritmo fijo + issuer/audience; `battleId` del ticket
  debe coincidir con el de la ruta (`4403`); `jti` de **un solo uso**
  (`4403 ticket_already_used`); si no hay feed vivo, `4404 battle_not_live`.
- **Sin ticket** → `4400 bad_request`. **Caducado o falsificado** → `4401
  invalid_ticket` (el `exp` lo comprueba `jsonwebtoken`; probado).

**Ojo con el 101.** El handshake HTTP devuelve `101 Switching Protocols`
*siempre*, incluso sin ticket y con una ruta inexistente — se midió en el
entorno desplegado. La librería `ws` acepta el upgrade y **después** cierra con
el código de aplicación. Un `101` **no** significa "canal concedido"; confundir
ambas cosas es el error de lectura más fácil de cometer aquí.

## 2. Autenticación y visibilidad

| | anónimo | autenticado | moderador+ |
|---|---|---|---|
| Obtener ticket | sí (era sí siempre; ver §6) | sí | sí |
| Snapshots públicos + eventos | sí | sí | sí |
| `debug: true` en el ticket (capas ocultas) | no | no | sí, firmado por la API |

- El flag `debug` lo **firma la API** según el rol; el visor no puede
  autoconcedérselo. En el despliegue actual es además inerte: el worker no pasa
  `debugLayers` a `attachBattle()`, así que no hay capa de depuración que emitir.
- **Qué viaja por el canal**: `init` (meta de cabecera + último snapshot),
  `snapshot`, `event`, `result`. El snapshot público
  (`Battle.publicSnapshot()`) contiene tick, vehículos (id, equipo, vivo,
  posición, rumbo, torreta, casco, módulos con su estado), proyectiles, marcador
  y objetivos. **No** contiene: `seed`, `seed_commitment`, observaciones
  privadas de bots (`observationFor` es del canal de BOT), ni **minas** —
  información oculta hasta que explotan.
- `init.meta` añade modo, mapa, torneo/match/ronda, `official` y la nómina
  pública: `{id, botId, team, chassis, name}`. **No** viaja el propietario, ni el
  loadout completo, ni la versión del bot. El `chassis` es la única información
  con valor competitivo y ya es deducible del propio snapshot.
- **Fuga entre partidas**: no. Cada feed es un `Map` por `battleId` y el ticket
  se ata a un `battleId` concreto, comprobado contra la ruta.
- **Fuga entre usuarios**: no hay identidad de usuario en el canal; el gateway ni
  la conoce. El retardo anti-coaching (`spectator.delaySeconds` del ruleset) es
  por conexión.

## 3. Límites de tasa y abuso

Lo que **hay hoy**:

- Cuota anónima por IP y ruta sobre la tabla `api_usage`: 300 peticiones/hora por
  defecto, `429` al superarla. Cubre `spectate-ticket`, `public-live`,
  `public-battle`. Persiste entre reinicios y se comparte entre réplicas.
  `TRUST_PROXY_HOPS=1` en el despliegue, así que `req.ip` es la IP real.
- `maxPayload` de 64 KiB en el WebSocketServer: un frame entrante grande cierra
  con `1009`. El canal es de solo lectura para el cliente.
- Tope de **100 conexiones simultáneas por batalla** (`4429 too_many_spectators`);
  las conexiones previas siguen vivas.

Lo que **no hay** (riesgo abierto, ver §8):

- **Ningún límite de conexiones WebSocket por IP ni global**, ni en nginx ni en
  el gateway. El tope de 100 es *por batalla*; con N batallas vivas el techo es
  100·N, y el coste del handshake se paga *antes* de autorizar.
- `nginx` no aplica `limit_req` ni `limit_conn` en `/ws/`. `proxy_read_timeout`
  es de 3600 s, así que una conexión ociosa se sostiene una hora.

## 4. Exposición pública — LAN frente a Internet

Distinción que aquí se ha confundido antes:

| | alcanzable en la LAN | alcanzable desde Internet |
|---|---|---|
| hoy | sí: `http://<vm>:8080` sirve `/api/v1/`, `/ws/`, `/replays/`, `/` | **no**: el reenvío del router está pendiente y el dominio no responde |
| tras abrir el reenvío | igual | todo lo anterior, sin filtro adicional |

Medido en el entorno desplegado:

- El **gateway es el único servicio con puertos publicados**: `8080→80` y
  `8443→443`. El resto de contenedores no publica nada.
- **`8443` está muerto**: dentro del contenedor sólo hay un `LISTEN` en `:80`.
  El `nginx.conf` desplegado (fechado antes que el del repositorio) tiene un
  único `server { listen 80; }` con `/api/v1/`, `/ws/`, `/replays/`, `/grafana/`
  y `/`; **no tiene bloque TLS**. El `nginx.conf` del repositorio sí lo tiene:
  **repositorio y despliegue divergen**. Un `curl` a `:8443` falla en el
  handshake TLS, no en HTTP.
- Consecuencia: si se abriera el reenvío hoy, el tráfico —tickets incluidos—
  viajaría **en claro**. Y `SPECTATE_WS_URL` no está definida en el contenedor de
  la API, así que `wsUrl` se emite como `ws://localhost:8081/spectate/...`: un
  valor inútil para el cliente, y sin el `wss://` que el propio código exige en
  producción.

Lo que quedaría accesible desde Internet con la puerta encendida **y** el
reenvío abierto: la web, `/api/v1/` **completo** (no sólo `/public/*`),
`/replays/` y `/ws/`. La puerta de espectador no reduce esa superficie; sólo
gobierna una parte de ella.

## 5. Comportamiento ante fallo

- **La partida acaba**: el `pump` emite `{type:"result"}`, para el temporizador y
  el worker programa `detachBattle` a los 3 s; los clientes reciben `1001
  battle_detached`. Degradación limpia.
- **El worker se reinicia**: el proceso muere con los feeds en memoria; todas las
  conexiones caen con un cierre de transporte. No hay reanudación: el cliente
  debe pedir **otro** ticket (el anterior ya quemó su `jti`). Los feeds **no se
  reconstruyen**: una batalla que estaba corriendo se reintenta como job, y hasta
  que el nuevo `attachBattle` ocurra el espectador recibe `4404 battle_not_live`.
- **El motor falla a mitad**: el `finally` del ejecutor programa el detach igual,
  así que los clientes reciben `1001`, no un volcado de error. El detalle del
  fallo va al log del worker, no al canal.
- **Errores internos**: el canal nunca serializa excepciones; los códigos de
  cierre son de aplicación (`44xx`) y no distinguen causas que filtrarían
  información. La API sí devuelve `correlationId` en sus errores, sin traza.

Punto flojo: el cliente **no distingue** "el worker se reinició" de "la batalla
terminó" salvo por haber recibido antes un `result`. La recuperación es
reconectar con ticket nuevo, y eso no está automatizado en el visor.

## 6. Fail-closed — el agujero encontrado

**HALLAZGO BLOQUEANTE (corregido en esta rama).**

Con `S9_PUBLIC_SPECTATE_ENABLED` apagada, la puerta **no cerraba el canal**:

1. `POST /battles/{id}/spectate-ticket` es `security: []` (`x-min-role: visitor`)
   y **no consultaba la capability**: emitía un ticket válido a cualquier
   visitante anónimo.
2. `SpectateGateway` **no leía la capability en ningún punto**: se instancia
   incondicionalmente en `main.ts` y sólo comprueba el ticket.
3. `GET /api/v1/battles` es también `security: []` y devuelve los ids de batalla
   a un anónimo — se verificó en el entorno desplegado: `200 {"items":[]}`
   (vacío hoy sólo porque no hay batallas). Los ids no hay que adivinarlos.

Es decir: la puerta gobernaba `/public/battles/live` y `/public/replays`
—los dos endpoints que se citan como prueba de que "está apagada"— mientras el
canal en vivo, que es el dato que de verdad importa, quedaba abierto a cualquiera
que alcanzase el gateway. El test `spectate-live.test.ts` ya lo describía sin
darse cuenta: *"se ve EN DIRECTO **con ticket anónimo**"*, con la capability
apagada.

**Corrección de esta rama** (dos controles independientes, en dos procesos):

- La API no emite ticket a un **anónimo** con la puerta apagada: `404`, el mismo
  que `getPublicLiveBattle`, para no revelar si el id existe. Una sesión
  autenticada sigue pudiendo espectar: el espectador interno del producto no es
  "espectador público".
- El ticket lleva `anon` **firmado por la API**, y el gateway rechaza un ticket
  anónimo con la puerta apagada (`4403 public_spectate_disabled`) aunque la firma
  sea válida. Un despliegue que ponga la variable en un servicio y no en el otro
  **falla cerrado en el canal**.

Rutas revisadas y descartadas como agujero: `/replays/` (gateado por
`S9_PUBLIC_REPLAYS_ENABLED` en la API; `replay-service` sirve su propio prefijo y
merece una revisión propia), `/grafana/` (perfil opcional, no activo), el puerto
8081 (no publicado; sólo alcanzable dentro de la red Docker).

## 7. Pruebas y mutaciones

- `apps/api/src/spectate/j-fail-closed.test.ts` (pura, sin BD): 10 casos.
- `apps/api/src/j-fail-closed-ticket.test.ts` (con BD, en CI): 6 casos.
- `apps/tournament-worker/src/spectate-live.test.ts` pasa a encender la
  capability **explícitamente**: queda como control positivo del canal.

Mutaciones ejecutadas de verdad:

| mutante | cambio | resultado |
|---|---|---|
| M1 | borrar la comprobación de capability en `gateway.ts` | **ROJO**, 3 casos |
| M2 | `publicSpectateEnabled ?? true` (default abierto) | primero **VERDE** → hueco real: todos los casos inyectaban la capability. Se añadió el caso que construye `new SpectateGateway()` como en producción; repetida la mutación, **ROJO** |
| M3 | `anon: false` fijo en la API | cubierto por el test de BD (CI) |

M2 es el hallazgo metodológico: una suite que sólo prueba lo inyectado no prueba
el **default de producción**, que es justo el valor que decide.

## 8. Gate de activación

Condiciones verificables antes de encender `S9_PUBLIC_SPECTATE_ENABLED`.

| # | condición | evidencia |
|---|---|---|
| G1 | La corrección de fail-closed está mergeada y **desplegada en las imágenes que corren** | `/version` de api y worker = el commit del merge (ADR-016) |
| G2 | TLS real en el borde: `:443` con `LISTEN` dentro del gateway | `ss -lntp` en el contenedor + handshake TLS correcto |
| G3 | `nginx.conf` desplegado == `nginx.conf` del repositorio | diff del fichero dentro del contenedor contra el del repo |
| G4 | `SPECTATE_WS_URL` definida y con esquema `wss://` | `docker inspect` de la API + `wsUrl` de una respuesta real |
| G5 | Decidir y aplicar la superficie de `/api/v1/` publicada: hoy Internet vería la API entera, no sólo `/public/*` | regla de nginx o allowlist, verificada con peticiones |
| G6 | `limit_conn` / `limit_req` en `/ws/` y tope global de espectadores | configuración + prueba de carga que alcance el límite |
| G7 | Cuota anónima calibrada para tráfico público (300/h por IP puede ser corta o larga; hoy nadie lo ha medido) | prueba de carga con `429` observado |
| G8 | Backup y llave verificados antes de exponer (condición ya vigente del programa) | dictamen del carril de backup |
| G9 | Reconexión automática del visor tras reinicio del worker | prueba con reinicio real en un entorno de test |

**Lo que no se puede demostrar sin activar** — hay que decirlo sin adornos:

- El comportamiento del canal bajo carga **real** de espectadores anónimos
  concurrentes: hoy sólo hay tests con límites bajos inyectados.
- Que la cuota anónima y `TRUST_PROXY_HOPS=1` funcionan con la topología de
  Internet (CGNAT, muchos clientes tras una IP) — hoy no hay tráfico externo.
- Que ningún campo del `init.meta` resulta sensible **en el uso real** (nombres
  de bot elegidos por usuarios, por ejemplo).
- El coste de CPU/RAM del `pump` a 30 Hz con decenas de conexiones sostenidas.

Estas cuatro exigen una activación acotada (ventana corta, una batalla, con
observación) antes de una activación permanente. No hay forma honesta de
declararlas verdes desde fuera.
