#!/usr/bin/env node
/**
 * RC2 DEV-CI (TD-052, REVIEW P0-3) · veredicto INDEPENDIENTE del job `container-proxy-e2e`.
 *
 * tests/container-proxy-e2e/run.sh registra lo que MIDIÓ en <out>/*.json; este script lo
 * juzga contra el contrato RC2. Una fase que no se ejecutó deja su fichero ausente y aquí
 * FALLA: `skipped`, 0 sondas o una batalla que no llegó a `finished` NUNCA son verde.
 *
 * Reglas (todas obligatorias; cualquier incumplimiento ⇒ exit 1):
 *   R1 compose resuelto conforme (compose-check.json: red bot-control del contrato,
 *      miembros = consumidores, alias a 10.89.250.1, sin 2375/docker.sock/privileged,
 *      interruptor del operador apagado por defecto).
 *   R2 imágenes construidas desde ESTE commit (label OCI revision) y servicios en marcha;
 *      cada consumidor en s9-bot-control con IP de 10.89.250.0/24 y el alias fijo.
 *   R3 ejecutores reales anunciados (battleExecution=container, sandbox=container).
 *   R4 el proxy escucha SÓLO en 10.89.250.1:2375; desde el host (loopback, docker0, IP
 *      principal) no conecta nada.
 *   R5 firewall de DEV-SECOPS aplicado y verificado (apply rc 0, check rc 0).
 *   R6 sondas (C5) desde CADA contenedor del stack y de los equivalentes declarados:
 *        consumidor                    → ACCESS (create válido = 201) en A y en B
 *        no consumidor, sólo internas  → sin ruta (ENETUNREACH/EHOSTUNREACH) en A y en B
 *        no consumidor con red NO interna (gateway, backup):
 *            fase A (sin firewall) → conecta y el PROXY deniega (403 o cierre)  [capa c]
 *            fase B (con firewall) → no llega a conectar                          [capa b]
 *   R7 política (C6) desde un consumidor legítimo: imagen ajena / base / digest fuera del
 *      lock / labels s9.* forjadas ⇒ 403; stop/start/inspect/stats de postgres (por id y
 *      por nombre) y stop del gateway ⇒ 403; postgres sigue running con el MISMO arranque;
 *      control positivo: create válido 201 + inspect del propio 200, con las labels
 *      impuestas por el proxy.
 *   R8 flujo (C3/C4): dos builds `passed` → published con artefacto de su build; batalla
 *      `finished`, agents=container, gana red, red dispara y blue tiene 0 intentos; replay
 *      por /api/v1/replays (200) y /replays* del gateway cerrado (404).
 *   R10 la sonda de DEV-NET (scripts/ops/network-probe.mjs --expect-members …) da rc 0
 *      sin firewall y con --expect-default-route-blocked con firewall (2 = no medido ≠ PASS).
 *   R11 (TD-062) frontera de privilegio, con el proxy INSTALADO como en producción
 *      (privilege.json): preflight inicial y final rc 0; el proceso es /usr/bin/node + el
 *      bundle de root, corre como s9proxy y NO ve el checkout; bundle del commit con sólo
 *      importaciones node:*; un usuario no root (s9cpx-arena) y s9proxy reciben EACCES en
 *      cada intento contra bundle/allowlist/unidad/entorno; cada mutación de root pone el
 *      preflight ROJO por su motivo y VERDE al revertir; el proxy no se reinició.
 *   R9 eventos de Docker: ≥2 contenedores de runtime creados durante los builds y ≥2 durante
 *      la batalla, TODOS con las labels del proxy; ningún create ajeno (sólo contenedores
 *      del proyecto Compose, del arnés o del proxy): un create sin labels = bypass.
 *
 * Uso:   node scripts/ci/assert-container-proxy-e2e.mjs <dir-out> [commit]
 * Tests: infrastructure/tests/container-proxy-e2e-gate.test.ts
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CONSUMERS,
  EXECUTORS,
  GATEWAY,
  NETWORK_NAME,
  PROXY_URL,
} from "../../tests/container-proxy-e2e/compose-check.mjs";

export const PROXY_INSTANCE = "s9-docker-proxy";
// TD-062 · contrato del artefacto instalado y de la fase `privilege` de run.sh.
export const EXPECTED_PROXY_CMDLINE = "/usr/bin/node --no-addons /usr/local/lib/s9-docker-proxy/docker-proxy.mjs";
export const PRIVILEGE_NEGATIVES = [
  "append-bundle",
  "create-in-libdir",
  "rename-bundle",
  "append-lock",
  "create-in-policydir",
  "append-unit",
  "create-dropin",
  "append-env",
  "append-preflight",
];
export const PRIVILEGE_MUTATIONS = [
  "bundle-group-writable",
  "libdir-owned-by-nonroot",
  "lockdir-owned-by-nonroot",
  "env-allowlist-in-tree",
  "unit-npx-tsx",
  "unit-workdir-opt",
  "unit-dropin",
];
export const APP_SERVICES = [
  "api",
  "web",
  "gateway",
  "arena-engine",
  "tournament-worker",
  "bot-manager",
  "bot-build-worker",
  "map-service",
  "replay-service",
];
export const STACK = ["postgres", "queue", ...APP_SERVICES];
export const EQUIVALENTS = ["backup-equivalent", "bot-equivalent"];
export const PROBE_TARGETS = [...STACK, ...EQUIVALENTS];
const NO_ROUTE = new Set(["ENETUNREACH", "EHOSTUNREACH"]);
const BLOCKED = new Set(["TIMEOUT", "REFUSED", "ENETUNREACH", "EHOSTUNREACH"]);

function leer(outDir, name, { jsonl = false } = {}) {
  const p = join(outDir, name);
  if (!existsSync(p)) return { error: `falta ${name} (la fase no se ejecutó)` };
  const raw = readFileSync(p, "utf8");
  try {
    if (jsonl)
      return {
        value: raw
          .split("\n")
          .filter((l) => l.trim().startsWith("{"))
          .map((l) => JSON.parse(l)),
      };
    return { value: JSON.parse(raw) };
  } catch (e) {
    return { error: `JSON inválido en ${name}: ${String(e)}` };
  }
}

/** Clasifica una sonda: ACCESS · DENIED (conectó y el proxy no concedió) · NO_ROUTE · BLOCKED · OTHER. */
export function clasificar(p) {
  if (!p || p.missing) return "MISSING";
  if (p.tcp === "CONNECT") {
    const st = p.http?.status;
    if (st === 201) return "ACCESS";
    if (st === 403 || (p.closed === true && !p.http)) return "DENIED";
    return `CONNECT_${st ?? "SIN_RESPUESTA"}`;
  }
  if (NO_ROUTE.has(p.tcp)) return "NO_ROUTE";
  if (BLOCKED.has(p.tcp)) return "BLOCKED";
  return `OTHER_${p.tcp}`;
}

/** Lo que el contrato exige para un objetivo en una fase. */
export function esperado(target, networks, fase) {
  if (CONSUMERS.includes(target)) return ["ACCESS"];
  const nonInternal = (networks ?? []).some((n) => n.internal !== true);
  if (!nonInternal) return ["NO_ROUTE"];
  return fase === "A" ? ["DENIED"] : ["BLOCKED"];
}

export function evaluar(outDir, { commit } = {}) {
  const filas = [];
  const add = (comprobacion, ok, detalle) => filas.push({ comprobacion, ok: Boolean(ok), detalle: String(detalle) });

  // R1
  const cc = leer(outDir, "compose-check.json");
  if (cc.error) add("R1 compose resuelto", false, cc.error);
  else {
    for (const c of cc.value.checks ?? []) add(`R1 ${c.id}`, c.ok, JSON.stringify(c.detail));
    if (!(cc.value.checks ?? []).length) add("R1 compose resuelto", false, "sin comprobaciones");
  }

  // R2
  const sv = leer(outDir, "services.json");
  if (sv.error) add("R2 servicios", false, sv.error);
  else {
    const by = Object.fromEntries((sv.value ?? []).map((s) => [s.service, s]));
    for (const s of STACK) {
      const x = by[s];
      if (!x || x.missing) {
        add(`R2 ${s} en marcha`, false, "sin contenedor");
        continue;
      }
      add(`R2 ${s} en marcha`, x.running === true, `running=${x.running} health=${x.health}`);
      if (x.mountsDockerSock || x.privileged) add(`R2 ${s} sin docker.sock ni privileged`, false, JSON.stringify(x));
    }
    for (const s of APP_SERVICES) {
      const x = by[s];
      if (!x || x.missing) continue;
      add(`R2 ${s}: imagen del commit`, !!commit && x.revision === commit, `revision=${x.revision} commit=${commit}`);
    }
    for (const c of CONSUMERS) {
      const x = by[c];
      if (!x || x.missing) {
        add(`R2 ${c}: en ${NETWORK_NAME}`, false, "sin contenedor");
        continue;
      }
      const net = (x.networks ?? []).find((n) => n.name === NETWORK_NAME);
      add(
        `R2 ${c}: en ${NETWORK_NAME} con IP de la subred`,
        !!net && /^10\.89\.250\.\d+$/.test(net.ip ?? "") && net.ip !== GATEWAY,
        JSON.stringify(x.networks),
      );
      add(
        `R2 ${c}: alias docker-proxy.internal → ${GATEWAY}`,
        (x.extraHosts ?? []).some(
          (h) => h === `docker-proxy.internal:${GATEWAY}` || h === `docker-proxy.internal=${GATEWAY}`,
        ),
        JSON.stringify(x.extraHosts),
      );
    }
    for (const e of EXECUTORS) {
      const x = by[e];
      add(`R2 ${e}: DOCKER_PROXY_URL en el contenedor`, x?.dockerProxyUrl === PROXY_URL, String(x?.dockerProxyUrl));
    }
  }

  // R3
  const rd = leer(outDir, "readiness.json");
  if (rd.error) add("R3 ejecutores reales", false, rd.error);
  else {
    add(
      "R3 tournament-worker battleExecution=container",
      rd.value.tournamentWorkerContainerExecution === true,
      JSON.stringify(rd.value),
    );
    add(
      "R3 bot-build-worker sandbox=container",
      rd.value.buildWorkerContainerSandbox === true,
      JSON.stringify(rd.value),
    );
  }

  // R4
  const hc = leer(outDir, "host-checks.json");
  if (hc.error) add("R4 escucha del proxy", false, hc.error);
  else {
    const l = hc.value.listeners ?? [];
    add(
      "R4 el proxy escucha SÓLO en 10.89.250.1:2375",
      l.length === 1 && l[0] === `${GATEWAY}:2375`,
      JSON.stringify(l),
    );
    const hp = hc.value.hostProbes ?? [];
    add(
      "R4 desde el host (loopback, docker0, IP principal) no conecta",
      hp.length >= 2 && hp.every((p) => p.tcp !== "CONNECT"),
      hp.map((p) => `${p.to}=${p.tcp}`).join(" ") || "sin sondas",
    );
  }

  // R5
  const fw = leer(outDir, "firewall.json");
  if (fw.error) add("R5 firewall", false, fw.error);
  else {
    add("R5 firewall aplicado (apply rc 0)", fw.value.applyRc === 0, `rc=${fw.value.applyRc} ${fw.value.script}`);
    add("R5 firewall verificado (check rc 0)", fw.value.checkRc === 0, `rc=${fw.value.checkRc}`);
  }

  // R6
  for (const fase of ["A", "B"]) {
    const pr = leer(outDir, `probes-${fase}.json`);
    if (pr.error) {
      add(`R6 sondas fase ${fase}`, false, pr.error);
      continue;
    }
    const by = Object.fromEntries((pr.value ?? []).map((p) => [p.target, p]));
    for (const t of PROBE_TARGETS) {
      const p = by[t];
      const got = clasificar(p);
      const want = esperado(t, p?.networks, fase);
      add(
        `R6 fase ${fase} · ${t}`,
        want.includes(got),
        `obtenido=${got} esperado=${want.join("|")} tcp=${p?.tcp} http=${p?.http?.status ?? "-"} redes=${(
          p?.networks ?? []
        )
          .map((n) => `${n.name}${n.internal ? "" : "(NO interna)"}`)
          .join(",")}`,
      );
    }
  }

  // R10 · segunda medida independiente: la sonda de DEV-NET (rc 0 = PASS; 2 = no medido)
  for (const fase of ["A", "B"]) {
    const np = leer(outDir, `network-probe-${fase}.json`);
    add(
      `R10 sonda de DEV-NET (network-probe.mjs) fase ${fase}`,
      !np.error && np.value.rc === 0,
      np.error ?? (np.value.missing ? "scripts/ops/network-probe.mjs ausente" : `rc=${np.value.rc}`),
    );
  }

  // R7
  const po = leer(outDir, "policy.json");
  if (po.error) add("R7 política", false, po.error);
  else {
    const reqs = po.value.requests ?? [];
    const want = [
      "create-foreign-postgres",
      "create-foreign-base-python",
      "create-foreign-digest",
      "create-label-forgery",
      "stop-postgres-by-id",
      "stop-postgres-by-name",
      "start-postgres",
      "inspect-postgres",
      "stats-postgres",
      "stop-gateway",
      "positive-create",
      "positive-inspect-own",
    ];
    for (const id of want) {
      const r = reqs.find((x) => x.id === id);
      add(
        `R7 ${id}`,
        !!r && r.tcp === "CONNECT" && r.http?.status === r.expect,
        r
          ? `status=${r.http?.status ?? r.tcp} esperado=${r.expect} ${String(r.http?.body ?? "").slice(0, 160)}`
          : "no se ejecutó",
      );
    }
    const b = po.value.postgres?.before ?? {};
    const a = po.value.postgres?.after ?? {};
    add(
      "R7 postgres sigue running con el mismo arranque",
      b.Running === true && a.Running === true && b.StartedAt === a.StartedAt && b.Pid === a.Pid,
      `antes=${JSON.stringify(b)} después=${JSON.stringify(a)}`,
    );
    const own = po.value.ownLabels ?? {};
    add(
      "R7 labels impuestas por el proxy en el create",
      own["s9.managed"] === "true" && own["s9.proxy.instance"] === PROXY_INSTANCE,
      JSON.stringify(own),
    );
  }

  // R8
  const fl = leer(outDir, "flow.json");
  if (fl.error) add("R8 flujo", false, fl.error);
  else {
    const f = fl.value;
    add("R8 flujo completo", f.ok === true && f.phase === "done", `fase=${f.phase} error=${f.error ?? "-"}`);
    for (const k of ["red", "blue"]) {
      const b = f.bots?.[k] ?? {};
      add(
        `R8 build ${k}: passed → published con el artefacto de SU build`,
        b.buildStatus === "passed" && b.state === "published" && !!b.buildId && b.artifactBuildId === b.buildId,
        `build=${b.buildId} status=${b.buildStatus} estado=${b.state} artefacto=${b.artifactBuildId}`,
      );
      add(
        `R8 build ${k}: postura del contenedor conforme (protocol_test)`,
        b.protocolTestPosture === true,
        String(b.protocolTestPosture),
      );
    }
    const bt = f.battle ?? {};
    const r = bt.result ?? {};
    const st = bt.stats ?? {};
    add("R8 batalla finished", bt.status === "finished", `battle=${bt.battleId} status=${bt.status}`);
    add(
      "R8 resultado battle-result/v1 con agents=container",
      r.schema === "battle-result/v1" && r.agents === "container",
      JSON.stringify(r),
    );
    add("R8 gana red", r.winner === "red", String(r.winner));
    add("R8 red disparó (SU código)", Number(st.redShots) > 0, String(st.redShots));
    add("R8 blue 0 disparos y 0 intentos (SU código)", st.blueShots === 0 && st.blueTries === 0, JSON.stringify(st));
    add(
      "R8 replay por /api/v1/replays (200) y /replays* del gateway cerrado (404)",
      bt.replayAvailable === true && bt.replayIndexStatus === 200 && bt.gatewayReplaysStatus === 404,
      `available=${bt.replayAvailable} api=${bt.replayIndexStatus} gateway=${bt.gatewayReplaysStatus}`,
    );
  }

  // R11 · TD-062: frontera de privilegio del proxy (instalado como en producción)
  const pv = leer(outDir, "privilege.json");
  if (pv.error) add("R11 frontera de privilegio del proxy", false, pv.error);
  else {
    const p = pv.value;
    const e = p.effective ?? {};
    const tr = p.trust ?? {};
    // B1 (REVIEW #167): la confianza no se ancla en el árbol.
    add(
      "R11 B1 el instalador del checkout (no de root) se NIEGA: preflight rc 2 e install rc 2",
      tr.untrustedPreflightRc === 2 && tr.untrustedInstallRc === 2,
      JSON.stringify({ preflight: tr.untrustedPreflightRc, install: tr.untrustedInstallRc }),
    );
    add(
      "R11 B1 preflight instalado de root (/usr/local/sbin, 0:0 755)",
      tr.installedPreflight === "0:0 755",
      String(tr.installedPreflight),
    );
    add(
      "R11 B1 el bundle construido por root en la copia de confianza = el del usuario (sha256)",
      Boolean(p.bundle?.sha256) && tr.bundleRootSha256 === p.bundle.sha256,
      JSON.stringify({ user: p.bundle?.sha256, root: tr.bundleRootSha256 }),
    );
    add(
      "R11 preflight inicial VERDE (root real, systemd real, proceso en marcha)",
      p.preflightInitialRc === 0,
      String(p.preflightInitialRc),
    );
    add(
      "R11 el proceso ejecuta /usr/bin/node + el bundle instalado (no tsx/npx del árbol)",
      Boolean(e.exe) &&
        e.exe === e.nodeReal &&
        e.cmdline === EXPECTED_PROXY_CMDLINE &&
        e.expectedCmdline === EXPECTED_PROXY_CMDLINE,
      JSON.stringify({ exe: e.exe, cmdline: e.cmdline }),
    );
    add("R11 el proceso corre como s9proxy", e.user === "s9proxy", String(e.user));
    add("R11 el proceso NO ve el checkout (árbol inaccesible)", e.treeVisible === false, String(e.treeVisible));
    add(
      "R11 bundle autocontenido del commit (sólo node:*)",
      Boolean(p.bundle) &&
        (!commit || p.bundle.commit === commit) &&
        (p.bundle.runtimeImports ?? []).length > 0 &&
        p.bundle.runtimeImports.every((i) => i.startsWith("node:")),
      JSON.stringify({ commit: p.bundle?.commit, runtimeImports: p.bundle?.runtimeImports }),
    );
    const neg = p.negatives ?? [];
    const negWho = new Set(neg.map((n) => n.who));
    add(
      "R11 negativos: s9cpx-arena y s9proxy reciben EACCES al tocar bundle/allowlist/unidad/entorno",
      neg.length >= PRIVILEGE_NEGATIVES.length * 2 &&
        ["s9cpx-arena", "s9proxy"].every((w) => negWho.has(w)) &&
        PRIVILEGE_NEGATIVES.every((id) =>
          ["s9cpx-arena", "s9proxy"].every((w) => neg.some((n) => n.who === w && n.id === id)),
        ) &&
        neg.every((n) => n.rc !== 0 && n.eacces === true),
      neg
        .filter((n) => !(n.rc !== 0 && n.eacces === true))
        .map((n) => `${n.who}/${n.id} rc=${n.rc}`)
        .join(", ") || `${neg.length} intentos denegados`,
    );
    const mut = p.mutations ?? [];
    for (const id of PRIVILEGE_MUTATIONS) {
      const m = mut.find((x) => x.id === id);
      add(
        `R11 mutación ${id}: preflight ROJO por su motivo y VERDE al revertir`,
        Boolean(m) && m.redRc === 1 && m.reasonFound === true && m.revertedRc === 0,
        m ? JSON.stringify(m) : "no se ejecutó",
      );
    }
    add("R11 preflight final VERDE", p.preflightFinalRc === 0, String(p.preflightFinalRc));
    const pr = p.process ?? {};
    add(
      "R11 el proxy siguió activo con el mismo MainPID (las mutaciones no lo reiniciaron)",
      pr.active === "active" &&
        Boolean(pr.mainPidBefore) &&
        pr.mainPidBefore !== "0" &&
        pr.mainPidBefore === pr.mainPidAfter,
      JSON.stringify(pr),
    );
  }

  // R9
  const ev = leer(outDir, "docker-events.jsonl", { jsonl: true });
  const im = leer(outDir, "images.json");
  if (ev.error || im.error) add("R9 eventos de Docker", false, ev.error ?? im.error);
  else {
    const runtime = new Set(im.value.runtimeImages ?? []);
    const creates = ev.value.filter(
      (e) => (e.Action ?? e.status) === "create" && (e.Type ?? "container") === "container",
    );
    const attrs = (e) => e.Actor?.Attributes ?? {};
    const byProxy = (e) => attrs(e)["s9.managed"] === "true" && attrs(e)["s9.proxy.instance"] === PROXY_INSTANCE;
    const harness = (e) => !!attrs(e)["com.docker.compose.project"] || /^s9cpx-local\/api:/.test(attrs(e).image ?? "");
    const unknown = creates.filter((e) => !byProxy(e) && !harness(e));
    add(
      "R9 ningún create fuera del Compose, del arnés o del proxy (sin bypass)",
      creates.length > 0 && unknown.length === 0,
      unknown.length
        ? unknown.map((e) => `${attrs(e).name}:${attrs(e).image}`).join(", ")
        : `${creates.length} creates, todos identificados`,
    );
    const viaProxyForeign = creates.filter((e) => byProxy(e) && !runtime.has(attrs(e).image));
    add(
      "R9 el proxy sólo creó imágenes de runtime del lock",
      viaProxyForeign.length === 0,
      viaProxyForeign.map((e) => attrs(e).image).join(", ") || "ninguna ajena",
    );
    const rtCreates = creates.filter((e) => runtime.has(attrs(e).image));
    add(
      "R9 todo contenedor de runtime lleva las labels del proxy",
      rtCreates.length > 0 && rtCreates.every(byProxy),
      `${rtCreates.filter(byProxy).length}/${rtCreates.length}`,
    );
    const f = fl.value ?? {};
    const t = (iso) => (iso ? Date.parse(iso) / 1000 : NaN);
    const start = t(f.startedAt);
    const battleAt = t(f.battle?.createdAt);
    const end = t(f.battle?.finishedAt ?? f.endedAt);
    const inWin = (e, a, b) => Number(e.time) >= a - 1 && Number(e.time) <= b + 1;
    const builds = rtCreates.filter((e) => byProxy(e) && inWin(e, start, battleAt)).length;
    const battle = rtCreates.filter((e) => byProxy(e) && inWin(e, battleAt, end)).length;
    add("R9 ≥2 contenedores de runtime vía proxy durante los builds", builds >= 2, String(builds));
    add("R9 ≥2 contenedores de runtime vía proxy durante la batalla", battle >= 2, String(battle));
  }

  return { ok: filas.length > 0 && filas.every((f) => f.ok), filas };
}

export function resumenMarkdown({ ok, filas }) {
  return [
    `## container-proxy-e2e: ${ok ? "PASS" : "FAIL"}`,
    "",
    "| Comprobación | Resultado | Detalle |",
    "|---|---|---|",
    ...filas.map(
      (f) => `| ${f.comprobacion} | ${f.ok ? "PASS" : "FAIL"} | ${f.detalle.replace(/\|/g, "\\|").slice(0, 400)} |`,
    ),
  ].join("\n");
}

function main() {
  const [outDir, commit] = process.argv.slice(2);
  if (!outDir) {
    console.error("uso: assert-container-proxy-e2e.mjs <dir-out> [commit]");
    process.exit(2);
  }
  const v = evaluar(outDir, { commit: commit ?? process.env.S9_CPX_COMMIT });
  const md = resumenMarkdown(v);
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  for (const f of v.filas)
    if (!f.ok) console.log(`::error::container-proxy-e2e · ${f.comprobacion}: ${f.detalle.slice(0, 300)}`);
  process.exit(v.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
