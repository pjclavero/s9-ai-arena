# Changelog

Todos los cambios relevantes de este proyecto se documentan aquí.
El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto
adopta [Versionado Semántico](https://semver.org/lang/es/) a partir de la 0.5.0.

## [Sin publicar]

### Problemas conocidos (abiertos, no corregidos)
- #197: preventivo; munición embebida y de ranura en un futuro chasis con dos armas.
- #305: `GET /bots` con un `ownerId` que no es un UUID devuelve 500 (o 400 «Cursor inválido» si lleva cursor).
- #306: visibilidad; el rol `organizer` recibe el nombre de un ganador de bot privado sin retransmisión, lo que contradice `docs/user/visibility.md`.

## [0.5.0] - pendiente de fecha (la etiqueta aún no existe)

Motor 0.5.0 · Contrato de API (OpenAPI) 0.25.0.

### Añadido
- Torneos: cancelación segura (`cancelTournament`): `draft|open` pasan a `cancelled` de forma
  terminal, idempotente y auditada; `closed|running|finished` devuelven 409 (#289).
- Torneos por equipos: inscripción atómica del equipo completo (`enterTournamentTeam`,
  migración 022 `entries.team_id`); o entran todos los miembros o ninguno (#290).
- Exportación e importación portable de bots y equipos entre instalaciones
  (`scripts/portable/portable.mjs`: export, import, verify; formato versionado con
  checksums, verificación previa y sin secretos) (#300).
- Motor 0.5.0 (ADR-024): proyección pública con identificadores públicos y equipamiento
  privado, daño/blindaje/torreta en montura, replay v2 con `stateHash` completo y RNG con
  nombre, `armorBroken` público, política de reaparición `all_alive_participants`,
  catálogo veraz (`weapon.rangeM`, `radio.rangeM` reales) con puerta de contrato (#293, #294).
- Ajustes de ejecución del servicio de torneos configurables:
  `TOURNAMENT_WORKER_CONCURRENCY` y `TOURNAMENT_WORKER_CPU_SAMPLE_MS` (#297).
- Cierre de inscripciones exige un mínimo de 2 participantes (#299, #301).

### Cambiado
- Muestreo de CPU de contenedores: de 500 ms a 2 s, una petición en vuelo por contenedor
  y sólo contenedores vivos (#297).
- Tiempo máximo de batalla proporcional a los ticks máximos del ruleset
  (`ceil(maxBattleTicks × ms × 1,25) + 15 s`) en lugar de un margen fijo; avisa si se recorta
  al techo del temporizador (#298).
- Ciclo de vida de batalla: cierre único de recursos, reaper, proxy acotado, display a
  demanda (#270, #294).
- Las acciones de gestión de torneos comprueban la propiedad y no sólo el rol (ver
  Seguridad). `GET /tournaments/{id}` añade `viewerCanManage` (#292).

### Corregido
- Un timeout de batalla con el motor ya en marcha se clasifica `battle_timeout` (un único
  reintento) y no `engine_start_failure` (3 reintentos de la batalla entera) (#298).
- Los errores de conexión a la base de datos se clasifican por su origen y se reintentan
  en lugar de ir a revisión manual (#298).
- Una batalla fallida de forma definitiva cierra su emparejamiento y el torneo termina;
  rescate idempotente de torneos atascados (#299).
- Espectador con retardo anti-coaching: latidos sin retardo y vigilancia coherente (#282);
  la emisión sigue la línea temporal pública retrasada (#284).
- Emisión en blanco del streamer y destino de emisión inválido (#260, #278, #274).
- Reutilización de versiones `frozen` en varios torneos (#285).

### Seguridad
- Autorización horizontal en torneos: `closeEntries`, `dryRunTournament` y la exclusión de
  inscripciones por el organizador exigen ser el creador del torneo o personal de
  moderación; antes bastaba con el rol de organizador (#292).
- `infrastructure/scripts/init-secrets.sh` ya no sigue enlaces simbólicos ni escribe en directorios
  ajenos (TD-064, #169).
- Dependencias: `vitest` 4.1.12 y `fast-uri` 3.1.9 (esta última en producción) (#296).
  Se declara una excepción acotada y con caducidad para el aviso GHSA-fc5q-39xc-vjpf
  (`picomatch`, sólo desarrollo, sin versión corregida disponible) (#296).
- Replay crudo restringido y proyección pública de competición (#259); visibilidad pública
  segura de bot, código y retransmisión (#244).

### Anterior a 0.5.0 (resumen)
Streaming real con relé RTMP y credenciales selladas (#227, #242, #250), partidas por
equipos 4v4 con radio aislada por equipo (#234), clasificación de temporada (#220, #229),
documentación consolidada por audiencia (#226, #228, #235).

[Sin publicar]: https://github.com/pjclavero/s9-ai-arena/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/pjclavero/s9-ai-arena/releases/tag/v0.5.0
