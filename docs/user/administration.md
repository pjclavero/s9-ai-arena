# Administración desde la web

## Resumen

Una cuenta con rol **admin** ve cuatro enlaces más en la barra: **Administración**, **Sistema**, **Auditoría** y **Roles**. Desde ahí puede:

- asignar roles;
- ver el catálogo importado y los hallazgos de seguridad;
- consultar el registro de auditoría;
- revisar el estado de la plataforma y la matriz de permisos.

No hay gestión de usuarios propiamente dicha: no hay listado, búsqueda, bloqueo ni borrado. El resto de la administración se hace fuera de la web, por consola ([TD-023](../roadmap/technical-debt.md#td-023)).

## Índice

- [Administración](#administración-admin)
- [Sistema](#sistema-system)
- [Auditoría](#auditoría-audit)
- [Roles](#roles-roles)
- [Acciones de organizador y moderador](#acciones-de-organizador-y-moderador)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)

## Administración (`#/admin`)

- **Roles de usuario** — **PARCIAL**:
  1. Escribe el **userId** (identificador interno) y los **roles separados por coma**; por ejemplo `user, developer, organizer`.
  2. Pulsa **«Asignar roles»**.
  - La lista **sustituye** los roles del usuario. Una lista vacía le deja sin acceso.
  - Sólo se muestran los errores; **no hay mensaje de éxito**.
  - Un rol inexistente da error.
- **Catálogo importado** — **FUNCIONA ACTUALMENTE**: versiones del catálogo de módulos, con su número de módulos. Importar uno nuevo no tiene pantalla.
- **Hallazgos de seguridad** — **FUNCIONA ACTUALMENTE**: lo que detecta la validación de bots (dependencias no permitidas, secretos en el código…), con fecha, tipo, gravedad y detalle.
- **Auditoría (solo inserción)** — **FUNCIONA ACTUALMENTE**: las últimas acciones registradas.

Un usuario sin el rol ve «Acceso denegado.».

## Sistema (`#/system`)

**FUNCIONA ACTUALMENTE.** Un usuario sin rol de administrador que abra `#/system` ve «No tienes permiso para esto» (403 real de la API), con «Reintentar». «Estado del sistema» muestra:

- entorno, commit y base de datos (OK / no accesible);
- **Runner real**: habilitado o deshabilitado. Hoy está deshabilitado y lo indica con «Battle execution unavailable in this environment (runner real no habilitado).»;
- si hay *digest* de bot de humo;
- **bots listos** y **mapas publicados**.

Además incluye:

- «Conteos por estado»;
- «Política de runtime (solo lectura)»: sin privilegios, sin socket de Docker, seccomp y *digest* obligatorio.

## Auditoría (`#/audit`)

**FUNCIONA ACTUALMENTE.** Tabla de las últimas 100 entradas: fecha, acción, objetivo, actor y correlación. Ejemplos de acciones: `tournament.created`, `map.published`, `battle.run_started`, `bot.version.rejected`. El registro no se puede modificar ni borrar.

## Roles (`#/roles`)

**FUNCIONA ACTUALMENTE.** Jerarquía de roles con su rango y **matriz endpoint → rol mínimo**, con un filtro por ruta, método o rol.

## Acciones de organizador y moderador

No son pantallas de administración, pero exigen roles altos:

- **Organizador**:
  - crear torneos y cerrar inscripciones ([Torneos](tournaments.md));
  - generar y publicar mapas ([Mapas](maps.md)).
- **Moderador**: suspender versiones de bots. **PENDIENTE**: sin pantalla.

## Errores / limitaciones

- **Identificadores manuales**: para asignar roles hay que conocer el identificador del usuario, y la web no lo muestra en ningún sitio.
- **Errores de carga**: si la carga del catálogo, los hallazgos o el registro de auditoría fallan, la página lo indica con el mensaje del servidor (antes el fallo del catálogo se tragaba).
- **PENDIENTE**:
  - listar o buscar usuarios;
  - bloquear cuentas;
  - restablecer contraseñas;
  - importar catálogos;
  - suspender bots;
  - lanzar el simulacro de un torneo;
  - activar la ejecución real o la emisión pública. Estas dos son configuración del despliegue: ver [configuration.md](../operations/configuration.md).

## Estado actual

**PARCIAL**: consulta completa; las acciones se limitan a asignar roles a mano.

## Documentación relacionada

- Usuario: [Cuentas](accounts.md)
- Técnica: [api.md — administración](../technical/api.md#recursos-por-área), [security.md](../technical/security.md), [frontend.md](../technical/frontend.md)
- Operación: [operations/index.md](../operations/index.md), [diagnostics.md](../operations/diagnostics.md)
- Deuda: [TD-023](../roadmap/technical-debt.md#td-023), [TD-012](../roadmap/technical-debt.md#td-012)
