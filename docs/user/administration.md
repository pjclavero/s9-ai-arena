# Administración desde la web

Esta página es para quien tiene un rol de **administrador dentro del juego**. No es la guía del **operador del servidor** (instalar, hacer copias, actualizar), que está en [operaciones](../operations/index.md).

Una cuenta con rol **admin** ve en la barra una entrada **«Administración»** con cuatro pantallas: **Usuarios y seguridad**, **Sistema**, **Auditoría** y **Roles y permisos**, y además **Streaming** (ver [Streaming](#streaming)). Encima de todas ellas, el panel **«Acceso público / Broadcast»** (ver [Acceso público](#acceso-público)). Un usuario sin el rol que abre una de ellas ve «No tienes permiso para esto».

Los usuarios se gestionan desde la sección **«Usuarios»** de la pantalla *Usuarios y seguridad* (ver [Usuarios](#usuarios)). No hay borrado de cuentas.

## Usuarios y seguridad

- **Usuarios**: listado, búsqueda, roles, bloqueo y recuperación de cuentas (sección siguiente).
- **Catálogo importado**: las versiones del catálogo de equipamiento, con su número de piezas.
- **Hallazgos de seguridad**: lo que detecta la validación de bots (dependencias no permitidas, secretos en el código…), con fecha, tipo, gravedad y detalle.
- **Auditoría (solo inserción)**: las últimas acciones registradas.

## Usuarios

La tabla **«Usuarios»** (la primera de *Usuarios y seguridad*) lista las cuentas de 20 en 20 (**«Cargar más»** pide la página siguiente) y se filtra con **«Buscar por nombre o email»** (no distingue mayúsculas; `%` y `_` se buscan tal cual). Cada fila muestra nombre, email, roles, si tiene 2FA y su estado (**activa** o **bloqueada**, y **recuperación pendiente** si hay un token vigente sin usar; si ese token restablecerá también la 2FA, lo dice: «recuperación pendiente (restablece la 2FA)»). Nunca se muestran contraseñas, secretos ni códigos de recuperación.

**Un solo administrador gestiona todo.** No hace falta que otro admin apruebe nada: puedes dar o quitar el rol `admin`, bloquear o desbloquear (también a otro admin) y recuperar la cuenta de cualquiera. Cada acción importante pide **escribir una frase exacta**, **tu contraseña** (y el código 2FA si tu cuenta lo tiene) cuando el servidor reautentica, y queda en la **auditoría**. Sólo hay un límite de seguridad: **nunca puede quedar 0 administradores activos** (ver abajo).

| Acción | Qué hace |
|---|---|
| **Roles** | pulsa **«Roles»** (se cargan los roles REALES de la cuenta), marca los roles y pulsa **«Guardar roles»**. La lista **sustituye** a la actual; vacía deja a la cuenta sin acceso. Cualquier cambio **anula los tokens de recuperación abiertos** de la cuenta. **Dar o quitar el rol `admin` (a quien sea, también a ti) pide tu contraseña** (y el 2FA si lo tienes); el resto de cambios, no. Pide la frase `CAMBIAR ROLES <email>`. |
| **Bloquear / Desbloquear** | un usuario bloqueado **no puede iniciar sesión** (aunque acierte la contraseña, ve «Cuenta bloqueada»), se le **cierran todas las sesiones** y se anulan sus tokens de recuperación. Puedes bloquear o desbloquear a cualquier cuenta, también a otro admin y a ti mismo. Frase `BLOQUEAR <email>` / `DESBLOQUEAR <email>`. |
| **Token de recuperación** | para un usuario que olvidó su contraseña (ver [abajo](#recuperar-la-cuenta-de-un-usuario)); vale también para la cuenta de otro admin. Frase `RECUPERAR <email>`. |

**Último admin protegido.** Quitar el rol `admin` o bloquear al **último administrador activo** (también a ti mismo) se rechaza con **409 `last_admin`**: la plataforma nunca se queda sin administrador. Se comprueba con un cerrojo, así que dos admins que se degraden a la vez no pueden dejarla vacía.

Todas las acciones quedan en la **auditoría** con quién las hizo (`admin.user.roles_set`, `admin.user.blocked`, `admin.user.unblocked`, `admin.user.recovery_token_issued`).

### Recuperar la cuenta de un usuario

No hay correo: el token se entrega **en persona o por un canal que controle el usuario**.

1. En la fila del usuario, **«Token de recuperación»**, escribe la frase y tu contraseña. Aparece el **token** una sola vez, con su caducidad (**30 minutos**). Si ya había uno vigente, queda anulado. No hay token para tu propia cuenta (usa «Mi cuenta»).
2. Dáselo al usuario. Él abre **«¿Has olvidado la contraseña?… canjéalo aquí»** en la pantalla de acceso (`#/reset`), pega el token y **elige él su contraseña** (mínimo 12 caracteres): tú nunca la conoces. El token vale **una sola vez**; al canjearlo se **cierran todas sus sesiones**. Si tiene 2FA, sigue necesitando su código para entrar, **salvo** que al emitir hayas marcado **«Restablecer también la 2FA»** (casilla visible si la cuenta tiene 2FA; por defecto desmarcada): entonces, al canjear, se desactiva la 2FA y se borran sus códigos (la activación de la 2FA tiene hoy su operación en la API; la pantalla propia llega con ACC-2FA, #351). Pide la frase `RESTABLECER 2FA <email>` en lugar de `RECUPERAR <email>`.
3. Un token caducado, usado, anulado (por un cambio de roles o de estado de la cuenta) o de una cuenta bloqueada se rechaza siempre con el mismo mensaje.

La **consola** (`reset-password`) es sólo el último recurso, para cuando ningún admin puede entrar: ver [recuperación de cuentas](../operations/account-recovery.md).

## Sistema

«Estado del sistema» muestra el entorno, la versión, si la base de datos responde, si la plataforma puede **ejecutar batallas** («Runner real» habilitado o deshabilitado), cuántos bots están listos para jugar y cuántos mapas hay publicados, además de los recuentos de batallas, builds y versiones por estado. Si las batallas no se ejecutan, lo dice con un aviso.

## Auditoría

Tabla de las últimas 100 acciones: fecha, acción (por ejemplo `tournament.created`, `map.published`, `bot.version.rejected`), objetivo, actor y correlación. El registro no se puede modificar ni borrar.

## Roles y permisos

La jerarquía de roles con su rango y la **matriz** de qué rol mínimo exige cada acción, con un filtro por ruta, método o rol.

## Acceso público

El panel **«Acceso público / Broadcast»**, en la parte superior de Administración, tiene dos interruptores que sólo puede cambiar un **admin** (cualquier otro rol recibe 403):

- **Espectador público**: batallas en directo sin cuenta.
- **Replays públicos**: batallas terminadas sin cuenta.

El valor se guarda en la base de datos y **manda siempre**; el cambio se aplica sin reiniciar nada y llega a todos los servicios en unos segundos (cinco por defecto). Cada cambio queda en la auditoría. Activarlos no publica todo: una batalla con un bot privado o de equipo sigue siendo privada salvo que sea de un torneo con retransmisión pública ([Visibilidad](visibility.md)). Poner un interruptor en apagado cierra el acceso aunque el operador haya dejado la variable de entorno encendida; ver [configuración](../operations/configuration.md).

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

Listar o buscar usuarios, bloquear cuentas, restablecer contraseñas, importar catálogos, suspender bots o activar la ejecución de batallas. Esas tareas son del operador del servidor: ver [operaciones](../operations/index.md) y [configuración](../operations/configuration.md).

Siguiente: [Cuentas](accounts.md).
