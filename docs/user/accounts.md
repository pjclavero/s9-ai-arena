# Cuentas, sesión y roles

## Resumen

Puedes registrarte libremente, iniciar sesión, mantenerla tras recargar la página y cerrarla. Tu cuenta nace con los roles **user** y **developer**, suficientes para crear bots y subir código. No puedes cambiar la contraseña ni recuperarla desde la web.

## Índice

- [Uso](#uso)
- [Roles](#roles)
- [Mensajes que puedes ver](#mensajes-que-puedes-ver)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)

## Uso

### Crear cuenta — **FUNCIONA ACTUALMENTE**

1. En la pantalla inicial pulsa **«Crear cuenta»**.
2. Rellena **«Nombre visible»** (hasta 48 caracteres), **«Email»** y **«Contraseña (≥12)»**.
3. Pulsa **«Registrarse y entrar»**. Se crea la cuenta y entras directamente.

### Iniciar sesión — **FUNCIONA ACTUALMENTE**

Introduce email y contraseña y pulsa **«Entrar»**. Si tu cuenta tiene la verificación en dos pasos activada, aparece el campo **«Código TOTP»**: escribe el código de tu aplicación y vuelve a pulsar «Entrar».

### Mantener la sesión — **FUNCIONA ACTUALMENTE**

Al recargar la página (F5) verás «Recuperando sesión…» y vuelves a donde estabas. La sesión se renueva sola. Si caduca, vuelves al login con el aviso «Tu sesión ha caducado. Vuelve a iniciar sesión.».

### Cerrar sesión — **FUNCIONA ACTUALMENTE**

Botón **«Salir»** a la derecha de la barra de navegación. Verás «Sesión cerrada.».

### Tu nombre y tus roles

Aparecen en la barra de navegación como `Nombre (user, developer)`.

## Roles

Los roles se acumulan: cada uno incluye todo lo de los anteriores.

| Rol | Qué permite (resumen) |
|---|---|
| user | Crear bots, equipos, inscribirse en torneos, crear batallas de práctica, importar mapas |
| developer | Subir versiones de código, enviarlas a validación y publicarlas |
| team_captain | Gestionar los miembros de tu equipo (se obtiene al crear un equipo) |
| organizer | Crear torneos, cerrar inscripciones, generar y publicar mapas |
| moderator | Suspender versiones de bots |
| admin | Administración: roles, auditoría, sistema |

Los roles de organizador o superiores sólo los concede un administrador ([Administración](administration.md)).

## Mensajes que puedes ver

| Mensaje | Significa |
|---|---|
| «La contraseña debe tener al menos 12 caracteres» | Contraseña corta |
| «Ya existe una cuenta con ese email» | El email ya está registrado |
| «email inválido» / «displayName obligatorio (máx. 48)» | Datos del formulario no válidos |
| «Credenciales inválidas» | Email o contraseña incorrectos |
| «Se requiere un código TOTP válido (2FA activo)» | Falta o es incorrecto el código de 2 pasos |
| «Demasiados intentos fallidos: bloqueo temporal» | Muchos fallos seguidos; espera unos minutos |

## Errores / limitaciones

- **PENDIENTE**: **cambiar la contraseña**. No existe la opción.
- **PENDIENTE**: **recuperar la contraseña** desde la web. La plataforma no envía correos.
- **PENDIENTE**: activar la verificación en dos pasos, ver tus sesiones abiertas o cambiar el nombre visible. Existen en la plataforma, pero no hay pantalla.
- Si la plataforma está caída y recargas la página, ya **no** aparece el login: verás «No se puede contactar con la plataforma» con «Reintentar» (y la opción de ir al inicio de sesión). Tu sesión sigue siendo válida. **FUNCIONA ACTUALMENTE** en la rama de cierre funcional ([TD-022](../roadmap/technical-debt.md#td-022)).
- Si la contraseña es incorrecta verás el mensaje del servidor; si el servidor no responde, «El servidor tarda demasiado» o «Servicio no disponible», nunca «credenciales incorrectas».
- El registro está abierto a cualquiera.

Deuda relacionada: [TD-012](../roadmap/technical-debt.md#td-012).

## Estado actual

**PARCIAL**: registro, login, sesión y cierre funcionan; la gestión de la cuenta no tiene pantalla.

## Documentación relacionada

- Técnica: [api.md — autenticación](../technical/api.md#autenticación-y-sesión), [security.md](../technical/security.md)
- Usuario: [Administración](administration.md), [Primeros pasos](getting-started.md)
