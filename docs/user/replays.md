# Replays

## Resumen

Cada batalla terminada deja un **replay** que se puede volver a ver. **«Replays»** (`#/replays`) los lista y el **reproductor** (`#/replay/<batalla>`) los reproduce, con velocidades, salto en el tiempo y enlace para compartir.

Desde el cierre funcional de 2026-10:

- la lista **funciona detrás de HTTPS** (ya no hay redirección a una dirección sin cifrar, [TD-014](../roadmap/technical-debt.md#td-014));
- el reproductor **dibuja la batalla**, avanza y llega al final ([TD-009](../roadmap/technical-debt.md#td-009));
- sigue abierto que los replays se pueden descargar sin iniciar sesión, incluidos los de batallas de práctica privadas ([TD-004](../roadmap/technical-debt.md#td-004)).

## Índice

- [Lista de replays](#lista-de-replays)
- [Reproductor](#reproductor)
- [Compartir](#compartir)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)

## Lista de replays

**FUNCIONA ACTUALMENTE.** Columnas:

- batalla (identificador corto; el completo al pasar el ratón);
- resultado («gana *equipo*» o «empate»);
- duración (minutos:segundos y ticks);
- oficial (sí o no);
- fecha;
- «Ver replay».

Si no hay ninguno: «No hay replays todavía. Se crean al terminar una batalla.», con enlace a «Batallas». Si el servicio de replays no responde verás **«Servicio no disponible (502)»** (o «El servidor tarda demasiado») con el detalle y un botón **«Reintentar»**; nunca una lista vacía engañosa.

## Reproductor

**FUNCIONA ACTUALMENTE.** Es una página pública: no requiere cuenta. Controles:

- **reproducir / pausa** (al terminar, «Reproducir» vuelve a empezar);
- velocidades de **0,5× a 8×**;
- **línea de tiempo** para saltar a cualquier momento;
- las mismas **cámaras** que el visor;
- enlace «← Todos los replays».

Estados: «cargando…» → «inicializando visor…» → «reproduciendo» → «fin del replay». Si el replay no existe: «replay no disponible: No existe o no está disponible». Si el servicio falla a mitad: «error al cargar el replay: …» con «Reintentar».

Los replays de batallas de práctica caducan a los 7 días según su ficha, aunque hoy nada los borra. Los de torneo se conservan siempre.

## Compartir

El reproductor genera un enlace con el instante actual (`#/replay/<id>?t=<tick>`). Quien lo abra empieza en ese momento.

## Errores / limitaciones

- La lista muestra identificadores y no los nombres de los bots.
- Puede listar replays de batallas que no existen en la plataforma (generados por pruebas).
- **Privacidad**: cualquiera con el identificador de una batalla puede descargar su replay, aunque la batalla sea privada ([TD-004](../roadmap/technical-debt.md#td-004)).
- En móvil (375 px) no se ha vuelto a medir el reproductor (la auditoría vio desbordamiento).

## Estado actual

**FUNCIONA ACTUALMENTE**: lista, apertura, carga, dibujo, avance, pausa, velocidad y fin, verificados en Chromium real detrás de TLS ([frontend.md — E2E](../technical/frontend.md#e2e-de-navegador)). Pendiente: privacidad de replays (TD-004).

## Documentación relacionada

- Usuario: [Visor](viewer.md), [Batallas](battles.md), [Estadísticas](statistics.md)
- Técnica: [replays.md](../technical/replays.md), [frontend.md](../technical/frontend.md#visor-reproductor-y-phaser)
- Deuda: [TD-004](../roadmap/technical-debt.md#td-004), [TD-009](../roadmap/technical-debt.md#td-009), [TD-014](../roadmap/technical-debt.md#td-014)
