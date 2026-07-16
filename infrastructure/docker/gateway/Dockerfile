# Gateway Nginx (dosier 6.2). Contexto de build: raíz del repo.
FROM nginx:1.27-alpine

# Config por defecto: modo standalone (TLS en el gateway). El Compose puede
# montar nginx-behind-proxy.conf encima (GATEWAY_CONF, docs/despliegue.md).
COPY infrastructure/gateway/nginx.conf /etc/nginx/nginx.conf

HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:80/healthz || exit 1
