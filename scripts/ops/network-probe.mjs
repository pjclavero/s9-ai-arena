#!/usr/bin/env node
/**
 * RC2 · DEV-NET — sonda de alcance hacia el s9-docker-proxy.
 *
 * Desde CADA contenedor de un proyecto Compose intenta una conexión TCP a
 * <target>:<port> (por defecto 10.89.250.1:2375, el bind del proxy) y clasifica
 * el resultado: CONNECT / ENETUNREACH / TIMEOUT / REFUSED / ERROR:<código>.
 *
 * Cómo mide: lanza un contenedor efímero que COMPARTE el espacio de red del
 * contenedor medido (`--network container:<id>`), así que ve exactamente sus
 * interfaces, rutas y resolución, sin necesitar herramientas dentro de la imagen
 * medida (nginx, postgres o redis no traen node ni nc). El contenedor de sonda
 * corre sin privilegios: --user 65534, --cap-drop ALL, --read-only,
 * no-new-privileges. La imagen de sonda por defecto es el runtime node FIJADO
 * en runtimes/DIGESTS.lock (3.ª columna, por digest): ya está en todo host que
 * vaya a ejecutar bots.
 *
 * Qué espera, deducido de la topología REAL del contenedor (docker inspect +
 * docker network inspect), no de una lista escrita a mano:
 *   MEMBER         está en la red de control (--control-network)  ⇒ CONNECT
 *   INTERNAL_ONLY  todas sus redes son internal: true             ⇒ ENETUNREACH
 *   DEFAULT_ROUTE  alguna red NO interna (ruta por defecto al host)
 *                    ⇒ sin veredicto: se mide y se reporta tal cual (sin
 *                      firewall de host ni control de cliente, CONNECT es lo
 *                      esperable: es justo lo que cierran esas otras capas);
 *                    ⇒ con --expect-default-route-blocked, cualquier cosa
 *                      distinta de CONNECT (para usarlo con el firewall puesto).
 *
 * Salida: tabla legible (o --json) y código de salida:
 *   0  todas las expectativas se cumplen
 *   1  alguna expectativa NO se cumple
 *   2  no se pudo medir (sin contenedores, sonda que no arranca, uso incorrecto):
 *      la ausencia de medida NUNCA es un aprobado.
 *
 * Uso:
 *   node scripts/ops/network-probe.mjs --project <proyecto-compose> \
 *     [--target 10.89.250.1] [--port 2375] [--timeout-ms 3000] \
 *     [--control-network s9-bot-control] [--probe-image <ref@sha256:…>] \
 *     [--expect-default-route-blocked] [--expect-members svc1,svc2,…] [--json]
 *
 *   --expect-members fija ADEMÁS qué servicios deben ser miembros de la red de
 *   control: si el conjunto medido difiere (p. ej. gateway unido a bot-control o
 *   un worker sin ella), rc 1. Sin esta bandera la sonda sólo comprueba que la
 *   conectividad es coherente con la topología, no que la topología sea la buena.
 *
 *   node scripts/ops/network-probe.mjs replica-compose --prefix <p> [--profile production …]
 *     Emite (stdout) un compose DERIVADO del render real de infrastructure/
 *     docker-compose.yml: mismos servicios, mismas redes y flags internal, misma
 *     subred/gateway de la red de control y mismos extra_hosts, pero cada
 *     servicio es un contenedor inerte con la imagen de sonda, y todos los
 *     nombres de red llevan <p> (no toca `arena` ni `s9-bot-control` reales).
 *     Sirve para medir la topología sin levantar la aplicación.
 *
 * Requiere el CLI `docker` (variable DOCKER_HOST respetada). Sin dependencias npm.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULTS = Object.freeze({
  target: "10.89.250.1",
  port: 2375,
  timeoutMs: 3000,
  controlNetwork: "s9-bot-control",
});

// ── Lógica pura (testeada en infrastructure/tests/network-probe.test.ts) ───────

/** Traduce el desenlace de net.connect a una clase estable. */
export function classifyOutcome(o) {
  if (o.connected) return "CONNECT";
  if (o.timedOut) return "TIMEOUT";
  switch (o.code) {
    case "ENETUNREACH":
      return "ENETUNREACH";
    case "EHOSTUNREACH":
      // Sin ruta al host concreto: a efectos de alcance, misma clase que la red.
      return "ENETUNREACH";
    case "ECONNREFUSED":
      return "REFUSED";
    case "ETIMEDOUT":
      return "TIMEOUT";
    default:
      return `ERROR:${o.code ?? "UNKNOWN"}`;
  }
}

/** Categoría de un contenedor según sus redes ({name, internal}[]). */
export function categorize(networks, controlNetwork = DEFAULTS.controlNetwork) {
  if (networks.some((n) => n.name === controlNetwork)) return "MEMBER";
  if (networks.length > 0 && networks.every((n) => n.internal === true)) return "INTERNAL_ONLY";
  return "DEFAULT_ROUTE";
}

/** ¿Cumple la medida lo esperado? null = sin veredicto (sólo se reporta). */
export function verdict(category, result, { expectDefaultRouteBlocked = false } = {}) {
  if (category === "MEMBER") return result === "CONNECT";
  if (category === "INTERNAL_ONLY") return result === "ENETUNREACH";
  if (expectDefaultRouteBlocked) return result !== "CONNECT" && !result.startsWith("ERROR:");
  return null;
}

/** Diferencia entre miembros esperados y medidos (null si coinciden). */
export function memberMismatch(expected, measured) {
  const e = new Set(expected);
  const m = new Set(measured);
  const missing = [...e].filter((x) => !m.has(x)).sort();
  const unexpected = [...m].filter((x) => !e.has(x)).sort();
  return missing.length || unexpected.length ? { missing, unexpected } : null;
}

export function expectationText(category, { expectDefaultRouteBlocked = false } = {}) {
  if (category === "MEMBER") return "CONNECT";
  if (category === "INTERNAL_ONLY") return "ENETUNREACH";
  return expectDefaultRouteBlocked ? "!CONNECT" : "(medir)";
}

/** Imagen de runtime node por digest desde DIGESTS.lock (3.ª columna). */
export function probeImageFromLock(text) {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const [runtime, , image] = t.split(/\s+/);
    if (runtime === "node" && /@sha256:[0-9a-f]{64}$/.test(image ?? "")) return image;
  }
  return null;
}

/** Programa que corre DENTRO del contenedor de sonda. Imprime una línea JSON. */
export const PROBE_JS = `
const net = require("node:net");
const [host, port, ms] = process.argv.slice(1);
const out = (o) => { process.stdout.write(JSON.stringify(o) + "\\n"); process.exit(0); };
const s = net.connect({ host, port: Number(port) });
const t = setTimeout(() => { s.destroy(); out({ timedOut: true }); }, Number(ms));
s.on("connect", () => { clearTimeout(t); s.destroy(); out({ connected: true }); });
s.on("error", (e) => { clearTimeout(t); out({ code: e.code }); });
`;

/**
 * Compose derivado para medir topología sin levantar la aplicación (ver cabecera).
 * `config` es el render JSON (`docker compose config --format json`).
 */
export function replicaCompose(config, { prefix, probeImage, controlKey = "bot-control" }) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(prefix)) throw new Error(`prefijo inválido: ${prefix}`);
  const networks = {};
  for (const [key, n] of Object.entries(config.networks ?? {})) {
    const out = { name: `${prefix}-${key}`, driver: n.driver ?? "bridge" };
    if (n.internal) out.internal = true;
    if (key === controlKey) {
      // Misma subred/gateway que la red real: el listener de prueba bindea esa IP.
      if (n.ipam) out.ipam = n.ipam;
      out.driver_opts = { "com.docker.network.bridge.name": `${prefix}-botctl0`.slice(0, 15) };
    }
    networks[key] = out;
  }
  const services = {};
  for (const [name, s] of Object.entries(config.services ?? {})) {
    services[name] = {
      image: probeImage,
      entrypoint: ["node", "-e", "setInterval(() => {}, 1 << 30)"],
      user: "65534:65534",
      read_only: true,
      cap_drop: ["ALL"],
      security_opt: ["no-new-privileges:true"],
      networks: Object.keys(s.networks ?? {}),
      ...(s.extra_hosts ? { extra_hosts: s.extra_hosts } : {}),
      labels: { "s9.rc2.replica-of": name },
    };
  }
  return { name: prefix, services, networks };
}

// ── Acceso a Docker ────────────────────────────────────────────────────────────
function docker(args, opts = {}) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

function inspectContainers(project) {
  const ids = docker(["ps", "-q", "--filter", `label=com.docker.compose.project=${project}`])
    .split("\n")
    .filter(Boolean);
  if (ids.length === 0) return [];
  const info = JSON.parse(docker(["inspect", ...ids]));
  const netCache = new Map();
  const netInfo = (name) => {
    if (!netCache.has(name)) {
      const [n] = JSON.parse(docker(["network", "inspect", name]));
      netCache.set(name, { name, internal: n.Internal === true });
    }
    return netCache.get(name);
  };
  return info
    .map((c) => ({
      id: c.Id,
      name: c.Name.replace(/^\//, ""),
      service: c.Config?.Labels?.["com.docker.compose.service"] ?? "?",
      networkMode: c.HostConfig?.NetworkMode ?? "",
      networks: Object.keys(c.NetworkSettings?.Networks ?? {}).map(netInfo),
    }))
    .sort((a, b) => a.service.localeCompare(b.service));
}

function probeOne(containerId, { target, port, timeoutMs, probeImage }) {
  const r = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      `container:${containerId}`,
      "--user",
      "65534:65534",
      "--cap-drop",
      "ALL",
      "--read-only",
      "--security-opt",
      "no-new-privileges:true",
      "--entrypoint",
      "node",
      probeImage,
      "-e",
      PROBE_JS,
      target,
      String(port),
      String(timeoutMs),
    ],
    { encoding: "utf8", timeout: timeoutMs + 60_000 },
  );
  const line = (r.stdout ?? "").trim().split("\n").pop() ?? "";
  try {
    return { ok: true, outcome: JSON.parse(line) };
  } catch {
    return { ok: false, error: `sonda no ejecutada (rc=${r.status}): ${(r.stderr ?? "").trim().slice(0, 300)}` };
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { profiles: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === "replica-compose") a.cmd = "replica";
    else if (k === "--project") a.project = v();
    else if (k === "--target") a.target = v();
    else if (k === "--port") a.port = Number(v());
    else if (k === "--timeout-ms") a.timeoutMs = Number(v());
    else if (k === "--control-network") a.controlNetwork = v();
    else if (k === "--probe-image") a.probeImage = v();
    else if (k === "--expect-default-route-blocked") a.expectDefaultRouteBlocked = true;
    else if (k === "--json") a.json = true;
    else if (k === "--expect-members")
      a.expectMembers = v()
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    else if (k === "--prefix") a.prefix = v();
    else if (k === "--profile") a.profiles.push(v());
    else if (k === "--compose") a.compose = v();
    else throw new Error(`argumento desconocido: ${k}`);
  }
  return a;
}

function defaultProbeImage() {
  const img = probeImageFromLock(readFileSync(join(REPO, "runtimes", "DIGESTS.lock"), "utf8"));
  if (!img) throw new Error("no hay runtime node por digest en runtimes/DIGESTS.lock");
  return img;
}

function main(argv) {
  let a;
  try {
    a = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  const probeImage = a.probeImage ?? defaultProbeImage();

  if (a.cmd === "replica") {
    if (!a.prefix) {
      console.error("replica-compose exige --prefix");
      return 2;
    }
    const compose = a.compose ?? join(REPO, "infrastructure", "docker-compose.yml");
    const profiles = a.profiles.length ? a.profiles : ["production"];
    const env = { ...process.env };
    delete env.DOCKER_PROXY_URL;
    const args = ["compose", "-f", compose, "--env-file", "/dev/null"];
    for (const p of profiles) args.push("--profile", p);
    args.push("config", "--format", "json");
    const config = JSON.parse(docker(args, { env }));
    process.stdout.write(JSON.stringify(replicaCompose(config, { prefix: a.prefix, probeImage }), null, 2) + "\n");
    return 0;
  }

  if (!a.project) {
    console.error("falta --project <proyecto compose>");
    return 2;
  }
  const opts = {
    target: a.target ?? DEFAULTS.target,
    port: a.port ?? DEFAULTS.port,
    timeoutMs: a.timeoutMs ?? DEFAULTS.timeoutMs,
    probeImage,
  };
  const controlNetwork = a.controlNetwork ?? DEFAULTS.controlNetwork;
  const vopts = { expectDefaultRouteBlocked: !!a.expectDefaultRouteBlocked };

  const containers = inspectContainers(a.project);
  if (containers.length === 0) {
    console.error(`sin contenedores en marcha en el proyecto ${a.project}: no hay medida (≠ aprobado)`);
    return 2;
  }
  const rows = [];
  let infraError = false;
  for (const c of containers) {
    const category = c.networkMode === "host" ? "DEFAULT_ROUTE" : categorize(c.networks, controlNetwork);
    const p = probeOne(c.id, opts);
    const result = p.ok ? classifyOutcome(p.outcome) : "NOT_MEASURED";
    if (!p.ok) infraError = true;
    const ok = p.ok ? verdict(category, result, vopts) : false;
    rows.push({
      service: c.service,
      container: c.name,
      networks: c.networks.map((n) => `${n.name}${n.internal ? "" : "(no-internal)"}`),
      category,
      expected: expectationText(category, vopts),
      result,
      verdict: ok === null ? "REPORT" : ok ? "PASS" : "FAIL",
      ...(p.ok ? {} : { error: p.error }),
    });
  }
  const summary = {
    target: `${opts.target}:${opts.port}`,
    controlNetwork,
    probeImage,
    pass: rows.filter((r) => r.verdict === "PASS").length,
    fail: rows.filter((r) => r.verdict === "FAIL").length,
    report: rows.filter((r) => r.verdict === "REPORT").length,
    members: [...new Set(rows.filter((r) => r.category === "MEMBER").map((r) => r.service))].sort(),
    memberMismatch: a.expectMembers
      ? memberMismatch(
          a.expectMembers,
          rows.filter((r) => r.category === "MEMBER").map((r) => r.service),
        )
      : null,
  };
  if (a.json) {
    process.stdout.write(JSON.stringify({ summary, rows }, null, 2) + "\n");
  } else {
    console.log(`destino ${summary.target} · red de control ${controlNetwork}`);
    for (const r of rows) {
      console.log(
        [
          r.verdict.padEnd(6),
          r.service.padEnd(22),
          r.category.padEnd(14),
          `esperado=${r.expected}`.padEnd(22),
          `medido=${r.result}`,
          r.networks.join(","),
        ].join(" "),
      );
      if (r.error) console.log(`       ${r.error}`);
    }
    console.log(`miembros medidos: ${summary.members.join(",") || "(ninguno)"}`);
    if (summary.memberMismatch) {
      console.log(
        `FAIL miembros: faltan=[${summary.memberMismatch.missing}] sobran=[${summary.memberMismatch.unexpected}]`,
      );
    }
    console.log(`PASS=${summary.pass} FAIL=${summary.fail} REPORT=${summary.report}`);
  }
  if (infraError) return 2;
  return summary.fail > 0 || summary.memberMismatch ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
