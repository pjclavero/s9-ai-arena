# Replays

## Resumen

Cada batalla terminada deja un **replay** que se puede volver a ver. **«Replays»** (`#/replays`) los lista y el **reproductor** (`#/replay/<batalla>`) los reproduce, con velocidades, salto en el tiempo y enlace para compartir.

Hoy:

- en el despliegue con HTTPS, la lista suele mostrar **«Servicio de replays no disponible»** ([TD-014](../roadmap/technical-debt.md#td-014));
- el reproductor descarga el replay, pero **no lo dibuja** ([TD-009](../roadmap/technical-debt.md#td-009));
- los replays se pueden descargar sin iniciar sesión, incluidos los de batallas de práctica privadas ([TD-004](../roadmap/technical-debt.md#td-004)).

## Índice

- [Lista de replays](#lista-de-replays)
- [Reproductor](#reproductor)
- [Compartir](#compartir)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)

## Lista de replays

**PARCIAL.** Columnas:

- batalla (identificador completo);
- resultado (equipo ganador);
- ticks;
- oficial (sí o no);
- fecha;
- «visor» · «reproductor».

Si no hay ninguno: «No hay replays todavía. Se crean al ejecutar batallas (arnés real o ejecución containerizada).». En producción, la petición de la lista se redirige a una dirección sin cifrar y el navegador la bloquea; verás «Servicio de replays no disponible: Failed to fetch» ([TD-014](../roadmap/technical-debt.md#td-014)).

## Reproductor

**PENDIENTE (no se dibuja).** Es una página pública: no requiere cuenta. Controles implementados:

- **reproducir / pausa**;
- velocidades de **0,5× a 8×**;
- **línea de tiempo** para saltar a cualquier momento;
- las mismas **cámaras** que el visor.

Estados: «cargando…», o «replay no disponible: …» si el replay no existe (por ejemplo, «HTTP 404»). Hoy el lienzo queda vacío y el contador «tick 0 / N» no avanza al pulsar Reproducir.

Los replays de batallas de práctica caducan a los 7 días según su ficha, aunque hoy nada los borra. Los de torneo se conservan siempre.

## Compartir

El reproductor genera un enlace con el instante actual (`#/replay/<id>?t=<tick>`). Quien lo abra empieza en ese momento.

## Errores / limitaciones

- La lista muestra identificadores largos y no los nombres de los bots.
- Puede listar replays de batallas que no existen en la plataforma (generados por pruebas). Su enlace «visor» acaba en «sin conexión».
- En desarrollo local sin la pasarela, la lista y el reproductor no funcionan ([setup.md](../development/setup.md)).
- **Privacidad**: cualquiera con el identificador de una batalla puede descargar su replay, aunque la batalla sea privada ([TD-004](../roadmap/technical-debt.md#td-004)).

## Estado actual

**PARCIAL**: los replays se generan y se sirven; la lista falla en producción y el reproductor no dibuja.

## Documentación relacionada

- Usuario: [Visor](viewer.md), [Batallas](battles.md), [Estadísticas](statistics.md)
- Técnica: [replays.md](../technical/replays.md), [frontend.md](../technical/frontend.md#visor-reproductor-y-phaser)
- Deuda: [TD-004](../roadmap/technical-debt.md#td-004), [TD-009](../roadmap/technical-debt.md#td-009), [TD-014](../roadmap/technical-debt.md#td-014)
