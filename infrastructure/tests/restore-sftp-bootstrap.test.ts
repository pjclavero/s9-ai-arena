// fix/restore-sftp-bootstrap — E2E REAL del bootstrap SSH de restore.sh
// contra un backend sftp: de restic, SIN Docker.
//
// POR QUÉ EXISTE ESTE FICHERO: hasta esta rama, restore.sh no mencionaba
// ssh/sftp en ninguna parte (`git grep -n "ssh\|sftp\|setup" -- infrastructure/backup/restore.sh`
// daba 0 coincidencias en origin/main). En producción "funcionaba" de
// rebote: el contenedor de backup PROGRAMADO ya había dejado ~/.ssh listo
// (lo prepara backup.sh/setup_ssh) en la capa de escritura de ESE MISMO
// contenedor. Un contenedor de RECUPERACIÓN nuevo — el escenario real que
// docs/recuperacion.md exige poder demostrar — nunca ejecutó backup.sh y no
// tiene ~/.ssh: reproducido en vivo, `restic` fallaba con
// "Host key verification failed" hasta preparar SSH a mano.
//
// Esta suite NO usa Docker (backup-sftp-e2e.test.ts ya cubre la imagen real
// completa para el carril de backup.sh; ese carril está en marcha en
// paralelo y este fichero no lo toca). En su lugar levanta un `sshd` real,
// sin privilegios, en 127.0.0.1, y ejecuta restore.sh de verdad contra un
// repositorio restic real sobre ese sshd — sin mocks: si `setup_ssh` dejara
// de copiar la clave, o si alguien "arreglara" un timeout con
// StrictHostKeyChecking=no, o si restore.sh dejara de invocar el bootstrap
// antes de restic, esta suite falla por la razón exacta, no por una
// aserción de conveniencia.
//
// EL PROBLEMA DEL "CONTENEDOR FRESCO" SIN DOCKER: `ssh` resuelve
// "~/.ssh/config" con el HOME real de la cuenta del sistema (vía
// getpwuid), NO con la variable de entorno $HOME — así que un simple
// `HOME=<tmp> ssh ...` no basta para que ssh lea la config que genera
// setup_ssh (comprobado en vivo: con sólo $HOME sobreescrito, `ssh -G`
// seguía devolviendo el UserKnownHostsFile por defecto del usuario real).
// En un contenedor real esto nunca pasa porque el HOME del proceso
// (siempre /root) SÍ coincide con el HOME de /etc/passwd del propio
// contenedor. Para reproducir esa misma coincidencia sin Docker, cada
// invocación de restore.sh corre dentro de un namespace de usuario+montaje
// sin privilegios (`unshare --user --map-root-user --mount`, la misma
// primitiva que ya usan replays-volume.test.ts/b13-data-volumes.test.ts
// para el guard del entrypoint) con un /etc/passwd propio, bind-montado,
// cuya línea "root" apunta al HOME de prueba — así `ssh`/`restic` ven
// exactamente la misma coincidencia HOME↔passwd que en un contenedor real,
// verificado con `ssh -G` antes de escribir esta suite.
//
// LIMITACIÓN CONOCIDA Y DOCUMENTADA (no oculta): sin CAP_NET_BIND_SERVICE
// no se puede escuchar en el puerto 22 real sin más privilegios que un
// namespace de usuario sin privilegios concede sobre su propia red (no se
// unshare la red aquí para no depender de rutas/loopback adicionales), así
// que el sshd de prueba escucha en un puerto alto y RESTIC_REPOSITORY usa
// la forma `sftp://user@host:puerto/ruta` (sintaxis real y documentada de
// restic para ese caso) en vez de la forma `sftp:user@host:ruta` (puerto 22
// implícito) que usa docs/recuperacion.md. El mecanismo bajo prueba —
// setup_ssh, StrictHostKeyChecking real, restic real — es idéntico; sólo
// cambia cómo se le indica el puerto a restic. Ver también
// infrastructure/.env.example para el formato real de producción (puerto
// 22 estándar del host de respaldo).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const here = dirname(fileURLToPath(import.meta.url));
const RESTORE_SH = join(here, "..", "backup", "restore.sh");
const SETUP_SSH_LIB = join(here, "..", "backup", "lib", "setup-ssh.sh");

const IS_CI = process.env.CI === "true" || process.env.CI === "1";

function which(bin: string): string | null {
  try {
    return execFileSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

const SSHD_BIN = existsSync("/usr/sbin/sshd") ? "/usr/sbin/sshd" : which("sshd");
const RESTIC_BIN = process.env.RESTIC_BIN || which("restic");
const SFTP_SERVER = [
  "/usr/lib/openssh/sftp-server",
  "/usr/libexec/openssh/sftp-server",
  "/usr/lib/ssh/sftp-server",
].find((p) => existsSync(p));

function unshareWorks(): boolean {
  try {
    execFileSync("unshare", ["--user", "--map-root-user", "--mount", "/bin/true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const HAS_UNSHARE = unshareWorks();

const HAS_ENV = !!(SSHD_BIN && RESTIC_BIN && SFTP_SERVER && HAS_UNSHARE);
const SKIP_LOCALLY = !HAS_ENV && !IS_CI;

if (!HAS_ENV) {
  // eslint-disable-next-line no-console
  console.warn(
    IS_CI
      ? "[restore-sftp-bootstrap] CI=true pero falta sshd/restic/sftp-server/unshare: la suite NO " +
          `se salta (sshd=${SSHD_BIN} restic=${RESTIC_BIN} sftp-server=${SFTP_SERVER} unshare=${HAS_UNSHARE}) — va a fallar a propósito en beforeAll.`
      : "[restore-sftp-bootstrap] entorno incompleto (sshd/restic/openssh-sftp-server/unshare sin " +
          "privilegios); se OMITE localmente. Debe ejecutarse donde SÍ estén disponibles — el job " +
          "de CI los instala explícitamente antes de correr esta suite. NO se sustituye por mocks.",
  );
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("no se pudo obtener un puerto libre")));
      }
    });
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.skipIf(SKIP_LOCALLY)("restore.sh — bootstrap SSH real contra sftp: (sin Docker)", () => {
  let root: string;
  let port: number;
  let sshdProc: ChildProcess;
  let hostKeyPub: string;
  let clientKeyPath: string;
  let knownHostsRealPath: string; // huella REAL, capturada con ssh-keyscan
  let secretKeyPath: string; // "montado" 0400, como /run/secrets/restic_ssh_key
  let secretKnownHostsPath: string;
  let repoPath: string;
  let repository: string;
  let emptySshConfigD: string;
  let counter = 0;

  beforeAll(async () => {
    if (IS_CI && !HAS_ENV) {
      throw new Error(
        `entorno de CI incompleto para restore-sftp-bootstrap.test.ts: sshd=${SSHD_BIN} restic=${RESTIC_BIN} ` +
          `sftp-server=${SFTP_SERVER} unshare=${HAS_UNSHARE}. Instalar openssh-server, openssh-sftp-server y ` +
          "restic en el job de CI (ver .github/workflows/ci.yml, job unit, paso 'Dependencias de " +
          "infrastructure/tests/restore-sftp-bootstrap.test.ts') — no tiene " +
          "sentido saltar este E2E: es exactamente el escenario que motivó esta rama.",
      );
    }

    root = mkdtempSync(join(tmpdir(), "restore-sftp-"));
    emptySshConfigD = join(root, "empty-ssh-config-d");
    mkdirSync(emptySshConfigD);

    // ── sshd real, sin privilegios, en 127.0.0.1:<puerto alto> ──────────────
    const keysDir = join(root, "keys");
    mkdirSync(keysDir);
    const hostKeyPath = join(keysDir, "hostkey");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKeyPath]);
    hostKeyPub = readFileSync(`${hostKeyPath}.pub`, "utf8");
    clientKeyPath = join(keysDir, "client");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", clientKeyPath]);
    const otherKeyPath = join(keysDir, "otherhost"); // para el mutante de fingerprint
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", otherKeyPath]);

    const authKeysPath = join(keysDir, "authorized_keys");
    writeFileSync(authKeysPath, readFileSync(`${clientKeyPath}.pub`, "utf8"), { mode: 0o600 });

    port = await getFreePort();
    const sshdConfigPath = join(root, "sshd_config");
    repoPath = join(root, "repo");
    mkdirSync(repoPath);
    writeFileSync(
      sshdConfigPath,
      [
        `Port ${port}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${hostKeyPath}`,
        `AuthorizedKeysFile ${authKeysPath}`,
        `PidFile ${join(root, "sshd.pid")}`,
        "UsePAM no",
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "StrictModes no",
        `Subsystem sftp ${SFTP_SERVER}`,
        "LogLevel ERROR",
        "",
      ].join("\n"),
    );
    let sshdLog = "";
    sshdProc = spawn(SSHD_BIN as string, ["-f", sshdConfigPath, "-D", "-e"], { stdio: ["ignore", "pipe", "pipe"] });
    sshdProc.stdout?.on("data", (d) => (sshdLog += d.toString()));
    sshdProc.stderr?.on("data", (d) => (sshdLog += d.toString()));
    let sshdExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    sshdProc.on("exit", (code, signal) => {
      sshdExit = { code, signal };
    });

    // Espera a verdad de red (el puerto acepta conexiones), no a un tiempo fijo.
    const deadline = Date.now() + 10_000;
    let up = false;
    while (Date.now() < deadline) {
      if (sshdExit) break; // murió antes de levantar: no tiene sentido seguir esperando
      try {
        execFileSync("bash", ["-c", `exec 3<>/dev/tcp/127.0.0.1/${port}`], { stdio: "ignore" });
        up = true;
        break;
      } catch {
        await sleep(200);
      }
    }
    if (!up) {
      throw new Error(
        `sshd de prueba no levantó en 127.0.0.1:${port} tras 10s (pid=${sshdProc.pid}, ` +
          `exit=${JSON.stringify(sshdExit)}):\n${sshdLog}`,
      );
    }

    // known_hosts REAL: capturado por ssh-keyscan contra el sshd real, no
    // fabricado a partir de hostKeyPub (que sí se usa para el mutante de
    // fingerprint malo, ver más abajo).
    knownHostsRealPath = join(root, "known_hosts_real");
    for (let i = 0; i < 10; i++) {
      const out = execFileSync("ssh-keyscan", ["-p", String(port), "127.0.0.1"], { encoding: "utf8" });
      if (out.includes("ssh-ed25519")) {
        writeFileSync(knownHostsRealPath, out);
        break;
      }
      await sleep(300);
    }
    if (!existsSync(knownHostsRealPath)) throw new Error("ssh-keyscan no devolvió ninguna clave tras varios intentos");

    // "Secretos" tal y como llegan montados por Docker: sólo lectura, 0400.
    secretKeyPath = join(root, "secret_restic_ssh_key");
    writeFileSync(secretKeyPath, readFileSync(clientKeyPath));
    chmodSync(secretKeyPath, 0o400);
    secretKnownHostsPath = join(root, "secret_restic_ssh_known_hosts");
    writeFileSync(secretKnownHostsPath, readFileSync(knownHostsRealPath));
    chmodSync(secretKnownHostsPath, 0o400);

    repository = `sftp://ia02@127.0.0.1:${port}${repoPath}`;

    // ── Inicializa el repositorio restic real (fuera de restore.sh — es
    // trabajo de `backup.sh --init-repo` en producción, ver docs/recuperacion.md
    // "Puesta en marcha"), usando el MISMO setup_ssh que se está probando. ──
    const init = runSetupSshThenRestic(["init"]);
    if (init.code !== 0) throw new Error(`no se pudo inicializar el repositorio restic de prueba:\n${init.out}`);

    // ── Sube UN snapshot real con forma de staging de backup.sh (para el
    // mutante "snapshot corrupto", que corrompe el árbol YA RESTAURADO). ────
    const stagingSrc = join(root, "staging-src");
    mkdirSync(join(stagingSrc, "maps"), { recursive: true });
    writeFileSync(join(stagingSrc, "maps", "a.txt"), "hola-mapa\n");
    const sum = execFileSync("sh", ["-c", `cd ${stagingSrc} && sha256sum maps/a.txt`], { encoding: "utf8" });
    writeFileSync(join(stagingSrc, "manifest.sha256"), sum);
    writeFileSync(
      join(stagingSrc, "manifest.json"),
      JSON.stringify({
        postgres: { status: "ok" },
        secrets: { status: "ok" },
        maps: { status: "ok", files: 1 },
        bot_sources: { status: "empty" },
        replays: { status: "empty" },
        assets: { status: "empty" },
      }),
    );
    const backup = runSetupSshThenRestic(["backup", "--tag", "s9-arena-data", "."], stagingSrc);
    if (backup.code !== 0) throw new Error(`no se pudo crear el snapshot de prueba:\n${backup.out}`);
  }, 60_000);

  afterAll(() => {
    try {
      sshdProc?.kill("SIGKILL");
    } catch {
      /* noop */
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  // fakeHome por test: cada invocación es un "contenedor de recuperación
  // fresco" real — directorio nuevo, sin ~/.ssh previo, sin que backup.sh se
  // haya ejecutado nunca aquí. Un contador evita colisiones entre tests.
  function freshFakeHome(): string {
    counter += 1;
    const home = join(root, `fakehome-${counter}`);
    mkdirSync(home, { recursive: true });
    return home;
  }

  // Namespace de usuario+montaje sin privilegios con un /etc/passwd propio
  // cuya línea "root" apunta a `fakeHome` — hace que `ssh`/`restic`
  // resuelvan "~/.ssh/config" exactamente donde apunta $HOME, la misma
  // coincidencia que se da siempre dentro de un contenedor real. Devuelve
  // {code, out} de ejecutar `cmd` (argv completo) dentro de ese namespace.
  function runInNamespace(fakeHome: string, env: Record<string, string>, cmd: string[]): { code: number; out: string } {
    const fakePasswd = join(fakeHome, ".fake-passwd");
    const realPasswd = readFileSync("/etc/passwd", "utf8");
    const patched = realPasswd.replace(/^root:x:0:0:([^:]*):[^:]*:/m, `root:x:0:0:$1:${fakeHome}:`);
    if (patched === realPasswd) throw new Error("no se encontró la línea 'root:' en /etc/passwd para parchear");
    writeFileSync(fakePasswd, patched);

    const script = [
      "set -uo pipefail",
      'if [ -d /etc/ssh/ssh_config.d ]; then mount --bind "$NS_EMPTY_SSH_CONFIG_D" /etc/ssh/ssh_config.d; fi',
      'mount --bind "$NS_FAKE_PASSWD" /etc/passwd',
      'export HOME="$NS_FAKE_HOME"',
      'exec "$@"', // $0 ("ns") no forma parte de "$@": nada que descartar
    ].join("\n");

    try {
      const out = execFileSync(
        "unshare",
        ["--user", "--map-root-user", "--mount", "/bin/bash", "-c", script, "ns", ...cmd],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            ...env,
            NS_FAKE_HOME: fakeHome,
            NS_FAKE_PASSWD: fakePasswd,
            NS_EMPTY_SSH_CONFIG_D: emptySshConfigD,
          },
          timeout: 15_000,
        },
      );
      return { code: 0, out };
    } catch (e: any) {
      return { code: typeof e.status === "number" ? e.status : 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  }

  // Ejecuta setup_ssh (la MISMA función que usa restore.sh) y encadena un
  // restic real — usado sólo en beforeAll para preparar el repositorio y el
  // snapshot de prueba, con el mismo mecanismo bajo prueba.
  function runSetupSshThenRestic(resticArgs: string[], cwd?: string): { code: number; out: string } {
    const fakeHome = freshFakeHome();
    const inline = [
      `source "${SETUP_SSH_LIB}"`,
      'log() { printf "[%s] %s\\n" "$1" "$2" >&2; }',
      "setup_ssh || exit 1",
      // cwd opcional: el backup de prueba archiva "." en vez de una ruta
      // absoluta — evita que restic intente restaurar la propiedad de los
      // directorios ANCESTROS reales (/, /tmp…), que en este namespace sin
      // privilegios sólo tiene mapeado un uid (el de ia02) y no el de esos
      // directorios del sistema (root real): un `restic restore` sobre una
      // ruta absoluta fallaría con "lchown: invalid argument" — un
      // artefacto de ESTE arnés de pruebas sin Docker/root, no un defecto
      // de restore.sh (en el contenedor real, que corre como root de
      // verdad, esto nunca ocurre). Ver la nota grande en beforeAll.
      ...(cwd ? [`cd "${cwd}"`] : []),
      `exec "${RESTIC_BIN}" -r "$RESTIC_REPOSITORY" "$@"`,
    ].join("\n");
    return runInNamespace(
      fakeHome,
      {
        RESTIC_REPOSITORY: repository,
        RESTIC_PASSWORD: "testpass",
        RESTIC_SSH_KEY_FILE: secretKeyPath,
        RESTIC_SSH_KNOWN_HOSTS_FILE: secretKnownHostsPath,
      },
      ["bash", "-c", inline, "restic", ...resticArgs],
    );
  }

  // Invoca restore.sh DE VERDAD (el fichero bajo prueba), en un contenedor
  // de recuperación fresco. `env` sobreescribe la config sftp por defecto
  // (para las mutaciones); `pathOverride`, si se da, sustituye el PATH
  // entero (mutante "restic no accesible").
  function runRestore(
    args: string[],
    envOverride: Partial<
      Record<"RESTIC_SSH_KEY_FILE" | "RESTIC_SSH_KNOWN_HOSTS_FILE" | "RESTIC_REPOSITORY", string>
    > = {},
    pathOverride?: string,
  ): { code: number; out: string; fakeHome: string } {
    const fakeHome = freshFakeHome();
    const env: Record<string, string> = {
      RESTIC_REPOSITORY: envOverride.RESTIC_REPOSITORY ?? repository,
      RESTIC_PASSWORD: "testpass",
      RESTIC_SSH_KEY_FILE: envOverride.RESTIC_SSH_KEY_FILE ?? secretKeyPath,
      RESTIC_SSH_KNOWN_HOSTS_FILE: envOverride.RESTIC_SSH_KNOWN_HOSTS_FILE ?? secretKnownHostsPath,
    };
    env.PATH = pathOverride !== undefined ? pathOverride : `${dirname(RESTIC_BIN as string)}:${process.env.PATH ?? ""}`;
    const r = runInNamespace(fakeHome, env, ["bash", RESTORE_SH, ...args]);
    return { ...r, fakeHome };
  }

  // ── Caso base ──────────────────────────────────────────────────────────
  it("CONTENEDOR NUEVO, sin ~/.ssh previo, sin backup.sh ejecutado antes: restore.sh --list contra sftp real → PASS", () => {
    const r = runRestore(["--list"]);
    // eslint-disable-next-line no-console
    console.log("[caso base] exit:", r.code, "\n", r.out);
    expect(r.code).toBe(0);
    // Prueba de verdad de que este HOME nunca tuvo nada preexistente:
    // setup_ssh tuvo que crearlo de cero para que restic funcionara.
    expect(existsSync(join(r.fakeHome, ".ssh", "id_backup"))).toBe(true);
    expect(existsSync(join(r.fakeHome, ".ssh", "known_hosts"))).toBe(true);
  });

  // ── Mutaciones ─────────────────────────────────────────────────────────
  it("MUTACIÓN sin clave → FAIL (falta RESTIC_SSH_KEY_FILE, nunca llega a tocar la red)", () => {
    const r = runRestore(["--list"], { RESTIC_SSH_KEY_FILE: "" });
    console.log("[sin clave] exit:", r.code, "\n", r.out);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("falta RESTIC_SSH_KEY_FILE");
    // Causa concreta: preflight, NO un error de red/ssh.
    expect(r.out).not.toMatch(/Host key verification|Connection refused|Connection reset/);
  });

  it("MUTACIÓN clave con permisos malos → el bootstrap la corrige SOBRE COPIA LOCAL (PASS), original intacto", () => {
    const badPermKey = join(root, "bad-perm-key");
    writeFileSync(badPermKey, readFileSync(clientKeyPath));
    chmodSync(badPermKey, 0o644); // "UNPROTECTED PRIVATE KEY FILE" si se usara tal cual
    const r = runRestore(["--list"], { RESTIC_SSH_KEY_FILE: badPermKey });
    console.log("[permisos malos] exit:", r.code, "\n", r.out);
    expect(r.code).toBe(0);
    const copyMode = statSync(join(r.fakeHome, ".ssh", "id_backup")).mode & 0o777;
    expect(copyMode).toBe(0o600);
    // El original NUNCA se toca (chmod es sobre la copia, nunca sobre el secreto).
    const originalMode = statSync(badPermKey).mode & 0o777;
    expect(originalMode).toBe(0o644);
  });

  it("MUTACIÓN host fingerprint malo → FAIL por verificación de huella (StrictHostKeyChecking real, nunca 'no')", () => {
    // known_hosts real pero con la clave de OTRO host distinto para la
    // misma dirección — exactamente lo que produciría un MITM/DNS spoofing.
    const badKnownHosts = join(root, "bad_known_hosts");
    const otherPub = readFileSync(join(root, "keys", "otherhost.pub"), "utf8")
      .trim()
      .split(" ")
      .slice(0, 2)
      .join(" ");
    writeFileSync(badKnownHosts, `[127.0.0.1]:${port} ${otherPub}\n`);
    const r = runRestore(["--list"], { RESTIC_SSH_KNOWN_HOSTS_FILE: badKnownHosts });
    console.log("[fingerprint malo] exit:", r.code, "\n", r.out);
    expect(r.code).not.toBe(0);
    // Causa concreta: rechazo de huella por ssh, no timeout ni otro motivo.
    expect(r.out).toMatch(/HOST IDENTIFICATION HAS CHANGED|Host key verification failed/);
  });

  it("MUTACIÓN repository incorrecto → FAIL porque el repositorio no existe en esa ruta (ssh/huella SÍ correctos)", () => {
    const r = runRestore(["--list"], { RESTIC_REPOSITORY: `sftp://ia02@127.0.0.1:${port}${repoPath}-no-existe` });
    console.log("[repository incorrecto] exit:", r.code, "\n", r.out);
    expect(r.code).not.toBe(0);
    // Causa concreta: restic no encuentra el repositorio (config file), NO
    // un fallo de ssh/huella — si esto fallara por ssh, sería la mutación
    // equivocada disparándose por la razón equivocada.
    expect(r.out).toMatch(/unable to open repository|Is there a repository/i);
    expect(r.out).not.toMatch(/Host key verification failed|HOST IDENTIFICATION HAS CHANGED/);
  });

  it("MUTACIÓN restic no accesible → FAIL con 'orden no encontrada' (nunca un fallo de red disfrazado)", () => {
    // PATH real del sistema, SIN el directorio que contiene el restic de
    // prueba — exactamente "openssh-client sí, restic no" (el mismo defecto
    // de imagen documentado en backup.sh, aplicado aquí a restic).
    const sysPath = (process.env.PATH || "").split(":").filter((p) => p !== dirname(RESTIC_BIN as string));
    const r = runRestore(["--list"], {}, sysPath.join(":"));
    console.log("[restic no accesible] exit:", r.code, "\n", r.out);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/restic: (orden no encontrada|command not found)/);
  });

  it("MUTACIÓN snapshot corrupto → --verify FAIL por checksum real (sha256sum -c sobre datos restaurados de verdad)", () => {
    const dest = join(root, "restore-target-corrupt");
    mkdirSync(dest, { recursive: true });
    const restoreR = runRestore(["--restore", dest]);
    console.log("[snapshot corrupto] restore:", restoreR.code, "\n", restoreR.out);
    expect(restoreR.code).toBe(0);

    const restoredFile = execFileSync("find", [dest, "-name", "a.txt"], { encoding: "utf8" }).trim().split("\n")[0];
    expect(restoredFile, "el fichero restaurado maps/a.txt debe existir de verdad").toBeTruthy();
    writeFileSync(restoredFile, "contenido-corrompido-a-propósito\n"); // corrompe el dato YA restaurado

    const verifyR = runInNamespace(freshFakeHome(), {}, ["bash", RESTORE_SH, "--verify", dest]);
    console.log("[snapshot corrupto] verify:", verifyR.code, "\n", verifyR.out);
    expect(verifyR.code).not.toBe(0);
    // Causa concreta: fallo de checksum real de sha256sum -c, no "manifest
    // ausente" ni ningún otro motivo genérico.
    expect(verifyR.out).toMatch(/FAILED|sha256sum/i);
  });
});
