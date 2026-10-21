#!/usr/bin/env node
/**
 * RC2 DEV-CI · diagnóstico de C3/C4 desde la posición de red de un BOT (red `arena`,
 * `Dns 0.0.0.0` como el create de ProxyContainerRunner): ¿resuelve y alcanza a los anfitriones
 * que le anuncian los ejecutores (BUILD_SANDBOX_HOST=bot-build-worker,
 * ARENA_ENGINE_HOST=tournament-worker)? Evidencia: el veredicto lo dan los builds y la
 * batalla reales.
 *
 * Uso: node bot-view.mjs [host:puerto-tcp …]   → una línea JSON
 */
import dns from "node:dns";
import net from "node:net";

const hosts = ["bot-build-worker", "tournament-worker"];
const tcpTargets = process.argv.slice(2).length ? process.argv.slice(2) : ["tournament-worker:8081"];

const lookup = (h) =>
  new Promise((r) =>
    dns.lookup(h, { all: true }, (e, a) => r(e ? { error: e.code } : { addrs: a.map((x) => x.address) })),
  );
const tcp = (target) =>
  new Promise((r) => {
    const [h, p] = target.split(":");
    const s = net.connect(Number(p), h);
    const t = setTimeout(() => {
      s.destroy();
      r("TIMEOUT");
    }, 4000);
    s.on("connect", () => {
      clearTimeout(t);
      s.destroy();
      r("CONNECT");
    });
    s.on("error", (e) => {
      clearTimeout(t);
      r(e.code ?? String(e));
    });
  });

const out = { resolve: {}, tcp: {} };
for (const h of hosts) out.resolve[h] = await lookup(h);
for (const t of tcpTargets) out.tcp[t] = await tcp(t);
console.log(JSON.stringify(out));
