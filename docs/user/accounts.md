# Cuentas, sesión y roles

Puedes registrarte libremente, iniciar sesión, mantener la sesión al recargar la página y cerrarla. Tu cuenta nace con los roles **user** y **developer**: suficientes para crear bots, subir código, lanzar batallas de práctica y editar mapas.

## Crear cuenta

1. En la pantalla inicial pulsa **«Crear cuenta»**.
2. Rellena **«Nombre visible»** (el que verán los demás jugadores, hasta 48 caracteres), **«Email»** y **«Contraseña (≥12)»**.
3. Pulsa **«Registrarse y entrar»**. Se crea la cuenta y entras directamente.

## Iniciar sesión

Escribe tu email y tu contraseña y pulsa **«Entrar»**. Si tu cuenta tiene activada la verificación en dos pasos, aparece el campo **«Código TOTP»**: escribe el código de seis cifras de tu aplicación de autenticación (o un código de recuperación) y vuelve a pulsar «Entrar».

## Mantener y cerrar la sesión

- Al recargar la página (F5) verás «Recuperando sesión…» y vuelves a donde estabas. La sesión se renueva sola.
- Si caduca, vuelves al login con el aviso «Tu sesión ha caducado. Vuelve a iniciar sesión.». El código o los cambios sin guardar de esa pestaña se recuperan al volver a entrar.
- **«Salir»**, a la derecha de la barra, cierra la sesión.
- Si la plataforma está caída cuando recargas, verás «No se puede contactar con la plataforma» con «Reintentar»; tu sesión **no se ha cerrado**.

Tu nombre y tus roles aparecen en la barra de navegación, por ejemplo `Nombre (user, developer)`.

## Roles

Los roles se acumulan: cada uno incluye todo lo de los anteriores.

| Rol | Qué permite |
|---|---|
| user | Crear bots y equipos, inscribir bots en torneos, lanzar batallas de práctica, crear mapas. |
| developer | Subir versiones de código, enviarlas a validación y publicarlas. |
| team_captain | Gestionar los miembros de tu equipo (se obtiene al crear un equipo). |
| organizer | Crear torneos, cerrar inscripciones, generar mapas procedurales. |
| moderator | Suspender versiones de bots. |
| admin | Administración de la plataforma: roles, auditoría, estado. |

Los roles de organizador o superiores los concede un administrador ([Administración](administration.md)). Si pulsas una acción para la que no tienes rol, verás «Requiere rol organizer» (o el que toque) sin que pase nada más.

## Mensajes que puedes ver

| Mensaje | Significa |
|---|---|
| «La contraseña debe tener al menos 12 caracteres» | Contraseña corta. |
| «Ya existe una cuenta con ese email» | El email ya está registrado. |
| «email inválido» / «displayName obligatorio (máx. 48)» | Datos del formulario no válidos. |
| «Credenciales inválidas» | Email o contraseña incorrectos. |
| «Se requiere un código TOTP válido (2FA activo)» | Falta el código de dos pasos o es incorrecto. |
| «Demasiados intentos fallidos: bloqueo temporal» | Muchos fallos seguidos; espera unos minutos. |

## Lo que todavía no puedes hacer desde la web

- **Cambiar la contraseña** y **recuperarla** si la olvidas (la plataforma no envía correos): pídeselo a un administrador.
- **Activar la verificación en dos pasos**, ver tus sesiones abiertas o cambiar tu nombre visible: existen en la plataforma, pero no tienen pantalla.
- El registro está abierto a cualquiera.

Siguiente: [Primeros pasos](getting-started.md) · [Bots](bots.md).
