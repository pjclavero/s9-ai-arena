/**
 * RC2 (DEV-PROXY, defecto hallado por DEV-CI) · resolución de NOMBRES dentro del sandbox.
 *
 * En Compose el anfitrión del sandbox se anuncia por nombre (`BUILD_SANDBOX_HOST:
 * bot-build-worker`, `ARENA_ENGINE_HOST: tournament-worker`). glibc resuelve con
 * getaddrinfo(AF_UNSPEC) enviando A y AAAA en paralelo con `sendmmsg`; si el perfil
 * seccomp de los bots no lo permite, la consulta falla con EAI_AGAIN («Temporary
 * failure in name resolution») y el bootstrap no descarga el artefacto: ningún build
 * se publica y ninguna batalla arranca. Los E2E y el golden no lo veían porque
 * anuncian una IP.
 *
 * 1. Estático (CI normal): el perfil real sigue siendo default-deny y permite sendmmsg.
 * 2. Docker real (opt-in S9_RUN_DOCKER_SANDBOX_E2E=1): contenedor con la imagen de
 *    runtime (python y node), el perfil seccomp REAL del repo, `--dns 0.0.0.0`, usuario
 *    del sandbox, cap-drop ALL y rootfs de sólo lectura, en una red de prueba; resuelve
 *    por NOMBRE un servicio de esa red y descarga de él. Recursos `rc2px-`, se borran.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SECCOMP_PROFILE } from "../src/container-battle.js";
import { loadImageAllowlist } from "../src/docker-proxy.js";
import { DOCKER_E2E } from "./docker-sandbox-env.js";

const here = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(here, "..", "security", "seccomp-bot.json");

describe("RC2 · perfil seccomp de los bots (estático)", () => {
  const profile = JSON.parse(readFileSync(PROFILE, "utf8")) as {
    defaultAction: string;
    syscalls: Array<{ names: string[]; action: string }>;
  };
  const allowed = new Set(profile.syscalls.filter((s) => s.action === "SCMP_ACT_ALLOW").flatMap((s) => s.names));

  it("es el perfil que usan build y batallas", () => {
    expect(DEFAULT_SECCOMP_PROFILE).toBe(PROFILE);
  });
  it("sigue siendo default-deny (ERRNO o KILL)", () => {
    expect(profile.defaultAction).toMatch(/^SCMP_ACT_(ERRNO|KILL|KILL_PROCESS|KILL_THREAD)$/);
  });
  it("permite sendmmsg (getaddrinfo AF_UNSPEC de glibc) junto a sendmsg/sendto", () => {
    for (const s of ["sendmmsg", "sendmsg", "sendto"]) expect(allowed.has(s), s).toBe(true);
  });
});

const RUN = randomBytes(3).toString("hex");
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const tryDocker = (...args: string[]) => {
  try {
    return docker(...args);
  } catch {
    return "";
  }
};

describe.skipIf(!DOCKER_E2E)("RC2 · resolución por nombre con el seccomp real (Docker real)", () => {
  const images = [...loadImageAllowlist()];
  const PY = images.find((i) => i.includes("runtime-python"))!;
  const NODE = images.find((i) => i.includes("runtime-node"))!;
  const net = `rc2px-dns-${RUN}`;
  const srvName = `rc2px-dnssrv-${RUN}`;
  const alias = `artifact-host-${RUN}`;

  beforeAll(() => {
    for (const img of [PY, NODE]) docker("image", "inspect", "-f", "{{.Id}}", img);
    docker("network", "create", "--internal", "--label", `rc2px.run=${RUN}`, net);
    // Servicio CON NOMBRE en la red (como bot-build-worker en Compose); sin seccomp propio.
    docker(
      "run",
      "-d",
      "--name",
      srvName,
      "--label",
      `rc2px.run=${RUN}`,
      "--network",
      net,
      "--network-alias",
      alias,
      "--entrypoint",
      "python",
      PY,
      "-c",
      "import http.server as h\n" +
        "class H(h.BaseHTTPRequestHandler):\n" +
        "  def do_GET(s):\n" +
        "    s.send_response(200);s.end_headers();s.wfile.write(b'artifact-ok')\n" +
        "h.HTTPServer(('0.0.0.0',8080),H).serve_forever()",
    );
  }, 120_000);

  afterAll(() => {
    const ids = tryDocker("ps", "-aq", "--filter", `label=rc2px.run=${RUN}`).split("\n").filter(Boolean);
    if (ids.length) tryDocker("rm", "-f", ...ids);
    tryDocker("network", "rm", net);
  }, 60_000);

  /** Misma postura que el sandbox: perfil real, DNS bloqueado, sin caps, rootfs ro, usuario 10001. */
  function sandboxRun(image: string, entrypoint: string, args: string[]): { rc: number; out: string } {
    const cmd = [
      "run",
      "--rm",
      "--name",
      `rc2px-dnscli-${randomBytes(3).toString("hex")}`,
      "--label",
      `rc2px.run=${RUN}`,
      "--network",
      net,
      "--dns",
      "0.0.0.0",
      "--user",
      "10001:10001",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--security-opt",
      `seccomp=${PROFILE}`,
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=8m",
      "--entrypoint",
      entrypoint,
      image,
      ...args,
    ];
    try {
      return { rc: 0, out: execFileSync("docker", cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { rc: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  }

  // Espera a que el servidor escuche (desde un cliente SIN el perfil, para no confundir causas).
  beforeAll(() => {
    for (let i = 0; i < 40; i++) {
      const r = tryDocker(
        "run",
        "--rm",
        "--label",
        `rc2px.run=${RUN}`,
        "--network",
        net,
        "--entrypoint",
        "python",
        PY,
        "-c",
        `import urllib.request;print(urllib.request.urlopen('http://${alias}:8080/',timeout=2).read().decode())`,
      );
      if (r.includes("artifact-ok")) return;
      execFileSync("sleep", ["0.5"]);
    }
    throw new Error("el servicio de prueba no respondió");
  }, 120_000);

  it("python: socket.getaddrinfo(AF_UNSPEC) + urlopen por NOMBRE → 200", () => {
    const r = sandboxRun(PY, "python", [
      "-c",
      "import socket,urllib.request\n" +
        `print(sorted({a[0].name for a in socket.getaddrinfo('${alias}',8080,socket.AF_UNSPEC,socket.SOCK_STREAM)}))\n` +
        `print(urllib.request.urlopen('http://${alias}:8080/',timeout=5).read().decode())`,
    ]);
    expect(r.rc, r.out).toBe(0);
    expect(r.out).toContain("artifact-ok");
  }, 60_000);

  it("node: fetch por NOMBRE (getaddrinfo de libuv/glibc) → 200", () => {
    const r = sandboxRun(NODE, "node", [
      "-e",
      `fetch('http://${alias}:8080/').then(r=>r.text()).then(t=>console.log(t)).catch(e=>{console.error(String(e.cause?.code??e));process.exit(3)})`,
    ]);
    expect(r.rc, r.out).toBe(0);
    expect(r.out).toContain("artifact-ok");
  }, 60_000);
});
