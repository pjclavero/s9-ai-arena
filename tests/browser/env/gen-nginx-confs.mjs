/**
 * FC-D · E2E de navegador — genera las confs nginx del entorno aislado A PARTIR
 * DE LAS REALES del repo, sin reescribirlas a mano:
 *
 *  - gateway: infrastructure/gateway/nginx-behind-proxy.conf (modo real del
 *    homelab: TLS fuera, gateway en http). Sólo se sustituyen los nombres de
 *    servicio Docker por 127.0.0.1:<puerto> y el `listen`; TODAS las `location`
 *    (incluidas /replays, /replays/, /ws/, /api/v1/) son las del repo.
 *  - web: infrastructure/docker/web/nginx.conf (estáticos + fallback de SPA).
 *  - tls: proxy TLS delante del gateway, en el papel del proxy inverso externo
 *    (termina TLS y reenvía en http con X-Forwarded-Proto https).
 *
 * Cada sustitución se EXIGE: si la conf real cambia y un patrón deja de
 * aparecer, el generador falla en vez de producir un entorno que ya no imita
 * al real.
 *
 * Uso: node gen-nginx-confs.mjs <repo> <outDir> <apiPort> <wsPort> <replayPort> <webPort> <gwPort> <tlsPort>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [repo, out, api, ws, replay, web, gw, tls] = process.argv.slice(2);
if (!tls) {
  console.error("uso: gen-nginx-confs.mjs <repo> <outDir> <api> <ws> <replay> <web> <gw> <tls>");
  process.exit(2);
}

function must(src, from, to, label) {
  if (!src.includes(from)) throw new Error(`gen-nginx-confs: no aparece «${from}» (${label}); la conf real cambió`);
  return src.split(from).join(to);
}

let g = readFileSync(join(repo, "infrastructure/gateway/nginx-behind-proxy.conf"), "utf8");
g = must(g, "listen 80;", `listen 127.0.0.1:${gw};`, "listen del gateway");
g = must(g, "resolver 127.0.0.11 valid=10s ipv6=off;", "# resolver: no hace falta con upstreams IP", "resolver Docker");
g = must(g, "http://api:8080", `http://127.0.0.1:${api}`, "upstream api");
g = must(g, "http://tournament-worker:8081", `http://127.0.0.1:${ws}`, "upstream ws");
g = must(g, "http://replay-service:8083", `http://127.0.0.1:${replay}`, "upstream replays");
g = must(g, "http://web:3000", `http://127.0.0.1:${web}`, "upstream web");
g = must(g, "http://grafana:3000", "http://127.0.0.1:9", "upstream grafana (sin uso)");
g = g.replace("events {", "pid /tmp/s9-e2e-gw.pid;\nevents {");
writeFileSync(join(out, "gateway.conf"), g);

let w = readFileSync(join(repo, "infrastructure/docker/web/nginx.conf"), "utf8");
w = must(w, "listen 3000;", `listen 127.0.0.1:${web};`, "listen del web");
writeFileSync(join(out, "web.conf"), w);

const t = `# Proxy TLS del entorno E2E (papel del proxy inverso externo). Generado.
worker_processes 1;
pid /tmp/s9-e2e-tls.pid;
events { worker_connections 256; }
http {
  map $http_upgrade $connection_upgrade { default upgrade; "" close; }
  access_log /dev/stdout;
  server {
    listen 127.0.0.1:${tls} ssl;
    ssl_certificate /certs/tls.crt;
    ssl_certificate_key /certs/tls.key;
    location / {
      proxy_pass http://127.0.0.1:${gw};
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto https;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;
      proxy_read_timeout 3600s;
      # Como un proxy externo real: NO reescribe Location. Si el gateway
      # devolviera un 301 a http://, llegaría tal cual al navegador.
      proxy_redirect off;
    }
  }
}
`;
writeFileSync(join(out, "tls.conf"), t);
console.log(JSON.stringify({ msg: "confs generadas", out }));
