// RC2 · DEV-SECOPS — firewall de host como código (infrastructure/firewall/s9-firewall.sh).
//
// La prueba autoritativa es el arnés de netns (tests/netns-harness.sh): conexiones TCP
// REALES desde clientes en sus propios netns hacia un «host» simulado, con un control
// negativo (sin reglas todo conecta), y fases de idempotencia, deriva de Tailscale, deriva
// de contenido, configuración insegura y retirada. Aquí se exige su veredicto completo
// (pass == expected, fail == 0): si no se puede crear un netns el test FALLA, no se salta.
// Se añaden comprobaciones semánticas de las unidades systemd que lo persisten.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
const SCRIPT = join(here, "s9-firewall.sh");
const HARNESS = join(here, "tests", "netns-harness.sh");
const SYSTEMD = join(here, "..", "systemd");

function parseUnit(path: string): Record<string, Record<string, string[]>> {
  const out: Record<string, Record<string, string[]>> = {};
  let sec = "";
  for (const raw of readFileSync(path, "utf8").replace(/\\\n/g, " ").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const m = /^\[(.+)\]$/.exec(line);
    if (m) {
      sec = m[1];
      out[sec] ??= {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq > 0) (out[sec][line.slice(0, eq).trim()] ??= []).push(line.slice(eq + 1).trim());
  }
  return out;
}
const words = (v: string[] | undefined) => (v ?? []).flatMap((x) => x.split(/\s+/)).filter(Boolean);

describe("s9-firewall.sh · arnés en netns aislado (conexiones reales)", () => {
  it("todas las fases en verde: control negativo, apply, idempotencia, derivas, config, remove, shim", () => {
    const r = spawnSync("bash", [HARNESS], { encoding: "utf8", timeout: 170000 });
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    expect(r.status, out).not.toBe(77); // sin netns posible: FALLA, no se salta
    const m = /RESULT pass=(\d+) fail=(\d+) expected=(\d+)/.exec(out);
    expect(m, out).not.toBeNull();
    const [pass, fail, expected] = m!.slice(1).map(Number);
    expect(fail, out).toBe(0);
    expect(pass, out).toBe(expected);
    expect(expected).toBeGreaterThanOrEqual(55); // la matriz no puede encogerse en silencio
    // El control negativo existe y conectó: sin él, un TIMEOUT no probaría nada.
    expect(out).toMatch(/^PASS \[control\] pub->proxy:2375 \(CONNECT\)$/m);
    expect(out).toMatch(/^PASS \[applied\] pub->proxy:2375 \(TIMEOUT\)$/m);
    expect(out).toMatch(/^PASS \[applied\] ctl->proxy:2375 \(CONNECT\)$/m);
    expect(r.status, out).toBe(0);
  }, 180000);
});

describe("s9-firewall.sh · configuración (sin root)", () => {
  const print = (env: Record<string, string> = {}) =>
    spawnSync("bash", [SCRIPT, "print"], { encoding: "utf8", env: { ...process.env, S9FW_CONF: "/dev/null", ...env } });

  it("print: la única aceptación de 2375 exige -i s9-botctl0, origen 10.89.250.0/24 y destino 10.89.250.1, y va ANTES del DROP", () => {
    const r = print();
    expect(r.status).toBe(0);
    const v4 = r.stdout
      .split("# IPv6")[0]
      .split("\n")
      .filter((l) => l.startsWith("-A "));
    const allow = v4.findIndex((l) => l.includes("-j RETURN"));
    const drop = v4.findIndex((l) => l.includes("--dport 2375 -j DROP"));
    expect(v4.filter((l) => l.includes("-j RETURN"))).toEqual([
      "-A S9-HOST-GUARD -s 10.89.250.0/24 -d 10.89.250.1/32 -i s9-botctl0 -p tcp -m tcp --dport 2375 -j RETURN",
    ]);
    expect(allow).toBeGreaterThanOrEqual(0);
    expect(drop).toBeGreaterThan(allow);
    for (const i of ["br-+", "docker0", "s9-botctl0"])
      expect(v4).toContain(`-A S9-HOST-GUARD -i ${i} -p tcp -m tcp --dport 22 -j DROP`);
  });

  for (const [name, env] of [
    ["subred 0.0.0.0/0", { S9FW_SUBNET: "0.0.0.0/0" }],
    ["subred que no es dirección de red", { S9FW_SUBNET: "10.89.250.1/24" }],
    ["bridge docker0", { S9FW_BRIDGE: "docker0" }],
    ["bridge comodín", { S9FW_BRIDGE: "br-+" }],
    ["proxy fuera de la subred", { S9FW_PROXY_IP: "172.17.0.1" }],
    ["puerto inválido", { S9FW_PROXY_PORT: "99999" }],
    ["sshd bloqueado en lo", { S9FW_SSH_BLOCK_IFACES: "lo" }],
  ] as const) {
    it(`rechaza ${name} ⇒ rc=2`, () => expect(print(env).status).toBe(2));
  }
});

describe("unidades systemd del firewall", () => {
  const svc = parseUnit(join(SYSTEMD, "s9-firewall.service"));
  const re = parseUnit(join(SYSTEMD, "s9-firewall-reassert.service"));
  const timer = parseUnit(join(SYSTEMD, "s9-firewall-reassert.timer"));

  it("s9-firewall.service aplica tras Docker y Tailscale, antes del proxy, y se re-aplica si se reinician", () => {
    expect(words(svc.Unit.After)).toEqual(expect.arrayContaining(["docker.service", "tailscaled.service"]));
    expect(words(svc.Unit.Before)).toContain("s9-docker-proxy.service");
    expect(words(svc.Unit.PartOf)).toEqual(expect.arrayContaining(["docker.service", "tailscaled.service"]));
    expect(words(svc.Install.WantedBy)).toEqual(expect.arrayContaining(["multi-user.target", "docker.service"]));
    expect(svc.Service.Type).toEqual(["oneshot"]);
    expect(svc.Service.RemainAfterExit).toEqual(["yes"]);
    expect(svc.Service.ExecStart).toEqual(["/usr/local/sbin/s9-firewall apply"]);
  });

  it("parar la unidad NO retira las reglas (no hay ExecStop)", () => {
    expect(svc.Service.ExecStop).toBeUndefined();
    expect(re.Service.ExecStop).toBeUndefined();
  });

  it("el timer re-afirma periódicamente con apply (idempotente)", () => {
    expect(timer.Timer.Unit).toEqual(["s9-firewall-reassert.service"]);
    expect(timer.Timer.OnUnitActiveSec).toEqual(["5min"]);
    expect(re.Service.ExecStart).toEqual(["/usr/local/sbin/s9-firewall apply"]);
  });

  it("ninguna unidad ejecuta el script desde el clon (escribible por el usuario de despliegue)", () => {
    for (const u of [svc, re])
      for (const e of [...(u.Service.ExecStart ?? []), ...(u.Service.ExecReload ?? [])])
        expect(e.startsWith("/opt/")).toBe(false);
  });

  it("Documentation= de las tres unidades existe en el árbol", () => {
    for (const u of [svc, re, timer]) {
      for (const d of words(u.Unit.Documentation)) {
        expect(d.startsWith("file:///opt/s9-ai-arena/")).toBe(true);
        expect(existsSync(join(ROOT, d.slice("file:///opt/s9-ai-arena/".length)))).toBe(true);
      }
    }
  });
});
