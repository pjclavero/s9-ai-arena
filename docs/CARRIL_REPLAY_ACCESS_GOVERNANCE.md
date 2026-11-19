# Carril · Gobierno del acceso a replays

**Contrato antes que código.** Este documento mapea lo que HOY autoriza (o no
autoriza) la lectura de un replay, define el modelo de visibilidad, propone el
contrato y evalúa las dos arquitecturas candidatas. No cambia ninguna ruta.

Direcciones y nombres de máquina se sustituyen por placeholders y rangos de
documentación (RFC 5737). Todo lo marcado **[medido]** se comprobó contra el
entorno desplegado con peticiones de solo lectura.

---

## 1. Mapa real del acceso a replays (medido)

El gateway nginx es el **único proceso con puertos publicados**. El fichero en
uso es `infrastructure/gateway/nginx-behind-proxy.conf` (`GATEWAY_CONF`), y
contiene —igual que `nginx.conf`— este bloque:

```nginx
location /replays/ {
  set $replays_up http://replay-service:8083;
  proxy_pass $replays_up;          # SIN rewrite: el prefijo /replays viaja entero
}
```

No hay `auth_request`, ni `limit_req`, ni restricción de método. **El camino
`/replays/*` no pasa por la API**: es un `proxy_pass` directo al servicio
interno.

### 1.1 Servidas por `replay-service` (`apps/replay-service/src/server.ts`)

| Ruta (por el gateway) | Método | Autoriza | Expone | Medido |
|---|---|---|---|---|
| `/replays` | GET | **nada** | listado global: `battleId`, `ticks`, `winner`, `official`, `createdAt`, `sizeBytes` (hasta 500 por página) | 200 anónimo |
| `/replays/:id` | GET | **nada** | **el archivo completo** del replay (zstd), `Accept-Ranges`, `X-Replay-Sha256` | 200 anónimo |
| `/replays/:id/index` | GET | **nada** | `sha256`, `algo`, `sizeBytes`, `official`, `createdAt`, `expiresAt`, `ticks`, `versions`, `mapChecksum`, keyframes, `result` (incl. `finalStateHash`), `debugOpen` | 200 anónimo |
| `/replays/:id/segment` | GET | **nada** | snapshots y eventos decodificados por rango de ticks; **`commands` si `debugOpen`** | 200 anónimo |
| `/replays/:id/verify` | POST | **nada** | re-simulación completa + hashes | 200 anónimo |
| `/replays/:id` | POST (ingesta) | `x-replay-ingest-auth`, fail-closed | — | 401 sin credencial (B8) |
| `/retention/sweep` | POST | `x-replay-ingest-auth`, fail-closed | — | **no alcanzable por el gateway** (no existe `location /retention/`) |

Notas medidas:

- El secreto de B8 protege **escritura**; nunca gobernó la lectura.
- `POST /replays/:id/verify` es una **re-simulación completa sin cuota ni
  credencial**, alcanzable por el gateway: amplificador de DoS barato. Es la
  deuda que B8 dejó anotada y sigue abierta.
- El `debugOpen` del índice abre los **comandos** de los bots (entrada de
  depuración) a cualquiera; hoy depende de un flag de ingesta, no de una
  autorización.

### 1.2 Servidas por la API (`/api/v1/…` → `api:8080`)

| Operación (contrato) | Ruta | `x-min-role` | `security` | Capability | Cuota |
|---|---|---|---|---|---|
| `getReplay` | `GET /api/v1/replays/{battleId}` | `visitor` | `[]` | **ninguna** | `replays` |
| `verifyReplay` | `POST /api/v1/replays/{battleId}/verify` | `visitor` | `[]` | **ninguna** | `replay-verify` |
| `listPublicReplays` | `GET /api/v1/public/replays` | `visitor` | `[]` | `S9_PUBLIC_REPLAYS_ENABLED` | `public-replays-list` |
| `getPublicReplay` | `GET /api/v1/public/replays/{battleId}` | `visitor` | `[]` | `S9_PUBLIC_REPLAYS_ENABLED` | `public-replay` |
| `downloadPublicReplay` | `GET /api/v1/public/replays/{battleId}/download` | `visitor` | `[]` | `S9_PUBLIC_REPLAYS_ENABLED` | `public-replay-download` |
| `listPublicLiveBattles` / `getPublicLiveBattle` | `GET /api/v1/public/battles/live`, `/{battleId}` | `visitor` | `[]` | `S9_PUBLIC_SPECTATE_ENABLED` | sí |

**Segundo hallazgo, y es el importante.** `getReplay` sirve *los mismos bytes*
que `downloadPublicReplay`, es anónima por contrato y **no la gobierna ninguna
capability**. Es decir: la capability de replays públicos es evadible **sin
tocar nginx, dentro de la propia API**. El problema no es solo que "nginx se
salte la autoridad": para el objeto *replay* **la autoridad todavía no existe**.
Que hoy responda `404` **[medido]** se debe a que el único replay en disco es un
smoke E2E sin fila en `battles`, no a un control.

Fail-closed del espectador (carril J) **[medido]**: `/api/v1/public/battles/live`
→ `{"enabled":false,"battles":[]}`, `/api/v1/public/replays` →
`{"enabled":false,"items":[]}`, `/api/v1/public/replays/<id>` → `404`. Ese carril
sigue cerrado. El agujero está enteramente en el camino `/replays/*` y en
`getReplay`.

---

## 2. Modelo de visibilidad

### 2.1 Lo que el producto YA modela

- `bots.owner_id`, `bots.team_id`, `bots.visibility ∈ {private, team, public}`.
- `battles.official` (booleana), `battles.spectator_mode ∈ {delayed, visible}`.
- Índice del replay: `official`, `debugOpen`, `expiresAt` (los temporales
  caducan a 7 días; los oficiales nunca).
- Roles: `visitor < user < developer < team_captain < organizer < moderator < admin`.

### 2.2 El hecho estructural

`replay-service` **no conoce propietario, ni equipo, ni visibilidad, ni sesión**.
Su índice no tiene ningún campo de sujeto. No puede decidir quién puede leer,
hoy ni con un parche: le falta el dato, no el código. Por eso una comprobación
de sesión improvisada dentro del servicio sería a la vez una autoridad duplicada
y una autoridad **ciega**.

### 2.3 Clases propuestas

| Clase | Qué es | Quién lee |
|---|---|---|
| **público** | replay de batalla `official`/torneo publicado | anónimo (**si** la capability pública está encendida), usuario, propietario, moderador+ |
| **restringido** | práctica/privado: batalla cuyos participantes son bots no `public` | propietarios de los bots participantes, su equipo si `visibility=team`, moderador+ |
| **interno** | bytes crudos, índice y segmentos como artefactos de infraestructura y auditoría | servicios del stack con credencial; nunca el navegador anónimo |

Matriz objetivo (`—` = 404, nunca 403: no se distingue "no existe" de "no
visible", como ya hace `getPublicLiveBattle`):

| | anónimo (cap. OFF) | anónimo (cap. ON) | usuario | propietario/equipo | moderador+ |
|---|---|---|---|---|---|
| listar replays | — | solo públicos | solo públicos | + los suyos | todos |
| metadatos/índice | — | públicos | públicos | + los suyos | todos |
| bytes / segmento | — | públicos | públicos | + los suyos | todos |
| `commands` (`debugOpen`) | — | no | no | sí, sobre los suyos | sí |
| `verify` | — | públicos, con cuota | con cuota | sí | sí |

**Los "oficiales" no son un permiso**: `official` significa *no caduca y es
auditable*, no *es legible por cualquiera*. Publicar sigue siendo un acto
gobernado por la capability pública.

---

## 3. Contrato (independiente de la opción elegida)

- **C1 · Autoridad única.** La decisión "¿este sujeto puede leer este replay?"
  se toma en **un solo lugar: la API**, el único proceso con la BD (propietario,
  equipo, `official`, estado de la batalla) y con noción de sesión.
- **C2 · `replay-service` no decide, obedece.** No se le añade noción de sesión.
  Como mucho **verifica la autenticidad del portador**; nunca evalúa política.
- **C3 · Fail-closed en los dos procesos.** Sin configuración explícita, ambos
  niegan. Nada de valor por defecto permisivo (la lección del carril J: el
  defecto es el que decide, y el que hay que probar).
- **C4 · Sin ruta pública al servicio interno.** La topología no es el control,
  pero sí es la superficie: la meta es que `/replays/*` deje de existir de cara
  al navegador.
- **C5 · Despliegue desordenado ⇒ cierra.** Cualquiera de los dos servicios
  desplegado sin el otro debe producir *rotura visible*, nunca *fuga silenciosa*.
- **C6 · Prohibido duplicar la decisión.** Un solo evaluador de política; el
  segundo control es de autenticidad, con separación de dominio (`aud` propio),
  igual que el ticket de espectador.
- **C7 · Nada de credenciales en la URL.** Las URLs acaban en el log de acceso
  de nginx (regla ya adoptada en J: ticket en la query ⇒ rechazo).
- **C8 · Auditable.** Toda lectura autorizada registra `correlationId` y sujeto.

---

## 4. Las dos opciones

### Opción A — `replay-service` interno; la autoridad vive en API/gateway

Se elimina `location /replays/`. La API gana operaciones de contrato para
índice, segmento y bytes (hoy solo tiene bytes: `getReplay`), decide, y lee del
volumen compartido o proxya al servicio interno.

- **A favor:** una sola autoridad, superficie pública mínima, es la preferencia
  declarada del operador, y no hay token que gestionar.
- **En contra:** la API pasa a mover datos grandes (rango, ficheros de MB) y
  hoy los lee enteros en memoria (`readFile` + `send`); el visor debe migrar de
  golpe a rutas nuevas; exige **ampliar el contrato OpenAPI** (dos operaciones
  nuevas) y actualizar el lock del prefijo del gateway
  (`apps/web/tests/replay-page-gateway-path.test.ts`).
- **Despliegue desordenado:** si solo se despliega el gateway (sin `location`),
  el visor rompe → cerrado. Si solo se despliega la API, no hay ruta nueva y la
  vieja sigue abierta → **abierto**: el orden obligatorio es *gateway primero*.
- **Si nginx cambia:** volver a añadir el `location` reabre el agujero entero.
  Es un control **posicional**, sin defensa en profundidad.

### Opción B — token interno firmado hacia `replay-service`

La API decide y emite un token corto firmado (HS256, `aud=s9-arena/replay`,
secreto propio o derivado por HKDF del de sesión, `exp` corto, `jti`, claims
mínimos: `battleId` y `scope ∈ {index, segment, bytes, commands}`).
`replay-service` **verifica firma y claims** y sirve; nunca consulta la BD.
Mismo patrón, ya en producción, que el ticket de espectador del carril J.

- **A favor:** cierra el agujero **sin depender de la topología** (aunque nginx
  reintroduzca la ruta, sin token no se lee); no duplica política (solo
  autenticidad); mecanismo ya conocido por el operador; el visor sigue con sus
  rutas actuales, solo pide token antes.
- **En contra:** un verificador más en un servicio que no lo tenía; hay que
  decidir el transporte (cabecera, nunca query — C7); una llamada extra del
  visor; la caché HTTP `immutable` de índice/segmento se complica.
- **Despliegue desordenado:** `replay-service` primero ⇒ exige token que nadie
  emite: visor roto, **cerrado**. API primero ⇒ emite tokens que nadie exige:
  **estado actual, abierto**. Orden obligatorio: *replay-service primero*.

### Recomendación: **B primero, A como estado final** (B→A, en dos fases)

1. **Fase 1 (B).** `replay-service` exige token en toda LECTURA, fail-closed sin
   secreto configurado. La API gana un emisor `POST /replays/{battleId}/access`
   que **decide** según §2.3. `nginx` no se toca. El agujero se cierra hoy sin
   romper al usuario autenticado y sin autoridad duplicada.
2. **Fase 2 (A).** Cuando el visor ya no vaya al servicio directamente, se
   retira `location /replays/`. El token se queda como **defensa en profundidad**
   (autenticidad del portador), de forma que un cambio de nginx ya no reabre
   nada.

Motivo: A sola exige mover bytes por la API y migrar al visor de golpe, y su
control es puramente posicional; B sola deja la superficie pública abierta al
mundo el día que se abra el router. La secuencia cierra hoy y aterriza en la
preferencia A del operador, cumpliendo C1–C8 en ambas fases.

---

## 5. Plan de migración sin romper al usuario autenticado

Consumidores medidos de `/replays/*` (búsqueda en el repo, no supuesta):

| Consumidor | Qué pide | Fase 1 | Fase 2 |
|---|---|---|---|
| `apps/web/src/pages/ReplaysPage.tsx` | `GET /replays` | pide token de listado, o pasa ya a una ruta de API | ruta de API |
| `apps/web/src/pages/ReplayPage.tsx` + `apps/web/src/viewer/replay-player.ts` | `/replays/:id/index`, `/replays/:id/segment` | pide token `index`/`segment` y lo manda en cabecera | rutas de API |
| `apps/web/tests/replay-page-gateway-path.test.ts` | lock del prefijo del gateway | sigue válido | **hay que reescribirlo** al retirar el `location` |
| `tests/e2e/e2e-real-battle-smoke.test.ts` | levanta su propio servicio | inyecta secreto de acceso | igual |
| `tests/e2e/mvp-success.e2e.test.ts` | va contra la API (supertest) | sin cambios | sin cambios |
| Grafana / paneles | — | no consumen replays | — |

Orden de despliegue **obligatorio** en Fase 1: `replay-service` **antes** que la
web; entre medias el visor rompe (cerrado), nunca fuga. En Fase 2: gateway
**antes** que retirar nada más.

---

## 6. Tests exigidos por el diseño

Además del *lock de superficie de lectura* que este carril deja implementado
(`apps/replay-service/tests/anonymous-read-surface-lock.test.ts`, §6.1), la
implementación de la Fase 1 debe traer:

1. **Instancia como producción**: construir el servicio por el mismo camino que
   `main.ts` (secreto resuelto de un entorno *limpio*), sin inyectar el valor
   permisivo. El defecto es lo que decide.
2. Lectura **sin token** ⇒ 401 en las cinco rutas de lectura, y **sin revelar**
   si el replay existe.
3. Token con `aud` de sesión o de espectador ⇒ rechazado (separación de dominio).
4. Token de otro `battleId` ⇒ rechazado; token caducado ⇒ rechazado.
5. `scope=index` no abre `segment` ni `bytes`; `commands` exige scope propio
   **y** `debugOpen`.
6. Token en la **query** ⇒ rechazado aunque sea válido (C7).
7. Emisor de la API: anónimo con capability apagada ⇒ 404; propietario ⇒ token;
   tercero sobre replay restringido ⇒ 404.
8. **Mutaciones que deben ponerse rojas**: quitar el guard de una ruta; invertir
   el fail-closed (`return true` sin secreto); aceptar `aud` cualquiera; ignorar
   `exp`; leer el token de la query; añadir una ruta de lectura nueva sin guard.

### 6.1 Lo que este carril deja ejecutable

`anonymous-read-surface-lock.test.ts` **enumera el router real** del servicio
instanciado como en producción (no cuenta texto, no hace grep) y compara la
superficie de lectura anónima contra un inventario declarado, y además comprueba
qué prefijos publica el gateway hacia el servicio. Cualquier ruta nueva sin
guard, cualquier guard retirado o cualquier `location` nuevo pone el test en
rojo. Es el control que hoy no existía: el agujero de `/replays/*` nació
precisamente porque nadie tenía inventariada la superficie anónima del servicio.

---

## 7. Decisiones de producto que NO corresponden a este carril

1. ¿La lectura anónima de replays públicos es una función del producto (visor
   público) o el visor es solo para autenticados? De la respuesta depende si el
   emisor de tokens atiende a anónimos con la capability encendida.
2. ¿Qué hace público a un replay: `battles.official`, la `visibility` de **todos**
   los bots participantes, o una publicación explícita del propietario?
3. `debugOpen` hoy lo fija quien ingesta. ¿Debe pasar a ser una propiedad
   revisable por el propietario, y visible solo para él y moderador+?

Hasta que 1–3 estén respondidas, **no se tocan rutas**.
