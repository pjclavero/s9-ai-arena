// TD-062 · frontera de privilegio del s9-docker-proxy.
//
// Regla: «el llamador puede pedir una operación; no puede modificar la autoridad que la
// aplica». El proxy corre con el grupo `docker` (= root en el host); TODO lo que ejecuta o
// lee como política (código, intérprete, allowlist, entorno, unidad) es de root y no lo
// escribe nadie más, incluidos los padres hasta /.
//
// Qué prueba este fichero (en el job `unit`):
//   B  el BUNDLE: sólo entradas de apps/bot-manager/src, sólo importaciones node:*, determinista,
//      arranca COPIADO fuera del repo (sin node_modules) y exige la allowlist explícita.
//   U  la UNIDAD: ExecStart = node del sistema + bundle instalado; sin WorkingDirectory; el
//      árbol inaccesible; endurecimiento declarado; `systemd-analyze verify/security`.
//   P  `install` + `preflight` con PROPIETARIOS REALES del núcleo, no simulados: dentro de
//      un userns con subuids (`unshare --map-root-user --map-auto`: uid 0 = el usuario que
//      corre el test, 1000/65534 = subuids distintos) o, si el núcleo no lo permite (Ubuntu
//      24.04 con AppArmor), con `sudo -n` en el runner efímero. Las rutas del host van bajo
//      S9PX_ROOT (árbol de pruebas); la cadena de padres termina en esa raíz (declarado).
//      Cada MUTACIÓN pone el preflight en ROJO por SU motivo, y el árbol sin mutar en VERDE.
//   N  negativos con un usuario NO root real (65534): escribir/renombrar el bundle, la
//      allowlist, la unidad o el entorno ⇒ EACCES del núcleo.
// Ningún caso se salta: sin userns utilizable ni sudo, el test FALLA.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
const BUILD = join(ROOT, "infrastructure", "scripts", "build-docker-proxy-bundle.mjs");
const INSTALLER = join(ROOT, "infrastructure", "scripts", "install-docker-proxy.sh");
const UNIT_PATH = join(ROOT, "infrastructure", "systemd", "s9-docker-proxy.service");
const LOCK = join(ROOT, "runtimes", "DIGESTS.lock");

const BUNDLE_DST = "/usr/local/lib/s9-docker-proxy/docker-proxy.mjs";
const LOCK_DST = "/etc/s9-docker-proxy/DIGESTS.lock";
const EXPECTED_EXECSTART = `/usr/bin/node --no-addons ${BUNDLE_DST}`;

const tmp = mkdtempSync(join(tmpdir(), "rc3priv-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

type Built = { out: string; sha256: string; inputs: string[]; runtimeImports: string[]; commit: string };
function build(out: string): Built {
  const r = spawnSync(process.execPath, [BUILD, "--out", out, "--commit", "0".repeat(40)], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`build rc=${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

let bundle: Built;
beforeAll(() => {
  bundle = build(join(tmp, "dist", "docker-proxy.mjs"));
}, 60_000);

// ── B · bundle ──────────────────────────────────────────────────────────────
describe("B · bundle autocontenido del proxy", () => {
  it("entradas: SÓLO apps/bot-manager/src (ningún node_modules); importaciones: SÓLO node:*", () => {
    expect(bundle.inputs.length).toBeGreaterThanOrEqual(3);
    for (const i of bundle.inputs) expect(i.startsWith("apps/bot-manager/src/"), i).toBe(true);
    expect(bundle.inputs).toContain("apps/bot-manager/src/docker-proxy-main.ts");
    expect(bundle.runtimeImports.length).toBeGreaterThan(0);
    for (const i of bundle.runtimeImports) expect(i.startsWith("node:"), i).toBe(true);
  });

  it("determinista: dos builds del mismo commit ⇒ mismo sha256 (y el .sha256 lo registra)", () => {
    const again = build(join(tmp, "dist2", "docker-proxy.mjs"));
    expect(again.sha256).toBe(bundle.sha256);
    expect(readFileSync(`${bundle.out}.sha256`, "utf8")).toBe(`${bundle.sha256}  docker-proxy.mjs\n`);
  });

  /** Arranca el bundle COPIADO a un directorio sin node_modules, con cwd fuera del repo. */
  function runCopied(env: Record<string, string>, waitFor: RegExp | null) {
    const dir = mkdtempSync(join(tmp, "lib-"));
    const file = join(dir, "docker-proxy.mjs");
    copyFileSync(bundle.out, file);
    const child = spawn(process.execPath, ["--no-addons", file], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    return new Promise<{ rc: number | null; out: string }>((res) => {
      const t = setTimeout(() => {
        child.kill();
      }, 15_000);
      child.stdout.on("data", () => {
        if (waitFor && waitFor.test(out)) child.kill();
      });
      child.on("exit", (rc) => {
        clearTimeout(t);
        res({ rc, out });
      });
    });
  }

  it("copiado fuera del repo (sin node_modules, cwd ajeno) ARRANCA y declara artifact=bundle", async () => {
    const lock = join(tmp, "lock-copy");
    copyFileSync(LOCK, lock);
    const r = await runCopied(
      {
        DOCKER_PROXY_BIND: "127.0.0.1",
        DOCKER_PROXY_PORT: String(20000 + Math.floor(Math.random() * 20000)),
        DOCKER_PROXY_IMAGE_ALLOWLIST: lock,
        DOCKER_SOCKET: join(tmp, "no-socket"),
      },
      /escuchando/,
    );
    const line = r.out.split("\n").find((l) => l.includes("escuchando"));
    expect(line, r.out).toBeTruthy();
    const j = JSON.parse(line!);
    expect(j.artifact).toMatchObject({ kind: "bundle", commit: "0".repeat(40) });
    expect(j.imageAllowlist.path).toBe(lock);
    expect(j.imageAllowlist.images.length).toBeGreaterThan(0);
  }, 30_000);

  it("en el bundle la allowlist es OBLIGATORIA: sin DOCKER_PROXY_IMAGE_ALLOWLIST ⇒ exit 78 (no la deduce del árbol)", async () => {
    const r = await runCopied({ DOCKER_PROXY_BIND: "127.0.0.1", DOCKER_PROXY_PORT: "23750" }, null);
    expect(r.rc, r.out).toBe(78);
    expect(r.out).toContain("DOCKER_PROXY_IMAGE_ALLOWLIST es obligatoria");
  }, 30_000);

  it("en el bundle una allowlist RELATIVA también ⇒ exit 78", async () => {
    const r = await runCopied(
      {
        DOCKER_PROXY_BIND: "127.0.0.1",
        DOCKER_PROXY_PORT: "23751",
        DOCKER_PROXY_IMAGE_ALLOWLIST: "runtimes/DIGESTS.lock",
      },
      null,
    );
    expect(r.rc, r.out).toBe(78);
  }, 30_000);
});

// ── U · unidad ──────────────────────────────────────────────────────────────
function parseUnit(text: string): Record<string, Record<string, string[]>> {
  const joined = text.replace(/\\\n/g, " ");
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
    (out[sec][line.slice(0, eq).trim()] ??= []).push(line.slice(eq + 1).trim());
  }
  return out;
}

describe("U · s9-docker-proxy.service ejecuta el artefacto instalado", () => {
  const S = parseUnit(readFileSync(UNIT_PATH, "utf8")).Service;
  const words = (k: string) => (S[k] ?? []).flatMap((v) => v.split(/\s+/)).filter(Boolean);

  it("ExecStart = /usr/bin/node --no-addons <bundle de root>; sin npx/tsx/node_modules", () => {
    expect(S.ExecStart).toEqual([EXPECTED_EXECSTART]);
  });

  it("sin WorkingDirectory; ninguna Exec*/Environment*/montaje apunta a /opt, npx o tsx", () => {
    expect(S.WorkingDirectory).toBeUndefined();
    for (const [k, vals] of Object.entries(S)) {
      if (!/^(Exec|WorkingDirectory|RootDirectory|Environment|Bind|ReadWritePaths)/.test(k)) continue;
      for (const v of vals) {
        expect(v, k).not.toMatch(/\/opt\//);
        expect(` ${v} `, k).not.toMatch(/[\s/](npx|tsx)\s|node_modules/);
      }
    }
  });

  it("el árbol de despliegue es inaccesible; código y allowlist de sólo lectura; sólo el socket escribible", () => {
    expect(words("InaccessiblePaths")).toContain("-/opt/s9-ai-arena");
    expect(words("ReadOnlyPaths")).toEqual(
      expect.arrayContaining(["/usr/local/lib/s9-docker-proxy", "/etc/s9-docker-proxy"]),
    );
    expect(words("ReadWritePaths")).toEqual(["/var/run/docker.sock"]);
    expect(S.ProtectSystem).toEqual(["strict"]);
    expect(S.ProtectHome).toEqual(["true"]);
  });

  it("ninguna variable puede inyectar código (UnsetEnvironment) y el endurecimiento S6 está declarado", () => {
    expect(words("UnsetEnvironment")).toEqual(
      expect.arrayContaining(["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH"]),
    );
    expect(S.CapabilityBoundingSet).toEqual([""]);
    for (const k of [
      "NoNewPrivileges",
      "PrivateDevices",
      "ProtectClock",
      "RestrictSUIDSGID",
      "ProtectKernelLogs",
      "ProtectHostname",
      "RestrictRealtime",
    ])
      expect(S[k], k).toEqual(["true"]);
    expect(S.SystemCallArchitectures).toEqual(["native"]);
    expect(S.UMask).toEqual(["0077"]);
    // V8 necesita W+X: declarado explícitamente, no olvidado.
    expect(S.MemoryDenyWriteExecute).toEqual(["false"]);
  });

  it("systemd-analyze verify rc=0 y security --offline ≤ 2.0 (la unidad de RC2 daba 6.5)", () => {
    const d = mkdtempSync(join(tmp, "sa-"));
    copyFileSync(UNIT_PATH, join(d, "s9-docker-proxy.service"));
    // verify exige que el binario de ExecStart exista: en la copia para verify (y SÓLO ahí)
    // /usr/bin/node se sustituye por el node que corre el test (el runner puede no tenerlo).
    const vdir = mkdtempSync(join(tmp, "sav-"));
    writeFileSync(
      join(vdir, "s9-docker-proxy.service"),
      readFileSync(UNIT_PATH, "utf8").replace("ExecStart=/usr/bin/node ", `ExecStart=${process.execPath} `),
    );
    const v = spawnSync("systemd-analyze", ["verify", join(vdir, "s9-docker-proxy.service")], { encoding: "utf8" });
    expect(v.error, "systemd-analyze no disponible: el test NO se salta").toBeUndefined();
    // verify avisa (no falla) de lo que no existe en esta máquina (/usr/bin/node en CI): se
    // exige rc=0 y ningún error de sintaxis/directiva.
    expect(v.status, v.stderr).toBe(0);
    expect(v.stderr).not.toMatch(/Unknown (key|section)|Failed to parse|Invalid/i);
    const s = spawnSync("systemd-analyze", ["security", "--offline=yes", join(d, "s9-docker-proxy.service")], {
      encoding: "utf8",
    });
    const m = /Overall exposure level for s9-docker-proxy\.service:\s*([\d.]+)/.exec(s.stdout + s.stderr);
    expect(m, s.stdout + s.stderr).toBeTruthy();
    expect(Number(m![1])).toBeLessThanOrEqual(2.0);
  });
});

// ── U · sandbox real de la unidad ───────────────────────────────────────────
// Las opciones de proceso de la unidad (seccomp, familias, NoNewPrivileges, capacidades…)
// se aplican de verdad con `systemd-run` a lo que la unidad ejecuta: `ip`/`grep`/`sleep` del
// ExecStartPre y el bundle con node. Regresión real que motivó la prueba: con
// `SystemCallFilter=~@privileged`, `ip` falla en capset() (EPERM), sale con 1 y el
// ExecStartPre espera un bridge que «nunca» aparece (CI, run 39672952774).
const SANDBOX_KEYS = [
  "SystemCallFilter",
  "SystemCallErrorNumber",
  "SystemCallArchitectures",
  "NoNewPrivileges",
  "RestrictAddressFamilies",
  "RestrictNamespaces",
  "LockPersonality",
  "MemoryDenyWriteExecute",
  "RestrictRealtime",
  "RestrictSUIDSGID",
  "CapabilityBoundingSet",
  "UMask",
];
/** systemd-run con gestor de usuario o, si no lo hay (runner de CI), el de sistema con sudo. */
function systemdRunLauncher(): { cmd: string[]; user: boolean } {
  const user = ["systemd-run", "--user", "--wait", "--pipe", "--quiet", "--collect"];
  if (spawnSync(user[0], [...user.slice(1), "true"]).status === 0) return { cmd: user, user: true };
  const uname = spawnSync("id", ["-un"], { encoding: "utf8" }).stdout.trim();
  const sys = ["sudo", "-n", "systemd-run", "--wait", "--pipe", "--quiet", "--collect", "-p", `User=${uname}`];
  if (spawnSync(sys[0], [...sys.slice(1), "true"]).status === 0) return { cmd: sys, user: false };
  throw new Error("ni systemd-run --user ni sudo -n systemd-run: el sandbox real no se puede probar (NO se salta)");
}

describe("U · lo que ejecuta la unidad funciona DENTRO de su sandbox real (systemd-run)", () => {
  const S = parseUnit(readFileSync(UNIT_PATH, "utf8")).Service;
  let L: { cmd: string[]; user: boolean };
  let props: string[] = [];
  beforeAll(() => {
    L = systemdRunLauncher();
    // Con el gestor de USUARIO, CapabilityBoundingSet= no se puede aplicar (exige CAP_SETPCAP;
    // sale con 218). Se omite SÓLO ahí (declarado): un proceso no root no tiene capacidades
    // que acotar. Con el gestor de sistema (CI, sudo) se aplican TODAS.
    const keys = L.user ? SANDBOX_KEYS.filter((k) => k !== "CapabilityBoundingSet") : SANDBOX_KEYS;
    props = keys.flatMap((k) => (S[k] ?? []).flatMap((v) => ["-p", `${k}=${v}`]));
  });
  const run = (cmd: string[], extra: string[] = []) => {
    const r = spawnSync(L.cmd[0], [...L.cmd.slice(1), ...props, ...extra, ...cmd], {
      encoding: "utf8",
      timeout: 60_000,
    });
    return { rc: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") + `\n[systemd-run rc=${r.status}]` };
  };

  it("se aplican las opciones de la unidad (el filtro seccomp está entre ellas)", () => {
    expect(props).toContain("SystemCallFilter=@system-service");
    expect(props.filter((p) => p.startsWith("SystemCallFilter=")).length).toBeGreaterThan(0);
  });

  it("`ip -4 -o addr show`, `grep` y `sleep` (ExecStartPre) funcionan con el seccomp de la unidad", () => {
    const ipBin = ["/usr/sbin/ip", "/sbin/ip", "/usr/bin/ip", "/bin/ip"].find(
      (p) => spawnSync("test", ["-x", p]).status === 0,
    );
    expect(ipBin, "no hay `ip` en el host del test").toBeTruthy();
    const r = run(["/bin/sh", "-ec", `${ipBin} -4 -o addr show dev lo | grep -qF " 127.0.0.1/"; sleep 0; echo PRE_OK`]);
    expect(r.out, r.out).toContain("PRE_OK");
    expect(r.rc, r.out).toBe(0);
  });

  it("el bundle arranca con node --no-addons con el seccomp de la unidad (escucha y declara artifact=bundle)", () => {
    const dir = mkdtempSync(join(tmp, "sbx-"));
    copyFileSync(bundle.out, join(dir, "docker-proxy.mjs"));
    copyFileSync(LOCK, join(dir, "DIGESTS.lock"));
    spawnSync("chmod", ["-R", "a+rX", tmp]);
    const port = String(20000 + Math.floor(Math.random() * 20000));
    const r = run(
      [process.execPath, "--no-addons", join(dir, "docker-proxy.mjs")],
      [
        "-p",
        "RuntimeMaxSec=6",
        "-E",
        "DOCKER_PROXY_BIND=127.0.0.1",
        "-E",
        `DOCKER_PROXY_PORT=${port}`,
        "-E",
        `DOCKER_PROXY_IMAGE_ALLOWLIST=${join(dir, "DIGESTS.lock")}`,
        "-E",
        `DOCKER_SOCKET=${join(dir, "no-socket")}`,
      ],
    );
    expect(r.out, r.out).toMatch(/proxy de Docker escuchando/);
    expect(r.out).toMatch(/"artifact":\{"kind":"bundle"/);
    expect(r.out).not.toMatch(/Bad system call|SIGSYS|EPERM/);
  }, 90_000);
});

// ── P/N · install + preflight con propietarios reales ──────────────────────
/** Cómo obtener un «root» con chown real: uid 0, userns con subuids o sudo -n. Nunca se salta. */
function privLauncher(): string[] {
  if (process.getuid?.() === 0) return [];
  const probe =
    'd=$(mktemp -d) && chown 1000:1000 "$d" && setpriv --reuid=65534 --regid=65534 --clear-groups true; r=$?; rm -rf "$d"; exit $r';
  if (spawnSync("unshare", ["--map-root-user", "--map-auto", "sh", "-c", probe]).status === 0)
    return ["unshare", "--map-root-user", "--map-auto"];
  if (spawnSync("sudo", ["-n", "true"]).status === 0) return ["sudo", "-n", "env", `PATH=${process.env.PATH}`];
  throw new Error("ni userns con subuids ni sudo -n: no se pueden probar propietarios reales (el test NO se salta)");
}
let LAUNCH: string[] = [];
beforeAll(() => {
  LAUNCH = privLauncher();
});

// Árbol del host mínimo (usr-merged como Debian) con root como dueño y modos de sistema, y
// la COPIA DE CONFIANZA del repo ($F/root/trusted: instalador, unidad, plantilla, lock y
// bundle, todo de root) desde la que se ejecuta `install`, como exige producción (B1,
// REVIEW PR #167). `pfi` es el preflight INSTALADO por `install` (/usr/local/sbin/…).
const BASE = `
umask 022
F=$(mktemp -d /tmp/rc3priv-fx.XXXXXX); chmod 755 "$F"; export F
trap 'rm -rf "$F" "$F".*' EXIT
mkdir -p "$F/usr/bin" "$F/usr/sbin" "$F/usr/local/sbin" "$F/usr/local/bin" "$F/etc/systemd/system" "$F/opt/s9-ai-arena/runtimes"
ln -s usr/bin "$F/bin"; ln -s usr/sbin "$F/sbin"
printf '#!/bin/sh\\n' >"$F/usr/bin/node"; printf '#!/bin/sh\\n' >"$F/usr/bin/dash"; chmod 755 "$F/usr/bin/node" "$F/usr/bin/dash"
ln -s dash "$F/usr/bin/sh"
cp "$LOCK" "$F/opt/s9-ai-arena/runtimes/DIGESTS.lock"
T="$F/root/trusted"; TI="$T/infrastructure/scripts/install-docker-proxy.sh"; export T TI
mkdir -p "$T/infrastructure/scripts" "$T/infrastructure/systemd" "$T/runtimes" "$T/dist/s9-docker-proxy"
cp "$INSTALLER" "$TI"
cp "$SYSTEMD_DIR/s9-docker-proxy.service" "$SYSTEMD_DIR/docker-proxy.env.example" "$T/infrastructure/systemd/"
cp "$LOCK" "$T/runtimes/DIGESTS.lock"
cp "$BUNDLE" "$T/dist/s9-docker-proxy/docker-proxy.mjs"
px() { S9PX_ROOT="$F" S9PX_EXPECT_SHA256="$BSHA" bash "$TI" "$@"; }
pfi() { S9PX_ROOT="$F" "$F/usr/local/sbin/s9-docker-proxy-preflight" "$@"; }
`;
const FIXTURE = `${BASE}
px install >"$F.install.log" 2>&1 || { echo "INSTALL_RC=$?"; cat "$F.install.log"; exit 90; }
`;

function priv(script: string, extraEnv: Record<string, string> = {}) {
  // LC_ALL=C: los mensajes del núcleo/coreutils se comparan en inglés («Permission denied»).
  const env = {
    LC_ALL: "C",
    LANG: "C",
    LOCK,
    INSTALLER,
    SYSTEMD_DIR: dirname(UNIT_PATH),
    BUNDLE: bundle.out,
    BSHA: bundle.sha256,
    ...extraEnv,
  };
  const envArgs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  const [cmd, ...pre] = LAUNCH.length ? LAUNCH : ["env"];
  const args = LAUNCH.length ? [...pre, "env", ...envArgs, "bash", "-c", script] : [...envArgs, "bash", "-c", script];
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 120_000 });
  return { rc: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

/** Árbol instalado + mutación + preflight; imprime la línea final PF_RC=<rc>. */
function preflightAfter(mutation: string) {
  const r = priv(`${FIXTURE}\n${mutation}\npfi preflight; echo "PF_RC=$?"`);
  const m = /PF_RC=(\d+)/.exec(r.out);
  return { rc: m ? Number(m[1]) : null, out: r.out, rojo: r.out.split("\n").filter((l) => l.includes("ROJO:")) };
}

const UNIT = '"$F/etc/systemd/system/s9-docker-proxy.service"';
const ENV = '"$F/etc/s9-ai-arena/docker-proxy.env"';

describe("P · install en un árbol de pruebas con propietarios reales", () => {
  it("instala bundle, sha256, allowlist, unidad y entorno con root:root y modos 0755/0644/0640", () => {
    const r = priv(
      `${FIXTURE}\nstat -c '%u:%g %a %n' "$F/usr/local/lib/s9-docker-proxy" "$F${BUNDLE_DST}" "$F${BUNDLE_DST}.sha256" "$F/etc/s9-docker-proxy" "$F${LOCK_DST}" ${UNIT} ${ENV} "$F/usr/local/sbin/s9-docker-proxy-preflight"\ncmp "$F${LOCK_DST}" "$LOCK" && echo LOCK_IGUAL\ncmp "$F${BUNDLE_DST}" "$BUNDLE" && echo BUNDLE_IGUAL`,
    );
    expect(r.rc, r.out).toBe(0);
    const modes = Object.fromEntries(
      r.out
        .split("\n")
        .filter((l) => /^\d+:\d+ \d+ /.test(l))
        .map((l) => {
          const [own, mode, path] = l.split(" ");
          return [path.replace(/^\/tmp\/rc3priv-fx\.[^/]+/, ""), `${own} ${mode}`];
        }),
    );
    expect(modes).toEqual({
      "/usr/local/lib/s9-docker-proxy": "0:0 755",
      [BUNDLE_DST]: "0:0 644",
      [`${BUNDLE_DST}.sha256`]: "0:0 644",
      "/etc/s9-docker-proxy": "0:0 755",
      [LOCK_DST]: "0:0 644",
      "/etc/systemd/system/s9-docker-proxy.service": "0:0 644",
      "/etc/s9-ai-arena/docker-proxy.env": "0:0 640",
      "/usr/local/sbin/s9-docker-proxy-preflight": "0:0 755",
    });
    expect(r.out).toContain("LOCK_IGUAL");
    expect(r.out).toContain("BUNDLE_IGUAL");
  });

  it("árbol instalado SIN mutar ⇒ preflight VERDE (rc=0, ningún ROJO)", () => {
    const r = preflightAfter("");
    expect(r.rojo, r.out).toEqual([]);
    expect(r.rc, r.out).toBe(0);
    expect(r.out).toContain("PREFLIGHT VERDE");
  });

  // Cada mutación: un único motivo esperado (el resto del árbol sigue conforme).
  const mutations: [string, string, RegExp][] = [
    [
      "bundle escribible por grupo",
      `chmod g+w "$F${BUNDLE_DST}"`,
      /bundle: .*docker-proxy\.mjs es escribible por grupo/,
    ],
    [
      "allowlist escribible por otros",
      `chmod o+w "$F${LOCK_DST}"`,
      /allowlist: .*DIGESTS\.lock es escribible por grupo u otros/,
    ],
    ["unidad escribible por grupo", `chmod g+w ${UNIT}`, /unidad: .*s9-docker-proxy\.service es escribible/],
    [
      "directorio del bundle propiedad de no root (rename/replace)",
      `chown 1000:1000 "$F/usr/local/lib/s9-docker-proxy"`,
      /s9-docker-proxy es propiedad de uid=1000/,
    ],
    [
      "padre lejano (/usr/local) propiedad de no root",
      `chown 1000 "$F/usr/local"`,
      /\/usr\/local es propiedad de uid=1000/,
    ],
    [
      "directorio de la allowlist propiedad de no root",
      `chown 1000 "$F/etc/s9-docker-proxy"`,
      /etc\/s9-docker-proxy es propiedad de uid=1000/,
    ],
    ["node propiedad de no root", `chown 1000 "$F/usr/bin/node"`, /node: .*usr\/bin\/node es propiedad de uid=1000/],
    [
      "/usr/local/bin del PATH del servicio escribible",
      `chmod o+w "$F/usr/local/bin"`,
      /PATH del servicio.*usr\/local\/bin es escribible/,
    ],
    [
      // REVIEW PR #167: un padre INTERMEDIO que es un enlace (aquí /usr/local/lib → un
      // directorio de uid 1000) deja el bundle a merced de ese usuario (puede renombrar
      // s9-docker-proxy/); el enlace es de root y la hoja también, así que sólo se ve
      // siguiendo la ruta REAL completa, no sólo el enlace de la hoja.
      "padre intermedio que es un enlace a un directorio de no root",
      `mkdir -p "$F/home/evil"; mv "$F/usr/local/lib/s9-docker-proxy" "$F/home/evil/"; chown 1000:1000 "$F/home/evil"; rmdir "$F/usr/local/lib"; ln -s ../../home/evil "$F/usr/local/lib"`,
      /home\/evil es propiedad de uid=1000/,
    ],
    [
      "allowlist bajo un directorio que es un enlace a uno de no root",
      `mkdir -p "$F/home/evil2"; mv "$F/etc/s9-docker-proxy" "$F/home/evil2/"; chown 1000:1000 "$F/home/evil2"; ln -s ../home/evil2/s9-docker-proxy "$F/etc/s9-docker-proxy"`,
      /home\/evil2 es propiedad de uid=1000/,
    ],
    [
      "bundle sustituido por un enlace al árbol",
      `ln -sf "$F/opt/s9-ai-arena/runtimes/DIGESTS.lock" "$F${BUNDLE_DST}"`,
      /no es un fichero regular/,
    ],
    ["bundle con contenido distinto al instalado", `echo '//x' >>"$F${BUNDLE_DST}"`, /sha256 .* ≠ registrado/],
    [
      "entorno: allowlist del árbol /opt (la autoridad que s9arena escribe)",
      `sed -i 's|^DOCKER_PROXY_IMAGE_ALLOWLIST=.*|DOCKER_PROXY_IMAGE_ALLOWLIST=/opt/s9-ai-arena/runtimes/DIGESTS.lock|' ${ENV}`,
      /debe ser la copia de root/,
    ],
    ["entorno: NODE_OPTIONS", `echo 'NODE_OPTIONS=--require /opt/x.js' >>${ENV}`, /check-env NO conforme/],
    [
      "unidad: ExecStart con npx tsx desde el árbol (RC1/RC2)",
      `sed -i 's|^ExecStart=.*|ExecStart=/usr/bin/npx tsx apps/bot-manager/src/docker-proxy-main.ts|' ${UNIT}`,
      /ExecStart debe ser exactamente/,
    ],
    [
      "unidad: WorkingDirectory=/opt/s9-ai-arena",
      `sed -i 's|^UMask=0077|UMask=0077\\nWorkingDirectory=/opt/s9-ai-arena|' ${UNIT}`,
      /WorkingDirectory=\/opt\/s9-ai-arena/,
    ],
    [
      "unidad: EnvironmentFile en el árbol",
      `sed -i 's|^EnvironmentFile=.*|EnvironmentFile=/opt/s9-ai-arena/proxy.env|' ${UNIT}`,
      /EnvironmentFile debe ser exactamente/,
    ],
    [
      "unidad: sin InaccessiblePaths del árbol",
      `sed -i '/^InaccessiblePaths=/d' ${UNIT}`,
      /InaccessiblePaths no incluye/,
    ],
    [
      "drop-in no auditado",
      `mkdir -p "$F/etc/systemd/system/s9-docker-proxy.service.d"; echo '[Service]' >"$F/etc/systemd/system/s9-docker-proxy.service.d/x.conf"`,
      /drop-ins presentes/,
    ],
    [
      "drop-in GLOBAL de servicios en /etc (service.d), invisible antes en --static",
      `mkdir -p "$F/etc/systemd/system/service.d"; echo '[Service]' >"$F/etc/systemd/system/service.d/x.conf"`,
      /drop-ins presentes en \/etc\/systemd\/system\/service\.d/,
    ],
    [
      "drop-in de la unidad en /run",
      `mkdir -p "$F/run/systemd/system/s9-docker-proxy.service.d"; echo '[Service]' >"$F/run/systemd/system/s9-docker-proxy.service.d/x.conf"`,
      /drop-ins presentes en \/run\/systemd\/system\/s9-docker-proxy\.service\.d/,
    ],
    [
      "fragmento de la unidad en /run (sustituye a la instalada)",
      `mkdir -p "$F/run/systemd/system"; cp ${UNIT} "$F/run/systemd/system/s9-docker-proxy.service"`,
      /fragmento en \/run\/systemd\/system/,
    ],
    [
      "unidad con el opt-in inseguro de tests",
      `sed -i 's|^UMask=0077|UMask=0077\\nEnvironment=DOCKER_PROXY_INSECURE_BIND_FOR_TESTS=1|' ${UNIT}`,
      /variable de tests \(DOCKER_PROXY_INSECURE_BIND_FOR_TESTS\)/,
    ],
    [
      "unidad con una variable S9PX_* (modo árbol de pruebas)",
      `sed -i 's|^UMask=0077|UMask=0077\\nEnvironment=S9PX_ROOT=/tmp/x|' ${UNIT}`,
      /variable de tests \(S9PX_ROOT\)/,
    ],
    [
      "preflight instalado escribible por grupo (validate/TD-057 dependen de él)",
      `chmod g+w "$F/usr/local/sbin/s9-docker-proxy-preflight"`,
      /(preflight instalado|copia en ejecución): .*s9-docker-proxy-preflight es escribible/,
    ],
    [
      "unidad del firewall que ejecuta un script del árbol",
      `printf '[Service]\\nExecStart=/opt/s9-ai-arena/infrastructure/firewall/s9-firewall.sh apply\\n' >"$F/etc/systemd/system/s9-firewall.service"; printf '#!/bin/sh\\n' >"$F/usr/local/sbin/s9-firewall"; chmod 755 "$F/usr/local/sbin/s9-firewall"`,
      /s9-firewall\.service ejecuta algo que no es \/usr\/local\/sbin\/s9-firewall/,
    ],
  ];
  for (const [name, mutation, reason] of mutations) {
    it(`MUTACIÓN «${name}» ⇒ preflight ROJO por su motivo`, () => {
      const r = preflightAfter(mutation);
      // 1 = ROJO; 2 = el preflight INSTALADO está comprometido por la mutación (p. ej. su padre
      // /usr/local) y se niega a dar veredicto. Las dos son negativas; nunca 0.
      expect([1, 2], r.out).toContain(r.rc);
      expect(
        r.rojo.some((l) => reason.test(l)),
        `${reason} no está en:\n${r.rojo.join("\n")}`,
      ).toBe(true);
    });
  }

  // ── B1 (REVIEW PR #167): la confianza no se ancla en el árbol ──
  it("B1 · install desde una copia que NO es sólo de root (el árbol de s9arena) ⇒ ABORTA rc=2 sin instalar nada", () => {
    const r = priv(`${BASE}
chown -R 1000:1000 "$T"
px install; echo "IN_RC=$?"
[ -e "$F${BUNDLE_DST}" ] && echo BUNDLE_INSTALADO || echo BUNDLE_NO_INSTALADO
[ -e "$F/etc/systemd/system/s9-docker-proxy.service" ] && echo UNIDAD_ESCRITA || echo UNIDAD_NO_ESCRITA`);
    expect(r.out).toContain("IN_RC=2");
    expect(r.out).toMatch(/copia en ejecución: .*install-docker-proxy\.sh es propiedad de uid=1000/);
    expect(r.out).toContain("BUNDLE_NO_INSTALADO");
    expect(r.out).toContain("UNIDAD_NO_ESCRITA");
  });

  it("B1 · install con el script de root pero el BUNDLE de origen de no root ⇒ ABORTA rc=2", () => {
    const r = priv(`${BASE}
chown 1000 "$T/dist/s9-docker-proxy/docker-proxy.mjs"
px install; echo "IN_RC=$?"`);
    expect(r.out).toContain("IN_RC=2");
    expect(r.out).toMatch(/origen de install: .*docker-proxy\.mjs es propiedad de uid=1000/);
  });

  it("B1 · preflight y validate ejecutados desde una copia de no root ⇒ rc=2 (su veredicto no vale)", () => {
    const r = priv(`${FIXTURE}
chown 1000 "$TI"
px preflight >/dev/null 2>&1; echo "PF_RC=$?"
px validate >/dev/null 2>&1; echo "VA_RC=$?"
pfi preflight >/dev/null 2>&1; echo "PFI_RC=$?"`);
    expect(r.out).toContain("PF_RC=2");
    expect(r.out).toContain("VA_RC=2");
    expect(r.out).toContain("PFI_RC=0"); // la copia instalada sigue siendo de root y válida
  });

  it("B1 · S9PX_EXPECT_SHA256 es OBLIGATORIO: sin él ⇒ ABORTA y no instala el bundle", () => {
    const r = priv(`${BASE}
S9PX_ROOT="$F" bash "$TI" install; echo "IN_RC=$?"
[ -e "$F${BUNDLE_DST}" ] && echo BUNDLE_INSTALADO || echo BUNDLE_NO_INSTALADO`);
    expect(r.out).toContain("IN_RC=1");
    expect(r.out).toContain("falta S9PX_EXPECT_SHA256");
    expect(r.out).toContain("BUNDLE_NO_INSTALADO");
  });

  it("B1 · S9PX_EXPECT_SHA256 distinto del bundle ⇒ ABORTA (PARA) y no instala el bundle", () => {
    const r = priv(`${BASE}
S9PX_ROOT="$F" S9PX_EXPECT_SHA256=${"f".repeat(64)} bash "$TI" install; echo "IN_RC=$?"
[ -e "$F${BUNDLE_DST}" ] && echo BUNDLE_INSTALADO || echo BUNDLE_NO_INSTALADO`);
    expect(r.out).toContain("IN_RC=1");
    expect(r.out).toContain("PARA: no instales");
    expect(r.out).toContain("BUNDLE_NO_INSTALADO");
  });

  // ── B2 (REVIEW PR #167): migración transaccional ──
  const OLD_UNIT = `printf '[Service]\\nExecStart=/usr/bin/npx tsx apps/bot-manager/src/docker-proxy-main.ts\\nWorkingDirectory=/opt/s9-ai-arena\\n' >"$F/etc/systemd/system/s9-docker-proxy.service"`;
  const OLD_ENV = `mkdir -p "$F/etc/s9-ai-arena"; sed 's|^DOCKER_PROXY_IMAGE_ALLOWLIST=.*|DOCKER_PROXY_IMAGE_ALLOWLIST=/opt/s9-ai-arena/runtimes/DIGESTS.lock|' "$SYSTEMD_DIR/docker-proxy.env.example" >"$F/etc/s9-ai-arena/docker-proxy.env"; chmod 640 "$F/etc/s9-ai-arena/docker-proxy.env"`;

  it("B2 · entorno de RC2 (allowlist de /opt) sin S9PX_MIGRATE_ENV ⇒ ABORTA con la unidad vieja intacta", () => {
    const r = priv(`${BASE}
${OLD_UNIT}; ${OLD_ENV}
sha0=$(sha256sum "$F/etc/systemd/system/s9-docker-proxy.service" | cut -c1-64)
px install; echo "IN_RC=$?"
[ "$(sha256sum "$F/etc/systemd/system/s9-docker-proxy.service" | cut -c1-64)" = "$sha0" ] && echo UNIDAD_INTACTA`);
    expect(r.out).toContain("IN_RC=1");
    expect(r.out).toContain("S9PX_MIGRATE_ENV=1");
    expect(r.out).toContain("UNIDAD_INTACTA");
  });

  it("B2 · S9PX_MIGRATE_ENV=1 cambia SÓLO la allowlist, DESPUÉS de instalar la copia de root, con copia de seguridad", () => {
    const r = priv(`${BASE}
${OLD_UNIT}; ${OLD_ENV}
cp "$F/etc/s9-ai-arena/docker-proxy.env" "$F.env0"
S9PX_MIGRATE_ENV=1 px install >"$F.log" 2>&1; echo "IN_RC=$?"
bak=$(sed -n 's/^==> copia de seguridad de unidad y entorno: //p' "$F.log")
cmp -s "$bak/env" "$F.env0" && echo BACKUP_ENV_OK
grep -q 'npx tsx' "$bak/unit" && echo BACKUP_UNIT_OK
stat -c '%u:%g %a' "$bak" "$F/etc/s9-ai-arena/docker-proxy.env"
diff "$F.env0" "$F/etc/s9-ai-arena/docker-proxy.env" | grep '^[<>]'
pfi preflight >/dev/null 2>&1; echo "PF_RC=$?"`);
    expect(r.out, r.out).toContain("IN_RC=0");
    expect(r.out).toContain("BACKUP_ENV_OK");
    expect(r.out).toContain("BACKUP_UNIT_OK");
    expect(r.out).toContain("0:0 700");
    expect(r.out).toContain("0:0 640");
    // diff: exactamente una línea fuera y una dentro, la de la allowlist.
    const d = r.out.split("\n").filter((l) => /^[<>] /.test(l));
    expect(d).toEqual([
      "< DOCKER_PROXY_IMAGE_ALLOWLIST=/opt/s9-ai-arena/runtimes/DIGESTS.lock",
      "> DOCKER_PROXY_IMAGE_ALLOWLIST=/etc/s9-docker-proxy/DIGESTS.lock",
    ]);
    expect(r.out).toContain("PF_RC=0");
  });

  it("B2 · preflight --static ROJO tras escribir la unidad ⇒ unidad y entorno RESTAURADOS (sin estado a medias)", () => {
    const r = priv(`${BASE}
${OLD_UNIT}; ${OLD_ENV}
cp "$F/etc/systemd/system/s9-docker-proxy.service" "$F.unit0"; cp "$F/etc/s9-ai-arena/docker-proxy.env" "$F.env0"
chown 1000 "$F/usr/bin/node"
S9PX_MIGRATE_ENV=1 px install >"$F.log" 2>&1; echo "IN_RC=$?"
grep -c 'restaurado desde' "$F.log"
cmp -s "$F.unit0" "$F/etc/systemd/system/s9-docker-proxy.service" && echo UNIDAD_RESTAURADA
cmp -s "$F.env0" "$F/etc/s9-ai-arena/docker-proxy.env" && echo ENV_RESTAURADO`);
    expect(r.out).toContain("IN_RC=1");
    expect(r.out).toContain("UNIDAD_RESTAURADA");
    expect(r.out).toContain("ENV_RESTAURADO");
  });

  it("B2 · `restore <copia>` (vuelta atrás) devuelve exactamente la unidad y el entorno anteriores", () => {
    const r = priv(`${BASE}
${OLD_UNIT}; ${OLD_ENV}
cp "$F/etc/systemd/system/s9-docker-proxy.service" "$F.unit0"; cp "$F/etc/s9-ai-arena/docker-proxy.env" "$F.env0"
S9PX_MIGRATE_ENV=1 px install >"$F.log" 2>&1; echo "IN_RC=$?"
bak=$(sed -n 's/^==> copia de seguridad de unidad y entorno: //p' "$F.log")
pfi restore "$bak"; echo "RS_RC=$?"
cmp -s "$F.unit0" "$F/etc/systemd/system/s9-docker-proxy.service" && echo UNIDAD_ANTERIOR
cmp -s "$F.env0" "$F/etc/s9-ai-arena/docker-proxy.env" && echo ENV_ANTERIOR
pfi restore "$F/no-existe"; echo "RS_MAL_RC=$?"`);
    expect(r.out).toContain("IN_RC=0");
    expect(r.out).toContain("RS_RC=0");
    expect(r.out).toContain("UNIDAD_ANTERIOR");
    expect(r.out).toContain("ENV_ANTERIOR");
    expect(r.out).toContain("RS_MAL_RC=1");
  });
});

describe("N · un usuario NO root real no puede tocar la autoridad del proxy (EACCES del núcleo)", () => {
  it("65534 no puede escribir, crear, renombrar ni sustituir bundle, allowlist, unidad ni entorno", () => {
    const attempts = [
      `printf x >>"$F${BUNDLE_DST}"`,
      `touch "$F/usr/local/lib/s9-docker-proxy/evil.mjs"`,
      `mv "$F${BUNDLE_DST}" "$F${BUNDLE_DST}.old"`,
      `printf x >>"$F${LOCK_DST}"`,
      `touch "$F/etc/s9-docker-proxy/DIGESTS.lock.new"`,
      `printf x >>${UNIT}`,
      `touch "$F/etc/systemd/system/s9-docker-proxy.service.d"`,
      `cat ${ENV}`,
      `printf x >>${ENV}`,
    ];
    const body = attempts
      .map(
        (a, i) =>
          `if setpriv --reuid=65534 --regid=65534 --clear-groups sh -c '${a.replace(/'/g, "'\\''")}' 2>"$F.err$i"; then echo "A${i}=PERMITIDO"; else grep -q 'Permission denied' "$F.err$i" && echo "A${i}=EACCES" || { echo "A${i}=OTRO"; cat "$F.err$i"; }; fi; rm -f "$F.err$i"`,
      )
      .join("\n");
    const r = priv(`${FIXTURE}\n${body}`);
    for (let i = 0; i < attempts.length; i++) expect(r.out, `${attempts[i]}\n${r.out}`).toContain(`A${i}=EACCES`);
  });

  it("control positivo del arnés: en un directorio SUYO, 65534 sí escribe (la denegación no es del arnés)", () => {
    const r = priv(
      `${FIXTURE}\nmkdir "$F/own"; chown 65534:65534 "$F/own"\nsetpriv --reuid=65534 --regid=65534 --clear-groups sh -c 'touch "$0/own/x"' "$F" && echo ESCRIBE`,
    );
    expect(r.out).toContain("ESCRIBE");
  });
});

// Ruta de salida del build por defecto ignorada por git (el bundle nunca se versiona).
describe("B · el bundle no se versiona", () => {
  it("dist/ está en .gitignore", () => {
    expect(readFileSync(join(ROOT, ".gitignore"), "utf8").split("\n")).toContain("dist/");
  });
});

// Evita que el directorio temporal del build quede sin crear si beforeAll falló.
mkdirSync(tmp, { recursive: true });
writeFileSync(join(tmp, ".keep"), "");
