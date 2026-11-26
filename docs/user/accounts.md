# Cuentas, sesión y roles

Puedes registrarte libremente, iniciar sesión, mantener la sesión al recargar la página y cerrarla. Tu cuenta nace con los roles **user** y **developer**: suficientes para crear bots, subir código, lanzar batallas de práctica y editar mapas.

## Crear cuenta

1. En la pantalla inicial pulsa **«Crear cuenta»**.
2. Rellena **«Nombre visible»** (el que verán los demás jugadores, hasta 48 caracteres), **«Email»** y **«Contraseña (≥12)»**.
3. Pulsa **«Registrarse y entrar»**. Se crea la cuenta y entras directamente.

## Iniciar sesión

Escribe tu email y tu contraseña y pulsa **«Entrar»**. Si tu cuenta tiene activada la verificación en dos pasos, aparece el campo **«Código TOTP»**: escribe el código de seis cifras de tu aplicación de autenticación (o un código de recuperación, ver [Si pierdes el móvil](#si-pierdes-el-móvil)) y vuelve a pulsar «Entrar».

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

## Verificación en dos pasos

Con la verificación en dos pasos (2FA), además de la contraseña se pide un código de 6 cifras que genera una aplicación de autenticación del móvil (Google Authenticator, Aegis, FreeOTP, 1Password…). Se gestiona en **«Mi cuenta» → «Verificación en dos pasos»**, que muestra si está activada y cuántos **códigos de recuperación** te quedan. Con menos de 3 verás un aviso para que generes otros.

### Activarla

1. Escribe tu **contraseña** y pulsa **«Activar la verificación en dos pasos»** (se pide para que nadie con tu sesión abierta pueda activarla por ti).
2. En la app del móvil añade una cuenta escaneando el **código QR**. Si no puedes escanearlo, escribe a mano la clave que aparece debajo (tipo «basada en el tiempo»).
3. Escribe el código de 6 cifras que muestra la app y pulsa **«Confirmar»**.
   - Hasta que confirmes, **no se activa nada**: si cancelas o cierras la página, tu cuenta sigue como estaba.
   - El alta caduca a los 10 minutos («El alta ha caducado»): vuelve a pulsar «Activar».
   - Si el código no vale, comprueba que la hora del móvil está en automático. Tras **5 códigos fallidos** queda bloqueado unos 15 minutos.
4. Se muestran tus **8 códigos de recuperación**. **Es la única vez que se ven**: guárdalos en un gestor de contraseñas o en papel, marca **«Los he guardado»** y pulsa **«Hecho»**.

Al activarla se cierran tus otras sesiones abiertas; la actual sigue.

### Regenerar los códigos de recuperación

Escribe tu **contraseña** y un **código** (de la app o uno de recuperación) y pulsa **«Regenerar los códigos»**. Se crean 8 códigos nuevos, que se muestran una sola vez, y **todos los anteriores dejan de valer**, también los que no hayas usado. Queda registrado en la auditoría (sin los códigos).

### Desactivarla

Escribe tu contraseña y un código y pulsa **«Desactivar la verificación en dos pasos»**. Tu cuenta volverá a pedir sólo la contraseña y se cerrarán tus otras sesiones.

Tras **5 intentos fallidos** seguidos al regenerar o desactivar, la operación queda bloqueada unos 15 minutos.

### Si pierdes el móvil

1. En **«Iniciar sesión»** escribe tu email y tu contraseña y pulsa «Entrar». Aparece el campo «Código TOTP».
2. Escribe ahí **uno de tus códigos de recuperación** (12 caracteres; da igual si lo escribes en mayúsculas o con espacios o guiones) y pulsa «Entrar».
3. Ya dentro, ve a «Mi cuenta»: regenera los códigos, o desactiva la verificación y vuelve a activarla con el móvil nuevo.

Cada código (de recuperación o de la app) **sirve una sola vez**: si acabas de usar uno, espera al siguiente que muestre la app. Sin móvil y sin códigos no se puede entrar desde la web: pide ayuda a un administrador.

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
| «Ese código ya se ha usado: espera al siguiente…» | Acabas de usar ese código (o uno posterior). Espera a que la app muestre otro; no cuenta como intento fallido. |
| «Demasiados intentos fallidos: bloqueo temporal» | Muchos fallos seguidos; espera unos minutos. |
| «Reautenticación requerida: contraseña inválida» | Al cambiar la contraseña, la actual no es correcta. |
| «La nueva contraseña debe ser distinta de la actual» | La contraseña nueva coincide con la actual. |

## Lo que todavía no puedes hacer desde la web

- **Recuperar la contraseña** si la olvidas: la plataforma no envía correos y todavía no existe un restablecimiento iniciado por un administrador (propuesto, pendiente de decisión). Hasta entonces no hay un procedimiento soportado para recuperar una cuenta cuya contraseña se ha olvidado: guarda la tuya y cámbiala desde «Mi cuenta» mientras tengas la sesión abierta.
- Ver tus sesiones abiertas o cambiar tu nombre visible: existen en la plataforma, pero no tienen pantalla.
- El registro está abierto a cualquiera.

Siguiente: [Primeros pasos](getting-started.md) · [Bots](bots.md).
