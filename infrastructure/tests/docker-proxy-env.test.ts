// Contrato de red de los runners (bug real de VM108): `ARENA_NETWORK` del proxy DEBE
// ser `arena` — el nombre EXACTO que exige compliance.mjs (fuente de verdad, compartida
// con el escáner del Compose). El Compose declara la red con `name: arena` para que NO
// se prefije con el proyecto (evita `infrastructure_arena`, que el proxy rechazaría).
//
// RC2 · DEV-SECOPS: además, el env de ejemplo fija las constantes del contrato RC2 (bind en
// el gateway de `bot-control`, clientes, allowlist de imágenes), `install-docker-proxy.sh
// check-env` rechaza configuraciones inseguras (cada mutación ⇒ rc≠0) sin ejecutar el
// fichero, y el ExecStartPre REAL de la unidad se ejecuta en un netns aislado.
import { afterAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
const ENV_PATH = join(here, "..", "systemd", "docker-proxy.env.example");
const UNIT_PATH = join(here, "..", "systemd", "s9-docker-proxy.service");
const COMPOSE_PATH = join(here, "..", "docker-compose.yml");
const INSTALLER = join(here, "..", "scripts", "install-docker-proxy.sh");
const REAL_LOCK = join(ROOT, "runtimes", "DIGESTS.lock");

function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}
const readEnv = () => parseEnvText(readFileSync(ENV_PATH, "utf8"));

/** Unidad systemd → { sección: { clave: [valores] } }, con continuaciones `\` unidas. */
function parseUnit(path: string): Record<string, Record<string, string[]>> {
  const joined = readFileSync(path, "utf8").replace(/\\\n/g, " ");
  const out: Record<string, Record<string, string[]>> = {};
  let sec = "";
  for (const raw of joined.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const m = /^\[(.+)\]$/.exec(line);
    if (m) {
      sec = m[1];
      out[sec] ??= {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    (out[sec][k] ??= []).push(line.slice(eq + 1).trim());
  }
  return out;
}
const words = (vals: string[] | undefined) => (vals ?? []).flatMap((v) => v.split(/\s+/)).filter(Boolean);

describe("docker-proxy.env.example · ARENA_NETWORK", () => {
  const env = readEnv();
  const compose = parse(readFileSync(COMPOSE_PATH, "utf8"), { merge: true });

  it("el compose define una red `arena`", () => {
    expect(Object.keys(compose.networks ?? {})).toContain("arena");
  });

  it("la red `arena` fija `name: arena` (no se prefija con el proyecto)", () => {
    expect(compose.networks?.arena?.name).toBe("arena");
  });

  it("ARENA_NETWORK es exactamente `arena`", () => {
    expect(env.ARENA_NETWORK).toBe("arena");
  });

  it("NO usa nombres prefijados ni erróneos", () => {
    expect(env.ARENA_NETWORK).not.toBe("infrastructure_arena");
    expect(env.ARENA_NETWORK).not.toBe("s9-ai-arena_arena");
  });
});

describe("docker-proxy.env.example · contrato RC2", () => {
  const env = readEnv();

  it("bind = gateway de bot-control (10.89.250.1:2375), nunca docker0/host-gateway/comodín", () => {
    expect(env.DOCKER_PROXY_BIND).toBe("10.89.250.1");
    expect(env.DOCKER_PROXY_PORT).toBe("2375");
    expect(env.DOCKER_PROXY_BIND).not.toMatch(/^(0\.0\.0\.0|::|127\.|172\.17\.)/);
  });

  it("bridge dedicado s9-botctl0 y clientes admitidos = 10.89.250.0/24", () => {
    expect(env.DOCKER_PROXY_BRIDGE).toBe("s9-botctl0");
    expect(env.DOCKER_PROXY_ALLOWED_CLIENTS).toBe("10.89.250.0/24");
  });

  it("allowlist de imágenes = runtimes/DIGESTS.lock del árbol desplegado; instancia por defecto", () => {
    expect(env.DOCKER_PROXY_IMAGE_ALLOWLIST).toBe("/opt/s9-ai-arena/runtimes/DIGESTS.lock");
    expect(env.DOCKER_PROXY_INSTANCE).toBe("s9-docker-proxy");
  });
});

// ------------------------------------------------------------------ check-env ----

const tmp = mkdtempSync(join(tmpdir(), "rc2so-env-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

/** Env de ejemplo con la allowlist apuntando al lock del repo y `edit` aplicado. */
function envVariant(edit: (lines: string[]) => string[]): string {
  const base = readFileSync(ENV_PATH, "utf8")
    .split("\n")
    .map((l) => (l.startsWith("DOCKER_PROXY_IMAGE_ALLOWLIST=") ? `DOCKER_PROXY_IMAGE_ALLOWLIST=${REAL_LOCK}` : l));
  n += 1;
  const p = join(tmp, `env-${n}`);
  writeFileSync(p, edit(base).join("\n"));
  return p;
}
const set = (k: string, v: string | null) => (lines: string[]) => {
  const rest = lines.filter((l) => !l.startsWith(`${k}=`));
  return v === null ? rest : [...rest, `${k}=${v}`];
};
function checkEnv(file: string, appDir = "/nonexistent-app-dir") {
  const r = spawnSync("bash", [INSTALLER, "check-env", file], {
    encoding: "utf8",
    env: { ...process.env, APP_DIR: appDir },
  });
  return { rc: r.status, out: r.stdout + r.stderr };
}

describe("install-docker-proxy.sh check-env", () => {
  it("el ejemplo (con la allowlist del repo) es conforme ⇒ rc=0", () => {
    const r = checkEnv(envVariant((l) => l));
    expect(r.out).toContain("conforme");
    expect(r.rc).toBe(0);
  });

  // Cada caso aísla UNA causa: los clientes se ajustan para contener el bind cuando hace
  // falta, de modo que el rechazo no pueda venir de la regla «bind fuera de los clientes»
  // (un rechazo sobredeterminado no prueba la regla que dice probar). Se exige un único
  // error y su motivo.
  const both =
    (...edits: ((l: string[]) => string[])[]) =>
    (l: string[]) =>
      edits.reduce((acc, e) => e(acc), l);
  const clients = (c: string) => set("DOCKER_PROXY_ALLOWED_CLIENTS", c);
  const bad: [string, (l: string[]) => string[], string][] = [
    ["bind 0.0.0.0", both(set("DOCKER_PROXY_BIND", "0.0.0.0"), clients("0.0.0.0/16")), "comodín o loopback"],
    ["bind loopback", both(set("DOCKER_PROXY_BIND", "127.0.0.1"), clients("127.0.0.0/24")), "comodín o loopback"],
    [
      "bind docker0 / host-gateway (172.17.0.1, el valor de RC1)",
      both(set("DOCKER_PROXY_BIND", "172.17.0.1"), clients("172.17.0.0/16")),
      "pool de docker0/host-gateway",
    ],
    ["bind vacío", set("DOCKER_PROXY_BIND", ""), "DOCKER_PROXY_BIND vacío"],
    ["bind ausente", set("DOCKER_PROXY_BIND", null), "DOCKER_PROXY_BIND vacío"],
    ["bind :: (IPv6 comodín)", set("DOCKER_PROXY_BIND", "::"), "IPv4 concreta"],
    ["bind host-gateway literal", set("DOCKER_PROXY_BIND", "host-gateway"), "IPv4 concreta"],
    ["bind fuera de los clientes admitidos", set("DOCKER_PROXY_BIND", "10.89.251.1"), "no pertenece"],
    ["puerto no numérico", set("DOCKER_PROXY_PORT", "abc"), "DOCKER_PROXY_PORT inválido"],
    ["bridge docker0", set("DOCKER_PROXY_BRIDGE", "docker0"), "DOCKER_PROXY_BRIDGE=docker0 prohibido"],
    ["espera del bridge > tope (80)", set("DOCKER_PROXY_BRIDGE_WAIT", "500"), "DOCKER_PROXY_BRIDGE_WAIT"],
    ["clientes ausentes", set("DOCKER_PROXY_ALLOWED_CLIENTS", null), "ALLOWED_CLIENTS vacío"],
    ["clientes 0.0.0.0/0", clients("0.0.0.0/0,10.89.250.0/24"), "demasiado ancho"],
    ["clientes no CIDR", clients("10.89.250.1,10.89.250.0/24"), "CIDR inválido"],
    // Ausente ⇒ se usa la del árbol ($APP_DIR/runtimes/DIGESTS.lock); aquí APP_DIR no existe.
    ["allowlist ausente y sin árbol", set("DOCKER_PROXY_IMAGE_ALLOWLIST", null), "no existe"],
    ["instancia inválida", set("DOCKER_PROXY_INSTANCE", "-mala/instancia"), "DOCKER_PROXY_INSTANCE inválido"],
    ["allowlist relativa", set("DOCKER_PROXY_IMAGE_ALLOWLIST", "runtimes/DIGESTS.lock"), "ruta absoluta"],
    ["allowlist inexistente", set("DOCKER_PROXY_IMAGE_ALLOWLIST", "/nonexistent/DIGESTS.lock"), "no existe"],
    ["ARENA_NETWORK prefijada", set("ARENA_NETWORK", "infrastructure_arena"), "ARENA_NETWORK"],
    ["sandbox como root", set("SANDBOX_USER", "0:0"), "no puede ser root"],
    ["sandbox sin gid", set("SANDBOX_USER", "10001"), "uid:gid"],
  ];
  for (const [name, edit, reason] of bad) {
    it(`RECHAZA: ${name} ⇒ rc=1 por «${reason}» (único error)`, () => {
      const r = checkEnv(envVariant(edit));
      expect(r.rc, r.out).toBe(1);
      expect(r.out).toContain("NO conforme (1 error/es)");
      expect(r.out).toContain(reason);
    });
  }

  it("allowlist ausente ⇒ usa runtimes/DIGESTS.lock del árbol (APP_DIR) y es conforme", () => {
    const r = checkEnv(envVariant(set("DOCKER_PROXY_IMAGE_ALLOWLIST", null)), ROOT);
    expect(r.rc, r.out).toBe(0);
  });

  it("RECHAZA una allowlist cuya 3ª columna no está por digest (tag)", () => {
    const lock = join(tmp, "tag.lock");
    writeFileSync(lock, `python python@sha256:${"a".repeat(64)} ghcr.io/x/bot-runtime-python:1.0\n`);
    expect(checkEnv(envVariant(set("DOCKER_PROXY_IMAGE_ALLOWLIST", lock))).rc).toBe(1);
  });

  it("NO ejecuta el fichero (se parsea, no se hace `source`)", () => {
    const marker = join(tmp, "pwned");
    const r = checkEnv(envVariant(set("DOCKER_PROXY_BIND", `$(touch ${marker})`)));
    expect(r.rc).toBe(1);
    expect(existsSync(marker)).toBe(false);
  });
});

// ------------------------------------------------------------- unidad systemd ----

describe("s9-docker-proxy.service · unidad", () => {
  const u = parseUnit(UNIT_PATH);

  it("Documentation= apunta a un fichero que EXISTE en el árbol (TD-056)", () => {
    const docs = words(u.Unit.Documentation);
    expect(docs.length).toBeGreaterThan(0);
    for (const d of docs) {
      expect(d.startsWith("file:///opt/s9-ai-arena/")).toBe(true);
      const rel = d.slice("file:///opt/s9-ai-arena/".length);
      expect(rel).toBe("docs/operations/docker-proxy.md");
      expect(existsSync(join(ROOT, rel))).toBe(true);
    }
  });

  it("After= y Requires= docker.service; tras el firewall (Wants, sin acoplarlo)", () => {
    expect(words(u.Unit.After)).toEqual(expect.arrayContaining(["docker.service", "s9-firewall.service"]));
    expect(words(u.Unit.Requires)).toContain("docker.service");
    expect(words(u.Unit.Wants)).toContain("s9-firewall.service");
  });

  it("EnvironmentFile del operador, usuario sin root y TimeoutStartSec > espera máxima (80×2 s)", () => {
    expect(u.Service.EnvironmentFile).toEqual(["/etc/s9-ai-arena/docker-proxy.env"]);
    expect(u.Service.User).toEqual(["s9proxy"]);
    expect(u.Service.RestartPreventExitStatus).toEqual(["78"]);
    expect(Number(u.Service.TimeoutStartSec?.[0])).toBeGreaterThan(160);
    expect(u.Service.ExecStartPre?.length).toBe(1);
  });
});

// El ExecStartPre REAL, extraído de la unidad, ejecutado en un netns aislado.
function execStartPreScript(): string {
  const v = parseUnit(UNIT_PATH).Service.ExecStartPre[0];
  const m = /^\/bin\/sh -ec '([\s\S]*)'$/.exec(v);
  if (!m) throw new Error(`ExecStartPre con forma inesperada: ${v.slice(0, 60)}`);
  return m[1].replace(/\$\$/g, "$"); // systemd: `$$` → `$` literal
}

function netnsLauncher(): string[] {
  if (process.getuid?.() === 0) return ["unshare", "-n"];
  // Se prueba la CAPACIDAD (crear un bridge), no sólo el userns: en Ubuntu 24.04 (AppArmor
  // restrict_unprivileged_userns) `unshare -rn true` funciona pero dentro no hay
  // CAP_NET_ADMIN; entonces se usa sudo -n (runners de GitHub).
  const probe = 'PATH="$PATH:/usr/sbin:/sbin"; ip link add rc2so-p type bridge && ip link set lo up';
  if (spawnSync("unshare", ["-rn", "sh", "-c", probe]).status === 0) return ["unshare", "-rn"];
  if (spawnSync("sudo", ["-n", "true"]).status === 0)
    return ["sudo", "-n", "env", `PATH=${process.env.PATH}`, "unshare", "-n"];
  throw new Error("no se puede crear un netns (ni userns sin privilegios ni sudo -n): el test NO se salta");
}

function runPre(setup: string, env: Record<string, string>) {
  const [cmd, ...pre] = netnsLauncher();
  const envArgs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  const body = `export PATH="$PATH:/usr/sbin:/sbin"; ${setup}\n${execStartPreScript()}`;
  const r = spawnSync(cmd, [...pre, "env", ...envArgs, "sh", "-ec", body], { encoding: "utf8", timeout: 60000 });
  return { rc: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

const BR = (name: string, cidr: string) =>
  `ip link add ${name} type bridge; ip addr add ${cidr} dev ${name}; ip link set ${name} up;`;
const OK_ENV = { DOCKER_PROXY_BIND: "10.89.250.1", DOCKER_PROXY_BRIDGE: "s9-botctl0", DOCKER_PROXY_BRIDGE_WAIT: "1" };

describe("s9-docker-proxy.service · ExecStartPre real en netns", () => {
  it("bridge con la IP del bind ⇒ rc=0", () => {
    const r = runPre(BR("s9-botctl0", "10.89.250.1/24"), OK_ENV);
    expect(r.rc, r.out).toBe(0);
  });

  it("bridge ausente ⇒ espera acotada y rc≠0 (no arranca)", () => {
    const r = runPre("", OK_ENV);
    expect(r.rc).toBe(1); // reintentable (no 78)
    expect(r.out).toContain("no tiene 10.89.250.1");
  });

  it("bridge presente pero con OTRA IP ⇒ rc≠0", () => {
    const r = runPre(BR("s9-botctl0", "10.89.250.2/24"), OK_ENV);
    expect(r.rc).not.toBe(0);
  });

  it("la IP del bind también en docker0 ⇒ rc≠0", () => {
    const r = runPre(BR("s9-botctl0", "10.89.250.1/24") + BR("docker0", "10.89.250.1/24"), OK_ENV);
    expect(r.rc).toBe(78);
    expect(r.out).toContain("docker0");
  });

  // La espera también fallaría con estos valores: se exige el MOTIVO, que sólo emite la
  // comprobación explícita (corre antes de esperar). Sin él, el rechazo estaría
  // sobredeterminado y no probaría la comprobación.
  for (const [name, env, reason] of [
    ["bind 0.0.0.0", { ...OK_ENV, DOCKER_PROXY_BIND: "0.0.0.0" }, "DOCKER_PROXY_BIND inválido"],
    ["bind vacío", { ...OK_ENV, DOCKER_PROXY_BIND: "" }, "DOCKER_PROXY_BIND inválido"],
    ["bind loopback", { ...OK_ENV, DOCKER_PROXY_BIND: "127.0.0.1" }, "DOCKER_PROXY_BIND inválido"],
    ["bridge docker0", { ...OK_ENV, DOCKER_PROXY_BRIDGE: "docker0" }, "DOCKER_PROXY_BRIDGE inválido"],
    ["espera no numérica", { ...OK_ENV, DOCKER_PROXY_BRIDGE_WAIT: "x" }, "DOCKER_PROXY_BRIDGE_WAIT inválido"],
  ] as const) {
    it(`RECHAZA ${name} aunque el bridge exista ⇒ rc≠0 por «${reason}»`, () => {
      const r = runPre(BR("s9-botctl0", "10.89.250.1/24") + BR("docker0", "172.17.0.1/16"), env);
      expect(r.rc).toBe(78); // EX_CONFIG: RestartPreventExitStatus=78, sin bucle
      expect(r.out).toContain(reason);
    });
  }
});

// ------------------------------------------------------- sonda /_ping (validate) ----
// Servidor HTTP REAL en otro proceso (spawnSync bloquearía el bucle de eventos de éste).
async function withServer(status: number, body: string, fn: (port: number) => void) {
  const code =
    `const s=require("http").createServer((q,r)=>{r.writeHead(${status},{"content-type":"application/json"});` +
    `r.end(${JSON.stringify(body)})});s.listen(0,"127.0.0.1",()=>console.log(s.address().port));`;
  const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const port = await new Promise<number>((res, rej) => {
      child.stdout.once("data", (d) => res(Number(String(d).trim())));
      child.once("exit", () => rej(new Error("el servidor de prueba terminó")));
    });
    fn(port);
  } finally {
    child.kill();
  }
}
const probe = (port: number) => {
  const r = spawnSync("bash", [INSTALLER, "probe", "127.0.0.1", String(port)], {
    encoding: "utf8",
    env: { ...process.env, PROBE_TIMEOUT: "2" },
  });
  return { rc: r.status, out: r.stdout + r.stderr };
};

describe("install-docker-proxy.sh probe · distingue los dos 403 por el cuerpo", () => {
  it("403 de la allowlist de endpoints ⇒ ENDPOINT_DENIED, rc=0", async () => {
    await withServer(403, JSON.stringify({ message: "endpoint fuera de la allowlist del proxy: GET /_ping" }), (p) => {
      const r = probe(p);
      expect(r.out).toContain("PING=ENDPOINT_DENIED");
      expect(r.rc).toBe(0);
    });
  });
  it("403 del control de cliente ⇒ CLIENT_DENIED, rc=0", async () => {
    await withServer(403, JSON.stringify({ message: "cliente no autorizado por el proxy de Docker" }), (p) => {
      const r = probe(p);
      expect(r.out).toContain("PING=CLIENT_DENIED");
      expect(r.rc).toBe(0);
    });
  });
  it("200 (un proxy que dejara pasar /_ping) ⇒ UNEXPECTED, rc=1", async () => {
    await withServer(200, "OK", (p) => {
      const r = probe(p);
      expect(r.out).toContain("PING=UNEXPECTED");
      expect(r.rc).toBe(1);
    });
  });
  it("403 con otro cuerpo ⇒ UNEXPECTED, rc=1 (no se acepta cualquier 403)", async () => {
    await withServer(403, JSON.stringify({ message: "otra cosa" }), (p) => {
      expect(probe(p).rc).toBe(1);
    });
  });
});

// ------------------------------------- costura con el lector del proxy (DEV-PROXY) ----
// Las variables que el PROCESO lee (por AST de docker-proxy-config.ts) y las del env de
// ejemplo deben coincidir: una variable del ejemplo que nadie lee es configuración
// muerta; una que el proceso lee y el ejemplo omite es un defecto que el operador no ve.
// Las únicas variables sólo de la unidad son las del ExecStartPre.
const PROXY_CONFIG = join(ROOT, "apps", "bot-manager", "src", "docker-proxy-config.ts");
const UNIT_ONLY = new Set(["DOCKER_PROXY_BRIDGE", "DOCKER_PROXY_BRIDGE_WAIT"]);
const TEST_ONLY = new Set(["DOCKER_PROXY_INSECURE_BIND_FOR_TESTS"]);

function envVarsReadBy(file: string): Set<string> {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    // env.X / process.env.X / env["X"]
    if (ts.isPropertyAccessExpression(n)) {
      const obj = n.expression.getText(sf);
      if (obj === "env" || obj === "process.env") out.add(n.name.text);
    } else if (ts.isElementAccessExpression(n) && ts.isStringLiteral(n.argumentExpression)) {
      const obj = n.expression.getText(sf);
      if (obj === "env" || obj === "process.env") out.add(n.argumentExpression.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe("docker-proxy.env.example ↔ docker-proxy-config.ts (costura con DEV-PROXY)", () => {
  it("existe el lector de configuración del proceso", () => {
    expect(existsSync(PROXY_CONFIG), "falta apps/bot-manager/src/docker-proxy-config.ts (rama DEV-PROXY)").toBe(true);
  });
  it("mismo conjunto de variables (salvo las de la unidad y las de tests)", () => {
    const read = [...envVarsReadBy(PROXY_CONFIG)].filter((v) => !TEST_ONLY.has(v)).sort();
    const example = Object.keys(readEnv())
      .filter((v) => !UNIT_ONLY.has(v))
      .sort();
    expect(read.length).toBeGreaterThanOrEqual(5); // el AST encontró lecturas de verdad
    expect(example).toEqual(read);
  });
});
