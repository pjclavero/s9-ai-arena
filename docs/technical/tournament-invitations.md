# Torneos por invitación

## Resumen

Un torneo tiene una **modalidad de inscripción** (`enrollment`): `open` o `invitation`. La modalidad decide
**quién puede inscribirse**, nunca quién puede ver el torneo. Es el contrato V1 que fijó el operador
(D-OP-43), con contrato OpenAPI 0.28.0 y la migración `026_tournament_invitations`.

- **Abierto** (`open`). Cualquier usuario registrado inscribe su bot o su equipo desde la ficha. Es el
  comportamiento de siempre, y todos los torneos anteriores a la migración quedan así.
- **Por invitación** (`invitation`). El torneo se ve en el mismo listado y su ficha es igual de pública, pero
  sólo se inscribe quien tenga un **enlace de invitación** válido y no revocado. El enlace abre el formulario
  y **no inscribe a nadie por sí solo**: el invitado elige su bot o su equipo y confirma.

## Índice

- [Visibilidad](#visibilidad)
- [Inscripción](#inscripción)
- [El enlace y su token](#el-enlace-y-su-token)
- [Gestión (organizador)](#gestión-organizador)
- [Recorrido del invitado en la web](#recorrido-del-invitado-en-la-web)
- [API](#api)
- [Persistencia](#persistencia)
- [Decisiones](#decisiones)
- [Verificación](#verificación)

## Visibilidad

- `GET /tournaments` lista **todos** los torneos, de las dos modalidades, igual que antes. Cada torneo indica su
  modalidad en `enrollment`. Los torneos en `draft` siguen tratándose como hoy (la modalidad no cambia nada).
- La ficha (`GET /tournaments/{id}`), el cuadro (`…/matches`), la clasificación (`…/team-standings`) y las
  batallas (`…/battles`) se leen igual con independencia de la modalidad.
- Los directos y resultados públicos siguen con sus reglas (`battle-access.ts`, `broadcast-effective.ts`,
  `replay-access.ts`), que **no miran la modalidad**. Un espectador no necesita invitación.
- Ninguna de esas respuestas lleva el token ni su hash.

## Inscripción

En un torneo `invitation`, la API rechaza **toda** inscripción que no presente la invitación activa:

| Vía | Sin token | Token que no vale (revocado, sustituido o inventado) |
|---|---|---|
| `POST /tournaments/{id}/entries` (también la sustitución de una versión pendiente no elegible) | 403 `invitation_required` | 403 `invitation_invalid` |
| `POST /tournaments/{id}/team-entries` (#287) | 403 `invitation_required` | 403 `invitation_invalid` |

- El token va en el **cuerpo** (`invitationToken`), nunca en la URL.
- La comprobación se hace **dentro de la transacción** de la inscripción, con el torneo bloqueado `FOR UPDATE`.
  Generar y revocar bloquean la misma fila, así que una revocación concurrente espera o se ve: no puede quedar
  ninguna inscripción hecha con un enlace ya revocado.
- Con un token válido se aplican **todas** las reglas de siempre, en el mismo orden: el torneo tiene que estar
  `open` (409 `entries_closed`); el bot tiene que ser tuyo (403); la versión, publicada o congelada y elegible
  (409); se aplica el presupuesto (B4) y un bot sólo se inscribe una vez (409 `already_entered`). En equipos se
  exige pertenencia, tamaño exacto, autorización de los dueños, que el equipo no esté ya inscrito, etc.
- No hay cupo de plazas: la única plaza que existe es el tamaño de equipo de los torneos NvN, y se aplica igual.
- Un torneo `open` **no mira** `invitationToken`: si llega uno, se ignora.
- Autorizar un bot propio para el equipo (`PUT …/team-consents/{botId}`) no es una inscripción y no exige
  invitación. El equipo sí la necesita al inscribirse.
- Revocar un enlace **no toca** las inscripciones hechas antes: se mantienen.

## El enlace y su token

- **Generación**: `randomBytes(32)` en base64url, es decir, 43 caracteres y 256 bits de aleatoriedad
  criptográfica.
- **Almacenamiento**: sólo se guarda su `sha256` en hexadecimal (`tournament_invitations.token_sha256`). El
  token en claro se devuelve **una sola vez**, en el 201 de `createTournamentInvitation`, con
  `Cache-Control: private, no-store`, y sólo al organizador. El campo `invitationToken` está marcado como
  `x-private` en el contrato.
- **Comparación**: en tiempo constante (`timingSafeEqual` de los dos sha256). Se compara contra la **única**
  invitación activa del torneo, que se busca por torneo y nunca por hash.
- **Nunca** aparece en `audit_log`, que sólo guarda `invitationId`, ni en una respuesta pública. La API no
  registra cuerpos ni URLs de las peticiones.
- **Una invitación activa por torneo**, garantizado por un índice único parcial. Generar otro enlace revoca el
  anterior en la misma transacción.

## Gestión (organizador)

La gestión es de quien creó el torneo o del staff (`canManageTournament`, #291/#311), además del rol
`organizer` del contrato.

- **Modalidad**: se elige al crear el torneo (`enrollment` en `POST /tournaments`, `open` por defecto) o se
  cambia con `PUT /tournaments/{id}/enrollment`, **sólo** con el torneo en `draft` u `open`; si no, responde
  409 `tournament_enrollment_locked`. Pasar a `open` revoca el enlace activo, así que al volver a `invitation`
  el enlace viejo no revive.
- **Generar**: `POST /tournaments/{id}/invitation`. Sólo funciona en un torneo `invitation` (si no, 409
  `tournament_not_invitation`) y en `draft`/`open`.
- **Consultar**: `GET /tournaments/{id}/invitation` dice si hay un enlace activo y desde cuándo, **nunca** el
  token.
- **Revocar**: `DELETE /tournaments/{id}/invitation` invalida el enlace de inmediato. Es idempotente.
- Todas las acciones se auditan, sin token: `tournament.enrollment_changed`, `tournament.invitation_created` y
  `tournament.invitation_revoked`.

## Recorrido del invitado en la web

El enlace tiene la forma `<origen>/#/tournaments/<id>/invitation/<token>`.

1. Al abrirlo, el panel (`apps/web/src/tournament-invitation.ts`) guarda el token en `sessionStorage`, que
   sólo vive en esa pestaña, y **sustituye** la entrada del historial por `#/tournaments/<id>`. El token
   desaparece de la barra de direcciones y del historial.
2. Sin sesión, el panel enseña el acceso con el aviso «Tienes una invitación…». Tras **iniciar sesión** o
   **registrarse**, la misma ruta pinta la ficha del torneo.
3. La ficha comprueba el enlace con `POST /tournaments/{id}/invitation/check` (token en el cuerpo) y sólo
   entonces enseña «Inscribir» o «Inscribir equipo». Sin enlace, o con uno revocado, dice que la inscripción
   es por invitación y no ofrece la opción.
4. El invitado elige su bot o su equipo y confirma. El token viaja en el cuerpo del POST.
5. Al cerrar sesión se borran las invitaciones guardadas en la pestaña.

**Por qué el fragmento y `sessionStorage`.** El panel ya navega por hash, y el fragmento **nunca sale del
navegador**:

- no viaja en la petición HTTP, así que no queda en los logs del gateway;
- el navegador lo quita de la cabecera `Referer`.

`sessionStorage` evita tener que pasar el token en un parámetro de vuelta tras el login: el acceso no cambia
de ruta y nada más lo lleva. El riesgo que queda es el de cualquier dato de la pestaña frente a un XSS, igual
que la sesión.

El organizador ve en la ficha (si `viewerCanManage` y el torneo está en `draft`/`open`) el panel
«Inscripción», con estos controles:

- el selector de modalidad;
- «Generar enlace» o «Generar enlace nuevo» (pide confirmación si ya hay uno activo);
- el enlace con «Copiar»;
- «Revocar enlace».

El enlace sólo se puede copiar justo después de generarlo.

## API

| Operación | Ruta | Rol | Nota |
|---|---|---|---|
| `createTournament` | `POST /tournaments` | organizer | `enrollment` opcional (`open` por defecto) |
| `setTournamentEnrollment` | `PUT /tournaments/{id}/enrollment` | organizer + `canManageTournament` | sólo en `draft`/`open` |
| `getTournamentInvitation` | `GET /tournaments/{id}/invitation` | organizer + `canManageTournament` | sin token |
| `createTournamentInvitation` | `POST /tournaments/{id}/invitation` | organizer + `canManageTournament` | 201 con `invitationToken` (una vez) |
| `revokeTournamentInvitation` | `DELETE /tournaments/{id}/invitation` | organizer + `canManageTournament` | idempotente |
| `checkTournamentInvitation` | `POST /tournaments/{id}/invitation/check` | user | `{ enrollment, valid, entriesOpen }`; no inscribe |
| `enterTournament` / `enterTournamentTeam` | `POST …/entries`, `POST …/team-entries` | user | `invitationToken` en el cuerpo; 403 `invitation_required` / `invitation_invalid` |

## Persistencia

La migración `026_tournament_invitations` (la 025 la reserva ADM-3, #347) hace dos cambios:

- añade `tournaments.enrollment text NOT NULL DEFAULT 'open' CHECK (enrollment IN ('open','invitation'))`;
- crea `tournament_invitations`, con estas columnas:
  - `id`;
  - `tournament_id`, con borrado en cascada;
  - `token_sha256`, `UNIQUE` y hexadecimal de 64;
  - `created_by` y `created_at`;
  - `revoked_at` y `revoked_by`.

  Lleva además el índice único parcial `tournament_invitations_one_active (tournament_id) WHERE revoked_at IS
  NULL`.

Se puede revertir por nombre (`NAMED_ROLLBACK_ALLOWED`). Al revertirla se pierden las invitaciones y todo
torneo vuelve a ser abierto.

## Decisiones

- **Regenerar en vez de volver a mostrar.** No se guarda el token cifrado: «copiar otra vez» es generar un
  enlace nuevo, y el anterior queda revocado. Así nunca hay un secreto recuperable en la BD y la revocación es
  trivial. El coste es que quien ya recibió el enlace anterior necesita el nuevo.
- **Estricto también al sustituir una versión.** Con el enlace revocado, el dueño de una inscripción pendiente
  no elegible no puede cambiar su versión sin un enlace nuevo. Lo pide «la API rechaza cualquier inscripción
  sin invitación válida»; la inscripción en sí se mantiene y el organizador puede excluirla.
- **Sin excepción para el organizador ni para el staff al inscribir.** El organizador genera el enlace y lo
  usa como cualquiera.
- **La ficha web sigue en el panel, que exige sesión, en las dos modalidades.** La API pública no cambia. Abrir
  la ficha web a anónimos no forma parte de este cambio.

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| Listado y ficha públicos sin token ni hash; directos y resultados iguales en las dos modalidades | CODE_VERIFIED + test | `apps/api/src/v1-tournament-invitation.test.ts` (`TI_LIST_*`, `TI_TOKEN_PUBLIC_SWEEP`, `TI_PUBLIC_SPECTATOR`) |
| 403 sin invitación (individual y equipo), con revocado y con el anterior a una regeneración | CODE_VERIFIED + test | `TI_NOINVITE_*`, `TI_REVOKE_*` |
| Con invitación se aplican todas las reglas de inscripción | CODE_VERIFIED + test | `TI_RULES_*` |
| Sólo el dueño del torneo o el staff gestionan; cambio de modalidad sólo en draft/open | CODE_VERIFIED + test | `TI_MANAGE_ONLY`, `TI_ENROLL_STATES` |
| Token de 256 bits, sólo sha256 en BD, ausente de audit_log | CODE_VERIFIED + test | `TI_TOKEN_STORAGE`, `TI_TOKEN_OPENAPI` |
| Abierto sin cambios | CODE_VERIFIED + test | `TI_OPEN_*`; `apps/web/tests/v1-tournament-invitation.test.tsx` (`TIW_OPEN_UNCHANGED`) |
| Web: ficha sin opción, formulario con enlace, panel del organizador, login y registro con vuelta al formulario | CODE_VERIFIED + test | `apps/web/tests/v1-tournament-invitation*.test.tsx` |
| Migración 026 | CODE_VERIFIED + test | `apps/api/src/db/migration-026.test.ts` |
| Calibración por mutantes | script | `scripts/v1-tournament-invitation-mutants.py` |
