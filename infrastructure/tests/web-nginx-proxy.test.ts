/**
 * BROADCAST-PUBLIC-ACCESS (2026-11-12) · el servidor `web` enruta /api/v1/ y /ws/
 * como el gateway.
 *
 * Incidente real (VM108, RC9 7bddda9): con `S9_PUBLIC_SPECTATE_ENABLED=true`, una
 * batalla suelta `running` de dos bots públicos y la emisión ACTIVA, /broadcast se
 * quedó toda la batalla en «La batalla empieza en breve». El Chromium del streamer
 * carga `BROADCAST_URL=http://web:3000/broadcast` por la red interna, SIN pasar por
 * el gateway; su `GET /api/v1/battles/{id}` llegaba a ESTE nginx, caía en el
 * fallback de SPA (200 text/html, el index.html: lo registró el access log de web),
 * `res.json()` lanzaba y el director (apps/web/src/broadcast/director.ts, `tick`)
 * se tragaba el error y conservaba «waiting». La API, la política de acceso y el
 * flag estaban bien: por el gateway el mismo GET anónimo daba 200.
 *
 * Esto PARSEA la conf real (bloques y directivas, no texto suelto) y resuelve
 * rutas con la semántica de `location` de nginx (exacta `=` primero, si no el
 * prefijo más largo). Se pone ROJO con la conf anterior (sin las dos location).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const WEB_CONF = join(here, "..", "docker", "web", "nginx.conf");
const GATEWAY_CONF = join(here, "..", "gateway", "nginx-behind-proxy.conf");

interface Block {
  name: string;
  args: string[];
  directives: string[][];
  children: Block[];
}

/** Tokenizador/parser mínimo de nginx: comentarios, comillas, `;`, `{` y `}`. */
export function parseNginx(src: string): Block {
  const toks: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === "{" || c === "}" || c === ";") {
      toks.push(c);
      i++;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      toks.push(src.slice(i + 1, j));
      i = j + 1;
    } else {
      let j = i;
      while (j < src.length && !/[\s;{}]/.test(src[j]!)) j++;
      toks.push(src.slice(i, j));
      i = j;
    }
  }
  const root: Block = { name: "", args: [], directives: [], children: [] };
  const stack: Block[] = [root];
  let cur: string[] = [];
  for (const t of toks) {
    const top = stack[stack.length - 1]!;
    if (t === ";") {
      if (cur.length) top.directives.push(cur);
      cur = [];
    } else if (t === "{") {
      const b: Block = { name: cur[0] ?? "", args: cur.slice(1), directives: [], children: [] };
      top.children.push(b);
      stack.push(b);
      cur = [];
    } else if (t === "}") {
      if (cur.length) throw new Error(`directiva sin ';' antes de '}': ${cur.join(" ")}`);
      stack.pop();
      if (stack.length === 0) throw new Error("'}' de más");
    } else {
      cur.push(t);
    }
  }
  if (stack.length !== 1 || cur.length) throw new Error("conf nginx sin cerrar");
  return root;
}

function servers(b: Block): Block[] {
  return b.name === "server" ? [b] : b.children.flatMap(servers);
}

/** Server que escucha en `port` (el web: 3000; el gateway behind-proxy: 80). */
function serverOn(conf: Block, port: string): Block {
  const s = servers(conf).filter((x) => x.directives.some((d) => d[0] === "listen" && d[1] === port));
  expect(s, `un server con listen ${port}`).toHaveLength(1);
  return s[0]!;
}

/** Semántica de nginx: `location = X` exacta; si no, el prefijo literal más largo. */
function resolveLocation(server: Block, uri: string): Block | null {
  const locs = server.children.filter((c) => c.name === "location");
  const exact = locs.find((l) => l.args[0] === "=" && l.args[1] === uri);
  if (exact) return exact;
  let best: Block | null = null;
  for (const l of locs) {
    if (l.args.length !== 1) continue; // = (ya visto), ~, ^~: la conf no usa regex
    if (uri.startsWith(l.args[0]!) && (!best || l.args[0]!.length > best.args[0]!.length)) best = l;
  }
  return best;
}

function directive(b: Block, name: string): string[][] {
  return b.directives.filter((d) => d[0] === name);
}

/** Destino EFECTIVO de proxy_pass (resuelve `set $var valor`). null = no hace proxy. */
function proxyTarget(loc: Block): string | null {
  const pp = directive(loc, "proxy_pass");
  if (pp.length === 0) return null;
  const v = pp[0]![1]!;
  if (!v.startsWith("$")) return v;
  const set = directive(loc, "set").find((d) => d[1] === v);
  return set ? set[2]! : null;
}

function rewrites(loc: Block): string[] {
  return directive(loc, "rewrite").map((d) => d.slice(1).join(" "));
}

function headers(loc: Block): Map<string, string> {
  return new Map(directive(loc, "proxy_set_header").map((d) => [d[1]!.toLowerCase(), d[2] ?? ""]));
}

/** Comprueba la conf del web. Exportada para calibrarla contra la conf anterior. */
export function checkWebConf(webSrc: string, gatewaySrc: string): void {
  const web = serverOn(parseNginx(webSrc), "3000");
  const gw = serverOn(parseNginx(gatewaySrc), "80");

  // 1 · Lo que pide /broadcast llega a la API, no al index.html.
  for (const uri of [
    "/api/v1/battles/d559453e-5d2d-495b-a153-5d096e891f6f",
    "/api/v1/battles/d559453e-5d2d-495b-a153-5d096e891f6f/spectate-ticket",
    "/api/v1/tournaments/t1/battles",
    "/api/v1/tournaments",
  ]) {
    const w = resolveLocation(web, uri);
    const g = resolveLocation(gw, uri);
    expect(w && proxyTarget(w), `web ${uri}`).toBe(g && proxyTarget(g));
    expect(proxyTarget(w!), `web ${uri} va a la API`).toBe("http://api:8080");
    expect(rewrites(w!), `web ${uri} misma reescritura que el gateway`).toEqual(rewrites(g!));
    expect(directive(w!, "try_files"), `web ${uri} no es el fallback de SPA`).toHaveLength(0);
  }

  // 2 · El canal de espectador (wsUrl relativo /ws/spectate/<id>) llega al gateway WS
  //     del tournament-worker, con Upgrade, igual que por el gateway.
  const wsUri = "/ws/spectate/d559453e-5d2d-495b-a153-5d096e891f6f";
  const ww = resolveLocation(web, wsUri)!;
  const gw2 = resolveLocation(gw, wsUri)!;
  expect(proxyTarget(ww)).toBe(proxyTarget(gw2));
  expect(proxyTarget(ww)).toBe("http://tournament-worker:8081");
  expect(rewrites(ww)).toEqual(rewrites(gw2));
  expect(headers(ww).get("upgrade")).toBe("$http_upgrade");
  expect(headers(ww).get("connection")?.toLowerCase()).toMatch(/upgrade/);
  expect(directive(ww, "proxy_http_version")[0]?.[1]).toBe("1.1");

  // 3 · No se abre nada más: los únicos proxy_pass del web son esos dos, y los
  //     replays NO llegan al replay-service (TD-004): siguen en el fallback de SPA.
  const proxied = web.children
    .filter((c) => c.name === "location" && proxyTarget(c) !== null)
    .map((c) => `${c.args.join(" ")} -> ${proxyTarget(c)}`)
    .sort();
  expect(proxied).toEqual(["/api/v1/ -> http://api:8080", "/ws/ -> http://tournament-worker:8081"]);
  for (const uri of ["/replays", "/replays/x/index", "/grafana/", "/broadcast"]) {
    const l = resolveLocation(web, uri)!;
    expect(proxyTarget(l), `web ${uri} no se reenvía`).toBeNull();
    expect(directive(l, "try_files")[0]?.slice(-1)[0], `web ${uri} = SPA`).toBe("/index.html");
  }
  // Ninguna DIRECTIVA (los comentarios no cuentan) nombra al replay-service.
  const all = (b: Block): string[][] => [...b.directives, ...b.children.flatMap(all)];
  expect(all(parseNginx(webSrc)).filter((d) => d.some((x) => x.includes("replay-service")))).toEqual([]);

  // 4 · upstream en variable ⇒ hace falta resolver (si no, nginx no arranca/resuelve).
  expect(directive(web, "resolver")[0]?.[1]).toBe("127.0.0.11");
}

describe("BROADCAST-PUBLIC-ACCESS · nginx de web enruta /api/v1 y /ws como el gateway", () => {
  const webSrc = readFileSync(WEB_CONF, "utf8");
  const gwSrc = readFileSync(GATEWAY_CONF, "utf8");

  it("la conf REAL del web reenvía la API y el canal de espectador al mismo destino que el gateway", () => {
    checkWebConf(webSrc, gwSrc);
  });

  it("el index.html (destino del fallback de SPA) se sirve con Cache-Control: no-cache", () => {
    const web = serverOn(parseNginx(webSrc), "3000");
    const idx = resolveLocation(web, "/index.html")!;
    expect(idx.args).toEqual(["=", "/index.html"]);
    const cc = directive(idx, "add_header").find((d) => d[1]?.toLowerCase() === "cache-control");
    expect(cc?.[2]).toMatch(/no-cache|no-store/);
  });

  it("CALIBRACIÓN · la conf anterior (sólo estáticos + SPA) se pone ROJA", () => {
    // La conf de RC9 7bddda9, reducida a su forma: sin las location de proxy.
    const before = `server {
      listen 3000; server_name _; root /usr/share/nginx/html; index index.html;
      location = /healthz { return 200 'ok'; }
      location /assets/ { expires 1y; }
      location / { try_files $uri $uri/ /index.html; }
    }`;
    expect(() => checkWebConf(before, gwSrc)).toThrow();
  });

  it("CALIBRACIÓN · reenviar /replays/ al replay-service se pone ROJO", () => {
    const mutated = webSrc.replace(
      "location /ws/ {",
      "location /replays/ { proxy_pass http://replay-service:8083; }\n    location /ws/ {",
    );
    expect(mutated).not.toBe(webSrc);
    expect(() => checkWebConf(mutated, gwSrc)).toThrow();
  });

  it("CALIBRACIÓN · /api/v1/ apuntando a otro upstream se pone ROJO", () => {
    const mutated = webSrc.replace("set $api_up http://api:8080;", "set $api_up http://replay-service:8083;");
    expect(mutated).not.toBe(webSrc);
    expect(() => checkWebConf(mutated, gwSrc)).toThrow();
  });
});
