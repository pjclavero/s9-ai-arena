// RC2 DEV-CI (REVIEW RC1 P0-3, TD-052) — el E2E contenedor → bot-control → s9-docker-proxy
// es un gate REAL de CI y su veredicto no se deja engañar.
//
// Garantías (cada una con su control negativo):
//   C1 functional-e2e.yml tiene el job `container-proxy-e2e` en ubuntu-24.04, sin `if:` ni
//      continue-on-error, con las fases en orden y SIN `if:` (un paso saltado no se cuela),
//      y veredicto, evidencia, subida y limpieza con `if: always()`. Lo llama ci.yml (G1 de
//      functional-e2e-gate.test.ts), así que el semáforo lo agrega.
//   C2 el veredicto (scripts/ci/assert-container-proxy-e2e.mjs) acepta el escenario conforme
//      y RECHAZA cada desviación: fase ausente, consumidor sin acceso, gateway/backup con
//      acceso, capa de proxy o de firewall que no actúa, imagen ajena o stop de postgres
//      admitidos, batalla sin terminar, contenedor de runtime sin labels (bypass)…
//   C3 compose-check.mjs juzga el compose RESUELTO: el conforme pasa y gateway en
//      bot-control, worker fuera, host-gateway, 2375 publicado o el interruptor encendido
//      por defecto lo ponen ROJO.
//   C4 probe.mjs clasifica de verdad (servidor real en loopback): REFUSED, 403 y cierre sin
//      respuesta.
//   C5 run.sh se NIEGA a correr fuera de un runner de GitHub Actions (aplica firewall con
//      sudo y borra el stack: nunca en una máquina compartida ni en producción).
import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
// @ts-expect-error módulo .mjs sin tipos
import {
  evaluar,
  EXPECTED_PROXY_CMDLINE,
  PRIVILEGE_MUTATIONS,
  PRIVILEGE_NEGATIVES,
  PROBE_TARGETS,
  PROXY_INSTANCE,
  STACK,
} from "../../scripts/ci/assert-container-proxy-e2e.mjs";
// @ts-expect-error módulo .mjs sin tipos
import { evaluateCompose, CONSUMERS, EXECUTORS } from "../../tests/container-proxy-e2e/compose-check.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..");
const FE = parse(readFileSync(join(REPO, ".github/workflows/functional-e2e.yml"), "utf8"));
const ASSERT = join(REPO, "scripts/ci/assert-container-proxy-e2e.mjs");
const PROBE = join(REPO, "tests/container-proxy-e2e/probe.mjs");
const RUN = join(REPO, "tests/container-proxy-e2e/run.sh");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

type Step = { name?: string; run?: string; uses?: string; if?: string; "continue-on-error"?: unknown };

describe("C1 · functional-e2e.yml: job container-proxy-e2e obligatorio y completo", () => {
  const job = FE.jobs["container-proxy-e2e"];
  const steps = (job?.steps ?? []) as Step[];
  const idx = (needle: string) => steps.findIndex((s) => s.run?.includes(needle));

  it("existe, en ubuntu-24.04 (Docker rootful + sudo), sin if: ni continue-on-error, con timeout", () => {
    expect(job, "falta el job container-proxy-e2e").toBeDefined();
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job.if).toBeUndefined();
    expect(job["continue-on-error"]).toBeUndefined();
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
    for (const s of steps) expect(s["continue-on-error"], s.name).toBeUndefined();
  });

  it("las fases corren en orden, cada una con su reloj y SIN if: (un paso no se puede saltar)", () => {
    const fases = [
      "run.sh prepare",
      "run.sh build",
      "run.sh up",
      "run.sh probes",
      "run.sh flow",
      "run.sh policy",
      "run.sh privilege",
    ];
    const pos = fases.map(idx);
    for (const [i, p] of pos.entries()) {
      expect(p, fases[i]).toBeGreaterThanOrEqual(0);
      expect(steps[p].if, fases[i]).toBeUndefined();
      expect((steps[p] as Record<string, unknown>)["timeout-minutes"], fases[i]).toBeGreaterThan(0);
    }
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
  });

  it("evidencia, veredicto (con el commit), subida y limpieza corren SIEMPRE, después de las fases", () => {
    const flow = idx("run.sh privilege");
    const ev = idx("run.sh evidence");
    const verdict = idx("assert-container-proxy-e2e.mjs");
    const collect = idx("collect-functional-evidence.sh");
    const upload = steps.findIndex((s) => s.uses?.startsWith("actions/upload-artifact"));
    const clean = idx("run.sh cleanup");
    for (const p of [ev, verdict, collect, upload, clean]) {
      expect(p).toBeGreaterThan(flow);
      expect(steps[p].if).toBe("always()");
    }
    expect(steps[verdict].run).toContain("$S9_CPX_COMMIT");
    expect(job.env.S9_CPX_COMMIT).toBe("${{ github.sha }}");
    expect(clean).toBe(steps.length - 1);
  });
});

// ── C2 · veredicto ───────────────────────────────────────────────────────────
const NETS: Record<string, { name: string; internal: boolean }[]> = {
  postgres: [{ name: "s9cpx_data", internal: true }],
  queue: [{ name: "s9cpx_platform", internal: true }],
  api: [
    { name: "s9cpx_platform", internal: true },
    { name: "s9cpx_data", internal: true },
  ],
  web: [{ name: "s9cpx_platform", internal: true }],
  gateway: [
    { name: "s9cpx_public", internal: false },
    { name: "s9cpx_platform", internal: true },
  ],
  "map-service": [{ name: "s9cpx_data", internal: true }],
  "replay-service": [{ name: "s9cpx_data", internal: true }],
  "backup-equivalent": [
    { name: "s9cpx_data", internal: true },
    { name: "s9cpx_public", internal: false },
  ],
  "bot-equivalent": [{ name: "arena", internal: true }],
};
const consumerNets = [
  { name: "s9cpx_platform", internal: true },
  { name: "s9-bot-control", internal: true },
];
const netsOf = (t: string) => NETS[t] ?? consumerNets;

function probe(t: string, fase: "A" | "B") {
  if (CONSUMERS.includes(t))
    return { target: t, tcp: "CONNECT", http: { status: 201, body: "{}" }, networks: netsOf(t) };
  if (netsOf(t).some((n) => !n.internal))
    return fase === "A"
      ? { target: t, tcp: "CONNECT", http: { status: 403, body: "{}" }, networks: netsOf(t) }
      : { target: t, tcp: "TIMEOUT", http: null, networks: netsOf(t) };
  return { target: t, tcp: "ENETUNREACH", http: null, networks: netsOf(t) };
}

const RT = "ghcr.io/pjclavero/s9-ai-arena/bot-runtime-python@sha256:" + "8c5de611".padEnd(64, "a");
function evento(time: number, image: string, extra: Record<string, string> = {}) {
  return JSON.stringify({
    Type: "container",
    Action: "create",
    time,
    Actor: { Attributes: { image, name: "x", ...extra } },
  });
}
const proxyLabels = { "s9.managed": "true", "s9.proxy.instance": PROXY_INSTANCE };

function fixture(mut: (d: string) => void = () => {}): string {
  const d = mkdtempSync(join(tmpdir(), "cpx-"));
  const w = (f: string, v: unknown) => writeFileSync(join(d, f), JSON.stringify(v));
  w("compose-check.json", { ok: true, checks: [{ id: "red bot-control existe", ok: true, detail: "" }] });
  w(
    "services.json",
    STACK.map((s: string) => ({
      service: s,
      running: true,
      health: "healthy",
      revision: COMMIT,
      mountsDockerSock: false,
      privileged: false,
      networks: CONSUMERS.includes(s)
        ? [
            { name: "s9cpx_platform", ip: "172.20.0.4" },
            { name: "s9-bot-control", ip: `10.89.250.${10 + STACK.indexOf(s)}` },
          ]
        : [{ name: "s9cpx_data", ip: "172.21.0.3" }],
      extraHosts: CONSUMERS.includes(s) ? ["docker-proxy.internal:10.89.250.1"] : [],
      dockerProxyUrl: EXECUTORS.includes(s) ? "http://docker-proxy.internal:2375" : null,
    })),
  );
  w("readiness.json", { tournamentWorkerContainerExecution: true, buildWorkerContainerSandbox: true });
  w("host-checks.json", {
    listeners: ["10.89.250.1:2375"],
    hostProbes: [
      { to: "127.0.0.1", tcp: "REFUSED" },
      { to: "172.17.0.1", tcp: "REFUSED" },
      { to: "192.0.2.10", tcp: "REFUSED" },
    ],
  });
  w("firewall.json", { script: "s9-firewall.sh", applyRc: 0, checkRc: 0 });
  w("network-probe-A.json", { rc: 0, result: {} });
  w("network-probe-B.json", { rc: 0, result: {} });
  for (const f of ["A", "B"] as const)
    w(
      `probes-${f}.json`,
      PROBE_TARGETS.map((t: string) => probe(t, f)),
    );
  const deny = (id: string) => ({ id, expect: 403, tcp: "CONNECT", http: { status: 403, body: "denegado" } });
  w("policy.json", {
    requests: [
      ...[
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
      ].map(deny),
      { id: "positive-create", expect: 201, tcp: "CONNECT", http: { status: 201, body: '{"Id":"abc"}' } },
      { id: "positive-inspect-own", expect: 200, tcp: "CONNECT", http: { status: 200, body: "{}" } },
    ],
    postgres: {
      before: { Running: true, StartedAt: "2026-10-21T10:00:00Z", Pid: 42 },
      after: { Running: true, StartedAt: "2026-10-21T10:00:00Z", Pid: 42 },
    },
    ownLabels: proxyLabels,
  });
  const t0 = 1_800_000_000;
  w("flow.json", {
    ok: true,
    phase: "done",
    startedAt: new Date(t0 * 1000).toISOString(),
    endedAt: new Date((t0 + 400) * 1000).toISOString(),
    bots: {
      red: {
        buildId: "b-r",
        buildStatus: "passed",
        state: "published",
        artifactBuildId: "b-r",
        protocolTestPosture: true,
      },
      blue: {
        buildId: "b-b",
        buildStatus: "passed",
        state: "published",
        artifactBuildId: "b-b",
        protocolTestPosture: true,
      },
    },
    battle: {
      battleId: "bt-1",
      createdAt: new Date((t0 + 200) * 1000).toISOString(),
      finishedAt: new Date((t0 + 390) * 1000).toISOString(),
      status: "finished",
      result: { schema: "battle-result/v1", agents: "container", winner: "red" },
      stats: { redShots: 9, blueShots: 0, redTries: 12, blueTries: 0 },
      replayAvailable: true,
      replayIndexStatus: 200,
      gatewayReplaysStatus: 404,
    },
  });
  w("images.json", { runtimeImages: [RT] });
  w("privilege.json", {
    preflightInitialRc: 0,
    preflightFinalRc: 0,
    effective: {
      exe: "/usr/bin/node",
      nodeReal: "/usr/bin/node",
      cmdline: EXPECTED_PROXY_CMDLINE,
      expectedCmdline: EXPECTED_PROXY_CMDLINE,
      user: "s9proxy",
      treeVisible: false,
    },
    bundle: { commit: COMMIT, sha256: "a".repeat(64), runtimeImports: ["node:fs", "node:http", "node:net"] },
    negatives: ["s9cpx-arena", "s9proxy"].flatMap((who) =>
      PRIVILEGE_NEGATIVES.map((id: string) => ({ who, id, rc: 1, eacces: true, err: "Permission denied" })),
    ),
    mutations: PRIVILEGE_MUTATIONS.map((id: string) => ({
      id,
      reason: "x",
      redRc: 1,
      reasonFound: true,
      revertedRc: 0,
    })),
    process: { mainPidBefore: "4242", mainPidAfter: "4242", active: "active" },
  });
  writeFileSync(
    join(d, "docker-events.jsonl"),
    [
      evento(t0 - 100, "s9cpx-local/api:ci-x", { "com.docker.compose.project": "s9cpx" }),
      evento(t0 - 50, "s9cpx-local/api:ci-x"),
      evento(t0 + 20, RT, proxyLabels),
      evento(t0 + 90, RT, proxyLabels),
      evento(t0 + 230, RT, proxyLabels),
      evento(t0 + 231, RT, proxyLabels),
    ].join("\n") + "\n",
  );
  mut(d);
  return d;
}
const patch = (d: string, f: string, fn: (v: any) => any) =>
  writeFileSync(join(d, f), JSON.stringify(fn(JSON.parse(readFileSync(join(d, f), "utf8")))));
const setProbe = (d: string, fase: string, target: string, p: Record<string, unknown>) =>
  patch(d, `probes-${fase}.json`, (v) => v.map((x: any) => (x.target === target ? { ...x, ...p } : x)));
const setReq = (d: string, id: string, status: number) =>
  patch(d, "policy.json", (v) => ({
    ...v,
    requests: v.requests.map((r: any) => (r.id === id ? { ...r, http: { status, body: "" } } : r)),
  }));

describe("C2 · assert-container-proxy-e2e: el veredicto no se deja engañar", () => {
  it("control positivo: escenario conforme → PASS (CLI rc 0)", () => {
    const d = fixture();
    const v = evaluar(d, { commit: COMMIT });
    expect(v.filas.filter((f: { ok: boolean }) => !f.ok)).toEqual([]);
    const r = spawnSync(process.execPath, [ASSERT, d, COMMIT], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
    });
    expect(r.status, r.stdout).toBe(0);
  });

  const casos: [string, (d: string) => void][] = [
    ["sin compose-check (la fase no corrió)", (d) => writeFileSync(join(d, "compose-check.json"), "")],
    [
      "compose-check en rojo",
      (d) => patch(d, "compose-check.json", () => ({ ok: false, checks: [{ id: "x", ok: false }] })),
    ],
    [
      "imagen de otro commit",
      (d) => patch(d, "services.json", (v) => v.map((s: any) => (s.service === "api" ? { ...s, revision: "f00" } : s))),
    ],
    [
      "bot-build-worker fuera de s9-bot-control",
      (d) =>
        patch(d, "services.json", (v) =>
          v.map((s: any) =>
            s.service === "bot-build-worker" ? { ...s, networks: [{ name: "s9cpx_build", ip: "172.22.0.2" }] } : s,
          ),
        ),
    ],
    [
      "alias docker-proxy.internal a host-gateway",
      (d) =>
        patch(d, "services.json", (v) =>
          v.map((s: any) =>
            s.service === "tournament-worker" ? { ...s, extraHosts: ["docker-proxy.internal:host-gateway"] } : s,
          ),
        ),
    ],
    [
      "tournament-worker sin ejecución real",
      (d) => patch(d, "readiness.json", (v) => ({ ...v, tournamentWorkerContainerExecution: false })),
    ],
    [
      "proxy escuchando en 0.0.0.0",
      (d) => patch(d, "host-checks.json", (v) => ({ ...v, listeners: ["0.0.0.0:2375"] })),
    ],
    [
      "el host conecta por loopback",
      (d) =>
        patch(d, "host-checks.json", (v) => ({
          ...v,
          hostProbes: [{ to: "127.0.0.1", tcp: "CONNECT" }, ...v.hostProbes.slice(1)],
        })),
    ],
    ["firewall no aplicado", (d) => patch(d, "firewall.json", (v) => ({ ...v, applyRc: 127 }))],
    ["sonda de DEV-NET no medida (rc 2)", (d) => patch(d, "network-probe-B.json", () => ({ rc: 2 }))],
    ["sonda de DEV-NET ausente", (d) => patch(d, "network-probe-A.json", () => ({ rc: null, missing: true }))],
    ["sin sondas de la fase B", (d) => writeFileSync(join(d, "probes-B.json"), "[]")],
    [
      "gateway con ACCESS (gateway en bot-control)",
      (d) => setProbe(d, "A", "gateway", { tcp: "CONNECT", http: { status: 201 } }),
    ],
    [
      "consumidor sin ruta (worker sin bot-control)",
      (d) => setProbe(d, "B", "bot-build-worker", { tcp: "ENETUNREACH", http: null }),
    ],
    [
      "fase A: gateway TIMEOUT (la capa del proxy no se ha medido)",
      (d) => setProbe(d, "A", "gateway", { tcp: "TIMEOUT", http: null }),
    ],
    [
      "fase B: backup conecta (el firewall no actúa)",
      (d) => setProbe(d, "B", "backup-equivalent", { tcp: "CONNECT", http: { status: 403 } }),
    ],
    [
      "postgres alcanza el proxy (red interna con ruta)",
      (d) => setProbe(d, "A", "postgres", { tcp: "CONNECT", http: { status: 403 } }),
    ],
    ["el bot alcanza el proxy", (d) => setProbe(d, "B", "bot-equivalent", { tcp: "CONNECT", http: { status: 201 } })],
    [
      "objetivo ausente de las sondas",
      (d) => patch(d, "probes-A.json", (v) => v.filter((x: any) => x.target !== "web")),
    ],
    ["imagen ajena admitida (allowlist desactivada)", (d) => setReq(d, "create-foreign-postgres", 201)],
    ["imagen base de DIGESTS.lock admitida", (d) => setReq(d, "create-foreign-base-python", 404)],
    ["labels s9.* forjadas admitidas", (d) => setReq(d, "create-label-forgery", 201)],
    ["stop de postgres admitido (propiedad desactivada)", (d) => setReq(d, "stop-postgres-by-id", 204)],
    ["stop de postgres por nombre admitido", (d) => setReq(d, "stop-postgres-by-name", 204)],
    ["el propio contenedor no se puede inspeccionar", (d) => setReq(d, "positive-inspect-own", 403)],
    [
      "postgres reiniciado durante la política",
      (d) =>
        patch(d, "policy.json", (v) => ({
          ...v,
          postgres: { ...v.postgres, after: { ...v.postgres.after, StartedAt: "otro" } },
        })),
    ],
    ["sin labels impuestas por el proxy", (d) => patch(d, "policy.json", (v) => ({ ...v, ownLabels: {} }))],
    ["sin flow.json (no hubo batalla)", (d) => writeFileSync(join(d, "flow.json"), "")],
    [
      "batalla sin terminar",
      (d) => patch(d, "flow.json", (v) => ({ ...v, battle: { ...v.battle, status: "running" } })),
    ],
    [
      "batalla sin contenedores",
      (d) =>
        patch(d, "flow.json", (v) => ({
          ...v,
          battle: { ...v.battle, result: { ...v.battle.result, agents: "builtin" } },
        })),
    ],
    [
      "el Pacifista disparó",
      (d) =>
        patch(d, "flow.json", (v) => ({ ...v, battle: { ...v.battle, stats: { ...v.battle.stats, blueTries: 2 } } })),
    ],
    [
      "build que no pasó",
      (d) =>
        patch(d, "flow.json", (v) => ({ ...v, bots: { ...v.bots, blue: { ...v.bots.blue, buildStatus: "failed" } } })),
    ],
    [
      "replay servido por /replays* del gateway",
      (d) => patch(d, "flow.json", (v) => ({ ...v, battle: { ...v.battle, gatewayReplaysStatus: 200 } })),
    ],
    [
      "contenedor de runtime SIN labels del proxy (bypass)",
      (d) =>
        writeFileSync(
          join(d, "docker-events.jsonl"),
          readFileSync(join(d, "docker-events.jsonl"), "utf8") + evento(1_800_000_250, RT) + "\n",
        ),
    ],
    [
      "create ajeno fuera del Compose/arnés/proxy",
      (d) =>
        writeFileSync(
          join(d, "docker-events.jsonl"),
          readFileSync(join(d, "docker-events.jsonl"), "utf8") + evento(1_800_000_250, "alpine:3") + "\n",
        ),
    ],
    [
      "el proxy creó una imagen que no es del lock",
      (d) =>
        writeFileSync(
          join(d, "docker-events.jsonl"),
          readFileSync(join(d, "docker-events.jsonl"), "utf8") +
            evento(1_800_000_250, "postgres:16", proxyLabels) +
            "\n",
        ),
    ],
    [
      "sin contenedores de runtime durante la batalla",
      (d) =>
        writeFileSync(
          join(d, "docker-events.jsonl"),
          readFileSync(join(d, "docker-events.jsonl"), "utf8")
            .split("\n")
            .filter((l) => !l.includes(`"time":${1_800_000_230}`) && !l.includes(`"time":${1_800_000_231}`))
            .join("\n"),
        ),
    ],
    // ── R11 · TD-062: frontera de privilegio ──
    ["sin privilege.json (la fase no corrió)", (d) => writeFileSync(join(d, "privilege.json"), "")],
    ["preflight inicial ROJO", (d) => patch(d, "privilege.json", (v) => ({ ...v, preflightInitialRc: 1 }))],
    [
      "el proxy corre con tsx desde el árbol",
      (d) =>
        patch(d, "privilege.json", (v) => ({
          ...v,
          effective: {
            ...v.effective,
            cmdline: "node /opt/s9-ai-arena/node_modules/.bin/tsx apps/bot-manager/src/docker-proxy-main.ts",
          },
        })),
    ],
    [
      "el ejecutable no es el node de root",
      (d) =>
        patch(d, "privilege.json", (v) => ({
          ...v,
          effective: { ...v.effective, exe: "/opt/hostedtoolcache/node/bin/node" },
        })),
    ],
    [
      "el proceso ve el checkout",
      (d) => patch(d, "privilege.json", (v) => ({ ...v, effective: { ...v.effective, treeVisible: true } })),
    ],
    [
      "el proceso corre como root",
      (d) => patch(d, "privilege.json", (v) => ({ ...v, effective: { ...v.effective, user: "root" } })),
    ],
    [
      "bundle con una importación de node_modules",
      (d) =>
        patch(d, "privilege.json", (v) => ({ ...v, bundle: { ...v.bundle, runtimeImports: ["node:fs", "yaml"] } })),
    ],
    [
      "bundle de otro commit",
      (d) => patch(d, "privilege.json", (v) => ({ ...v, bundle: { ...v.bundle, commit: "f".repeat(40) } })),
    ],
    [
      "s9cpx-arena PUEDE escribir la allowlist",
      (d) =>
        patch(d, "privilege.json", (v) => ({
          ...v,
          negatives: v.negatives.map((n: any) =>
            n.who === "s9cpx-arena" && n.id === "append-lock" ? { ...n, rc: 0, eacces: false } : n,
          ),
        })),
    ],
    [
      "un negativo falla por otra causa (no EACCES)",
      (d) =>
        patch(d, "privilege.json", (v) => ({
          ...v,
          negatives: v.negatives.map((n: any) => (n.id === "append-unit" ? { ...n, eacces: false } : n)),
        })),
    ],
    [
      "falta un negativo (no se midió)",
      (d) =>
        patch(d, "privilege.json", (v) => ({
          ...v,
          negatives: v.negatives.filter((n: any) => n.id !== "rename-bundle"),
        })),
    ],
    [
      "mutación que NO pone el preflight en rojo",
      (d) =>
        patch(d, "privilege.json", (v) => ({
          ...v,
          mutations: v.mutations.map((m: any) => (m.id === "env-allowlist-in-tree" ? { ...m, redRc: 0 } : m)),
        })),
    ],
    [
      "mutación en rojo por OTRO motivo",
      (d) =>
        patch(d, "privilege.json", (v) => ({
          ...v,
          mutations: v.mutations.map((m: any) => (m.id === "unit-npx-tsx" ? { ...m, reasonFound: false } : m)),
        })),
    ],
    [
      "mutación sin revertir a verde",
      (d) =>
        patch(d, "privilege.json", (v) => ({
          ...v,
          mutations: v.mutations.map((m: any) => (m.id === "unit-dropin" ? { ...m, revertedRc: 1 } : m)),
        })),
    ],
    [
      "falta una mutación",
      (d) =>
        patch(d, "privilege.json", (v) => ({
          ...v,
          mutations: v.mutations.filter((m: any) => m.id !== "libdir-owned-by-nonroot"),
        })),
    ],
    ["preflight final ROJO", (d) => patch(d, "privilege.json", (v) => ({ ...v, preflightFinalRc: 1 }))],
    [
      "el proxy se reinició durante las mutaciones",
      (d) => patch(d, "privilege.json", (v) => ({ ...v, process: { ...v.process, mainPidAfter: "999" } })),
    ],
  ];
  for (const [nombre, mut] of casos) {
    it(`${nombre} → FAIL (CLI rc 1)`, () => {
      const d = fixture(mut);
      expect(evaluar(d, { commit: COMMIT }).ok).toBe(false);
      const r = spawnSync(process.execPath, [ASSERT, d, COMMIT], {
        encoding: "utf8",
        env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
      });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("::error::");
    });
  }

  it("sin commit esperado → FAIL (no se puede afirmar la procedencia)", () => {
    expect(evaluar(fixture(), {}).ok).toBe(false);
  });
  it("directorio vacío → FAIL", () => {
    expect(evaluar(mkdtempSync(join(tmpdir(), "cpx-empty-")), { commit: COMMIT }).ok).toBe(false);
  });
});

// ── C3 · compose-check ───────────────────────────────────────────────────────
function composeOk() {
  const svc = (networks: string[], extra: Record<string, unknown> = {}) => ({
    networks: Object.fromEntries(networks.map((n) => [n, null])),
    ...extra,
  });
  const consumer = (env: Record<string, string> = {}) =>
    svc(["platform", "bot-control"], { extra_hosts: ["docker-proxy.internal=10.89.250.1"], environment: env });
  const url = { DOCKER_PROXY_URL: "http://docker-proxy.internal:2375" };
  return {
    services: {
      gateway: svc(["public", "platform"], { ports: [{ target: 80, published: "80" }] }),
      api: svc(["platform", "data"]),
      postgres: svc(["data"], { image: "postgres@sha256:" + "1".padEnd(64, "2") }),
      "arena-engine": consumer({ DOCKER_PROXY_URL: "" }),
      "bot-manager": svc(["platform", "build"], {
        extra_hosts: ["docker-proxy.internal=10.89.250.1"],
        environment: url,
      }),
      "bot-build-worker": consumer(url),
      "tournament-worker": consumer(url),
      backup: svc(["data", "public"]),
    },
    networks: {
      public: { name: "s9cpx_public" },
      platform: { name: "s9cpx_platform", internal: true },
      data: { name: "s9cpx_data", internal: true },
      "bot-control": {
        name: "s9-bot-control",
        driver: "bridge",
        internal: true,
        driver_opts: { "com.docker.network.bridge.name": "s9-botctl0" },
        ipam: { config: [{ subnet: "10.89.250.0/24", gateway: "10.89.250.1" }] },
      },
    },
  };
}
function defaultsOk() {
  const c = composeOk() as any;
  c.services["tournament-worker"].environment = { DOCKER_PROXY_URL: "" };
  return c;
}

describe("C3 · compose-check.mjs juzga el compose resuelto", () => {
  it("control positivo → ok", () => {
    const r = evaluateCompose(composeOk(), defaultsOk());
    expect(r.checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);
    expect(r.ok).toBe(true);
  });
  const casos: [string, (c: any, d: any) => void][] = [
    ["gateway en bot-control", (c) => (c.services.gateway.networks["bot-control"] = null)],
    [
      "bot-manager en bot-control (no consume el proxy)",
      (c) => (c.services["bot-manager"].networks["bot-control"] = null),
    ],
    ["bot-build-worker fuera de bot-control", (c) => delete c.services["bot-build-worker"].networks["bot-control"]],
    ["bot-control no interna", (c) => (c.networks["bot-control"].internal = false)],
    ["subred distinta", (c) => (c.networks["bot-control"].ipam.config[0].subnet = "172.30.0.0/16")],
    ["sin nombre de bridge fijo", (c) => (c.networks["bot-control"].driver_opts = {})],
    [
      "alias a host-gateway",
      (c) => (c.services["tournament-worker"].extra_hosts = ["docker-proxy.internal=host-gateway"]),
    ],
    ["2375 publicado", (c) => (c.services.api.ports = [{ target: 2375, published: "2375" }])],
    ["docker.sock montado", (c) => (c.services.api.volumes = [{ type: "bind", source: "/var/run/docker.sock" }])],
    ["worker sin la URL en el job", (c) => (c.services["bot-build-worker"].environment = {})],
    [
      "interruptor del operador encendido por defecto",
      (_c, d) => (d.services["tournament-worker"].environment = { DOCKER_PROXY_URL: "http://x:1" }),
    ],
  ];
  for (const [nombre, mut] of casos) {
    it(`${nombre} → FAIL`, () => {
      const c = composeOk();
      const d = defaultsOk();
      mut(c, d);
      expect(evaluateCompose(c, d).ok).toBe(false);
    });
  }
});

// ── C4 · probe.mjs clasifica con un servidor real en loopback ───────────────
function runProbe(port: number, method = "GET", path = "/x"): Promise<any> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [PROBE, "127.0.0.1", String(port), method, path, "-", "3000"]);
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("close", () => resolve(JSON.parse(out.trim())));
  });
}
async function withServer(handler: (s: net.Socket | http.ServerResponse) => void, kind: "http" | "tcp") {
  const srv =
    kind === "http"
      ? http.createServer((_q, res) => handler(res))
      : net.createServer((s) => {
          s.once("data", () => handler(s));
        });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  return { port, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

describe("C4 · probe.mjs", () => {
  it("puerto cerrado → REFUSED", async () => {
    const tmp = net.createServer();
    await new Promise<void>((r) => tmp.listen(0, "127.0.0.1", () => r()));
    const port = (tmp.address() as net.AddressInfo).port;
    await new Promise<void>((r) => tmp.close(() => r()));
    expect((await runProbe(port)).tcp).toBe("REFUSED");
  });
  it("403 del proxy → CONNECT + status 403 (también con chunked)", async () => {
    const s = await withServer((res) => {
      const r = res as http.ServerResponse;
      r.writeHead(403, { "content-type": "application/json" });
      r.end('{"message":"cliente no permitido"}');
    }, "http");
    const p = await runProbe(s.port, "POST", "/containers/create");
    await s.close();
    expect(p.tcp).toBe("CONNECT");
    expect(p.http.status).toBe(403);
    expect(p.http.body).toContain("cliente no permitido");
  });
  it("cierre sin respuesta → CONNECT + closed", async () => {
    const s = await withServer((sock) => (sock as net.Socket).destroy(), "tcp");
    const p = await runProbe(s.port);
    await s.close();
    expect(p.tcp).toBe("CONNECT");
    expect(p.http).toBeNull();
    expect(p.closed).toBe(true);
  });
});

// ── TD-062 · el job ejecuta el proxy COMO PRODUCCIÓN ────────────────────────
// Complementa R11 (que mide el proceso efectivo en el runner: /proc/<pid>/exe y cmdline):
// aquí se exige que run.sh no tenga otro camino de arranque del proxy desde el checkout.
describe("TD-062 · run.sh arranca el proxy con el instalador real, no desde el árbol", () => {
  const sh = readFileSync(RUN, "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
  it("ninguna línea ejecutable arranca docker-proxy-main.ts ni el proxy con tsx", () => {
    // Excluidas (declarado): las `sed -i` de la fase privilege, que ESCRIBEN ese ExecStart
    // en la unidad como mutación de calibración (el preflight debe ponerse rojo con ella).
    const lines = sh.split("\n").filter((l) => !/sudo -n sed -i /.test(l));
    expect(lines.filter((l) => /docker-proxy-main\.ts/.test(l))).toEqual([]);
    expect(sh.split("\n").filter((l) => /docker-proxy-main\.ts/.test(l)).length).toBe(1); // sólo la mutación
  });
  it("instala con install-docker-proxy.sh install, construye el bundle sin root y retira con rollback", () => {
    expect(sh).toMatch(/INSTALLER="\$REPO\/infrastructure\/scripts\/install-docker-proxy\.sh"/);
    expect(sh).toMatch(/"\$\{PX\[@\]\}" install/);
    expect(sh).toMatch(/"\$\{PX\[@\]\}" rollback/);
    expect(sh).toMatch(/node "\$REPO\/infrastructure\/scripts\/build-docker-proxy-bundle\.mjs"/);
  });
});

// ── C5 · run.sh sólo en el runner efímero ───────────────────────────────────
describe("C5 · run.sh se niega fuera de GitHub Actions", () => {
  for (const env of [{}, { GITHUB_ACTIONS: "true" }, { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted" }]) {
    it(`entorno ${JSON.stringify(env)} → rc 3 sin tocar nada`, () => {
      const state = join(mkdtempSync(join(tmpdir(), "cpx-run-")), "state");
      const base = { ...process.env };
      delete base.GITHUB_ACTIONS;
      delete base.RUNNER_ENVIRONMENT;
      const r = spawnSync("bash", [RUN, "cleanup"], {
        encoding: "utf8",
        env: { ...base, ...env, S9_CPX_STATE: state },
      });
      expect(r.status).toBe(3);
      expect(r.stderr).toContain("sólo en un runner efímero");
      expect(existsSync(state), "run.sh salió antes de crear nada").toBe(false);
    });
  }
});
