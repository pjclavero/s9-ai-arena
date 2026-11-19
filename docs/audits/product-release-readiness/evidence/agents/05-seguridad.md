> Anexo de trazabilidad: informe de trabajo original, saneado para publicación (rutas locales sustituidas por marcadores y sección de anexo privado retirada; estaba vacía). Las severidades y grupos **finales** son los de los documentos 01-15, no los de este informe.

# Agente 5 · Seguridad — Auditoría de producto S9 AI Arena

- Repo: pjclavero/s9-ai-arena · HEAD verificado (`git -C <árbol-auditado@8f380eb> rev-parse HEAD`): `8f380eb700c3e984691649b3449d2c543038dfb1` (main, merge #298)
- Fecha: 2026-11-19 · Fase 1 (estática). Prefijo de hallazgos: SEC-
- Alcance revisado: autenticación y sesiones (`apps/api/src/auth`, `routes/auth.ts`, `middleware/*`), RBAC y ownership (`registry.ts`, `routes/bots.ts`, `teams.ts`, `users.ts`), sandbox de bots y docker-proxy (`apps/bot-manager`), compose y redes (`infrastructure/docker-compose.yml`), gateway y nginx de la web, firewall de host (`infrastructure/firewall`), secretos (`init-secrets.sh`), CI y workflows, excepción de `npm audit`, deuda TD-xxx de seguridad.
- NO se pudo mirar (prohibido en fase 1 o fuera de alcance): producción y laboratorio, estado real del firewall del host, permisos de `.env`/`secrets/` en el host, ejecución de tests, `npm audit` y Trivy en vivo, configuración del repo en GitHub (permisos por defecto del token, protección de rama, secretos de Actions). No se revisaron los ~100 endpoints uno a uno: la autorización se auditó por muestreo (bots, equipos, usuarios, replays/espectador) y apoyándose en la matriz `rbac-matrix.test.ts`, que no se ha ejecutado.

## 2. Resumen y veredicto: READY_WITH_CONDITIONS

1. El núcleo de seguridad está bien diseñado y es coherente con lo que dice la documentación: sin `docker.sock` en ningún servicio, proxy de Docker con allowlist de endpoints, imagen por digest, labels de propiedad y control de cliente, y postura del sandbox del bot (cap-drop ALL, rootfs de sólo lectura, seccomp por allowlist, red interna, límites obligatorios) validada por una única función (`compliance.mjs`).
2. Los secretos se generan aleatorios por fichero (0400), el JWT falla cerrado sin secreto y no hay secretos commiteados (`git ls-files` sin `.env`, `.pem` ni `secrets/*.txt`).
3. Sesión: access JWT de 15 min en memoria del cliente, refresh opaco con rotación por familias, detección de reutilización, tope absoluto de 30 días, sesión comprobada en BD en cada petición.
4. Un solo servicio publica puertos (gateway). Los replays ya no pasan por el gateway sin autorizar (TD-004 cerrada, con test sobre la conf real).
5. Lo que impide llamarlo READY sin condiciones: (a) la SPA se sirve sin ninguna cabecera de seguridad (SEC-01); (b) registro abierto con rol `developer` y sin verificación de email, además de gestión de cuenta incompleta (SEC-02, SEC-03); (c) el anfitrión de bots con credenciales de BD está en la misma red que los bots (SEC-04); (d) las imágenes de servicio no se escanean y TD-031 sigue sin arreglar en el código (SEC-05).
6. No encontré ningún P0 ni un P1 con ruta de explotación concreta. Las prioridades históricas TD-008 (P0) y TD-031/TD-033 (P1) bajan por los motivos indicados en §6.
7. Evidencia: casi todo es CODE_VERIFIED. Hay TEST_VERIFIED sólo para lo que cubre el run de CI `44383512640` sobre 8f380eb (jobs `scan`, `semaforo`, `functional-e2e / container-proxy-e2e`, `docker-e2e` y `golden` en success). Nada es PROD_VERIFIED por mí.
8. El workflow `nightly` falló sobre 8f380eb (run 44519497401, job `slow-suites`). No lo investigué: es TD-019 y cae fuera de mi área.
9. Una instalación nueva con valores por defecto queda cerrada en lo importante (ejecución real de batallas, espectador público y métricas apagados por defecto). Lo que queda abierto es el registro de cuentas (§8).
10. Fase 2 debe confirmar en el host lo que el repo sólo declara: firewall aplicado, permisos 0600/0700 y 74 hallazgos de imagen vigentes (§7).

## 3. Matriz del área

| Elemento | Estado real | Evidencia | Qué falta | Prio | Esfuerzo | Bloquea lanzamiento |
|---|---|---|---|---|---|---|
| Secreto JWT | Fail-closed, por fichero; sin longitud mínima ni `kid` | `auth/tokens.ts:48-80` CODE_VERIFIED | Mínimo de longitud; procedimiento de rotación (SEC-12) | P3 | S | No |
| Expiración / rotación de sesión | 15 min + refresh rotado por familia + tope 30 d | `tokens.ts:25-40`, `routes/auth.ts:228+` CODE_VERIFIED | Nada relevante | — | — | No |
| Almacenamiento en cliente | Access en memoria, refresh en cookie httpOnly SameSite=Lax, `Secure` según `req.secure`; localStorage sólo guarda una marca booleana | `apps/web/src/api.ts:7-70`, `auth.ts:54-66` CODE_VERIFIED | Comprobar `Secure` tras el proxy real (fase 2) | P3 | S | No |
| Registro | Abierto, sin interruptor ni verificación de email; concede `user`+`developer` | `routes/auth.ts:147-175` | Interruptor o invitación; verificación (SEC-02) | P2 | M | Condición |
| Política de contraseñas | Sólo mínimo de 12 caracteres, Argon2id | `routes/auth.ts`, `auth/passwords.ts` | Lista de contraseñas comunes, opcional | P3 | S | No |
| Rate limiting / fuerza bruta | Compartido en BD; bloqueo tras 20 fallos por `ip|email`; `TRUST_PROXY_HOPS` por defecto 1 | `shared-rate-limit.ts`, `docker-compose.yml:193` | Salto correcto en modo detrás de proxy (SEC-10) | P3 | S | No |
| Gestión de cuenta | Sin cambio de contraseña; recuperación sin transporte | `routes/auth.ts:392-440` | SEC-03 | P2 | M | Condición |
| RBAC | Guard por rango desde el contrato OpenAPI, `safeLookup` contra `__proto__` | `registry.ts`, `middleware/authenticate.ts` CODE_VERIFIED | Ejecutar `rbac-matrix` (fase 2) | — | — | No |
| Ownership bots/equipos | Comprobaciones por dueño/equipo/staff (moderador o superior); código fuente sólo dueño, equipo y staff | `routes/bots.ts:98-110,367-380,648` | Muestreo, no exhaustivo; TD-041 | P3 | S | No |
| Sandbox de ejecución de bots | Conforme, ver §4 | `compliance.mjs`, `docker-proxy.ts`, `seccomp-bot.json` | SEC-04 | P2 | L | No |
| docker-proxy | Allowlist de endpoints, de imagen (digest exacto de DIGESTS.lock), de cliente, de propiedad; límites obligatorios | `docker-proxy.ts:1-100,316-450,926-936` | Verificar en el host (fase 2) | — | — | No |
| Secretos | Por fichero 0400, aleatorios; `stream_key` sellada con RSA en BD | `init-secrets.sh`, compose `secrets:` | `.env` 0644 en host (TD-060) | P3 | S | No |
| Superficie de red | Sólo gateway publica 80/443; redes `internal`; `bot-control` con subred fija | `docker-compose.yml:100-112,1197-1245` | `/version` en :80 (SEC-09) | P3 | S | No |
| Cabeceras / CORS | CORS restringido a un origen en la API; la SPA NO lleva cabeceras | `middleware/context.ts:26-51`; `web/nginx.conf`; `gateway/nginx.conf` | SEC-01 | P2 | S | Condición |
| WebSocket espectador | Ticket de un uso por subprotocolo, audiencia firmada, `maxPayload`, tope de clientes | `spectate/gateway.ts` | Comprobación de `Origin` (no vista) | P3 | S | No |
| Privacidad de datos | Perfil público sin email; loadout y fuente sólo dueño/equipo/staff; TD-047 cerrada | `serialize.ts`, `routes/bots.ts` | Enumeración por email (SEC-06) | P3 | M | No |
| Seguridad por defecto | Ver §8 | `init-secrets.sh`, `.env.example` | SEC-02 | — | — | — |
| Dependencias | `npm audit` + Trivy fs en CI; una excepción dev-only con caducidad | `ci.yml:855-885`, `npm-audit-excepciones.json` | Escaneo de imágenes (SEC-05) | P2 | M | Condición |
| Workflows GitHub | Sin `pull_request_target`; push a GHCR sólo en main; permisos por job | `.github/workflows/*` | SEC-11 | P3 | S | No |

## 4. Fortalezas y debilidades

Fortalezas (cada una verificada en código):
- Ningún servicio monta `docker.sock`; lo impone un escáner de compose en CI (job `scan` en success en el run 44383512640). El proxy del host sólo permite crear/arrancar/parar/inspeccionar/borrar/listar con imagen del `DIGESTS.lock`, ids completos, labels `s9.*` impuestas por el proxy y cliente por IP de socket (`docker-proxy.ts:1-100`).
- El create exige límites de CPU, memoria y pids con techo, `MemorySwap == Memory`, usuario no root, `CapDrop ALL`, rootfs de sólo lectura, `/tmp` noexec, DNS `0.0.0.0` y una sola red (`docker-proxy.ts:316-450,926-936`; `compliance.mjs`). Seccomp por allowlist sin ptrace, mount, bpf, unshare, etc. (`seccomp-bot.json`).
- El build del bot ya no ocurre en la API: la API sólo encola (`QueueBotManager`); el worker corre el sandbox y firma el artefacto (ed25519); el worker de batallas lo verifica con la clave pública.
- Anti-enumeración en login (hash señuelo) y reutilización de refresh revoca la familia con auditoría.
- Tickets de espectador con secreto, issuer y audiencia distintos del de sesión, de un solo uso, fuera de la URL.
- Pruebas calibradas con mutaciones para el proxy, el firewall y el gateway de replays (p. ej. `infrastructure/gateway/tests/replay-gateway.test.ts`); que existan no las hace TEST_VERIFIED aquí: corren en el job de tests de CI, pero no las he ejecutado ni visto en rojo.

Debilidades: ver hallazgos. En resumen, la capa web (cabeceras), el ciclo de vida de cuentas, la separación de privilegios del anfitrión de bots y el escaneo de imágenes.

## 5. Hallazgos

### SEC-01 · La SPA se sirve sin ninguna cabecera de seguridad
- Área: Cabeceras / web · Severidad: P2 · Tipo: DEFECTO_CONFIRMADO · Grupo: B
- Descripción e impacto: el nginx del contenedor `web` sólo añade `Content-Type` y `Cache-Control`; el gateway añade sólo HSTS. La API sí emite CSP restrictiva, `nosniff`, `X-Frame-Options: DENY` y `no-referrer`, pero esas cabeceras no cubren el HTML/JS de la SPA. Consecuencia: la consola de administración y el editor de bots se pueden enmarcar (clickjacking) y no hay defensa en profundidad si apareciera un XSS (el código de bots, nombres y mapas se renderizan en la web). Afecta a administradores y programadores.
- Evidencia: `infrastructure/docker/web/nginx.conf` (`add_header` sólo en líneas 58, 66, 72, 87, ninguna de seguridad); `infrastructure/gateway/nginx.conf:88` (sólo HSTS); `nginx-behind-proxy.conf:60,71`. CODE_VERIFIED. No he comprobado si el proxy externo del modo real añade cabeceras (fase 2).
- Reproducción: `curl -sI https://<dominio>/` y comprobar ausencia de CSP, XFO, nosniff.
- Causa probable: el hardening de R1.8/R2.6 se hizo en la API y se asumió para todo.
- Solución: en el gateway `add_header ... always` con CSP (default-src 'self'; connect-src con el origen WS; frame-ancestors 'none'; el visor/streamer necesitan su excepción para `/broadcast`), `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`; test sobre la conf real como el de replays.
- Esfuerzo: S (CSP del visor/Phaser puede subir a M) · incertidumbre media
- Dependencias: `/broadcast` lo carga el Chromium del streamer por la red interna. Validar tras el cambio con navegador real (job `golden`).

### SEC-02 · Registro abierto con rol `developer`, sin verificación de email ni interruptor
- Área: Autenticación · Severidad: P2 (histórica P1 en TD-012) · Tipo: RIESGO · Grupo: B
- Descripción e impacto: cualquiera crea una cuenta que ya puede subir código y encolar builds en el sandbox. Los límites existen (30 registros/min/IP, 60 versiones/h por usuario, límites por contenedor), pero no hay forma de cerrar o acotar el alta en una instalación pública: abuso de cómputo y de cola de builds, cuentas de usuario desechables, y nada impide registrar el email de otra persona. Para un tercero que instale el producto, ésta es la principal puerta abierta por defecto.
- Evidencia: `apps/api/src/routes/auth.ts:147-175` (sin flag; inserta `user` y `developer`). No existe verificación de email (no hay transporte: `git grep -niE "nodemailer|smtp|sendMail" -- apps packages` vacío según TD-012; no lo he repetido). CODE_VERIFIED.
- Ruta de explotación concreta: bucle de registro desde varias IPs + `POST` de versiones de bot hasta saturar `jobs`/sandbox. No medido.
- Solución: interruptor `REGISTRATION_MODE=open|invite|closed` en runtime-settings (ya existe `RuntimeSettingsStore`), por defecto `invite` o `closed` en instalaciones nuevas; el rol `developer` tras aceptar términos o por invitación; cuota global de builds en cola por usuario.
- Esfuerzo: M · incertidumbre baja
- Dependencias: necesita canal de email para verificar (SEC-03). Validación: test de contrato con modo cerrado y mutación.

### SEC-03 · Gestión de cuenta incompleta: sin cambio de contraseña y recuperación sin transporte
- Área: Autenticación · Severidad: P2 · Tipo: FALTA · Grupo: B
- Descripción: `POST /auth/recover` crea el token de reset y lo descarta (no hay envío), así que un usuario que olvida la contraseña no tiene salida; tampoco existe cambio de contraseña. No hay pantallas de 2FA, sesiones ni recuperación en la web. Impacto: usuarios externos bloqueados y el operador forzado a tocar la BD.
- Evidencia: `routes/auth.ts:392-440` (`createPasswordReset`: «el transporte real sería email; en dev se loguea»). CODE_VERIFIED. Revalida TD-012.
- Solución: cambio de contraseña con reautenticación (ya existe `requireStrongReauth`), canal de email o, como mínimo, reset asistido por admin con auditoría; pantallas.
- Esfuerzo: M-L · incertidumbre media (depende de decidir el canal de email)
- Dependencias: SEC-02.

### SEC-04 · El anfitrión de sesiones de bots (con credenciales de BD) comparte red con los bots
- Área: Aislamiento · Severidad: P2 (histórica P1 en TD-033) · Tipo: RIESGO · Grupo: C
- Descripción: `tournament-worker` y `bot-build-worker` están en `data` (credenciales de PostgreSQL) y en `arena`, donde abren puertos efímeros del protocolo con token y, el worker, el gateway de espectador (8081). El contenedor del bot sólo está en `arena`, así que alcanza esos puertos y, por la misma red, a otros contenedores de bots. Un fallo de análisis en el servidor de protocolo (WS) desde un bot daría ejecución en un proceso con acceso a la BD y a `jwt_secret`.
- Evidencia: `docker-compose.yml:360` (`networks: [platform, data, arena, bot-control]`), `:535`; `secrets: [postgres_password, jwt_secret, artifact_verify_key]` en el worker. CODE_VERIFIED. No hay ruta de explotación conocida: es una hipótesis de encadenamiento, por eso baja de P1 a P2. Mitigaciones reales: `maxPayload`, validación contra esquema de envelope, tokens por sesión.
- Solución: separar el anfitrión de la sesión (protocolo + artefacto) en un proceso sin credenciales, o ICC desactivado/reglas por puerto en `arena`; test de compose.
- Esfuerzo: L · incertidumbre alta
- Nota TD-043: el worker monta `jwt_secret` y el secreto del ticket se deriva por HKDF del de sesión (`tokens.ts:96-100`), pero ese mismo proceso ya tiene la contraseña de BD (con la que podría insertar sesiones), por lo que el secreto dedicado aporta poco aislado: P2 → P3.

### SEC-05 · Imágenes de servicio sin escaneo y con herramientas de desarrollo (TD-031 sigue abierta)
- Área: Dependencias / imágenes · Severidad: P2 (histórica P1) · Tipo: DEUDA · Grupo: B
- Descripción: la base `node:22.15-alpine` va por tag, no por digest (a diferencia de redis, postgres y los runtimes de bots); `npm ci --ignore-scripts` sin `--omit=dev` deja devDependencies y el CLI de npm en las seis imágenes Node; ningún job escanea imágenes de servicio (sólo `fs` del árbol y los runtimes de bots). TD-031 midió 74 hallazgos HIGH/CRITICAL con fix (2026-10-16): no lo he re-medido.
- Evidencia: `infrastructure/docker/node-service/Dockerfile:9` y `RUN npm ci --ignore-scripts`; `.github/workflows/ci.yml:878-880` (único `scan-type` es `fs`); `git grep -- "--omit"` en `infrastructure/docker` vacío. CODE_VERIFIED. Sin ruta de explotación demostrada (las librerías afectadas son del CLI de npm y de la base, no de código de servicio), de ahí P2.
- Solución: base fijada por digest y reciente; etapa final con `--omit=dev`; job de Trivy sobre las imágenes construidas con control negativo.
- Esfuerzo: M · incertidumbre media

### SEC-06 · Oráculo de cuentas por email
- Área: Privacidad · Severidad: P3 (histórica P2, TD-041) · Tipo: DEFECTO_CONFIRMADO · Grupo: C
- Descripción: `POST /auth/register` responde 409 `email_taken`, y `POST /teams/{id}/members` distingue 201 de «Usuario no encontrado»; además el alta es inmediata y sin consentimiento, y da lectura del código de los bots del equipo al invitado. Permite enumerar emails registrados y añadir a terceros a un equipo.
- Evidencia: `routes/auth.ts:158-160`, `routes/teams.ts:192-200`. CODE_VERIFIED. Baja a P3: el impacto es privacidad de bajo valor en un producto con registro abierto (el atacante puede crear cuenta y probar igualmente), sin salto de privilegios.
- Solución: invitaciones aceptadas por el invitado; mensaje uniforme.
- Esfuerzo: M · incertidumbre baja

### SEC-07 · Hardening de contenedores desigual y Redis sin autenticación
- Área: Privilegios · Severidad: P3 · Tipo: DEUDA · Grupo: C
- Descripción: sólo `streamer` y `bot-runtime-template` usan `cap_drop: [ALL]`, y sólo la plantilla del bot tiene `read_only: true`; el resto sólo `no-new-privileges`. Los servicios Node arrancan como root un instante y bajan a `node` por `su-exec`. Redis (`queue`) no tiene contraseña y vive en `platform`, red que comparten gateway, web, API y workers. Sin ruta de explotación concreta: es reducción de superficie ante un compromiso previo.
- Evidencia: `docker-compose.yml` (`grep -n cap_drop` → líneas 834, 861; `read_only: true` → 125 [volumen], 859); `:664-698`. CODE_VERIFIED.
- Solución: `cap_drop: ALL`, `read_only` + tmpfs donde sea viable, `requirepass` desde secreto.
- Esfuerzo: M · incertidumbre media (cada servicio exige prueba)

### SEC-08 · Secreto TOTP en claro en la base de datos
- Área: Autenticación · Severidad: P3 · Tipo: HIPÓTESIS · Grupo: C
- Descripción: `users.totp_secret` es `text` y se compara directo; los códigos de recuperación sí se guardan hasheados (sha256). Una fuga de BD (p. ej. backup) permitiría generar TOTP de todos los usuarios con 2FA. No he mirado si hay cifrado a nivel de columna o de disco.
- Evidencia: `db/migrations.ts:43`, `routes/auth.ts:126-128,210-212,348`. CODE_VERIFIED para el almacenamiento en claro.
- Solución: cifrar con clave derivada de un secreto de aplicación. Esfuerzo S-M · incertidumbre baja

### SEC-09 · `/version` servido en el puerto 80 publicado
- Área: Superficie de red · Severidad: P3 · Tipo: HIPÓTESIS · Grupo: C
- Descripción: el comentario del gateway dice que `/version` es «sólo LAN/red interna», pero el servidor de :80 está publicado en todas las interfaces (`HTTP_PORT:80`). Expone commit y fecha de build. Depende del firewall perimetral y del modo (en el modo con proxy externo puede no ser alcanzable).
- Evidencia: `gateway/nginx.conf:55-68`, `docker-compose.yml:110-112`. CODE_VERIFIED el diseño; alcance real UNKNOWN. Solución: `allow` por red o ligar el puerto 80 a la LAN. Esfuerzo S · incertidumbre media

### SEC-10 · Sin límites a nivel de gateway; punto de fallo de `TRUST_PROXY_HOPS`
- Área: Rate limiting · Severidad: P3 · Tipo: RIESGO · Grupo: C
- Descripción: nginx no tiene `limit_req`/`limit_conn` (ni para `/grafana/`, `/ws/` o la web); toda la limitación está en la API y es por IP. El valor por defecto es 1 salto; en el modo detrás de proxy externo hacen falta 2, si no todos los clientes comparten IP y el bloqueo de 20 fallos pasa a ser global (DoS de login). `POST /auth/reset` no tiene limitador propio (el token de 24 bytes lo hace inviable por fuerza bruta).
- Evidencia: `gateway/nginx.conf` (sin `limit_`), `docker-compose.yml:193`, `middleware/proxy-trust.ts`, `routes/auth.ts:405-409`. CODE_VERIFIED; valor real en producción UNKNOWN (TD-012).
- Solución: `limit_req` en `/api/v1/auth/` y `/grafana/login`; preflight que compruebe los saltos. Esfuerzo S · incertidumbre baja

### SEC-11 · Workflows: acciones por tag mutable y permisos del token por defecto sin fijar
- Área: CI · Severidad: P3 · Tipo: DEUDA · Grupo: C
- Descripción: `ci.yml` no declara `permissions:` a nivel de workflow (sólo `build-images` y `semaforo` lo hacen); los demás jobs heredan el valor del repo, que no he podido ver. Las acciones van por tag (`@v4`, `trivy-action@v0.36.0`), sin SHA ni Dependabot. Lo positivo: no hay `pull_request_target`, el login y push a GHCR sólo ocurre en main, y `STAGING_HOST` se usa como secreto sólo en jobs de main.
- Evidencia: `.github/workflows/*.yml`; no existe `.github/dependabot.yml`. CODE_VERIFIED; configuración del repo UNKNOWN.
- Solución: `permissions: contents: read` global, fijar por SHA, Dependabot para actions. Esfuerzo S

### SEC-12 · Secreto JWT sin longitud mínima ni procedimiento de rotación
- Área: Autenticación · Severidad: P3 · Tipo: FALTA · Grupo: C
- Descripción: `resolveSecret` sólo exige no vacío; `init-secrets.sh` genera 40 caracteres, pero un valor manual corto se acepta. No hay `kid` ni doble clave: rotarlo invalida todas las sesiones (y los tickets, derivados por HKDF). Aceptable para un único nodo, pero sin runbook.
- Evidencia: `auth/tokens.ts:48-80`. CODE_VERIFIED. Solución: longitud mínima (≥32) al arrancar y documentar la rotación. Esfuerzo S

### SEC-13 · Topología interna en el repositorio público (TD-008)
- Área: Repo público · Severidad: P3 (histórica P0) · Tipo: DEUDA · Grupo: C
- Descripción: sin secretos ni credenciales. Lo que queda fuera de `docs/history`: una IP de la red local y nombres de máquinas virtuales en el comentario de cabecera de `infrastructure/gateway/nginx-behind-proxy.conf` (líneas 3-4), el dominio público de producción como valor por defecto de `S9_DOMAIN` y comentarios en `infrastructure/.env.example`, y referencias a hosts/VM en `docs/operations/firewall.md`, scripts de firewall y tests. Un recuento de `git grep` por nombres de VM y host devuelve decenas de ficheros (no he repetido la cifra exacta de TD-008). Revalidación: la IP de red privada en un repo público facilita poco el reconocimiento sin acceso a la red local; el dominio ya es público por definición. P0 → P3. El historial git conserva todo lo anterior.
- Evidencia: `git grep` sobre 8f380eb. CODE_VERIFIED. Sin gate de CI que parsee direcciones (el test `NO_INTERNAL_TOPOLOGY` sólo mira docs).
- Solución: sustituir por valores de documentación, gate por parseo, decidir si purgar historial. Esfuerzo M · incertidumbre media

### SEC-14 · `cli.ts seed` crea cuentas de desarrollo (incluida `admin`) con contraseña pública
- Área: Seguridad por defecto · Severidad: P3 · Tipo: RIESGO · Grupo: C
- Descripción: `seed` crea un usuario por rol, incluido admin, con contraseña fija del repo y sin guarda por entorno; sólo lo advierten comentarios y `first-run.md`. Un operador que lo ejecute en una instalación real deja un admin conocido. El comando apto es `bootstrap`.
- Evidencia: `apps/api/src/db/cli.ts:9-14,63-65`, `db/seeds/dev.ts:27,79-86`; `docs/operations/first-run.md:142`. CODE_VERIFIED.
- Solución: negarse a correr si `DATABASE_URL` no es local o falta `--i-know`; test. Esfuerzo S

## 6. Deuda técnica: revalidación contra el código de 8f380eb

| TD | Estado registrado | Estado revalidado | Prioridad | Motivo |
|---|---|---|---|---|
| TD-004 replays a anónimos | CERRADA | Confirmada en código | — | `gateway/nginx.conf` devuelve 404 en `/replays*`; la API autoriza |
| TD-008 topología | ABIERTA P0 | ABIERTA | P0 → P3 | SEC-13 |
| TD-012 autenticación | ABIERTA P1 | ABIERTA | P1 → P2 | SEC-02, SEC-03, SEC-10; el defecto de «IP colapsada» depende del valor real de saltos (UNKNOWN) |
| TD-031 imágenes | ABIERTA P1 | ABIERTA, confirmada en Dockerfile | P1 → P2 | SEC-05; sin ruta de explotación |
| TD-033 anfitrión con BD en `arena` | ABIERTA P1 | ABIERTA | P1 → P2 | SEC-04 |
| TD-041 oráculo de emails | ABIERTA P2 | ABIERTA | P2 → P3 | SEC-06 |
| TD-043 `jwt_secret` en worker | ABIERTA P2 | ABIERTA | P2 → P3 | SEC-04 (nota) |
| TD-048 `NODE_ENV` sin fijar | ABIERTA P2 | ABIERTA, sin cambios (no lo reexaminé) | P2 | Sólo afecta a un guard menor |
| TD-051/052/053/061/062 proxy y sandbox | CERRADAS | Código conforme; falta ver el host | — | `docker-proxy.ts`, firewall como código; TEST_VERIFIED sólo por el job `container-proxy-e2e` del run 44383512640 |
| TD-060 `.env` 0644 | ABIERTA P2 | No verificable sin host | P2 → P3 | Requiere acceso local al host |
| TD-063 escuchas del host | ABIERTA P3 | UNKNOWN | P3 | Medir en fase 2 |
| TD-047 bots privados en batallas | CERRADA | Sin hallazgos en muestreo | — | Cubierto por tests, no ejecutados por mí |

Deuda nueva no registrada: SEC-01, SEC-07 (Redis), SEC-08, SEC-09, SEC-11, SEC-12, SEC-14.

Excepción de `npm audit` (GHSA-fc5q-39xc-vjpf, picomatch ≤ 4.0.7): `infrastructure/npm-audit-excepciones.json`, alta 2026-11-17, caduca 2026-12-17 (en 28 días desde hoy). El motivo declarado (sólo herramientas de desarrollo, sin código de servicio) es coherente con el lockfile (picomatch lo piden vite, vitest y herramientas de build) y `scan-gate.mjs` carga el lockfile para acotarla y compara la fecha de hoy; el run de CI de 8f380eb tiene `scan` en success. Riesgo operativo: si no sale versión corregida antes del 17-12, el job `scan` se pone rojo y bloquea todos los PR; prever renovar con motivo o sustituir la dependencia (P3, sin hallazgo propio). No verifiqué en esta fase que `npm audit` hoy diga lo mismo.

## 7. Verificaciones para FASE 2

| # | Qué | Comando / prueba | Entorno | Confirma / refuta |
|---|---|---|---|---|
| 1 | Cabeceras de la SPA (SEC-01) | `curl -sI https://<dominio>/` y `/api/v1/healthz` | Producción sólo lectura | Confirma si faltan CSP, XFO, nosniff; refuta si el proxy externo las añade |
| 2 | Firewall del host aplicado | `s9-firewall.sh check` (rc 0 = conforme) y `iptables -S S9-HOST-GUARD` | Producción sólo lectura | rc 0 y cadena primera en INPUT confirman TD-053 en host |
| 3 | Alcance del proxy desde un contenedor ajeno | Desde un contenedor de `public` (p. ej. el gateway): conectar a la IP del proxy:2375 | Laboratorio aislado | Timeout o 403 confirma; respuesta 200 refuta |
| 4 | Sandbox real | Subir un bot de prueba que intente: `connect` a otro contenedor de `arena`, resolver DNS, escribir fuera de `/tmp`, `fork` bomb, `mmap` exec en `/tmp` | Laboratorio aislado | Todos denegados dentro de los límites confirma el sandbox; cualquier conexión a `tournament-worker` distinta del protocolo refuta SEC-04 como mitigado |
| 5 | Alcance de bots hacia el anfitrión (SEC-04) | `nc -zv tournament-worker 8081` y puertos efímeros desde un bot | Laboratorio | Si conecta, SEC-04 es real y medible |
| 6 | Valor de `TRUST_PROXY_HOPS` y bloqueo global | 21 logins fallidos de una IP y probar login desde otra | Laboratorio con la misma topología | Si la segunda IP también se bloquea, el salto es erróneo (SEC-10) |
| 7 | Atributo `Secure` de la cookie de refresh tras el proxy | `curl -si -X POST .../auth/login` y revisar `Set-Cookie` | Laboratorio | `Secure` presente confirma; ausente es defecto |
| 8 | Permisos de `.env` y `secrets/` | `stat -c '%a %U' infrastructure/.env infrastructure/secrets` | Producción sólo lectura | 600/700 refuta TD-060 |
| 9 | Hallazgos de imágenes (SEC-05) | `trivy image --severity HIGH,CRITICAL --ignore-unfixed` sobre las imágenes desplegadas | Laboratorio | Cuenta actual frente a 74 |
| 10 | `/version` en :80 (SEC-09) | `curl -s http://<host>:80/version` desde fuera de la LAN | Producción sólo lectura | Respuesta con commit confirma |
| 11 | Matriz de roles | `npx vitest run apps/api/src/rbac-matrix.test.ts` y probar a mano IDOR con dos cuentas (bots, equipos, torneos) | Laboratorio | Rc 0 y ningún acceso cruzado |
| 12 | Permisos del token en Actions y protección de rama | `gh api repos/pjclavero/s9-ai-arena/actions/permissions/workflow` | Sólo lectura de GitHub | `default_workflow_permissions: read` confirma |
| 13 | Origen en el WS de espectador | Conectar al WS con `Origin` ajeno y ticket válido | Laboratorio | Si abre, falta la comprobación (P3) |
| 14 | Estado real de `npm audit` y caducidad | `npm audit --json` en lab | Laboratorio | Que picomatch siga siendo la única excepción |

## 8. Respuestas cortas a las preguntas del brief

- ¿JWT: secreto, expiración, rotación, almacenamiento? Secreto por fichero (falla cerrado, sin longitud mínima); access 15 min en memoria; refresh opaco rotado por familia en cookie httpOnly; sin rotación de la clave de firma (SEC-12).
- ¿Registro abierto? Sí, con rol `developer`, sin verificación ni interruptor (SEC-02).
- ¿Política de contraseñas y rate limiting? Mínimo 12 caracteres con Argon2id; límites compartidos en BD y bloqueo a 20 fallos; sólo en la API, por IP (SEC-10).
- ¿Autorización/IDOR? Guard por rango del contrato y comprobaciones de dueño/equipo/staff (staff = moderador o superior, que lee código de cualquier bot). No hallé IDOR en el muestreo; falta ejecutar la matriz (fase 2, #11).
- ¿Aislamiento del código no confiable? Conforme en diseño y con E2E en CI; riesgo residual SEC-04.
- ¿Qué permite el docker-proxy? Crear (con imagen de DIGESTS.lock y límites), arrancar, parar, inspeccionar, ver `stats` puntuales, borrar y listar sólo contenedores propios; lo demás 403.
- ¿Algún servicio con `docker.sock`? Ninguno, y el escáner de compose lo hace cumplir en CI.
- ¿Secretos? Por fichero, aleatorios, sin commits; `.env` 0644 en el host (TD-060, sin verificar); `stream_key` guardada sellada con RSA; clave de emisión en argv de FFmpeg según TD-066 (no revisado).
- ¿Puertos expuestos? Sólo 80/443 del gateway; firewall del host como código para el proxy y sshd.
- ¿Exposición de datos privados? Perfil público sin email, código y loadout sólo dueño/equipo/staff, replays autorizados por la API, espectador con audiencias proyectadas. Fuga detectada: oráculo de emails (SEC-06).
- ¿Qué queda abierto si un tercero instala con valores por defecto? Registro libre con rol `developer` (SEC-02), SPA sin cabeceras (SEC-01), `/version` posiblemente (SEC-09), Redis sin contraseña dentro de la red de plataforma (SEC-07), y `cli.ts seed` como trampa (SEC-14). Cerrado por defecto: ejecución real de batallas, espectador y replays públicos, métricas, DOCKER_PROXY_URL vacío.
- ¿Dependencias/imágenes y excepción picomatch? SEC-05 y §6.
- ¿Workflows? Sin `pull_request_target`; permisos por defecto y SHAs sin fijar (SEC-11).
