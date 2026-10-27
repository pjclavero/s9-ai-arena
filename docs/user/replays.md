# Replays

## Resumen

Cada batalla terminada deja un **replay** que se puede volver a ver. **«Replays»** (`#/replays`) los lista y el **reproductor** (`#/replay/<batalla>`) los reproduce, con velocidades, salto en el tiempo y enlace para compartir.

Desde el cierre funcional de 2026-10:

- la lista **funciona detrás de HTTPS** (ya no hay redirección a una dirección sin cifrar, [TD-014](../roadmap/technical-debt.md#td-014));
- el reproductor **dibuja la batalla**, avanza y llega al final ([TD-009](../roadmap/technical-debt.md#td-009));
- desde la fase *Production Readiness* (2026-10, desplegada en producción), **un replay sólo lo ve quien tiene permiso** ([TD-004](../roadmap/technical-debt.md#td-004)); ver [Quién puede ver un replay](#quién-puede-ver-un-replay).

## Índice

- [Quién puede ver un replay](#quién-puede-ver-un-replay)
- [Lista de replays](#lista-de-replays)
- [Reproductor](#reproductor)
- [Compartir](#compartir)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)

## Quién puede ver un replay

Puedes ver (lista, reproductor y descarga) el replay de una batalla si:

- **uno de tus bots participó** en ella;
- eres **miembro del equipo** de un bot participante y ese bot no es privado (visibilidad «equipo» o «pública»);
- tienes rol de **organizador, moderador o administrador**;
- o la plataforma tiene activado el **acceso público a replays** y **todos** los bots de la batalla son públicos. Activarlo no hace públicas las batallas en las que participa algún bot privado o de equipo.

En cualquier otro caso el replay **no existe para ti**: la lista no lo muestra y el reproductor dice «no existe o no está disponible», exactamente igual que con un identificador inventado. Sin sesión iniciada sólo se ven los replays públicos (si el acceso público está activado).

## Lista de replays

**FUNCIONA ACTUALMENTE** (requiere sesión). Muestra sólo los replays que puedes ver. Columnas:

- batalla (identificador corto; el completo al pasar el ratón);
- resultado («gana *equipo*» o «empate»);
- duración (minutos:segundos y ticks);
- oficial (sí o no);
- fecha;
- «Ver replay».

Si no hay ninguno: «No hay replays todavía. Se crean al terminar una batalla.», con enlace a «Batallas». Si la plataforma no responde verás **«Servicio no disponible (502)»** (o «El servidor tarda demasiado») con el detalle y un botón **«Reintentar»**; nunca una lista vacía engañosa.

## Reproductor

**FUNCIONA ACTUALMENTE.** La dirección se puede abrir sin cuenta, pero el replay sólo se carga si tienes permiso (ver arriba); si tienes sesión, el reproductor la recupera antes de pedirlo («Recuperando sesión…»). Controles:

- **reproducir / pausa** (al terminar, «Reproducir» vuelve a empezar);
- velocidades de **0,5× a 8×**;
- **línea de tiempo** para saltar a cualquier momento;
- las mismas **cámaras** que el visor;
- enlace «← Todos los replays».

Estados: «cargando…» → «inicializando visor…» → «reproduciendo» → «fin del replay». Si el replay no existe **o no tienes permiso**: «replay no disponible: No existe o no está disponible» (sin «Reintentar»). Si el servicio falla a mitad: «error al cargar el replay: …» con «Reintentar».

Los replays de batallas de práctica caducan a los 7 días según su ficha, aunque hoy nada los borra. Los de torneo se conservan siempre.

## Compartir

El reproductor genera un enlace con el instante actual (`#/replay/<id>?t=<tick>`). Quien lo abra empieza en ese momento, **si tiene permiso** para ver ese replay.

## Errores / limitaciones

- La lista muestra identificadores y no los nombres de los bots.
- Ya no lista ficheros de replay sin batalla en la plataforma: la lista sale de las batallas, no del almacén de ficheros.
- En móvil (375 px) no se ha vuelto a medir el reproductor (la auditoría vio desbordamiento).

## Estado actual

**FUNCIONA ACTUALMENTE**: lista, apertura, carga, dibujo, avance, pausa, velocidad y fin, verificados en Chromium real detrás de TLS ([frontend.md — E2E](../technical/frontend.md#e2e-de-navegador)). Privacidad de replays ([TD-004](../roadmap/technical-debt.md#td-004)): implementada, probada y desplegada en producción.

## Documentación relacionada

- Usuario: [Visor](viewer.md), [Batallas](battles.md), [Estadísticas](statistics.md)
- Técnica: [replays.md](../technical/replays.md#autorización-de-acceso-td-004), [security.md](../technical/security.md), [frontend.md](../technical/frontend.md#visor-reproductor-y-phaser)
- Deuda: [TD-004](../roadmap/technical-debt.md#td-004), [TD-009](../roadmap/technical-debt.md#td-009), [TD-014](../roadmap/technical-debt.md#td-014)
