# ADR-025 · Torneos por invitación: la modalidad decide la inscripción, no la visibilidad

**Estado:** propuesto (implementado en la rama `feat/v1-tournament-invitation`, sin integrar) · **Decisión de producto:** D-OP-43 (operador, 2026-11-24) · **Ámbito:** `apps/api/src/routes/tournaments.ts`, `apps/api/src/services/tournament-invitations.ts`, migración `026_tournament_invitations`, `apps/api/openapi.yaml` (0.28.0), `apps/web/src/tournament-invitation.ts` y la ficha del torneo.

## Contexto

En `main` no existía ninguna modalidad de inscripción: cualquier torneo abierto admitía la inscripción de cualquier usuario. El operador pide torneos «por invitación» con cuatro condiciones:

- siguen siendo **visibles** en el listado, y su ficha, resultados y directos son igual de públicos;
- sólo se inscribe quien tenga un **enlace** válido;
- el enlace **no inscribe solo**;
- el organizador lo **genera, copia y revoca** desde la web.

## Decisión

1. **Inscripción, no visibilidad.** La modalidad es la columna `tournaments.enrollment` (`open` o `invitation`; `open` por defecto y para todos los torneos existentes). Ninguna regla de lectura (`battle-access.ts`, `replay-access.ts`, `broadcast-effective.ts`) la consulta.
2. **La API manda.** `enterTournament` y `enterTournamentTeam` exigen en un torneo `invitation` el token del enlace vigente: 403 `invitation_required` si falta y 403 `invitation_invalid` si no vale. Lo comprueban dentro de su transacción y con el torneo `FOR UPDATE`, que es el mismo cerrojo que usan generar y revocar. Ocultar el botón en la web es sólo usabilidad.
3. **Token de un solo uso de lectura.** Tiene 256 bits de `randomBytes` y en la BD sólo se guarda su sha256. Se compara en tiempo constante contra la única invitación activa del torneo. El token en claro se devuelve una vez, al generarlo y sólo al organizador; no va a `audit_log` ni a ninguna respuesta pública. **Generar = enlace nuevo y el anterior revocado**: no se guarda cifrado para volver a mostrarlo.
4. **Transporte en el fragmento.** El enlace es `#/tournaments/<id>/invitation/<token>`. La web lo pasa a `sessionStorage`, lo quita de la barra y del historial (`history.replaceState`) y lo envía sólo en el cuerpo de los POST. El fragmento no viaja al servidor ni en `Referer`, así que no queda en logs del gateway. Tras el login o el registro, la misma ruta vuelve a la ficha.
5. **Gestión** por el dueño del torneo o el staff (`canManageTournament`). La modalidad sólo cambia en `draft` u `open`, y pasar a `open` revoca el enlace activo.

## Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| Ocultar los torneos por invitación del listado | Contradice D-OP-43: la modalidad no decide la visibilidad. |
| Guardar el token cifrado para poder volver a copiarlo | Deja un secreto recuperable en la BD y una clave que custodiar, y no aporta nada frente a regenerar. |
| Token en la query (`?invitation=`) o en un parámetro de vuelta del login | Viaja al servidor: queda en logs del gateway y en `Referer`. |
| Invitaciones nominativas, de un solo uso o con caducidad | Fuera del contrato V1. El modelo (`tournament_invitations`) admite añadirlas después. |
| Que el organizador o el staff se inscriban sin enlace | Rompe «la API rechaza cualquier inscripción sin invitación válida». El organizador usa su propio enlace. |

## Consecuencias

- El contrato pasa a 0.28.0, con cinco operaciones nuevas. Es un cambio de contrato para los clientes que inscriben bots, que ahora pueden recibir esos 403; está anotado en `docs/roadmap/known-issues.md`.
- Con el enlace revocado, el dueño de una inscripción pendiente no elegible no puede cambiar su versión. La inscripción se mantiene y el organizador puede excluirla.
- La ficha web sigue en el panel, que exige sesión, en las dos modalidades; la API pública no cambia.

Detalle y verificación: [../technical/tournament-invitations.md](../technical/tournament-invitations.md).
