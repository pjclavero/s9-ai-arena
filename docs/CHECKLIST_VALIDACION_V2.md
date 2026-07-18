# Checklist de validación — S9 AI Arena v2

> Rellenar "Resultado real / Fecha / Evidencia / Responsable / Estado" al ejecutar.
> Estado: ✅ pasa · ❌ falla · ⏳ pendiente · ⚠️ parcial.
> Contexto: [`ESTADO_ACTUAL.md`](ESTADO_ACTUAL.md) · Operación: [`OPERACION_VM108.md`](OPERACION_VM108.md).

Última pasada de referencia: **2026-07-18** (auditoría). Las pruebas 1-3, 7 y parte del dominio
se verificaron; el resto queda pendiente con su causa.

| # | Prueba | Comando / acción | Resultado esperado | Resultado real | Fecha | Evidencia | Responsable | Estado |
|---|---|---|---|---|---|---|---|---|
| 1 | Despliegue VM108 | `docker compose ps` (como `s9arena` en `infrastructure/`) | 7 servicios `Up (healthy)`, 0 reinicios | 7/7 healthy, 0 restarts | 2026-07-18 | `docker ps` auditoría | auditoría | ✅ |
| 2 | LAN | `curl -s -o /dev/null -w '%{http_code}' http://192.168.1.208:8080/healthz` | 200 | 200 | 2026-07-18 | auditoría | auditoría | ✅ |
| 3 | Tailscale | `curl … http://100.81.2.105:8080/healthz` | 200 | 200 | 2026-07-18 | auditoría | auditoría | ✅ |
| 4 | Dominio (externo) | Navegador desde Internet `https://s9arena.seccionnueve.duckdns.org/` | 200 + SPA | (loopback VM104 = 200; externo NO probado) | 2026-07-18 | sin hairpin NAT en host de auditoría | auditoría | ⚠️ |
| 5 | WebSocket | Handshake WS real a `wss://s9arena…/ws/` (o `ws://192.168.1.208:8080/ws/`) | 101 Switching Protocols + frames | `GET /ws/` → 426/301 (ruta OK), handshake real NO probado | 2026-07-18 | curl upgrade | auditoría | ⏳ |
| 6 | Visual navegador | Abrir `/` y comprobar render del panel + visor | Panel "S9 AI Arena" carga, sin errores de consola | HTML/título OK; render en navegador NO probado | 2026-07-18 | `curl /` (title) | — | ⏳ |
| 7 | Healthchecks | `docker inspect --format '{{.State.Health.Status}}'` en los 7 | todos `healthy` | 7/7 healthy | 2026-07-18 | auditoría | auditoría | ✅ |
| 8 | bot-manager | (tras desplegar) `curl http://<bot-manager>:PORT/healthz` | 200 | servicio NO desplegado (fuera de `nucleo`); entrypoint en PR #38 | — | — | — | ⏳ |
| 9 | map-service | (tras desplegar) `curl http://<map-service>:PORT/healthz` | 200 | servicio NO desplegado; entrypoint `src/main.ts` en PR #38 | — | — | — | ⏳ |
| 10 | bot-build-worker | servicio Compose arriba + firma de un paquete de bot | worker procesa build/análisis/firma | servicio NO existe en `main`; definido en PR #38 | — | — | — | ⏳ |
| 11 | docker-proxy | `systemctl status s9-docker-proxy` en VM108 | unidad activa (fuera de Compose) | unidad systemd definida en PR #38; NO instalada aún | — | — | — | ⏳ |
| 12 | Sandbox básica | suite de escape (7 vectores) con imagen de `runtimes/DIGESTS.lock` | 7/7 contenidos | probado VIVO 7/7 en R6.1 (no contra el stack de prod) | 2026-07-17 | `R6.1-runtimes-digests.md` | R6.1 | ✅* |
| 13 | Replay | generar y reproducir un replay determinista | replay reproducible + checksum | NO probado contra stack desplegado | — | — | — | ⏳ |
| 14 | Rollback | ensayo de `git checkout a5651ff` + rebuild (o snapshot) | vuelve a estado funcional | documentado, NO ensayado | — | — | — | ⏳ |
| 15 | Validación Compose | `docker compose --profile nucleo config -q` | sin errores | — | — | — | — | ⏳ |
| 16 | Nginx VM104 | `nginx -t` + `curl --resolve …/healthz` | OK + 200 | OK + 200 (loopback) | 2026-07-18 | auditoría | auditoría | ✅ |
| 17 | TLS | `openssl s_client -servername s9arena…` | cert `*.seccionnueve.duckdns.org` vigente | NO comprobado en detalle | — | — | — | ⏳ |
| 18 | Batalla real E2E | lanzar una batalla y ver el resultado en el visor | batalla simula, visor muestra, replay guarda | **NUNCA ejecutada contra prod** | — | — | — | ⏳ |

\* La sandbox se probó viva en R6.1, pero contra imágenes de `runtimes/`, no contra el stack
`nucleo` desplegado (que no incluye `bot-manager`).

## Notas de ejecución

- Ejecutar todo Docker/Compose **como `s9arena`**, nunca root.
- Para la prueba 4 (dominio externo) hace falta un equipo con salida a Internet distinta de la
  LAN, o probar desde un móvil con datos.
- Las pruebas 8-11 dependen del **merge de PR #38** y de un despliegue posterior.
- La prueba 18 es el gran pendiente funcional: cierra la duda de si la cadena
  bot→worker→motor→visor→replay funciona de verdad en el entorno desplegado.
