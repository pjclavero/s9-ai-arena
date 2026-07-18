# Despliegue del dominio — S9 AI Arena

> Estado verificado: 2026-07-18. Ver [`ESTADO_ACTUAL.md`](ESTADO_ACTUAL.md).

## 1. Dominio correcto

- ✅ **`s9arena.seccionnueve.duckdns.org`** — este proyecto (VM108).
- ⛔ **`arena.seccionnueve.duckdns.org`** — **NO usar**. Es **otro proyecto** y ya está en uso;
  su vhost en VM104 proxya a **VM107** (`192.168.1.207:8080`). No modificar ese vhost.

> Cualquier documento que diga `arena.seccionnueve.duckdns.org` para S9 AI Arena está
> **desactualizado** (p. ej. `docs/despliegue.md`, corregido en este cambio). El correcto es
> `s9arena.…`.

## 2. Flujo de tráfico

```
Internet
  │  HTTPS (443)  →  s9arena.seccionnueve.duckdns.org  (DuckDNS → IP público 207.188.136.103)
  ▼
VM104  192.168.1.204   (Nginx, termina TLS con wildcard *.seccionnueve.duckdns.org)
  │  HTTP  proxy_pass  http://192.168.1.208:8080
  ▼
VM108  192.168.1.208   (gateway del stack v2, único puerto expuesto: 8080→80 / 8443→443)
  │  enruta por prefijo
  ├─ /            → web  (SPA)
  ├─ /api/v1/     → api
  ├─ /ws/         → tournament-worker (WebSocket espectador)
  └─ /replays/    → replay-service
```

## 3. Rutas HTTP

Todas cuelgan de `location /` en el vhost de VM104 → gateway de VM108, que reparte por prefijo
(ver tabla arriba). No hay que declarar cada ruta en VM104: el gateway decide.

## 4. Rutas WebSocket

El vhost de VM104 tiene un `location /ws/` dedicado con:
```nginx
location /ws/ {
    proxy_pass http://192.168.1.208:8080/ws/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```
El gateway de VM108 reenvía `/ws/` al `tournament-worker` (donde vive la simulación y el canal
de espectador). Verificación: `GET /ws/` sin cabeceras devuelve **426 Upgrade Required**.

## 5. Puertos que expone VM108 (solo interno a la LAN)

- `8080` → 80 del gateway. `8443` → 443 del gateway. **Nada más.**
- No se abre ningún puerto en el router: el acceso público entra **solo** por VM104 (443).
- Acceso directo a `:8080` disponible en LAN y Tailscale para diagnóstico.

## 6. Validación de TLS

```bash
# Certificado wildcard servido para el subdominio:
echo | openssl s_client -connect 192.168.1.204:443 \
  -servername s9arena.seccionnueve.duckdns.org 2>/dev/null \
  | openssl x509 -noout -subject -dates
```
Debe mostrar el certificado `*.seccionnueve.duckdns.org` vigente.

## 7. Validación de Nginx (VM104)

```bash
nginx -t                                   # syntax OK
curl -s -o /dev/null -w '%{http_code}\n' \
  --resolve s9arena.seccionnueve.duckdns.org:443:127.0.0.1 \
  https://s9arena.seccionnueve.duckdns.org/healthz    # -> 200
systemctl reload nginx                     # recarga sin cortar (solo tras nginx -t OK)
```

## 8. Rollback del virtual host

- Copia previa: `/root/s9arena-vhost-v1-backup-20260717.conf` (config v1 del vhost).
- Restaurar:
  ```bash
  cp /root/s9arena-vhost-v1-backup-20260717.conf \
     /etc/nginx/sites-available/s9arena.seccionnueve.duckdns.org.conf
  nginx -t && systemctl reload nginx
  ```
- **Nunca** tocar `arena.seccionnueve.duckdns.org.conf` (otro proyecto).
