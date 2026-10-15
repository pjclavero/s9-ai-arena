# S9 AI Arena — el proyecto

## Resumen

S9 AI Arena es una **arena de combate 2D para bots de IA**. Los usuarios programan bots
(en Python o JavaScript), los equipan con módulos (chasis, armas, sensores…) y los enfrentan en
batallas y torneos. Un motor determinista simula las batallas y produce replays verificables.
Todo se gestiona desde una plataforma web.

**Estado actual, en una línea:** el motor y la plataforma existen en código y tienen tests, pero
**el producto no es funcional de extremo a extremo** en su despliegue: ningún bot puede publicarse
y ninguna batalla ejecuta código de usuario. Ver [current-status.md](../roadmap/current-status.md).

## Índice

- [Idea original y objetivo](#idea-original-y-objetivo)
- [Qué es y qué no es](#qué-es-y-qué-no-es)
- [Usuarios](#usuarios)
- [Casos de uso](#casos-de-uso)
- [Capacidades](#capacidades)
- [Estado actual](#estado-actual)
- [Verificación](#verificación)

## Idea original y objetivo

La idea nace del dosier técnico del proyecto («motor 2D modular»), que está en la raíz del
repositorio. Propone un juego de programación en el que la habilidad está en el **código del
bot** y en la **elección del equipamiento**, no en los reflejos. Pide tres cosas:

- **Justicia:** el mismo mapa, la misma semilla y el mismo código dan el mismo resultado. El motor es determinista y cada replay se puede re-simular para verificarlo.
- **Seguridad:** el código de los usuarios es código no confiable. Se analiza, se firma y sólo se ejecuta en contenedores aislados, nunca en los servicios de la plataforma.
- **Competición:** torneos con varios formatos, rating Elo, ranking, estadísticas y espectadores.

Las decisiones fundacionales (unidades métricas, tick fijo a 30 Hz, decisión del bot cada 3 ticks
con 80 ms de plazo, protocolo `arena/1`…) están en
[ADR-000](../adr/ADR-000-decisiones-fundacionales.md).

## Qué es y qué no es

| Es | No es |
|---|---|
| Una plataforma web multiusuario para programar, equipar y enfrentar bots | Un juego de acción en tiempo real controlado por personas |
| Un motor de simulación determinista con replays verificables | Un motor gráfico. El visor (Phaser) sólo representa lo que el motor ya ha decidido |
| Un monorepo TypeScript/Node desplegado con Docker Compose | Un servicio gestionado o multi-host. El stack está pensado para un único host |
| La «v2» (`infrastructure/docker-compose.yml`) | La «v1» (`docker-compose.demo.yml`, `apps/arena-server`, `apps/arena-viewer`): un prototipo legacy que se conserva sólo por historia y **no se despliega** |

## Usuarios

Los roles reales del código son, de menor a mayor:

`visitor` < `user` < `developer` < `team_captain` < `organizer` < `moderator` < `admin`

- **Visitante:** ve el ranking, los mapas publicados y (si se activa) las batallas públicas.
- **Desarrollador de bots** (`user` + `developer`, lo que concede el registro): crea bots, sube su código, configura el loadout y forma equipos.
- **Organizador:** importa, genera y publica mapas; crea y gestiona torneos.
- **Moderador / admin:** gestiona roles, suspende bots y consulta la auditoría.
- **Operador** (fuera de la web): instala, despliega, hace backup y restore, y activa las funciones gateadas. Ver [docs/operations/](../operations/index.md).

Detalle del modelo de permisos: [docs/technical/security.md](../technical/security.md).

## Casos de uso

| Caso de uso | Estado |
|---|---|
| Registrarse, crear un bot, pegar su código y configurar su loadout | **FUNCIONA ACTUALMENTE** |
| Enviar el bot a validación y publicarlo | **PENDIENTE**: bloqueado por [TD-001](../roadmap/technical-debt.md#td-001) |
| Lanzar una batalla de práctica desde la web | **PENDIENTE**: bloqueado por [TD-003](../roadmap/technical-debt.md#td-003) |
| Que la batalla ejecute el código del bot | **PENDIENTE**: [TD-002](../roadmap/technical-debt.md#td-002) |
| Organizar un torneo `round_robin` y ver el bracket y el Elo | **PARCIAL**: funciona con el stub, sólo para el rol organizer |
| Ver una batalla en directo o reproducir un replay | **PARCIAL**: roto en navegador ([TD-009](../roadmap/technical-debt.md#td-009)) |
| Crear un mapa en el editor y usarlo | **PARCIAL**: el editor no guarda ([TD-010](../roadmap/technical-debt.md#td-010)) |
| Consultar el ranking | **FUNCIONA ACTUALMENTE** (vacío en producción: no hay batallas) |

Guía de uso: [docs/user/](../user/index.md).

## Capacidades

En el código existe:

- **Motor:**
  - física Rapier 2D;
  - armas, blindaje por sector y daño a módulos;
  - sensores (lidar, radar, proximidad) y acústica;
  - radio (parcial);
  - modos deathmatch, team deathmatch, capturar la bandera y control de zona;
  - determinismo, checkpoints por resimulación y replays.

  Ver [docs/technical/engine.md](../technical/engine.md).
- **Catálogo de módulos y validador de loadouts:** presupuesto en créditos y 5 chasis. Ver [docs/technical/equipment.md](../technical/equipment.md).
- **Pipeline de bots:** análisis estático y AST, detección de secretos, firma y sandbox en contenedor. Ver [docs/technical/bots.md](../technical/bots.md).
- **SDK de JavaScript y de Python**, con bots de ejemplo (`example-bots/`).
- **Torneos:** 6 formatos de torneo en código y rating Elo. Ver [docs/technical/tournaments.md](../technical/tournaments.md).
- **Espectador** por WebSocket con ticket de un solo uso, y streaming opcional a RTMPS.
- **Operación:** backup con restic/SFTP, gates de despliegue, detección de deriva del runtime y readiness.

## Estado actual

Ver [docs/roadmap/current-status.md](../roadmap/current-status.md) (fuente única) y la
[auditoría 2026-10-15](../audits/2026-10-15/README.md). En una frase: el motor es sólido (82 %); la
madurez por capacidades ronda el 47 %, y el recorrido de producto de extremo a extremo es del 0 %.

## Documentación relacionada

- [architecture.md](architecture.md) · [technologies.md](technologies.md) · [glossary.md](glossary.md)
- [Documentación técnica](../technical/index.md) · [Guía de usuario](../user/index.md) · [Operación](../operations/index.md)

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| Jerarquía de roles | CODE_VERIFIED | `apps/api/src/db/migrations.ts:20`; `apps/api/src/openapi.ts:37` (rango = índice) |
| El registro concede `user` + `developer` | CODE_VERIFIED | `apps/api/src/routes/auth.ts:168-172` |
| Tick a 30 Hz, decisión cada 3 ticks, plazo de 80 ms | CODE_VERIFIED | `packages/game-rules/constants.ts:17-21` |
| Protocolo `arena/1` | CODE_VERIFIED | `packages/game-rules/constants.ts:34` |
| La v1 sólo está en el compose de demo | CODE_VERIFIED | `docker-compose.demo.yml`; `apps/arena-server`, `apps/arena-viewer` |
| SDK JS y Python reales; .NET y Java vacíos | CODE_VERIFIED | `sdks/javascript`, `sdks/python`; `sdks/dotnet/README.md` |
| Estado del producto | RUNTIME_VERIFIED (en la auditoría) | [AUDIT-DELTA](../audits/2026-10-15/AUDIT-DELTA-2026-10.md) |
