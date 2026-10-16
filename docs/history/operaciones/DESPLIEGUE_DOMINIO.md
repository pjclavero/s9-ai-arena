# Despliegue del dominio — S9 AI Arena

> Estado verificado: 2026-07-18. Ver [`ESTADO_ACTUAL.md`](../status/ESTADO_ACTUAL.md).

## 1. Dominio correcto

- ✅ **`arena.example.internal`** — este proyecto (<host-arena>).
- ⛔ **`otro-proyecto.example.internal`** — **NO usar**. Es **otro proyecto** y ya está en uso;
  su vhost en <proxy-host> proxya a **<host-otro-proyecto>** (`192.0.2.7:8080`). No modificar ese vhost.

> Cualquier documento que diga `otro-proyecto.example.internal` para S9 AI Arena está
> **desactualizado** (p. ej. `docs/despliegue.md`, corregido en este cambio). El correcto es
> `s9arena.…`.

## 2. Flujo de tráfico

```
Internet
  │  HTTPS (443)  →  arena.example.internal  (DNS dinámico → IP público 203.0.113.10)
  ▼
<proxy-host>  192.0.2.4   (Nginx, termina TLS con wildcard *.example.internal)
  │  HTTP  proxy_pass  http://192.0.2.10:8080
  ▼
<host-arena>  192.0.2.10   (gateway del stack v2, único puerto expuesto: 8080→80 / 8443→443)
  │  enruta por prefijo
  ├─ /            → web  (SPA)
  ├─ /api/v1/     → api
  ├─ /ws/         → tournament-worker (WebSocket espectador)
  └─ /replays/    → replay-service
```

## 3. Rutas HTTP

Todas cuelgan de `location /` en el vhost de <proxy-host> → gateway de <host-arena>, que reparte por prefijo
(ver tabla arriba). No hay que declarar cada ruta en <proxy-host>: el gateway decide.

## 4. Rutas WebSocket

El vhost de <proxy-host> tiene un `location /ws/` dedicado con:
```nginx
location /ws/ {
    proxy_pass http://192.0.2.10:8080/ws/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```
El gateway de <host-arena> reenvía `/ws/` al `tournament-worker` (donde vive la simulación y el canal
de espectador). Verificación: `GET /ws/` sin cabeceras devuelve **426 Upgrade Required**.

## 5. Puertos que expone <host-arena> (solo interno a la LAN)

- `8080` → 80 del gateway. `8443` → 443 del gateway. **Nada más.**
- No se abre ningún puerto en el router: el acceso público entra **solo** por <proxy-host> (443).
- Acceso directo a `:8080` disponible en LAN y Tailscale para diagnóstico.

## 6. Validación de TLS

```bash
# Certificado wildcard servido para el subdominio:
echo | openssl s_client -connect 192.0.2.4:443 \
  -servername arena.example.internal 2>/dev/null \
  | openssl x509 -noout -subject -dates
```
Debe mostrar el certificado `*.example.internal` vigente.

## 7. Validación de Nginx (<proxy-host>)

```bash
nginx -t                                   # syntax OK
curl -s -o /dev/null -w '%{http_code}\n' \
  --resolve arena.example.internal:443:127.0.0.1 \
  https://arena.example.internal/healthz    # -> 200
systemctl reload nginx                     # recarga sin cortar (solo tras nginx -t OK)
```

## 8. Rollback del virtual host

- Copia previa: `/root/s9arena-vhost-v1-backup-20260717.conf` (config v1 del vhost).
- Restaurar:
  ```bash
  cp /root/s9arena-vhost-v1-backup-20260717.conf \
     /etc/nginx/sites-available/arena.example.internal.conf
  nginx -t && systemctl reload nginx
  ```
- **Nunca** tocar `otro-proyecto.example.internal.conf` (otro proyecto).
