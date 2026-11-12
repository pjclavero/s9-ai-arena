# Administración desde la web

Esta página es para quien tiene un rol de **administrador dentro del juego**. No es la guía del **operador del servidor** (instalar, hacer copias, actualizar), que está en [operaciones](../operations/index.md).

Una cuenta con rol **admin** ve la zona **«Administración»** y, además, la pantalla de **Streaming**. En Administración se gestionan roles, catálogo, hallazgos, auditoría y el bloque **«Acceso público / Broadcast»**. Un usuario sin rol admin recibe «No tienes permiso para esto».

No hay gestión de usuarios propiamente dicha: no hay listado, búsqueda, bloqueo ni borrado.

## Usuarios y seguridad

- **Roles de usuario**: escribe el identificador del usuario y los **roles separados por coma** (por ejemplo `user, developer, organizer`) y pulsa **«Asignar roles»**. La lista **sustituye** los roles del usuario, y una lista vacía le deja sin acceso. Sólo se muestran los errores; no hay mensaje de éxito. Hay que conocer el identificador del usuario: la web no lo muestra.
- **Catálogo importado**: las versiones del catálogo de equipamiento, con su número de piezas.
- **Hallazgos de seguridad**: lo que detecta la validación de bots (dependencias no permitidas, secretos en el código…), con fecha, tipo, gravedad y detalle.
- **Auditoría (solo inserción)**: las últimas acciones registradas.

## Acceso público / Broadcast

Desde PR #269, el bloque **Administración → Acceso público / Broadcast** permite cambiar sin SSH ni editar `.env`:

- **Espectador público**: permite ver batallas en directo sin cuenta cuando la batalla y su política lo permiten.
- **Replays públicos**: permite ver replays sin cuenta cuando la política del replay/batalla lo permite.

Los cambios:

- se guardan en la aplicación (BD);
- quedan auditados con quién, cuándo, valor anterior y nuevo;
- se aplican en caliente; los demás procesos los releen en pocos segundos;
- fallan cerrados: si no se puede leer un estado válido, no se abre el acceso público;
- no contienen secretos.

El bloque muestra también el **estado efectivo** de la retransmisión. Que una batalla tenga `broadcastable=true` no basta si, por ejemplo, el espectador público está desactivado.

Ejemplos de motivos que puede mostrar la interfaz:

- espectador público desactivado;
- replays públicos desactivados;
- batalla no pública;
- torneo no retransmisible;
- batalla todavía no iniciada;
- streaming no configurado.

### Importante

Activar el espectador público expone sólo las batallas que la política pública permite. No hace público automáticamente el código, la ficha privada ni los datos internos de un bot. Consulta [Visibilidad](visibility.md).

## Sistema

«Estado del sistema» muestra el entorno, la versión, si la base de datos responde, si la plataforma puede **ejecutar batallas** («Runner real» habilitado o deshabilitado), cuántos bots están listos para jugar y cuántos mapas hay publicados, además de los recuentos de batallas, builds y versiones por estado. Si las batallas no se ejecutan, lo dice con un aviso.

## Auditoría

Tabla de las últimas 100 acciones: fecha, acción (por ejemplo `tournament.created`, `map.published`, `bot.version.rejected`), objetivo, actor y correlación. El registro no se puede modificar ni borrar.

## Roles y permisos

La jerarquía de roles con su rango y la **matriz** de qué rol mínimo exige cada acción, con un filtro por ruta, método o rol.

## Streaming

Pantalla **Administración → Streaming**: emite una batalla (o un torneo) en directo hacia YouTube u
otra ingesta RTMPS, o la graba en MP4. Sólo para admin; un usuario normal no puede iniciar, parar,
cambiar el destino ni ver la clave. La ayuda completa está en **Ayuda → Administración: Streaming**
y la operación en [streaming.md](../operations/streaming.md).

- **Iniciar:** elige el destino (los botones «Retransmitir» del detalle de una batalla lo rellenan) y
  pulsa **Iniciar emisión**. Sólo puede haber **una** emisión: si ya hay otra, la pantalla lo dice y
  no la toca. El estado pasa por **Iniciando** y sólo marca **En directo** cuando la ingesta acepta
  el vídeo.
- **Detener:** **Detener emisión**. Pulsarlo dos veces no rompe nada.
- **Estados:** desactivado, listo, iniciando, en directo, grabando, reconectando, abandonada (los
  reintentos se agotaron), interrumpida (la emisión se cortó; por ejemplo, se reinició el servicio)
  y servicio no disponible. Desde **abandonada** o **interrumpida** basta con volver a pulsar
  **Iniciar emisión** (o **Reiniciar emisión**).
- **Errores habituales:** «ya hay una emisión activa», «el streaming está desactivado», «no hay clave
  de emisión configurada», «la clave se guardó para otra URL de ingesta» y «servicio de emisión no
  disponible». El último error del servicio se muestra redactado: nunca aparece la clave.
- **La clave:** se escribe una vez en **Credenciales** y después sólo se ve «configurada (****ABCD)».
  Para cambiarla, escribe la nueva; se aplica en el siguiente inicio o reinicio.

## Acciones de organizador y moderador

No son pantallas de administración, pero exigen roles altos:

- **Organizador**: crear torneos y cerrar inscripciones ([Torneos](tournaments.md)); generar mapas procedurales ([Mapas](maps.md)).
- **Moderador**: suspender versiones de bots (hoy sin pantalla).

## Lo que no se hace desde la web

Listar o buscar usuarios, bloquear cuentas, restablecer contraseñas, importar catálogos, suspender bots, activar la ejecución real de batallas y operar backup/restore/readiness siguen fuera de la web. **El espectador y los replays públicos sí se gestionan ya desde Administración → Acceso público / Broadcast.** Para el resto, ver [operaciones](../operations/index.md) y [configuración](../operations/configuration.md).

Siguiente: [Cuentas](accounts.md).


## Próxima evolución: Retransmisión V2 (DESIGN_ONLY)

La arquitectura MS-1 (#275) está aprobada como **diseño**, pero todavía no forma parte del producto. Cuando MS-2…MS-8 se integren, Administración → Retransmisión deberá permitir preparar una batalla antes de arrancarla, esperar a `BROADCAST_READY`, emitir un torneo completo en una única sesión YouTube, elegir/cambiar la batalla, obtener fuentes por batalla para OBS/vMix y emitir replays o listas de replays. Hasta entonces, esta sección es informativa y no describe botones disponibles hoy.
