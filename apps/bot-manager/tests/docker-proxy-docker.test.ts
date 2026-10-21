/**
 * RC2 (DEV-PROXY) · P10 · el proxy REAL contra Docker REAL (opt-in: S9_RUN_DOCKER_SANDBOX_E2E=1).
 *
 * Reproduce los controles N20–N23 de OPS-C (RC1) con el mismo tipo de víctima —un
 * contenedor creado FUERA del proxy— y exige el resultado contrario: 403 y la víctima
 * intacta (mismo StartedAt, sigue running). Además, con el proxy como PROCESO REAL
 * (el BUNDLE instalado de docker-proxy-main.ts, TD-062) dentro de un contenedor que comparte red con los clientes,
 * prueba el control de cliente por IP de origen con contenedores de verdad:
 *   - cliente en la red «de control» (subred admitida)          → pasa el control;
 *   - cliente en una red NO interna ajena (el caso gateway/backup) → 403.
 *
 * Qué NO reproduce (declarado): el proxy aquí no es una unidad systemd del host ni
 * escucha en el gateway 10.89.250.1 de `s9-bot-control` (en Docker rootless el bridge
 * vive en el netns de rootlesskit y un proceso del host no puede bindear ahí). Para
 * que un cliente ajeno ALCANCE físicamente el listener —lo que ocurre en producción
 * con una IP propiedad del host— el proxy escucha en 0.0.0.0 dentro de su contenedor
 * con el opt-in DOCKER_PROXY_INSECURE_BIND_FOR_TESTS=1. La topología real (red
 * dedicada + firewall + proxy en el host) la prueba el job contenedor→proxy de DEV-CI.
 *
 * Recursos: todo con prefijo `rc2px-` (o labels de la instancia `rc2px-test`), y se
 * borra sólo lo propio al acabar. La red `arena` (compartida) se usa y NUNCA se borra.
 * Imágenes: sólo las de runtimes/DIGESTS.lock (la CI las descarga antes), más
 * cualquier imagen local ajena para N20 si existe (si no, un digest sintético: el
 * proxy deniega antes de preguntar a Docker).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LIMITS, DockerContainerRunner, complianceViolations } from "../src/container-runner.js";
import {
  DEFAULT_POLICY,
  LABEL_INSTANCE,
  LABEL_MANAGED,
  type ProxyDecisionLog,
  ProxyContainerRunner,
  createDockerProxyServer,
  createSocketBackend,
  loadImageAllowlist,
} from "../src/docker-proxy.js";
import { DOCKER_E2E, dockerSocketPath } from "./docker-sandbox-env.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..", "..");
const SECCOMP_PATH = join(here, "..", "security", "seccomp-bot.json");
const BUILD = join(REPO, "infrastructure", "scripts", "build-docker-proxy-bundle.mjs");
// Prefijo de TODOS los recursos Docker del test (defecto rc2px; en local, el de cada carril:
// p. ej. S9_PROXY_DOCKER_TEST_PREFIX=rc3priv). Limpieza sólo de lo propio.
const PFX = process.env.S9_PROXY_DOCKER_TEST_PREFIX || "rc2px";
const RUN = randomBytes(3).toString("hex");
const INSTANCE = `${PFX}-test`;
const RUNTIMES = [...loadImageAllowlist()];
const RUNTIME_NODE = RUNTIMES.find((i) => i.includes("runtime-node")) ?? RUNTIMES[0];

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const dockerOk = (...args: string[]) => {
  try {
    return { ok: true, out: docker(...args) };
  } catch (e) {
    return { ok: false, out: String((e as { stderr?: unknown }).stderr ?? e) };
  }
};
const inspectState = (id: string) => JSON.parse(docker("inspect", "-f", "{{json .State}}", id));

/** Contenedor CREADO FUERA DEL PROXY (la víctima de N21–N23), corriendo de verdad. */
function victim(name: string, labels: Record<string, string> = {}): string {
  const labelArgs = Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
  return docker(
    "run",
    "-d",
    "--name",
    name,
    "--network",
    "none",
    "--label",
    `${PFX}.run=${RUN}`,
    ...labelArgs,
    "--entrypoint",
    "node",
    RUNTIME_NODE,
    "-e",
    "setInterval(()=>{},1e9)",
  );
}

function createBody(overrides: Record<string, unknown> = {}) {
  const body = ProxyContainerRunner.buildCreateBody({
    imageDigest: RUNTIME_NODE,
    botId: PFX,
    version: 1,
    battleId: RUN,
    network: "arena",
    engineEndpoint: "ws://127.0.0.1:9",
    env: {},
    limits: DEFAULT_LIMITS,
    seccompProfilePath: SECCOMP_PATH,
    cmd: ["-e", "setInterval(()=>{},1e9)"],
    autoRemove: true,
  });
  return { ...body, ...overrides };
}

function cleanup() {
  for (const filter of [`label=${PFX}.run=${RUN}`, `label=${LABEL_INSTANCE}=${INSTANCE}`, `name=${PFX}-`]) {
    const ids = dockerOk("ps", "-aq", "--filter", filter).out.split("\n").filter(Boolean);
    if (ids.length) dockerOk("rm", "-f", ...ids);
  }
}

describe.skipIf(!DOCKER_E2E)("RC2 · P10 · proxy real contra Docker real (in-process)", () => {
  let server: http.Server;
  let url = "";
  const decisions: ProxyDecisionLog[] = [];
  const victims: Record<string, string> = {};

  beforeAll(async () => {
    for (const img of RUNTIMES) docker("image", "inspect", "-f", "{{.Id}}", img); // presentes (la CI las descarga)
    if (!dockerOk("network", "inspect", "arena").ok) docker("network", "create", "arena"); // compartida: nunca se borra
    server = createDockerProxyServer({
      backend: createSocketBackend(dockerSocketPath()),
      policy: { ...DEFAULT_POLICY, instance: INSTANCE },
      onDecision: (d) => decisions.push(d),
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    victims.plain = victim(`${PFX}-victim-${RUN}`);
    victims.mimic = victim(`${PFX}-mimic-${RUN}`, { [LABEL_MANAGED]: "true", [LABEL_INSTANCE]: "otra-instancia" });
    victims.managedOnly = victim(`${PFX}-managed-${RUN}`, { [LABEL_MANAGED]: "true" });
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    cleanup();
  }, 60_000);

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text };
  };

  it("positivo: create 201 (labels impuestas DE VERDAD), start 204, json 200, stats 200, stop 204; AutoRemove → 404", async () => {
    const name = `${PFX}-ok-${RUN}`;
    const c = await call("POST", `/containers/create?name=${name}`, createBody());
    expect(c.status, c.text).toBe(201);
    const id = JSON.parse(c.text).Id as string;
    const labels = JSON.parse(docker("inspect", "-f", "{{json .Config.Labels}}", id));
    expect(labels[LABEL_MANAGED]).toBe("true");
    expect(labels[LABEL_INSTANCE]).toBe(INSTANCE);
    expect((await call("POST", `/containers/${id}/start`)).status).toBe(204);
    const j = await call("GET", `/containers/${id}/json`);
    expect(j.status).toBe(200);
    // P8/P9 sobre el contenedor REAL: postura conforme y límites aplicados por la Engine.
    const inspected = JSON.parse(j.text);
    expect(complianceViolations(DockerContainerRunner.analyzeInspect(inspected))).toEqual([]);
    expect(inspected.HostConfig.Privileged).toBe(false);
    expect(inspected.HostConfig.CapDrop).toContain("ALL");
    expect(inspected.HostConfig.ReadonlyRootfs).toBe(true);
    expect(inspected.Config.User).toBe("10001:10001");
    expect(inspected.HostConfig.Memory).toBe(DEFAULT_LIMITS.memoryBytes);
    expect(inspected.HostConfig.PidsLimit).toBe(DEFAULT_LIMITS.pids);
    expect(inspected.HostConfig.NanoCpus).toBe(Math.round(DEFAULT_LIMITS.cpus * 1e9));
    expect(Object.keys(inspected.NetworkSettings.Networks)).toEqual(["arena"]);
    expect(inspected.Mounts).toEqual([]);
    expect((await call("GET", `/containers/${id}/stats?stream=false`)).status).toBe(200);
    expect((await call("POST", `/containers/${id}/stop?t=1`)).status).toBe(204);
    // AutoRemove es asíncrono: hasta 15 s para que la Engine lo borre.
    let after = 0;
    for (let i = 0; i < 30 && after !== 404; i++) {
      after = (await call("GET", `/containers/${id}/json`)).status;
      if (after !== 404) await new Promise((r) => setTimeout(r, 500));
    }
    expect(after).toBe(404);
    expect((await call("POST", `/containers/${id}/stop?t=1`)).status).toBe(404); // el runner lo trata como «ya parado»
  }, 60_000);

  it("el runner real (ProxyContainerRunner) lanza, mide, consulta state() y para a través del proxy endurecido", async () => {
    const runner = new ProxyContainerRunner(url);
    const handle = await runner.launch({
      imageDigest: RUNTIME_NODE,
      botId: `${PFX}-${RUN}`,
      version: 1,
      battleId: "runner",
      network: "arena",
      engineEndpoint: "ws://127.0.0.1:9",
      env: {},
      limits: DEFAULT_LIMITS,
      seccompProfilePath: SECCOMP_PATH,
      cmd: ["-e", "setInterval(()=>{},1e9)"],
      autoRemove: true,
    });
    try {
      expect(complianceViolations(await handle.posture())).toEqual([]);
      expect(await handle.state()).toMatchObject({ running: true, gone: false });
      const cpu = await handle.cpuMs();
      expect(cpu === null || cpu >= 0).toBe(true);
    } finally {
      await handle.stop();
    }
    await expect(handle.stop()).resolves.toBeUndefined(); // segundo stop: 404/304, no lanza
  }, 60_000);

  // N20 de OPS-C: create con una imagen fijada por digest que NO es runtime de bots.
  const localForeign = (() => {
    if (!DOCKER_E2E) return [];
    const out = dockerOk("images", "--digests", "--format", "{{.Repository}}@{{.Digest}}").out;
    return out
      .split("\n")
      .filter((l) => /@sha256:[0-9a-f]{64}$/.test(l) && !RUNTIMES.includes(l))
      .slice(0, 3);
  })();
  const foreign = [
    ...localForeign,
    `postgres@sha256:${"7".repeat(63)}1`,
    RUNTIME_NODE.replace(/@sha256:.*/, ":latest"),
    ...loadImageAllowlistBases(),
  ];
  for (const image of foreign) {
    it(`N20 · create con imagen ajena ${image.slice(0, 60)}… → 403 y NO se crea nada`, async () => {
      const name = `${PFX}-n20-${randomBytes(3).toString("hex")}`;
      const r = await call("POST", `/containers/create?name=${name}`, createBody({ Image: image }));
      expect(r.status, r.text).toBe(403);
      expect(dockerOk("inspect", name).ok).toBe(false);
    });
  }

  for (const [label, key] of [
    ["sin labels", "plain"],
    ["labels de OTRA instancia", "mimic"],
    ["sólo s9.managed=true", "managedOnly"],
  ]) {
    it(`N21–N23 · víctima ${label}: inspect/stats/stop/start → 403; sigue running con el MISMO StartedAt`, async () => {
      const id = victims[key];
      const before = inspectState(id);
      expect(before.Running).toBe(true);
      for (const [m, p] of [
        ["GET", `/containers/${id}/json`],
        ["GET", `/containers/${id}/stats?stream=false`],
        ["POST", `/containers/${id}/stop?t=1`],
        ["POST", `/containers/${id}/start`],
      ]) {
        const r = await call(m, p);
        expect(r.status, `${m} ${p}: ${r.text}`).toBe(403);
      }
      const after = inspectState(id);
      expect(after.Running).toBe(true);
      expect(after.StartedAt).toBe(before.StartedAt);
      expect(after.FinishedAt).toBe(before.FinishedAt);
    }, 30_000);
  }

  it("por NOMBRE o prefijo corto de la víctima → 403 (el proxy nunca resuelve por nombre)", async () => {
    for (const ref of [`${PFX}-victim-${RUN}`, victims.plain.slice(0, 12)]) {
      expect((await call("POST", `/containers/${ref}/stop`)).status).toBe(403);
    }
    expect(inspectState(victims.plain).Running).toBe(true);
  });

  it("operaciones fuera de la allowlist sobre la víctima → 403 (kill, DELETE, exec, logs, update) y no la tocan", async () => {
    const id = victims.plain;
    const startedAt = inspectState(id).StartedAt;
    for (const [m, p] of [
      ["POST", `/containers/${id}/kill`],
      ["DELETE", `/containers/${id}?force=true`],
      ["POST", `/containers/${id}/exec`],
      ["GET", `/containers/${id}/logs?stdout=1`],
      ["POST", `/containers/${id}/update`],
      ["POST", `/containers/${id}/restart`],
      ["GET", "/containers/json?all=1"],
      ["POST", "/images/create?fromImage=alpine"],
    ]) {
      expect((await call(m, p, m === "POST" ? {} : undefined)).status, `${m} ${p}`).toBe(403);
    }
    const st = inspectState(id);
    expect(st.Running).toBe(true);
    expect(st.StartedAt).toBe(startedAt);
  });

  it("create hostil (label s9.* del cliente / privileged / docker.sock / red host) → 403 y nada creado", async () => {
    const bodies: Array<[string, Record<string, unknown>]> = [
      ["label s9.managed", createBody({ Labels: { [LABEL_MANAGED]: "true" } })],
      ["label s9.proxy.instance", createBody({ Labels: { [LABEL_INSTANCE]: INSTANCE } })],
    ];
    const base = createBody() as any;
    bodies.push(["privileged", { ...base, HostConfig: { ...base.HostConfig, Privileged: true } }]);
    bodies.push([
      "docker.sock",
      { ...base, HostConfig: { ...base.HostConfig, Binds: ["/var/run/docker.sock:/var/run/docker.sock"] } },
    ]);
    bodies.push(["red host", { ...base, HostConfig: { ...base.HostConfig, NetworkMode: "host" } }]);
    for (const [label, body] of bodies) {
      const name = `${PFX}-hostile-${randomBytes(3).toString("hex")}`;
      const r = await call("POST", `/containers/create?name=${name}`, body);
      expect(r.status, `${label}: ${r.text}`).toBe(403);
      expect(dockerOk("inspect", name).ok, label).toBe(false);
    }
  });

  it("cada denegación quedó registrada con motivo y origen", () => {
    const denied = decisions.filter((d) => !d.allowed);
    expect(denied.length).toBeGreaterThan(10);
    for (const d of denied) {
      expect(d.reason).toBeTruthy();
      expect(d.client).toBe("127.0.0.1");
    }
  });
});

function loadImageAllowlistBases(): string[] {
  // La 2.ª columna (imagen BASE) del lock: nunca debe poder crearse.
  return execFileSync("awk", ["!/^#/ && NF==3 {print $2}", join(REPO, "runtimes", "DIGESTS.lock")], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
}

// ── control de cliente con contenedores reales y el PROCESO real del proxy ───

const CTL_SUBNET = "10.89.246.0/24";
const PUB_SUBNET = "10.89.245.0/24";

describe.skipIf(!DOCKER_E2E)(
  "RC2 · P10 · control de cliente: proceso real del proxy, clientes en contenedores reales",
  () => {
    const ctlNet = `${PFX}-ctl-${RUN}`;
    const pubNet = `${PFX}-pub-${RUN}`;
    const proxyName = `${PFX}-proxy-${RUN}`;
    let proxyCtlIp = "";
    let proxyPubIp = "";
    let bundleDir = "";

    beforeAll(() => {
      docker("network", "create", "--internal", "--subnet", CTL_SUBNET, "--label", `${PFX}.run=${RUN}`, ctlNet);
      docker("network", "create", "--subnet", PUB_SUBNET, "--label", `${PFX}.run=${RUN}`, pubNet);
      const nodeHome = dirname(dirname(process.execPath));
      // TD-062: el proxy corre DESDE EL BUNDLE (como la unidad de producción), sin montar
      // el repo ni node_modules: si el bundle necesitara algo del árbol, no arrancaría.
      // La allowlist es una copia montada en la ruta de producción.
      bundleDir = mkdtempSync(join(tmpdir(), `${PFX}-bundle-`));
      execFileSync(process.execPath, [BUILD, "--out", join(bundleDir, "lib", "docker-proxy.mjs")], { encoding: "utf8" });
      mkdirSync(join(bundleDir, "policy"));
      copyFileSync(join(REPO, "runtimes", "DIGESTS.lock"), join(bundleDir, "policy", "DIGESTS.lock"));
      chmodSync(bundleDir, 0o755);
      docker(
        "run",
        "-d",
        "--name",
        proxyName,
        "--label",
        `${PFX}.run=${RUN}`,
        "--user",
        "0:0",
        "--network",
        ctlNet,
        "-v",
        `${join(bundleDir, "lib")}:/usr/local/lib/s9-docker-proxy:ro`,
        "-v",
        `${join(bundleDir, "policy")}:/etc/s9-docker-proxy:ro`,
        "-v",
        `${nodeHome}:/opt/node:ro`,
        "-v",
        `${dockerSocketPath()}:/var/run/docker.sock`,
        "-e",
        "DOCKER_PROXY_BIND=0.0.0.0",
        "-e",
        "DOCKER_PROXY_INSECURE_BIND_FOR_TESTS=1",
        "-e",
        `DOCKER_PROXY_ALLOWED_CLIENTS=${CTL_SUBNET}`,
        "-e",
        "DOCKER_PROXY_PORT=2375",
        "-e",
        `DOCKER_PROXY_INSTANCE=${INSTANCE}`,
        "-e",
        "DOCKER_SOCKET=/var/run/docker.sock",
        "-e",
        "DOCKER_PROXY_IMAGE_ALLOWLIST=/etc/s9-docker-proxy/DIGESTS.lock",
        "-w",
        "/",
        "--entrypoint",
        "/opt/node/bin/node",
        RUNTIME_NODE,
        "--no-addons",
        "/usr/local/lib/s9-docker-proxy/docker-proxy.mjs",
      );
      docker("network", "connect", pubNet, proxyName);
      const nets = JSON.parse(docker("inspect", "-f", "{{json .NetworkSettings.Networks}}", proxyName));
      proxyCtlIp = nets[ctlNet].IPAddress;
      proxyPubIp = nets[pubNet].IPAddress;
      const deadline = Date.now() + 60_000;
      while (!/proxy de Docker escuchando/.test(dockerOk("logs", proxyName).out)) {
        if (Date.now() > deadline) throw new Error(`el proxy no arrancó: ${dockerOk("logs", proxyName).out}`);
        execFileSync("sleep", ["0.5"]);
      }
    }, 120_000);

    afterAll(() => {
      cleanup();
      dockerOk("network", "rm", ctlNet, pubNet);
      if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
    }, 60_000);

    it("TD-062: el proceso del proxy es el BUNDLE instalado (sin repo ni node_modules montados)", () => {
      const line = dockerOk("logs", proxyName)
        .out.split("\n")
        .find((l) => l.includes("proxy de Docker escuchando"));
      const j = JSON.parse(line!);
      expect(j.artifact.kind).toBe("bundle");
      expect(j.imageAllowlist.path).toBe("/etc/s9-docker-proxy/DIGESTS.lock");
      const mounts = JSON.parse(docker("inspect", "-f", "{{json .Mounts}}", proxyName)) as { Destination: string }[];
      expect(mounts.map((m) => m.Destination).sort()).toEqual(
        ["/etc/s9-docker-proxy", "/opt/node", "/usr/local/lib/s9-docker-proxy", "/var/run/docker.sock"].sort(),
      );
    });

    /** Cliente HTTP en un contenedor de verdad, en la red dada. */
    function clientCall(network: string, target: string, path: string): { status: number; body: string } {
      const js =
        `fetch(${JSON.stringify(`http://${target}:2375${path}`)})` +
        `.then(async r=>console.log(JSON.stringify({status:r.status,body:await r.text()})))` +
        `.catch(e=>console.log(JSON.stringify({status:-1,body:String(e.cause?.code??e.message)})))`;
      const out = docker(
        "run",
        "--rm",
        "--name",
        `${PFX}-client-${randomBytes(3).toString("hex")}`,
        "--label",
        `${PFX}.run=${RUN}`,
        "--network",
        network,
        "--entrypoint",
        "node",
        RUNTIME_NODE,
        "-e",
        js,
      );
      return JSON.parse(out.split("\n").pop()!);
    }

    const probePath = `/containers/${"0".repeat(63)}1/json`;

    it("cliente en la subred admitida (consumidor): PASA el control de cliente (404 del inspect, no 403)", () => {
      const r = clientCall(ctlNet, proxyCtlIp, probePath);
      expect(r.status, r.body).toBe(404);
    }, 60_000);

    it("cliente en una red NO interna ajena (caso gateway/backup) que ALCANZA el listener: 403 cliente no autorizado", () => {
      const r = clientCall(pubNet, proxyPubIp, probePath);
      expect(r.status, r.body).toBe(403);
      expect(r.body).toMatch(/cliente no autorizado/);
    }, 60_000);

    it("proceso local del «host» del proxy que conecta a la IP de la red de control (origen ∈ subred admitida) → 403", () => {
      // Análogo del hallazgo de DEV-SECOPS: un proceso del host que conecta a 10.89.250.1
      // sale con origen 10.89.250.1, dentro de 10.89.250.0/24. Aquí el «host» del proxy es
      // su contenedor: un proceso en él conecta a su propia IP de la red de control.
      const js =
        `fetch(${JSON.stringify(`http://${proxyCtlIp}:2375${probePath}`)})` +
        `.then(async r=>console.log(JSON.stringify({status:r.status,body:await r.text()})))` +
        `.catch(e=>console.log(JSON.stringify({status:-1,body:String(e.cause?.code??e.message)})))`;
      const out = docker("exec", proxyName, "/opt/node/bin/node", "-e", js);
      const r = JSON.parse(out.split("\n").pop()!) as { status: number; body: string };
      expect(proxyCtlIp.startsWith(CTL_SUBNET.split(".").slice(0, 3).join("."))).toBe(true);
      expect(r.status, r.body).toBe(403);
      expect(r.body).toMatch(/cliente no autorizado/);
    }, 60_000);

    it("el proxy registró la denegación con la IP de origen de la red ajena", () => {
      const logs = dockerOk("logs", proxyName).out;
      const pubPrefix = PUB_SUBNET.split(".").slice(0, 3).join(".");
      expect(logs).toMatch(new RegExp(`cliente no autorizado: ${pubPrefix.replace(/\./g, "\\.")}\\.\\d+`));
    });
  },
);
