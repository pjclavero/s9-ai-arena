# Cuentas, sesión y roles

Puedes registrarte libremente, iniciar sesión, mantener la sesión al recargar la página y cerrarla. Tu cuenta nace con los roles **user** y **developer**: suficientes para crear bots, subir código, lanzar batallas de práctica y editar mapas.

## Crear cuenta

1. En la pantalla inicial pulsa **«Crear cuenta»**.
2. Rellena **«Nombre visible»** (el que verán los demás jugadores, hasta 48 caracteres), **«Email»** y **«Contraseña (≥12)»**. Una buena contraseña es una frase larga y fácil de recordar: de 12 a 128 caracteres, sin obligación de mayúsculas, números ni símbolos, pero que no sea una contraseña común.
3. Pulsa **«Registrarse y entrar»**. Se crea la cuenta y entras directamente.

## Iniciar sesión

Escribe tu email y tu contraseña y pulsa **«Entrar»**. Si tu cuenta tiene activada la verificación en dos pasos, aparece el campo **«Código TOTP»**: escribe el código de seis cifras de tu aplicación de autenticación (o un código de recuperación) y vuelve a pulsar «Entrar».

## Mantener y cerrar la sesión

- Al recargar la página (F5) verás «Recuperando sesión…» y vuelves a donde estabas. La sesión se renueva sola.
- Si caduca, vuelves al login con el aviso «Tu sesión ha caducado. Vuelve a iniciar sesión.». El código o los cambios sin guardar de esa pestaña se recuperan al volver a entrar.
- **«Salir»**, a la derecha de la barra, cierra la sesión.
- Si la plataforma está caída cuando recargas, verás «No se puede contactar con la plataforma» con «Reintentar»; tu sesión **no se ha cerrado**.

Tu nombre y tus roles aparecen en la barra de navegación, por ejemplo `Nombre (user, developer)`.

## Cambiar la contraseña

Con la sesión iniciada, entra en **«Mi cuenta»** (barra de navegación, junto a tu nombre) y rellena **«Contraseña actual»**, **«Contraseña nueva»** (mínimo 12 caracteres, distinta de la actual) y su repetición. Si tu cuenta tiene verificación en dos pasos, escribe también el **«Código TOTP»** (o un código de recuperación). Pulsa **«Cambiar la contraseña»**.

- Se cierran **todas tus otras sesiones** (otros navegadores o dispositivos); la actual sigue abierta.
- Tras **5 intentos fallidos** seguidos con la contraseña actual, el cambio queda bloqueado unos 15 minutos («Demasiados intentos fallidos»).
- No desactiva la verificación en dos pasos: el siguiente inicio de sesión sigue pidiendo el código.

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
| «La contraseña no puede superar 128 caracteres» | Contraseña demasiado larga. |
| «La contraseña es demasiado común o ha aparecido en filtraciones: elige otra» | Está en la lista de contraseñas comunes (sin importar mayúsculas). |
| «La contraseña no puede basarse en tu email o nombre visible» | Es tu email, tu nombre o ese texto con cifras al final. |
| «Ya existe una cuenta con ese email» | El email ya está registrado. |
| «email inválido» / «displayName obligatorio (máx. 48)» | Datos del formulario no válidos. |
| «Credenciales inválidas» | Email o contraseña incorrectos. |
| «Se requiere un código TOTP válido (2FA activo)» | Falta el código de dos pasos o es incorrecto. |
| «Demasiados intentos fallidos: bloqueo temporal» | Muchos fallos seguidos; espera unos minutos. |
| «Reautenticación requerida: contraseña inválida» | Al cambiar la contraseña, la actual no es correcta. |
| «La nueva contraseña debe ser distinta de la actual» | La contraseña nueva coincide con la actual. |

## Lo que todavía no puedes hacer desde la web

- **Recuperar la contraseña** si la olvidas: la plataforma no envía correos y todavía no existe un restablecimiento iniciado por un administrador (propuesto, pendiente de decisión). Hasta entonces no hay un procedimiento soportado para recuperar una cuenta cuya contraseña se ha olvidado: guarda la tuya y cámbiala desde «Mi cuenta» mientras tengas la sesión abierta.
- **Activar la verificación en dos pasos**, ver tus sesiones abiertas o cambiar tu nombre visible: existen en la plataforma, pero no tienen pantalla.
- El registro está abierto a cualquiera.

Siguiente: [Primeros pasos](getting-started.md) · [Bots](bots.md).
