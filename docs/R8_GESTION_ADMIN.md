# R8 · Gestión / admin de bots, mapas, equipos y batallas

Estado del bloque **R8 — capa de gestión/administración** sobre `main@8251565`
(PR #43 mergeada, dictamen del proyecto **B+**: código y arnés real listos, la
validación real en VM108 la ejecuta OTRO equipo — bloque **B+ → A**).

> **Este bloque NO toca la operación de VM108** ni el arnés real de #43 (solo
> lectura), NO instala `s9-docker-proxy`, NO monta `docker.sock`, NO declara A.

---

## 1. Hallazgo del diagnóstico (importante)

El brief de R8 describe la capa de gestión como si fuese _green-field_. **No lo
es.** El modelo de datos y la API de gestión ya existían y son **más completos**
que lo pedido. Implementar tablas/rutas nuevas (`bots`, `maps`, `teams`,
`battles`…) habría **duplicado y roto** lo existente — justo lo que el brief
prohíbe ("compatible con el pipeline real, no sustituirlo", "no crear otra
arquitectura paralela").

Por tanto R8 aquí se ejecuta como lo que realmente falta: **completar la capa de
gestión respetando la existente**. El único hueco real de "admin UI" era la
**pantalla de mapas** (todos los demás recursos ya tenían página; los mapas solo
eran gestionables por API). Eso es lo que añade esta rama.

### Qué YA existía (no se duplica)

| Área R8 | Estado previo | Dónde |
| --- | --- | --- |
| R8.1 Bots / versions / builds / artifacts | ✅ completo, con firma/digest | `apps/api/src/routes/bots.ts`, migración `003_bots` |
| R8.2 Maps / map_versions / validación E4 | ✅ API completa (validador real de 6 checks) | `apps/api/src/routes/maps.ts`, `002_content` |
| R8.3 Teams / team_members | ✅ | `apps/api/src/routes/teams.ts`, `001_identity` |
| R8.4 Battles / participants / results | ✅ incl. `createPracticeBattle` | `apps/api/src/routes/battles.ts`, `004_competition` |
| R8.5 Histórico + replays (`replay_ref`, `/verify`) | ✅ | `battles.ts`, `/replays/*` |
| R8.6 Admin UI | ✅ parcial: bots, teams, batallas, torneos, admin | `apps/web/src/pages/*` |
| R8.7 API + contratos (OpenAPI) | ✅ | `apps/api/openapi.yaml` |
| R8.8 RBAC (7 roles) | ✅ `visitor…admin` + matriz de tests | `migrations.ts` `ROLES`, `rbac-matrix.test.ts` |
| R8.9 Migraciones | ✅ 10 migraciones, up/down | `apps/api/src/db/migrations.ts` |
| R8.10 Tests | ✅ backend + panel + contratos | `apps/api/src/*.test.ts`, `apps/web/tests/*` |

### Qué añade esta rama

- **`apps/web/src/pages/MapsPage.tsx`** — pantalla de gestión de mapas del panel:
  - **listar** versiones con estado (`draft` / `validated` / `published`),
    dimensiones, modos y **vista previa 2D** (miniatura SVG que ya genera la API
    al publicar);
  - **importar** un mapa (JSON interno o export de Tiled) vía `multipart` →
    `POST /maps`. Si el validador real de E4 lo rechaza (422), los **checks se
    muestran** (nunca se tragan);
  - **generar** un mapa procedural determinista (semilla + params JSON) →
    `POST /maps/generate`;
  - **publicar** una versión validada → `POST /maps/{mapId}/versions/{version}/actions/publish`
    (deshabilitado si ya está publicada, que es inmutable);
  - errores de la API **anunciados** con `role="alert"`, carga con reintento
    (patrón R3.7, nunca "lista vacía" ante un fallo).
- Cableado en **`apps/web/src/App.tsx`**: enlace de nav `#/maps` + ruteo.
- Test **`apps/web/tests/maps-page.test.tsx`** (5 casos).

No se ha tocado el backend, las migraciones, el arnés #43 ni la operación VM108.

---

## 2. Cómo usar la gestión de mapas (admin local)

1. `#/maps` en el panel autenticado.
2. **Importar**: elige un `.json` (mapa interno o export JSON de Tiled) → _Importar
   mapa_. Se valida con el validador real; si pasa, queda en `draft`.
3. **Generar**: escribe una semilla y unos parámetros JSON → _Generar mapa_.
   Misma semilla ⇒ mismo checksum (determinismo E4).
4. **Publicar**: en una fila `validated`, _Publicar_. Congela contenido+checksum
   y genera la miniatura. Un mapa **publicado** es el único que puede
   seleccionarse para una batalla.

La ejecución de la batalla en sí (correr el mapa publicado con bots reales)
**no se dispara desde aquí**: depende del pipeline real (VM108, bloque B+ → A).

---

## 3. Seguridad / permisos (RBAC)

Roles del sistema (`migrations.ts` `ROLES`): `visitor < user < developer <
team_captain < organizer < moderator < admin`. La **API autoriza**; la UI solo
oculta/deshabilita (cap. 16). Permisos de los endpoints de mapas (OpenAPI
`x-min-role`):

| Acción | Endpoint | Rol mínimo |
| --- | --- | --- |
| Listar / ver mapa | `GET /maps`, `GET /maps/{id}/versions/{v}` | `visitor` (público) |
| Importar mapa | `POST /maps` | `user` |
| Generar procedural | `POST /maps/generate` | `organizer` |
| Publicar versión | `POST /maps/{id}/versions/{v}/actions/publish` | `organizer` |
| Reemplazar versión | `PUT …` (siempre 409, inmutable) | `admin` |

La UI no expone secretos, ni rutas internas, ni logs completos. Un rechazo por
rol se muestra como alerta accesible, sin filtrar detalle sensible.

---

## 4. Dependencias externas (lo que R8 NO resuelve)

- **Ejecución real de batallas** → depende de `s9-docker-proxy` + arnés #43 +
  `SMOKE_BOT_DIGEST` en VM108 (bloque B+ → A). R8 no lo instala ni lo dispara.
- **Replay real** → `battles.replay_ref` + `/replays/{id}/verify`; el visor
  avanzado es R7.1. R8 solo deja la estructura de histórico lista.

---

## 5. Qué queda pendiente (fuera de esta rama)

- Selección de mapa publicado + bots `ready` desde una UI de creación de batalla
  (el endpoint `createPracticeBattle` ya existe; conviene NO cablearlo hasta que
  B+ → A valide la ejecución real, para no inducir falsos éxitos).
- Editor visual avanzado de mapas (explícitamente fuera de R8).
- Visor de replay avanzado (R7).
- Auth pública completa por rol `player`/`viewer` (hoy admin/internal + RBAC ya
  presente en la API).

---

## 6. Validaciones ejecutadas

- `tsc --noEmit` (raíz) y `tsc --noEmit -p apps/web`: **0 errores**.
- `apps/web/tests/maps-page.test.tsx`: **5/5**.
- Regresión panel (`r37-panel-pages`, `r37-session`, `admin-visibility`): **21/21**.
- `prettier --check` sobre los archivos tocados: OK.
- grep de seguridad sobre el footprint (docker.sock, `privileged: true`,
  `network_mode: host`, dominio antiguo `arena.seccionnueve.duckdns.org`): sin
  coincidencias.
