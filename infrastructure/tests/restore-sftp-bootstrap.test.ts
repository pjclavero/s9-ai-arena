// fix/restore-sftp-bootstrap — E2E REAL del bootstrap SSH de restore.sh
// contra un backend sftp: de restic, DENTRO de la imagen real de Docker.
//
// POR QUÉ EXISTE ESTE FICHERO: hasta esta rama, restore.sh no mencionaba
// ssh/sftp en ninguna parte (`git grep -n "ssh\|sftp\|setup" -- infrastructure/backup/restore.sh`
// daba 0 coincidencias en origin/main). En producción "funcionaba" de
// rebote: el contenedor de backup PROGRAMADO ya había dejado ~/.ssh listo
// (lo prepara backup.sh/setup_ssh, ver infrastructure/backup/lib/setup-ssh.sh)
// en la capa de escritura de ESE MISMO contenedor. Un contenedor de
// RECUPERACIÓN nuevo — el escenario real que docs/recuperacion.md exige
// poder demostrar — nunca ejecutó backup.sh y no tiene ~/.ssh: reproducido en
// vivo, `restic` fallaba con "Host key verification failed" hasta preparar
// SSH a mano.
//
// HISTORIA DE ESTE FICHERO (para el próximo que lo toque): la primera
// versión levantaba un `sshd` sin privilegios directamente en el runner de
// CI (sin Docker), con un namespace `unshare --user --map-root-user --mount`
// para hacer coincidir $HOME con /etc/passwd (ver el motivo en el punto de
// abajo, que sigue siendo cierto). Esa versión demostró con evidencia que:
//   (a) el namespace SÍ funcionaba en el runner (log: "userns sin
//       privilegios: disponible", y el propio fallo era un error de RESTIC,
//       no de `unshare`);
//   (b) el paquete openssh-sftp-server SÍ estaba instalado, con el binario
//       en la ruta esperada (`dpkg -L` lo confirmó, existsSync también);
//   (c) SSH en sí funcionaba perfectamente (el `sftp -v` de diagnóstico
//       llegaba a autenticar y validar la huella del host);
//   pero el subsistema `sftp` de UN SSHD SIN PRIVILEGIOS, lanzado suelto en
//   ese runner concreto de GitHub Actions, simplemente no arrancaba
//   ("server unexpectedly closed connection: unexpected EOF" al negociar la
//   versión del protocolo SFTP) — un defecto del ENTORNO del runner, no de
//   restore.sh. Insistir por ese camino habría sido gastar vueltas de CI en
//   el sitio equivocado.
//
// Esta versión usa exactamente el arnés que YA funciona en este repo para el
// mismo problema de fondo (SFTP real sin depender de un sshd suelto en el
// runner): infrastructure/tests/backup-sftp-e2e.test.ts, que este fichero NO
// modifica ni importa (carril paralelo) pero SÍ replica en su patrón —
// mismo servidor SFTP de prueba (atmoz/sftp, CON chroot real), misma imagen
// real de backup (reutilizada del job build-images, nunca reconstruida
// aquí), mismos helpers de robustez (sh() asíncrono con timeout propio,
// phase() con desglose de tiempos, waitFor() con diagnóstico en el propio
// fallo). El "contenedor de recuperación limpio" que exige el requisito es,
// aquí, LITERAL: cada mutación se ejecuta con un `docker run --rm` NUEVO,
// que nunca ejecutó backup.sh y no tiene ~/.ssh — no hace falta simularlo
// con un namespace, Docker ya da un filesystem nuevo por cada `run`.
//
// EL PROBLEMA DEL "CONTENEDOR FRESCO" QUE ESTE FICHERO EXISTE PARA CERRAR:
// dentro de un contenedor de recuperación recién creado, `restore.sh` debe
// preparar ~/.ssh por sí mismo a partir de RESTIC_SSH_KEY_FILE/
// RESTIC_SSH_KNOWN_HOSTS_FILE — nunca depender de que backup.sh se haya
// ejecutado antes en ese mismo contenedor.
//
// Corre en su propio job obligatorio de la CI, `e2e-restore-sftp-bootstrap`
// (.github/workflows/ci.yml), reutilizando la imagen que ya exporta
// build-images para e2e-backup-sftp (mismo artefacto `backup-image-tar`,
// mismo tag `s9-ai-arena/backup:e2e-test`) — no se reconstruye nada aquí.
// Si Docker no está disponible, la suite FALLA a propósito (nunca se salta
// en silencio): ver IS_CI/HAS_DOCKER más abajo, mismo mecanismo que
// backup-sftp-e2e.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, writeSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Debe coincidir con el tag que ci.yml pone a la imagen reutilizada de
// build-images (idéntico al que usa backup-sftp-e2e.test.ts — es la MISMA
// imagen, reutilizada, no una copia).
const IMAGE_TAG = "s9-ai-arena/backup:e2e-test";
const NET = "s9-restore-e2e-net";
const SFTP_CONTAINER = "s9-restore-e2e-sftp";
const PG_CONTAINER = "s9-restore-e2e-pg";
const SFTP_USER = "backupuser";
// Mismo esquema que backup-sftp-e2e.test.ts: "usuario::uid::gid::directorio"
// crea el directorio DENTRO del home del usuario como subcarpeta escribible;
// el home es la raíz del chroot (ChrootDirectory exige que sea propiedad de
// root y no escribible por grupo/otros). Desde la sesión SFTP se ve como
// "/restic", nunca la ruta física.
const SFTP_SUBDIR = "restic";
const CHROOT_PATH = `/${SFTP_SUBDIR}`;

// ── Observabilidad: mismo patrón que backup-sftp-e2e.test.ts (writeSync
// síncrono, nunca console.log con búfer) — ver ese fichero para el
// incidente real que motivó esto (un cuelgue de 15 min sin una sola línea). ─
function ts(): string {
  return new Date().toISOString().slice(11, 23);
}
function logLine(msg: string) {
  writeSync(2, `[${ts()}] ${msg}\n`);
}

const phaseTimings: { name: string; ms: number; ok: boolean }[] = [];

async function phase<T>(name: string, fn: () => Promise<T>): Promise<T> {
  logLine(`▶ inicio: ${name}`);
  const start = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - start;
    phaseTimings.push({ name, ms, ok: true });
    logLine(`✔ fin:    ${name} (${(ms / 1000).toFixed(1)}s)`);
    return result;
  } catch (e) {
    const ms = Date.now() - start;
    phaseTimings.push({ name, ms, ok: false });
    logLine(`✖ FALLO:  ${name} (${(ms / 1000).toFixed(1)}s) — ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}

function dumpPhaseTimings() {
  if (phaseTimings.length === 0) return;
  logLine("── desglose de tiempos por fase ──────────────────────────────");
  for (const t of phaseTimings) {
    logLine(`  ${t.ok ? "OK  " : "FAIL"} ${(t.ms / 1000).toFixed(1).padStart(7)}s  ${t.name}`);
  }
  const total = phaseTimings.reduce((a, t) => a + t.ms, 0);
  logLine(`  TOTAL ${(total / 1000).toFixed(1)}s`);
}

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const HAS_DOCKER = dockerAvailable();
// Mismo mecanismo que backup-sftp-e2e.test.ts: fuera de CI, comodidad de
// desarrollo local sin Docker (se salta con aviso). DENTRO de CI, si Docker
// faltara, el describe se ejecuta igual y el primer beforeAll revienta con
// un mensaje explícito — nunca un "skipped" silencioso.
const IS_CI = process.env.CI === "true" || process.env.CI === "1";
const SKIP_LOCALLY_WITHOUT_DOCKER = !HAS_DOCKER && !IS_CI;
if (!HAS_DOCKER) {
  // eslint-disable-next-line no-console
  console.warn(
    IS_CI
      ? "[restore-sftp-bootstrap] CI=true pero docker no está disponible: el E2E NO se salta — va a " +
          "fallar a propósito en beforeAll para que sea visible en el pipeline."
      : "[restore-sftp-bootstrap] docker no disponible en este entorno: se OMITE el E2E real. Corre en " +
          "el job `e2e-restore-sftp-bootstrap` de .github/workflows/ci.yml. NO se sustituye por un sshd " +
          "suelto en el runner: esa vía se probó y el propio runner de CI no la soporta (ver la cabecera " +
          "de este fichero) — sería reintroducir el mismo problema que motivó este cambio de arnés.",
  );
}

// sh(): idéntico patrón que backup-sftp-e2e.test.ts — spawn + Promise (NO
// execFileSync síncrono, que bloqueaba el hilo de Node y ocultaba timeouts
// de vitest), con timeout propio y streaming opcional en vivo.
function sh(
  cmd: string,
  args: string[],
  opts: { input?: string; timeoutMs?: number; stream?: boolean } = {},
): Promise<{ code: number; out: string; timedOut: boolean }> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const stream = opts.stream ?? false;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      logLine(`⏱ TIMEOUT (${(timeoutMs / 1000).toFixed(0)}s) matando: ${cmd} ${args.join(" ")}`);
      child.kill("SIGKILL");
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      out += text;
      if (stream) {
        for (const line of text.split("\n")) {
          if (line.length > 0) logLine(`  │ ${line}`);
        }
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code ?? 1), out, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, out: `${out}\n[spawn error] ${err.message}`, timedOut: false });
    });
  });
}

function dockerExec(container: string, args: string[], opts: { timeoutMs?: number } = {}) {
  return sh("docker", ["exec", container, ...args], opts);
}

function dockerRun(args: string[], opts: { timeoutMs?: number } = {}) {
  return sh("docker", ["run", ...args], opts);
}

// Verdad de kernel (/proc/net/tcp dentro del contenedor SFTP), no un mensaje
// de log concreto de atmoz/sftp — mismo mecanismo que backup-sftp-e2e.test.ts.
async function sftpListening(): Promise<boolean> {
  const r = await dockerExec(SFTP_CONTAINER, ["sh", "-c", "cat /proc/net/tcp 2>/dev/null"], { timeoutMs: 10_000 });
  if (r.code !== 0) return false;
  return /: [0-9A-F]{8}:0016 [0-9A-F]{8}:[0-9A-F]{4} 0A/.test(r.out);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => Promise<boolean>, what: string, timeoutMs = 60_000, stepMs = 500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await sleep(stepMs);
  }
  logLine(`✖ TIMEOUT esperando "${what}" tras ${(timeoutMs / 1000).toFixed(0)}s`);
  logLine("--- docker ps -a ---");
  logLine((await sh("docker", ["ps", "-a"], { timeoutMs: 10_000 })).out);
  for (const c of [SFTP_CONTAINER, PG_CONTAINER]) {
    const inspect = await sh("docker", ["inspect", "-f", "{{.State.Status}} (exit={{.State.ExitCode}})", c], {
      timeoutMs: 10_000,
    });
    logLine(`--- estado de ${c}: ${inspect.out.trim() || "(no existe)"} ---`);
    logLine(`--- docker logs ${c} ---`);
    logLine((await sh("docker", ["logs", c], { timeoutMs: 10_000 })).out);
  }
  throw new Error(`timeout esperando: ${what} (${(timeoutMs / 1000).toFixed(0)}s)`);
}

describe.skipIf(SKIP_LOCALLY_WITHOUT_DOCKER)(
  "restore.sh — bootstrap SSH real, imagen backup real + SFTP con chroot (E2E)",
  () => {
    let tmp: string;
    let keyPath: string; // clave buena (par con la que conoce el SFTP)
    let otherKeyPath: string; // clave de OTRO host, para el mutante de fingerprint
    let knownHostsPath: string;
    let repository: string;

    beforeAll(async () => {
      if (IS_CI && !HAS_DOCKER) {
        throw new Error(
          "docker no está disponible en este job de CI. El E2E de fix/restore-sftp-bootstrap EXIGE " +
            "Docker real (imagen backup + atmoz/sftp con chroot) — no tiene sentido 'saltarlo' en CI: " +
            "eso es exactamente el escenario ('funciona en el repo, falla en la imagen') que este " +
            "fichero existe para evitar. Revisa que el job use runs-on: ubuntu-latest sin `container:`.",
        );
      }

      tmp = mkdtempSync(join(tmpdir(), "s9-restore-e2e-"));

      await phase("limpieza defensiva (contenedores/red de una ejecución anterior)", async () => {
        for (const c of [SFTP_CONTAINER, PG_CONTAINER]) await sh("docker", ["rm", "-f", c]);
        await sh("docker", ["network", "rm", NET]);
        const netCreate = await sh("docker", ["network", "create", NET], { timeoutMs: 15_000 });
        if (netCreate.code !== 0) throw new Error(`no se pudo crear la red de prueba ${NET}:\n${netCreate.out}`);
      });

      // Imagen backup: SIEMPRE reutilizada del job build-images en CI (ci.yml
      // la carga y etiqueta como IMAGE_TAG antes de invocar vitest). Nunca se
      // reconstruye aquí — mismo motivo que backup-sftp-e2e.test.ts: es más
      // rápido y más fiel (ejercita el artefacto real). Si no está cargada
      // (uso local sin ese paso previo), se falla con un mensaje claro en
      // vez de reconstruir en silencio una imagen que podría divergir.
      await phase("imagen backup: comprobar que está cargada (reutilizada de build-images)", async () => {
        const inspect = await sh("docker", ["image", "inspect", IMAGE_TAG], { timeoutMs: 10_000 });
        if (inspect.code !== 0) {
          throw new Error(
            `la imagen ${IMAGE_TAG} no está cargada. En CI la carga el job e2e-restore-sftp-bootstrap ` +
              "(mismo artefacto backup-image-tar que exporta build-images). En local: " +
              `docker build -f infrastructure/docker/backup/Dockerfile -t ${IMAGE_TAG} .`,
          );
        }
        logLine(`imagen ${IMAGE_TAG} presente (reutilizada) — no se reconstruye`);
      });

      // Dos claves: la real (par con la que se instala en el SFTP de
      // prueba) y otra de "otro host" para el mutante de fingerprint malo.
      keyPath = join(tmp, "id_backup");
      await phase("ssh-keygen (clave de prueba)", async () => {
        const keygen = await sh("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath, "-C", "e2e-test"], {
          timeoutMs: 15_000,
        });
        if (keygen.code !== 0) throw new Error(`ssh-keygen falló:\n${keygen.out}`);
      });
      otherKeyPath = join(tmp, "id_otherhost");
      await phase("ssh-keygen (clave de OTRO host, para el mutante de fingerprint)", async () => {
        const keygen = await sh("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", otherKeyPath, "-C", "other-host"], {
          timeoutMs: 15_000,
        });
        if (keygen.code !== 0) throw new Error(`ssh-keygen falló:\n${keygen.out}`);
      });

      await phase("docker pull atmoz/sftp", async () => {
        const pull = await sh("docker", ["pull", "atmoz/sftp"], { timeoutMs: 120_000, stream: true });
        if (pull.code !== 0) throw new Error(`no se pudo descargar atmoz/sftp:\n${pull.out}`);
      });
      await phase("docker pull postgres:16-alpine", async () => {
        const pull = await sh("docker", ["pull", "postgres:16-alpine"], { timeoutMs: 120_000, stream: true });
        if (pull.code !== 0) throw new Error(`no se pudo descargar postgres:16-alpine:\n${pull.out}`);
      });

      await phase("docker run sftp (atmoz/sftp, chroot)", async () => {
        const runSftp = await dockerRun(
          [
            "-d",
            "--name",
            SFTP_CONTAINER,
            "--network",
            NET,
            "-v",
            `${keyPath}.pub:/home/${SFTP_USER}/.ssh/keys/id_ed25519.pub:ro`,
            "atmoz/sftp",
            `${SFTP_USER}::1001::${SFTP_SUBDIR}`,
          ],
          { timeoutMs: 30_000 },
        );
        if (runSftp.code !== 0) throw new Error(`no se pudo levantar el servidor SFTP de prueba:\n${runSftp.out}`);
      });
      await phase("docker run postgres (fuente crítica de backup.sh, para producir un snapshot real)", async () => {
        const runPg = await dockerRun(
          [
            "-d",
            "--name",
            PG_CONTAINER,
            "--network",
            NET,
            "-e",
            "POSTGRES_USER=arena",
            "-e",
            "POSTGRES_PASSWORD=arena-e2e-test",
            "-e",
            "POSTGRES_DB=arena",
            "postgres:16-alpine",
          ],
          { timeoutMs: 30_000 },
        );
        if (runPg.code !== 0) throw new Error(`no se pudo levantar postgres de prueba:\n${runPg.out}`);
      });

      await phase("esperar: postgres de prueba listo", () =>
        waitFor(
          async () => (await dockerExec(PG_CONTAINER, ["pg_isready", "-U", "arena"])).code === 0,
          "postgres de prueba",
          60_000,
        ),
      );
      await phase("esperar: sshd del SFTP de prueba escuchando", () =>
        waitFor(sftpListening, "sshd del SFTP de prueba (puerto 22 en LISTEN)", 60_000),
      );

      // known_hosts REAL, capturado con ssh-keyscan desde la propia imagen
      // bajo prueba, en la misma red — mismo camino que backup-sftp-e2e.test.ts.
      let knownHosts = "";
      await phase("captura de known_hosts (ssh-keyscan desde la propia imagen)", () =>
        waitFor(
          async () => {
            const r = await sh(
              "docker",
              [
                "run",
                "--rm",
                "--network",
                NET,
                "--entrypoint",
                "ssh-keyscan",
                IMAGE_TAG,
                "-t",
                "ed25519",
                SFTP_CONTAINER,
              ],
              { timeoutMs: 15_000 },
            );
            if (r.out.includes("ssh-ed25519")) {
              knownHosts = r.out;
              return true;
            }
            logLine(`  ssh-keyscan aún sin huella (code=${r.code}): ${r.out.trim().slice(0, 300) || "(vacía)"}`);
            return false;
          },
          "captura de known_hosts con ssh-keyscan",
          30_000,
          1_000,
        ),
      );
      knownHostsPath = join(tmp, "known_hosts");
      writeFileSync(knownHostsPath, knownHosts, { mode: 0o644 });
      chmodSync(keyPath, 0o600);

      writeFileSync(join(tmp, "restic_password"), "e2e-restic-password", { mode: 0o600 });
      writeFileSync(join(tmp, "postgres_password"), "arena-e2e-test", { mode: 0o600 });
      const secretsDir = join(tmp, "secrets");
      mkdirSync(secretsDir, { recursive: true });
      writeFileSync(join(secretsDir, "ejemplo.txt"), "contenido-de-mentira-para-el-e2e\n", { mode: 0o600 });

      repository = `sftp:${SFTP_USER}@${SFTP_CONTAINER}:${CHROOT_PATH}`;

      // ── Puesta en marcha del repositorio (docs/recuperacion.md): paso
      // EXPLÍCITO con backup.sh --init-repo, igual que en producción — nunca
      // implícito dentro de restore.sh. ────────────────────────────────────
      await phase("backup.sh --init-repo (puesta en marcha del repositorio de prueba)", async () => {
        const init = await dockerRun(
          [
            "--rm",
            "--network",
            NET,
            "-v",
            `${keyPath}:/run/secrets/restic_ssh_key:ro`,
            "-v",
            `${knownHostsPath}:/run/secrets/restic_ssh_known_hosts:ro`,
            "-v",
            `${tmp}/restic_password:/run/secrets/restic_password:ro`,
            "-e",
            `RESTIC_REPOSITORY=${repository}`,
            "-e",
            "RESTIC_PASSWORD_FILE=/run/secrets/restic_password",
            "-e",
            "RESTIC_SSH_KEY_FILE=/run/secrets/restic_ssh_key",
            "-e",
            "RESTIC_SSH_KNOWN_HOSTS_FILE=/run/secrets/restic_ssh_known_hosts",
            "--entrypoint",
            "/usr/local/bin/backup.sh",
            IMAGE_TAG,
            "--init-repo",
          ],
          { timeoutMs: 60_000 },
        );
        if (init.code !== 0) throw new Error(`backup.sh --init-repo falló:\n${init.out}`);
      });

      // ── UN snapshot real (tag s9-arena-data) subido por backup.sh de
      // verdad (postgres real + maps con un fichero) — no un manifest
      // fabricado a mano: así el mutante "snapshot corrupto" corrompe datos
      // que de verdad pasaron por el pipeline real de backup.sh/restic. ────
      const mapsDir = join(tmp, "data-maps");
      mkdirSync(mapsDir, { recursive: true });
      writeFileSync(join(mapsDir, "a.txt"), "hola-mapa\n");
      await phase("backup.sh real (produce el snapshot que las mutaciones de restore.sh van a consumir)", async () => {
        const run = await dockerRun(
          [
            "--rm",
            "--network",
            NET,
            "-v",
            `${keyPath}:/run/secrets/restic_ssh_key:ro`,
            "-v",
            `${knownHostsPath}:/run/secrets/restic_ssh_known_hosts:ro`,
            "-v",
            `${tmp}/restic_password:/run/secrets/restic_password:ro`,
            "-v",
            `${tmp}/postgres_password:/run/secrets/postgres_password:ro`,
            "-v",
            `${secretsDir}:/secrets:ro`,
            "-v",
            `${mapsDir}:/data/maps:ro`,
            "-e",
            `RESTIC_REPOSITORY=${repository}`,
            "-e",
            "RESTIC_PASSWORD_FILE=/run/secrets/restic_password",
            "-e",
            "RESTIC_SSH_KEY_FILE=/run/secrets/restic_ssh_key",
            "-e",
            "RESTIC_SSH_KNOWN_HOSTS_FILE=/run/secrets/restic_ssh_known_hosts",
            "-e",
            "PGHOST=" + PG_CONTAINER,
            "-e",
            "PGUSER=arena",
            "-e",
            "PGDATABASE=arena",
            "-e",
            "PGPASSWORD_FILE=/run/secrets/postgres_password",
            "-e",
            "METRICS_DIR=/tmp/textfile",
            "--entrypoint",
            "/usr/local/bin/backup.sh",
            IMAGE_TAG,
          ],
          { timeoutMs: 90_000 },
        );
        if (run.code !== 0 || !run.out.includes("backup SUCCESS")) {
          throw new Error(`backup.sh real (preparación del snapshot) no llegó a SUCCESS:\n${run.out}`);
        }
      });

      dumpPhaseTimings();
    }, 300_000);

    afterAll(async () => {
      dumpPhaseTimings();
      for (const c of [SFTP_CONTAINER, PG_CONTAINER]) await sh("docker", ["rm", "-f", c]);
      await sh("docker", ["network", "rm", NET]);
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }, 60_000);

    // runRestore: SIEMPRE un `docker run --rm` NUEVO — el "contenedor de
    // recuperación limpio" del requisito no se simula, ES la propia
    // semántica de `docker run`: filesystem nuevo, nunca ejecutó backup.sh,
    // sin ~/.ssh previo. `entrypoint` se fuerza a restore.sh directamente
    // (nunca al ENTRYPOINT real, que programa cron — no aplica aquí).
    function runRestore(
      args: string[],
      opts: {
        keyFile?: string; // ruta en el HOST del fichero a montar como RESTIC_SSH_KEY_FILE (o "" para omitir)
        keyMode?: number; // permisos del fichero de clave EN EL HOST antes de montarlo (bind-mount los conserva)
        knownHostsFile?: string; // ruta en el HOST del known_hosts a montar
        repository?: string; // override de RESTIC_REPOSITORY
        extraMounts?: string[]; // más -v host:container[:ro]
        resticAusente?: boolean; // simula "restic ausente de la imagen"
      } = {},
    ) {
      const mounts: string[] = [];
      const env: string[] = [];
      const effectiveKeyFile = opts.keyFile ?? keyPath;
      if (effectiveKeyFile !== "") {
        if (opts.keyMode !== undefined) chmodSync(effectiveKeyFile, opts.keyMode);
        mounts.push("-v", `${effectiveKeyFile}:/run/secrets/restic_ssh_key:ro`);
        env.push("-e", "RESTIC_SSH_KEY_FILE=/run/secrets/restic_ssh_key");
      }
      const effectiveKnownHosts = opts.knownHostsFile ?? knownHostsPath;
      if (effectiveKnownHosts !== "") {
        mounts.push("-v", `${effectiveKnownHosts}:/run/secrets/restic_ssh_known_hosts:ro`);
        env.push("-e", "RESTIC_SSH_KNOWN_HOSTS_FILE=/run/secrets/restic_ssh_known_hosts");
      }
      mounts.push("-v", `${join(tmp, "restic_password")}:/run/secrets/restic_password:ro`);
      env.push("-e", "RESTIC_PASSWORD_FILE=/run/secrets/restic_password");
      env.push("-e", `RESTIC_REPOSITORY=${opts.repository ?? repository}`);
      // "restic ausente": se BORRA de verdad en ESTE contenedor efímero
      // (--rm; nunca toca la imagen compartida ni otros `docker run`) antes
      // de invocar restore.sh — más fiel que manipular PATH, que rompería
      // también coreutils/ssh que el propio bootstrap necesita.
      const entrypointCmd = opts.resticAusente
        ? [
            "/bin/sh",
            "-c",
            `rm -f "$(command -v restic)"; exec /usr/local/bin/restore.sh ${args.map((a) => `'${a}'`).join(" ")}`,
          ]
        : ["/usr/local/bin/restore.sh", ...args];
      return dockerRun(
        [
          "--rm",
          "--network",
          NET,
          ...mounts,
          ...(opts.extraMounts ?? []),
          ...env,
          "--entrypoint",
          entrypointCmd[0],
          IMAGE_TAG,
          ...entrypointCmd.slice(1),
        ],
        { timeoutMs: 30_000 },
      );
    }

    // ── Caso base ────────────────────────────────────────────────────────
    it("CONTENEDOR DE RECUPERACIÓN NUEVO (nunca ejecutó backup.sh, sin ~/.ssh) — restore.sh --list contra sftp real → PASS", async () => {
      const r = await runRestore(["--list"]);
      logLine(`[caso base] exit=${r.code}\n${r.out}`);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/snapshots|ID\s+Time/i);
    });

    // ── Mutaciones ───────────────────────────────────────────────────────
    it("MUTACIÓN sin clave → FAIL (falta RESTIC_SSH_KEY_FILE, nunca llega a tocar la red)", async () => {
      const r = await runRestore(["--list"], { keyFile: "" });
      logLine(`[sin clave] exit=${r.code}\n${r.out}`);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("falta RESTIC_SSH_KEY_FILE");
      expect(r.out).not.toMatch(/Host key verification|Connection refused|Connection reset/);
    });

    it("MUTACIÓN clave con permisos malos → el bootstrap la corrige SOBRE COPIA LOCAL (PASS)", async () => {
      const badPermKey = join(tmp, "id_backup_badperm");
      writeFileSync(badPermKey, readFileSync(keyPath));
      const r = await runRestore(["--list"], { keyFile: badPermKey, keyMode: 0o644 });
      logLine(`[permisos malos] exit=${r.code}\n${r.out}`);
      expect(r.code).toBe(0);
      // El original (montado 0644 a propósito) nunca se toca: el chmod real
      // de setup_ssh ocurre sobre la copia DENTRO del contenedor efímero,
      // que desaparece con --rm. Lo único verificable desde fuera es que el
      // original sigue en el modo que se montó.
      expect((await sh("stat", ["-c", "%a", badPermKey], { timeoutMs: 5_000 })).out.trim()).toBe("644");
    });

    it("MUTACIÓN host fingerprint malo → FAIL por verificación de huella (StrictHostKeyChecking real, nunca 'no')", async () => {
      const badKnownHosts = join(tmp, "known_hosts_bad");
      const otherPub = readFileSync(`${otherKeyPath}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ");
      writeFileSync(badKnownHosts, `${SFTP_CONTAINER} ${otherPub}\n`);
      const r = await runRestore(["--list"], { knownHostsFile: badKnownHosts });
      logLine(`[fingerprint malo] exit=${r.code}\n${r.out}`);
      expect(r.code).not.toBe(0);
      expect(r.out.toLowerCase()).toMatch(/host key verification failed|remote host identification has changed/);
    });

    it("MUTACIÓN repository incorrecto → FAIL porque el repositorio no existe en esa ruta (ssh/huella SÍ correctos)", async () => {
      const r = await runRestore(["--list"], {
        repository: `sftp:${SFTP_USER}@${SFTP_CONTAINER}:${CHROOT_PATH}-no-existe`,
      });
      logLine(`[repository incorrecto] exit=${r.code}\n${r.out}`);
      expect(r.code).not.toBe(0);
      expect(r.out).toMatch(/unable to open repository|Is there a repository|unable to open config file/i);
      expect(r.out.toLowerCase()).not.toMatch(/host key verification failed|remote host identification has changed/);
    });

    it("MUTACIÓN restic no accesible → FAIL con 'orden no encontrada' (nunca un fallo de red disfrazado)", async () => {
      const r = await runRestore(["--list"], { resticAusente: true });
      logLine(`[restic no accesible] exit=${r.code}\n${r.out}`);
      expect(r.code).not.toBe(0);
      expect(r.out).toMatch(/restic.*not found|not found.*restic|command not found/i);
    });

    it("MUTACIÓN snapshot corrupto → --verify FAIL por checksum real (sha256sum -c sobre datos restaurados de verdad)", async () => {
      const dest = join(tmp, "restore-target-corrupt");
      mkdirSync(dest, { recursive: true });
      const restoreR = await runRestore(["--restore", "/restore-target"], {
        extraMounts: ["-v", `${dest}:/restore-target`],
      });
      logLine(`[snapshot corrupto] restore exit=${restoreR.code}\n${restoreR.out}`);
      expect(restoreR.code).toBe(0);

      const found = await sh("find", [dest, "-name", "a.txt"], { timeoutMs: 10_000 });
      const restoredFile = found.out.trim().split("\n")[0];
      expect(restoredFile, "el fichero restaurado maps/a.txt debe existir de verdad").toBeTruthy();
      writeFileSync(restoredFile, "contenido-corrompido-a-propósito\n");

      const verifyR = await runRestore(["--verify", "/restore-target"], {
        extraMounts: ["-v", `${dest}:/restore-target`],
      });
      logLine(`[snapshot corrupto] verify exit=${verifyR.code}\n${verifyR.out}`);
      expect(verifyR.code).not.toBe(0);
      expect(verifyR.out).toMatch(/FAILED|sha256sum|no coincide/i);
    });
  },
);
