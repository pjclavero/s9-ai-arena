#!/usr/bin/env node
/**
 * RC2 DEV-CI · comprobación SEMÁNTICA del compose RESUELTO (`docker compose config
 * --format json`), no del texto del YAML: lo que se comprueba es lo que Docker va a crear.
 *
 * Contrato RC2 (COMMON-RC2.md, «CONTRATO entre carriles»):
 *   - red clave `bot-control`, nombre `s9-bot-control`, bridge `internal: true`, bridge del
 *     host `s9-botctl0`, subred 10.89.250.0/24 y gateway 10.89.250.1;
 *   - miembros = EXACTAMENTE los consumidores del proxy (ni uno más, ni uno menos);
 *   - cada consumidor con `extra_hosts` docker-proxy.internal → 10.89.250.1 (nunca host-gateway);
 *   - ningún servicio publica ni expone 2375, monta docker.sock ni corre privilegiado;
 *   - los ejecutores reales (bot-build-worker, tournament-worker) hablan con
 *     http://docker-proxy.internal:2375 en el render del job.
 *
 * Uso: node compose-check.mjs <config-del-job.json> [config-con-defectos.json] > compose-check.json
 *   La segunda (opcional) se renderiza SIN DOCKER_PROXY_URL en el entorno y verifica el
 *   interruptor del operador: tournament-worker apagado por defecto, builds con la URL.
 * rc 0 si todo se cumple; 1 si no (y el JSON dice qué).
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const NETWORK_KEY = "bot-control";
export const NETWORK_NAME = "s9-bot-control";
export const BRIDGE_NAME = "s9-botctl0";
export const SUBNET = "10.89.250.0/24";
export const GATEWAY = "10.89.250.1";
export const PROXY_URL = "http://docker-proxy.internal:2375";
/**
 * Consumidores del s9-docker-proxy: quien instancia ProxyContainerRunner / habla con
 * DOCKER_PROXY_URL (verificado en código por DEV-NET, N1). Lista EXPLÍCITA a propósito:
 * un servicio nuevo en `bot-control` tiene que pasar por aquí o el gate se pone ROJO.
 */
export const CONSUMERS = ["arena-engine", "bot-build-worker", "bot-manager", "tournament-worker"];
/** Los que ejecutan contenedores en los flujos reales del E2E (C3/C4). */
export const EXECUTORS = ["bot-build-worker", "tournament-worker"];

const asList = (x) => (Array.isArray(x) ? x : x && typeof x === "object" ? Object.entries(x) : []);

/** extra_hosts: el render JSON puede dar ["a=b"], ["a:b"] o {a: b}; se normaliza a pares. */
export function extraHosts(svc) {
  const raw = svc.extra_hosts;
  const pairs = [];
  if (Array.isArray(raw)) {
    for (const e of raw) {
      const s = String(e);
      const i = s.search(/[=:]/);
      if (i > 0) pairs.push([s.slice(0, i), s.slice(i + 1)]);
    }
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) for (const ip of Array.isArray(v) ? v : [v]) pairs.push([k, String(ip)]);
  }
  return pairs;
}

/** Redes de un servicio con su nombre real y si son internas. */
export function serviceNetworks(cfg, svcName) {
  const svc = cfg.services[svcName] ?? {};
  const keys = Array.isArray(svc.networks) ? svc.networks : Object.keys(svc.networks ?? {});
  return keys.map((key) => {
    const n = cfg.networks?.[key] ?? {};
    return { key, name: n.name ?? key, internal: n.internal === true };
  });
}

export function evaluateCompose(cfg, defaultsCfg) {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail });
  const services = Object.keys(cfg.services ?? {}).sort();
  const net = cfg.networks?.[NETWORK_KEY];

  add("red bot-control existe", !!net, net ? `name=${net.name}` : "ausente en el compose resuelto");
  if (net) {
    const ipam = (net.ipam?.config ?? [])[0] ?? {};
    add("red: nombre fijo", net.name === NETWORK_NAME, String(net.name));
    add("red: driver bridge", (net.driver ?? "bridge") === "bridge", String(net.driver));
    add("red: internal true", net.internal === true, String(net.internal));
    add(
      "red: bridge del host",
      net.driver_opts?.["com.docker.network.bridge.name"] === BRIDGE_NAME,
      JSON.stringify(net.driver_opts ?? {}),
    );
    add("red: subred", ipam.subnet === SUBNET, String(ipam.subnet));
    add("red: gateway", ipam.gateway === GATEWAY, String(ipam.gateway));
  }

  const members = services.filter((s) => serviceNetworks(cfg, s).some((n) => n.key === NETWORK_KEY));
  const extra = members.filter((m) => !CONSUMERS.includes(m));
  const missing = CONSUMERS.filter((c) => services.includes(c) && !members.includes(c));
  add("miembros de bot-control = consumidores", extra.length === 0 && missing.length === 0, {
    members,
    expected: CONSUMERS.filter((c) => services.includes(c)),
    extra,
    missing,
  });

  for (const c of CONSUMERS.filter((s) => services.includes(s))) {
    const hosts = extraHosts(cfg.services[c]).filter(([h]) => h === "docker-proxy.internal");
    add(
      `${c}: docker-proxy.internal → ${GATEWAY}`,
      hosts.length === 1 && hosts[0][1] === GATEWAY,
      hosts.map((h) => h.join("=")).join(",") || "sin alias",
    );
  }
  for (const s of services) {
    const hg = extraHosts(cfg.services[s]).filter(([, ip]) => ip === "host-gateway");
    if (hg.length) add(`${s}: sin host-gateway`, false, hg.map((h) => h.join("=")).join(","));
  }

  for (const s of services) {
    const svc = cfg.services[s];
    const ports = asList(svc.ports).map((p) => (Array.isArray(p) ? p[1] : p));
    const bad = ports.filter((p) => String(p.target ?? p) === "2375" || String(p.published ?? "") === "2375");
    const exposeBad = asList(svc.expose).filter((e) => String(Array.isArray(e) ? e[1] : e).startsWith("2375"));
    if (bad.length || exposeBad.length) add(`${s}: no publica/expone 2375`, false, JSON.stringify({ bad, exposeBad }));
    const vols = asList(svc.volumes).map((v) => (Array.isArray(v) ? v[1] : v));
    const sock = vols.filter((v) => String(v.source ?? v).includes("docker.sock"));
    if (sock.length) add(`${s}: no monta docker.sock`, false, JSON.stringify(sock));
    if (svc.privileged === true) add(`${s}: no privilegiado`, false, "privileged: true");
  }
  add(
    "ningún servicio publica 2375 ni monta docker.sock ni es privilegiado",
    !checks.some((c) => !c.ok && /2375|docker\.sock|privilegiado/.test(c.id)),
    "",
  );

  for (const e of EXECUTORS.filter((s) => services.includes(s))) {
    const url = cfg.services[e].environment?.DOCKER_PROXY_URL ?? "";
    add(`${e}: DOCKER_PROXY_URL del job`, url === PROXY_URL, String(url));
  }

  if (defaultsCfg) {
    const tw = defaultsCfg.services?.["tournament-worker"]?.environment?.DOCKER_PROXY_URL ?? "";
    add("defectos: tournament-worker con la ejecución APAGADA (DOCKER_PROXY_URL vacío)", tw === "", JSON.stringify(tw));
    const bw = defaultsCfg.services?.["bot-build-worker"]?.environment?.DOCKER_PROXY_URL ?? "";
    add("defectos: bot-build-worker con la URL del contrato", bw === PROXY_URL, JSON.stringify(bw));
  }

  const networks = Object.fromEntries(services.map((s) => [s, serviceNetworks(cfg, s)]));
  return { ok: checks.every((c) => c.ok), checks, members, networks };
}

function main() {
  const [jobCfg, defaultsCfg] = process.argv.slice(2);
  if (!jobCfg) {
    console.error("uso: compose-check.mjs <config-del-job.json> [config-con-defectos.json]");
    process.exit(2);
  }
  const cfg = JSON.parse(readFileSync(jobCfg, "utf8"));
  const def = defaultsCfg ? JSON.parse(readFileSync(defaultsCfg, "utf8")) : undefined;
  const r = evaluateCompose(cfg, def);
  process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  for (const c of r.checks) if (!c.ok) console.error(`compose-check FALLA · ${c.id}: ${JSON.stringify(c.detail)}`);
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
