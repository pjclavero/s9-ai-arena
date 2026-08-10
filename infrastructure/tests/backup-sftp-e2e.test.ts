// fix/backup-sftp-scheduled-runtime — E2E de verdad, DENTRO de la MISMA
// imagen y el MISMO entrypoint que usa el job programado.
//
// POR QUÉ EXISTE ESTE FICHERO: el primer backup real se hizo A MANO desde el
// host, y "funcionó" — pero el backup PROGRAMADO seguía roto por dos
// defectos que un `restic -r … snapshots` lanzado desde el host, o incluso
// un `restore.sh --dry-run` que sólo valida variables, NUNCA reproduce:
//   1. `openssh-client` no estaba en infrastructure/docker/backup/Dockerfile.
//      El host SÍ tiene `ssh`; la imagen del backup NO lo tenía. El backend
//      `sftp:` de restic delega en el binario `ssh`, así que el job
//      programado fallaba en EJECUCIÓN, cada noche, silenciosamente (hasta
//      que la alerta BackupTooOld saltara a las 26 h).
//   2. La cuenta del host de respaldo está confinada con `ChrootDirectory`:
//      la ruta física del host no es la que ve la sesión SFTP. Un
//      RESTIC_REPOSITORY con la ruta física fuera del chroot da "No such
//      file" desde DENTRO del contenedor, aunque un cliente sftp manual
//      apuntando a otra ruta (probada por error) pareciera funcionar.
//
// Esta suite reutiliza la imagen real que build-images ya construye en CI
// (mismo Dockerfile, ver ci.yml: job e2e-backup-sftp descarga el artefacto
// backup-image-tar y la carga como `s9-ai-arena/backup:e2e-test` antes de
// invocar vitest — en local, si esa imagen no existe, esta suite la
// construye ella misma), levanta un servidor SFTP de prueba (atmoz/sftp) CON
// chroot real (el usuario de prueba sólo ve su subdirectorio "restic" como
// raíz — misma topología que el host de respaldo real, ver
// infrastructure/.env.example), arranca el contenedor de backup con su
// ENTRYPOINT real (sin overrides) y ejercita backup.sh dentro de ese
// contenedor ya en marcha. Nada de esto se simula: si `openssh-client`
// desapareciera del Dockerfile, o si alguien "arreglara" un timeout con
// StrictHostKeyChecking=no, o si la ruta volviera a ser la física del host,
// esta suite falla.
//
// Corre en su propio job obligatorio de la CI, `e2e-backup-sftp`
// (.github/workflows/ci.yml), en ubuntu-latest con daemon Docker
// preinstalado — deliberadamente FUERA del job `unit` (que también corre
// infrastructure/, pero excluye este fichero explícitamente: construir una
// imagen y levantar contenedores no pinta en un informe de cobertura de
// TypeScript, y merece su propio veredicto en el semáforo de ci-gate.mjs).
// Localmente, si Docker no está disponible (p. ej. un entorno de agente sin
// permiso sobre /var/run/docker.sock, como el que escribió esta suite), los
// tests se OMITEN con un aviso — pero NUNCA en CI (ver IS_CI más abajo: ahí
// la ausencia de Docker hace fallar el job a propósito). No se sustituye por
// una comprobación que no ejerza la imagen real, porque eso sería
// reintroducir exactamente el defecto que este fichero existe para atrapar.
//
// REGISTRO DE INCIDENTES REALES DE ESTE FICHERO (para el próximo que lo toque):
//
// #1 — `docker inspect -f '{{.NetworkSettings.Networks.<red>.IPAddress}}'`
// con un nombre de red con GUIONES ("s9-backup-e2e-net"). El motor de
// plantillas de Go (`text/template`) no admite guiones en el acceso
// `.Campo`: la plantilla ni parseaba, `docker inspect` devolvía un error de
// parseo por stderr, `sh()` lo capturaba como si fuera la IP, y
// `ssh-keyscan` se quedaba resolviendo ese "host" hasta agotar el timeout —
// falló en CI como "timeout esperando: sshd del SFTP de prueba" sin ninguna
// pista. Arreglo: nunca más depender de esa plantilla; sshd se comprueba
// leyendo /proc/net/tcp DENTRO del contenedor (verdad de kernel), y el
// known_hosts se captura con `ssh-keyscan` desde un contenedor efímero de la
// PROPIA imagen bajo prueba, en la misma red (mismo camino que usará después
// el contenedor de backup real).
//
// #2 — Con el fallo de #1 ya arreglado, la ejecución real en CI se quedó
// colgada 15 minutos SIN EMITIR UNA SOLA LÍNEA, hasta que GitHub Actions
// canceló el job por su propio timeout-minutes — el hook de 180 s de esta
// misma suite (vitest) NUNCA llegó a dispararse. Causa: todas las llamadas a
// Docker usaban `execFileSync`, que es SÍNCRONO — bloquea el hilo único de
// Node por completo mientras dura, así que ni puede emitirse salida
// intermedia NI el propio vitest puede comprobar si su timeout ya venció
// (su mecanismo de timeout necesita el bucle de eventos libre para
// dispararse). Un `docker build`/`docker pull` lento no fallaba con un
// mensaje de vitest: colgaba el proceso entero, invisible, hasta que un
// vigilante EXTERNO (GitHub Actions) lo mataba a ciegas a los 15 minutos.
// Arreglo de fondo: `sh()` es ahora asíncrono (`spawn` + Promise), con
// streaming en vivo (marca de tiempo por línea, escritura síncrona con
// `fs.writeSync` para que no se pierda nada si el proceso muere después) y
// un timeout PROPIO por comando (bastante menor que el del job) que mata el
// proceso hijo y lanza un error con la fase exacta. Además, el job de CI
// (ci.yml) ya NO reconstruye esta imagen desde cero: reutiliza la que
// construye build-images (ver el comentario de ese job), eliminando el
// `apk add` completo como sospechoso número uno del cuelgue.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..");
const DOCKERFILE = join(REPO_ROOT, "infrastructure", "docker", "backup", "Dockerfile");
const BACKUP_SH_PATH = join(REPO_ROOT, "infrastructure", "backup", "backup.sh");
const RESTORE_SH_PATH = join(REPO_ROOT, "infrastructure", "backup", "restore.sh");
const ENTRYPOINT_SH_PATH = join(REPO_ROOT, "infrastructure", "backup", "entrypoint.sh");
// Debe coincidir con el tag que ci.yml pone a la imagen reutilizada de
// build-images (`docker tag ... s9-ai-arena/backup:e2e-test`).
const IMAGE_TAG = "s9-ai-arena/backup:e2e-test";
const NET = "s9-backup-e2e-net";
const SFTP_CONTAINER = "s9-backup-e2e-sftp";
const PG_CONTAINER = "s9-backup-e2e-pg";
const BACKUP_CONTAINER = "s9-backup-e2e-backup";
const SFTP_USER = "backupuser";
// atmoz/sftp: "usuario::uid::gid::directorio" crea el directorio DENTRO del
// home del usuario como subcarpeta ESCRIBIBLE; el propio home es la raíz del
// chroot y NO es escribible por requisito de sshd (ChrootDirectory exige que
// el directorio raíz sea propiedad de root y no escribible por el grupo/
// otros). Desde la sesión SFTP (ya dentro del chroot) esa subcarpeta se ve
// como "/restic" — exactamente la ruta "dentro del chroot" que documenta
// infrastructure/.env.example, y NO "/home/backupuser/restic" (la ruta
// física, invisible desde dentro de la sesión confinada).
const SFTP_SUBDIR = "restic";
const CHROOT_PATH = `/${SFTP_SUBDIR}`;

// ── Observabilidad: timestamps con escritura SÍNCRONA (fs.writeSync), nunca
// console.log (que en un pipe de Linux es asíncrono/con búfer y puede
// perderse si el proceso muere). Ver incidente #2 de la cabecera. ──────────
function ts(): string {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}
function logLine(msg: string) {
  writeSync(2, `[${ts()}] ${msg}\n`);
}

const phaseTimings: { name: string; ms: number; ok: boolean }[] = [];

// phase(): mide y registra cada etapa lenta (pull, build, arranque,
// ejecución de backup.sh...) para que "dónde se va el tiempo" sea un dato,
// no una intuición — pedido explícito del coordinador tras el incidente #2.
// El resumen completo se vuelca en afterAll, pase lo que pase.
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
// GitHub Actions (y la mayoría de runners de CI) exportan CI=true. Hallazgo
// del coordinador: un `describe.skipIf` sin más se salta EN SILENCIO también
// en CI si por lo que sea el runner no tiene Docker — el peor escenario
// posible, porque un "skipped" no hace fallar el pipeline y nadie se entera
// de que el E2E real nunca corrió. Por eso el salto SÓLO se permite fuera de
// CI (comodidad de desarrollo local sin Docker); dentro de CI, si falta
// Docker, el describe se ejecuta igual y el primer `beforeAll` revienta con
// un mensaje explícito — un rojo ruidoso, nunca un skip silencioso.
const IS_CI = process.env.CI === "true" || process.env.CI === "1";
const SKIP_LOCALLY_WITHOUT_DOCKER = !HAS_DOCKER && !IS_CI;
if (!HAS_DOCKER) {
  // eslint-disable-next-line no-console
  console.warn(
    IS_CI
      ? "[backup-sftp-e2e] CI=true pero docker no está disponible: el E2E NO se salta — va a " +
          "fallar a propósito en beforeAll para que sea visible en el pipeline, en vez de " +
          "reportar 'skipped' y dar una falsa sensación de cobertura."
      : "[backup-sftp-e2e] docker no disponible en este entorno (sin acceso al daemon): " +
          "se OMITE el E2E real. Debe ejecutarse donde SÍ haya Docker — el job `e2e-backup-sftp` " +
          "de .github/workflows/ci.yml corre en ubuntu-latest con daemon Docker preinstalado. " +
          "NO se sustituye por una prueba sin contenedor real: sería el mismo defecto que " +
          "este fichero existe para atrapar.",
  );
}

// sh(): reemplaza el antiguo execFileSync SÍNCRONO (incidente #2 de la
// cabecera). Usa spawn + Promise: no bloquea el hilo de Node, respeta un
// timeout PROPIO (mata el proceso con SIGKILL y resuelve con un mensaje
// claro de qué comando y cuánto tardó) y, si `stream` es true, escribe cada
// línea en vivo con marca de tiempo — así un cuelgue futuro dice DÓNDE se
// quedó en vez de nada.
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

// Verdad de kernel, no de logs: ¿hay algo escuchando en el puerto 22 (hex
// 0016) DENTRO del contenedor SFTP? /proc/net/tcp existe en cualquier
// contenedor Linux, así que esto no depende de que atmoz/sftp emita un
// mensaje de log concreto ni de resolución de nombres desde el host.
async function sftpListening(): Promise<boolean> {
  const r = await dockerExec(SFTP_CONTAINER, ["sh", "-c", "cat /proc/net/tcp 2>/dev/null"], { timeoutMs: 10_000 });
  if (r.code !== 0) return false;
  // Formato de /proc/net/tcp: "sl local_address rem_address st ...", con
  // local_address como IP:PUERTO en hex. ":0016" = puerto 22; st "0A" = LISTEN.
  return /: [0-9A-F]{8}:0016 [0-9A-F]{8}:[0-9A-F]{4} 0A/.test(r.out);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// waitFor con diagnóstico real: si se agota el timeout, vuelca docker logs +
// docker ps -a ANTES de lanzar — hallazgo del coordinador tras el primer
// fallo real en CI ("timeout esperando: sshd del SFTP de prueba" sin ninguna
// pista). Así el PRÓXIMO fallo (si lo hay) es diagnosticable de un vistazo
// en el log del job. Asíncrono (incidente #2): no bloquea el hilo mientras
// reintenta, así que un vitest hook timeout SÍ puede dispararse si hiciera falta.
async function waitFor(cond: () => Promise<boolean>, what: string, timeoutMs = 60_000, stepMs = 500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await sleep(stepMs);
  }
  logLine(`✖ TIMEOUT esperando "${what}" tras ${(timeoutMs / 1000).toFixed(0)}s — diagnóstico:`);
  logLine("--- docker ps -a ---");
  logLine((await sh("docker", ["ps", "-a"], { timeoutMs: 10_000 })).out);
  for (const c of [SFTP_CONTAINER, PG_CONTAINER, BACKUP_CONTAINER]) {
    const inspect = await sh("docker", ["inspect", "-f", "{{.State.Status}} (exit={{.State.ExitCode}})", c], {
      timeoutMs: 10_000,
    });
    logLine(`--- estado de ${c}: ${inspect.out.trim() || "(no existe)"} ---`);
    logLine(`--- docker logs ${c} ---`);
    logLine((await sh("docker", ["logs", c], { timeoutMs: 10_000 })).out);
  }
  throw new Error(`timeout esperando: ${what} (${(timeoutMs / 1000).toFixed(0)}s)`);
}

// Construye un contexto de build MÍNIMO (no todo el monorepo) con backup.sh
// parcheado, para las pruebas de mutación de setup_ssh() de más abajo. Copia
// sólo lo que el Dockerfile realmente necesita (mismas rutas relativas que
// espera infrastructure/docker/backup/Dockerfile, así el Dockerfile original
// no necesita tocarse para nada). Al compartir base (`FROM alpine` + el
// mismo `apk add`) con la imagen principal ya cargada, Docker reutiliza esa
// capa por caché de contenido — sólo reconstruye la capa COPY de backup.sh.
async function buildMutant(tag: string, patch: (original: string) => string) {
  const root = mkdtempSync(join(tmpdir(), "s9-backup-mutant-"));
  const backupDir = join(root, "infrastructure", "backup");
  const dockerDir = join(root, "infrastructure", "docker", "backup");
  mkdirSync(backupDir, { recursive: true });
  mkdirSync(dockerDir, { recursive: true });
  writeFileSync(join(backupDir, "backup.sh"), patch(readFileSync(BACKUP_SH_PATH, "utf8")));
  copyFileSync(RESTORE_SH_PATH, join(backupDir, "restore.sh"));
  copyFileSync(ENTRYPOINT_SH_PATH, join(backupDir, "entrypoint.sh"));
  copyFileSync(DOCKERFILE, join(dockerDir, "Dockerfile"));
  const build = await phase(`build mutante ${tag}`, () =>
    sh("docker", ["build", "-f", join(dockerDir, "Dockerfile"), "-t", tag, root], { timeoutMs: 120_000, stream: true }),
  );
  if (build.code !== 0) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`build del mutante ${tag} falló:\n${build.out}`);
  }
  return root;
}

describe.skipIf(SKIP_LOCALLY_WITHOUT_DOCKER)(
  "backup.sh dentro de la imagen real + servidor SFTP con chroot (E2E)",
  () => {
    let tmp: string;
    // Fuente crítica `secrets`, compartida por el contenedor principal y por
    // los mutantes que también ejecutan backup.sh hasta el final.
    let secretsDir: string;

    beforeAll(async () => {
      // Guarda explícita (hallazgo del coordinador): en CI este describe NUNCA
      // se salta. Si Docker no está disponible aquí, esto debe FALLAR fuerte y
      // pronto, no dejar que cada `it` reviente por separado con errores
      // crípticos de "ENOENT docker" ni, peor, que el runner lo reporte como
      // "skipped".
      if (IS_CI && !HAS_DOCKER) {
        throw new Error(
          "docker no está disponible en este job de CI. El E2E de fix/backup-sftp-scheduled-runtime " +
            "EXIGE Docker real (imagen backup + atmoz/sftp con chroot + postgres) — no tiene sentido " +
            "'saltarlo' en CI: eso es exactamente el escenario ('funciona en el repo, falla en la imagen') " +
            "que este fichero existe para evitar. Revisa que el job use runs-on: ubuntu-latest sin " +
            "`container:` (que aislaría el daemon) y que no se haya movido a un runner sin Docker.",
        );
      }

      tmp = mkdtempSync(join(tmpdir(), "s9-backup-e2e-"));

      // Limpieza defensiva de una ejecución anterior interrumpida.
      await phase("limpieza defensiva (contenedores/red de una ejecución anterior)", async () => {
        for (const c of [SFTP_CONTAINER, PG_CONTAINER, BACKUP_CONTAINER]) await sh("docker", ["rm", "-f", c]);
        await sh("docker", ["network", "rm", NET]);
        const netCreate = await sh("docker", ["network", "create", NET], { timeoutMs: 15_000 });
        if (netCreate.code !== 0) throw new Error(`no se pudo crear la red de prueba ${NET}:\n${netCreate.out}`);
      });

      // 1) Imagen de backup: REUTILIZADA de build-images en CI (ci.yml la
      // carga y etiqueta como IMAGE_TAG antes de invocar vitest). Si no
      // existe (uso local/desarrollo sin ese paso previo), se construye aquí
      // como fallback — con streaming en vivo y timeout propio, nunca en
      // silencio.
      await phase("imagen backup: comprobar si ya está cargada (reutilizada de build-images)", async () => {
        const inspect = await sh("docker", ["image", "inspect", IMAGE_TAG], { timeoutMs: 10_000 });
        if (inspect.code === 0) {
          logLine(`imagen ${IMAGE_TAG} ya presente (reutilizada) — no se reconstruye`);
          return;
        }
        logLine(`imagen ${IMAGE_TAG} NO encontrada localmente — construyendo como fallback (¿entorno local?)`);
        await phase("docker build (fallback local, mismo Dockerfile que build-images)", async () => {
          const build = await sh("docker", ["build", "-f", DOCKERFILE, "-t", IMAGE_TAG, REPO_ROOT], {
            timeoutMs: 300_000,
            stream: true,
          });
          if (build.code !== 0) throw new Error(`docker build de la imagen backup falló:\n${build.out}`);
        });
      });

      // 2) Clave SSH de prueba (ed25519, la misma familia que init-secrets.sh genera).
      const keyPath = join(tmp, "id_backup");
      await phase("ssh-keygen (clave de prueba)", async () => {
        const keygen = await sh("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath, "-C", "e2e-test"], {
          timeoutMs: 15_000,
        });
        if (keygen.code !== 0) throw new Error(`ssh-keygen falló (¿falta en el entorno de test?):\n${keygen.out}`);
      });

      // 3) Pulls explícitos (medidos por separado del arranque: es la
      // sospecha principal de dónde se iba el tiempo, según el coordinador).
      await phase("docker pull atmoz/sftp", async () => {
        const pull = await sh("docker", ["pull", "atmoz/sftp"], { timeoutMs: 120_000, stream: true });
        if (pull.code !== 0) throw new Error(`no se pudo descargar atmoz/sftp:\n${pull.out}`);
      });
      await phase("docker pull postgres:16-alpine", async () => {
        const pull = await sh("docker", ["pull", "postgres:16-alpine"], { timeoutMs: 120_000, stream: true });
        if (pull.code !== 0) throw new Error(`no se pudo descargar postgres:16-alpine:\n${pull.out}`);
      });

      // 4) Servidor SFTP de prueba CON chroot real (atmoz/sftp): el usuario sólo
      // ve "restic/" como raíz de su sesión — misma topología que el host de
      // respaldo real, nunca una ruta plana.
      await phase("docker run sftp (atmoz/sftp, chroot)", async () => {
        const runSftp = await sh(
          "docker",
          [
            "run",
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

      // 5) PostgreSQL de prueba (fuente CRÍTICA de backup.sh: sin ella no hay
      // SUCCESS posible, y el objetivo es demostrar el camino completo).
      await phase("docker run postgres", async () => {
        const runPg = await sh(
          "docker",
          [
            "run",
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

      // Esperar a que ambos servicios acepten conexiones (sin sleeps fijos: se
      // reintenta con backoff corto y se falla con diagnóstico si no arrancan).
      await phase("esperar: postgres de prueba listo", () =>
        waitFor(
          async () => (await dockerExec(PG_CONTAINER, ["pg_isready", "-U", "arena"])).code === 0,
          "postgres de prueba",
          60_000,
        ),
      );
      // Verdad de kernel (/proc/net/tcp), no un mensaje de log concreto de
      // atmoz/sftp: el host key se genera al primer arranque, así que hay que
      // esperar a que sshd esté realmente escuchando antes de usarlo.
      await phase("esperar: sshd del SFTP de prueba escuchando", () =>
        waitFor(sftpListening, "sshd del SFTP de prueba (puerto 22 en LISTEN, verdad de /proc/net/tcp)", 60_000),
      );

      // 6) known_hosts REAL: se captura la huella del servidor de prueba con
      // ssh-keyscan ejecutado DESDE la propia imagen bajo prueba, en la MISMA
      // red — el mismo camino de red y el mismo binario ssh que usará después
      // el contenedor de backup real (nunca una IP inspeccionada desde el host
      // con una plantilla frágil, ver incidente #1 de la cabecera). Es el
      // equivalente exacto de lo que un operador haría a mano UNA VEZ,
      // verificando la huella fuera de banda, nunca con StrictHostKeyChecking=no.
      let knownHosts = "";
      await phase("captura de known_hosts (ssh-keyscan desde la propia imagen)", () =>
        waitFor(
          async () => {
            // `--entrypoint` es OBLIGATORIO aquí: la imagen declara
            // ENTRYPOINT ["/entrypoint.sh"], así que sin él los argumentos
            // NO se ejecutan — se le pasan al entrypoint, que los ignora,
            // instala el crontab y termina en `exec crond -f`. El contenedor
            // se queda vivo sirviendo cron y ssh-keyscan no llega a correr
            // NUNCA: se agota el timeout con la salida vacía y el síntoma
            // (fase muda de 32s) no se parece en nada a la causa.
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
            // Sin esto el reintento es mudo y un fallo real es indistinguible
            // de "aún no está listo" — el modo de fallo que ya costó una
            // vuelta entera de CI.
            logLine(
              `  ssh-keyscan aún sin huella (code=${r.code}, timedOut=${r.timedOut}): ${r.out.trim().slice(0, 300) || "(salida vacía)"}`,
            );
            return false;
          },
          "captura de known_hosts con ssh-keyscan (mismo contenedor, misma imagen que el backup real)",
          30_000,
          1_000,
        ),
      );
      writeFileSync(join(tmp, "known_hosts"), knownHosts, { mode: 0o644 });

      writeFileSync(join(tmp, "restic_password"), "e2e-restic-password", { mode: 0o600 });
      writeFileSync(join(tmp, "postgres_password"), "arena-e2e-test", { mode: 0o600 });
      chmodSync(keyPath, 0o600);

      // Fuente crítica `secrets`: en producción el compose monta
      // `./secrets:/secrets:ro`. Aquí se fabrica un directorio equivalente
      // con contenido INVENTADO — nunca material real.
      secretsDir = join(tmp, "secrets");
      mkdirSync(secretsDir, { recursive: true });
      writeFileSync(join(secretsDir, "ejemplo.txt"), "contenido-de-mentira-para-el-e2e\n", { mode: 0o600 });

      // 7) Contenedor de backup con su ENTRYPOINT REAL, sin overrides — el
      // mismo binario que arrancaría el servicio `backup` del compose en
      // producción. Los secretos se montan como Docker los monta de verdad
      // (sólo lectura); ver el comentario de setup_ssh() en backup.sh sobre
      // por qué hace falta copiarlos a un sitio escribible antes de usarlos.
      await phase("docker run backup (ENTRYPOINT real)", async () => {
        const runBackup = await sh(
          "docker",
          [
            "run",
            "-d",
            "--name",
            BACKUP_CONTAINER,
            "--network",
            NET,
            "-v",
            `${keyPath}:/run/secrets/restic_ssh_key:ro`,
            "-v",
            `${tmp}/known_hosts:/run/secrets/restic_ssh_known_hosts:ro`,
            "-v",
            `${tmp}/restic_password:/run/secrets/restic_password:ro`,
            "-v",
            `${tmp}/postgres_password:/run/secrets/postgres_password:ro`,
            // SECRETS_DIR (/secrets) es fuente CRÍTICA y en el compose de
            // producción se monta `./secrets:/secrets:ro`. Sin este montaje,
            // `restic backup --tag s9-arena-secrets /secrets` muere con
            // "Fatal: all target directories/files do not exist" y todo el
            // backup termina en FULL FAILURE. Contenido de mentira: este
            // directorio sólo existe para que la fuente crítica esté
            // presente, jamás secretos reales.
            "-v",
            `${secretsDir}:/secrets:ro`,
            "-e",
            `RESTIC_REPOSITORY=sftp:${SFTP_USER}@${SFTP_CONTAINER}:${CHROOT_PATH}`,
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
            "METRICS_DIR=/textfile",
            "-e",
            "BACKUP_CRON=0 0 31 2 *", // fecha imposible: el cron nunca dispara solo; el test invoca backup.sh explícitamente.
            IMAGE_TAG,
          ],
          { timeoutMs: 30_000 },
        );
        if (runBackup.code !== 0) throw new Error(`no se pudo arrancar el contenedor de backup:\n${runBackup.out}`);
      });
      await phase("esperar: contenedor de backup arrancado", () =>
        waitFor(
          async () => (await sh("docker", ["exec", BACKUP_CONTAINER, "true"])).code === 0,
          "contenedor de backup arrancado",
          30_000,
        ),
      );

      // 8) Inicialización EXPLÍCITA del repositorio restic, con el mismo
      // binario, la misma clave y la misma ruta con chroot que usará el
      // backup. En producción este paso se hizo a mano y no estaba ni en el
      // código ni en las pruebas: por eso este E2E le pedía a backup.sh que
      // escribiera en un repositorio inexistente y restic respondía
      // "unable to open config file / Is there a repository at ...".
      // No se hace dentro de backup.sh en cada ejecución a propósito: ver la
      // nota junto a INIT_REPO en backup.sh (una errata en RESTIC_REPOSITORY
      // crearía un repositorio vacío y el backup "tendría éxito").
      await phase("restic init (repositorio del E2E, vía SFTP con chroot)", async () => {
        const init = await dockerExec(BACKUP_CONTAINER, ["/usr/local/bin/backup.sh", "--init-repo"], {
          timeoutMs: 120_000,
        });
        if (init.code !== 0) throw new Error(`restic init falló (code=${init.code}):\n${init.out}`);
        logLine(`  init: ${init.out.trim().slice(0, 300)}`);
      });

      dumpPhaseTimings();
    }, 300_000); // 5 min: con la imagen reutilizada (sin reconstruirla) sobra margen; ver desglose por fase en los logs.

    afterAll(async () => {
      dumpPhaseTimings();
      for (const c of [BACKUP_CONTAINER, SFTP_CONTAINER, PG_CONTAINER]) await sh("docker", ["rm", "-f", c]);
      await sh("docker", ["network", "rm", NET]);
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }, 60_000);

    it("openssh-client está instalado en la imagen real (defecto #1: ausente antes de este fix)", async () => {
      const r = await dockerExec(BACKUP_CONTAINER, ["sh", "-c", "command -v ssh"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("/ssh");
    });

    it("el dry-run de arranque del ENTRYPOINT real ya valida sftp (ssh presente, config OK)", async () => {
      const logs = (await sh("docker", ["logs", BACKUP_CONTAINER])).out;
      expect(logs).toContain("CONFIG OK");
      expect(logs).toContain("ssh presente");
      expect(logs).not.toContain("no está instalado en esta imagen");
    });

    it("backup.sh ejecutado DENTRO del contenedor real crea un snapshot restic vía SFTP con chroot (defecto #2 corregido)", async () => {
      const run = await dockerExec(BACKUP_CONTAINER, ["/usr/local/bin/backup.sh"], { timeoutMs: 60_000 });
      expect(run.out).toContain("backup SUCCESS");
      expect(run.code).toBe(0);

      // Clave usable, permisos correctos (rechazados por ssh si no son 600;
      // ver la prueba de mutación más abajo, que demuestra esto de verdad).
      const perms = await dockerExec(BACKUP_CONTAINER, ["sh", "-c", "stat -c %a /root/.ssh/id_backup"]);
      expect(perms.out.trim()).toBe("600");

      // La ruta de chroot es la correcta: restic ve el snapshot en /restic,
      // NUNCA en la ruta física /home/backupuser/restic (invisible desde la
      // sesión confinada — si RESTIC_REPOSITORY hubiera usado esa ruta física,
      // este comando fallaría con "repository does not exist").
      const snapshots = await dockerExec(BACKUP_CONTAINER, [
        "sh",
        "-c",
        `RESTIC_REPOSITORY="sftp:${SFTP_USER}@${SFTP_CONTAINER}:${CHROOT_PATH}" RESTIC_PASSWORD_FILE=/run/secrets/restic_password restic snapshots --tag s9-arena-data --json`,
      ]);
      expect(snapshots.code).toBe(0);
      const parsed = JSON.parse(snapshots.out);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);

      // Métricas: "programado" (sin ejecución previa) → "éxito" tras esta
      // ejecución real. s9_backup_run_success es el campo que dispara/despeja
      // la alerta BackupFailed.
      const metrics = (await dockerExec(BACKUP_CONTAINER, ["cat", "/textfile/s9_backup.prom"])).out;
      expect(metrics).toContain("s9_backup_run_success 1");
      expect(metrics).toContain("s9_backup_last_exit_code 0");
      expect(metrics).toContain("s9_backup_postgres_success 1");
      expect(metrics).toContain("s9_backup_restic_snapshot_created 1");
    }, 90_000);

    it("la huella del host SÍ se verifica: known_hosts vacío/incorrecto rompe la conexión en vez de aceptarla a ciegas", async () => {
      // Prueba negativa exigida por el operador: nunca StrictHostKeyChecking=no.
      // Se sustituye known_hosts por uno con la huella de OTRO host (ajena al
      // servidor real) y se comprueba que restic/ssh RECHAZA la conexión —si
      // alguien hubiera "arreglado" un problema de conectividad desactivando
      // la verificación, este snapshot se crearía igualmente y el test fallaría.
      const wrongHostKey =
        "s9-backup-e2e-sftp ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINVALIDHOSTKEYFORTESTINGPURPOSESONLY";
      await dockerExec(BACKUP_CONTAINER, [
        "sh",
        "-c",
        `printf '%s\\n' "${wrongHostKey}" > /root/.ssh/known_hosts.wrong`,
      ]);
      const attempt = await dockerExec(BACKUP_CONTAINER, [
        "sh",
        "-c",
        `ssh -F /root/.ssh/config -o UserKnownHostsFile=/root/.ssh/known_hosts.wrong -o BatchMode=yes ` +
          `${SFTP_USER}@${SFTP_CONTAINER} true`,
      ]);
      expect(attempt.code).not.toBe(0);
      expect(attempt.out.toLowerCase()).toMatch(/host key verification failed|remote host identification has changed/);
    });

    // Pregunta directa del coordinador, confirmada ya sin Docker en
    // backup.test.ts (con backup.sh real + entrypoint.sh real, pero sin
    // contenedor) — aquí se repite CON el contenedor real, arrancado con su
    // ENTRYPOINT sin overrides, exactamente como lo arrancaría el compose:
    // "que el arranque del contenedor con known_hosts vacío falla en cerrado
    // con un mensaje claro, y no que arranca bien y se cae luego en la
    // primera ejecución del cron".
    it("con known_hosts VACÍO, el contenedor (ENTRYPOINT real, sin overrides) se niega a arrancar — no arranca y falla después", async () => {
      const emptyKnownHosts = join(tmp, "known_hosts_empty_for_startup_test");
      writeFileSync(emptyKnownHosts, "");
      const containerName = "s9-backup-e2e-startup-fail";
      await sh("docker", ["rm", "-f", containerName]);
      // docker run SIN -d: el proceso principal es el ENTRYPOINT real
      // (entrypoint.sh sin argumentos ni overrides); si aborta el arranque
      // (exit 1, ver entrypoint.sh), `docker run` en primer plano devuelve
      // ese mismo código de salida — no hace falta encuestar el estado del
      // contenedor por separado.
      const run = await sh(
        "docker",
        [
          "run",
          "--rm",
          "--name",
          containerName,
          "--network",
          NET,
          "-v",
          `${tmp}/id_backup:/run/secrets/restic_ssh_key:ro`,
          "-v",
          `${emptyKnownHosts}:/run/secrets/restic_ssh_known_hosts:ro`,
          "-v",
          `${tmp}/restic_password:/run/secrets/restic_password:ro`,
          "-v",
          `${tmp}/postgres_password:/run/secrets/postgres_password:ro`,
          "-e",
          `RESTIC_REPOSITORY=sftp:${SFTP_USER}@${SFTP_CONTAINER}:${CHROOT_PATH}`,
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
          "METRICS_DIR=/textfile",
          IMAGE_TAG,
          // Sin argumentos: usa el ENTRYPOINT de la imagen tal cual (entrypoint.sh).
        ],
        { timeoutMs: 30_000 },
      );
      expect(run.code).not.toBe(0);
      expect(run.out).toContain("ARRANQUE ABORTADO");
      expect(run.out).toContain("está vacío o no es legible");
      // No debe haber llegado a "cron programado" seguido de crond en marcha
      // sin más: el mensaje de error es la ÚLTIMA cosa que pasa, no algo que
      // conviva con un contenedor sano en segundo plano.
      const stillRunning = await sh("docker", ["inspect", "-f", "{{.State.Running}}", containerName], {
        timeoutMs: 10_000,
      });
      expect(stillRunning.out.trim()).not.toBe("true");
    }, 45_000);

    // ── Mutaciones sobre setup_ssh() aplicadas de verdad, DENTRO de la imagen ──
    // real (pedido explícito del coordinador: hasta ahora sólo se habían
    // razonado, nunca ejecutado, porque no había entorno con Docker). Cada una
    // construye un contenedor MUTANTE (mismo Dockerfile, backup.sh parcheado
    // con `sed`-equivalente en JS) y demuestra que, sin la línea real, pasa
    // justo lo que esa línea existe para impedir.
    describe("mutaciones sobre setup_ssh() (backup.sh) — controles de seguridad, no cosmética", () => {
      it("MUTACIÓN chmod 600→644 de la clave privada: ssh la RECHAZA (el permiso no es decorativo)", async () => {
        const tag = "s9-ai-arena/backup:e2e-mutant-chmod";
        const root = await buildMutant(tag, (src) => {
          const needle = 'chmod 600 "$HOME/.ssh/id_backup"';
          if (!src.includes(needle))
            throw new Error("no se encontró la línea a mutar (chmod 600 id_backup) — ¿cambió backup.sh?");
          return src.replace(needle, 'chmod 644 "$HOME/.ssh/id_backup"');
        });
        try {
          const run = await phase("ejecutar mutante chmod", () =>
            sh(
              "docker",
              [
                "run",
                "--rm",
                "--network",
                NET,
                "-v",
                `${tmp}/id_backup:/run/secrets/restic_ssh_key:ro`,
                "-v",
                `${tmp}/known_hosts:/run/secrets/restic_ssh_known_hosts:ro`,
                "-v",
                `${tmp}/restic_password:/run/secrets/restic_password:ro`,
                "-v",
                `${tmp}/postgres_password:/run/secrets/postgres_password:ro`,
                "-e",
                `RESTIC_REPOSITORY=sftp:${SFTP_USER}@${SFTP_CONTAINER}:${CHROOT_PATH}`,
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
                "METRICS_DIR=/textfile",
                // --entrypoint OBLIGATORIO: la imagen declara
                // ENTRYPOINT ["/entrypoint.sh"]. Sin él, "backup.sh" era un
                // ARGUMENTO que el entrypoint ignoraba, y el contenedor se
                // quedaba en `exec crond -f` hasta agotar el timeout de 60s.
                // Como las dos comprobaciones de abajo son NEGATIVAS, el
                // timeout las satisfacía y esta mutación de seguridad pasaba
                // EN FALSO: nunca llegó a ejecutar el backup. La pista
                // estaba en el tiempo (62s ≈ el timeout), no en el veredicto.
                "--entrypoint",
                "/usr/local/bin/backup.sh",
                tag,
              ],
              { timeoutMs: 60_000 },
            ),
          );
          // Con la clave en 644, OpenSSH se niega a usarla ("UNPROTECTED
          // PRIVATE KEY FILE") y la conexión sftp falla: el backup NO puede
          // llegar a SUCCESS. Si este test pasara con "backup SUCCESS", el
          // chmod 600 real sería cosmético — y no lo es.
          expect(run.out).not.toContain("backup SUCCESS");
          expect(run.code).not.toBe(0);
          // Comprobaciones POSITIVAS, obligatorias porque las dos de arriba
          // son negativas y un timeout (o un contenedor que ni arranca) las
          // satisface sin haber probado nada. Esto exige que el backup se
          // ejecutara DE VERDAD y fallara por el motivo alegado.
          expect(run.timedOut).toBe(false);
          expect(run.out).toContain("backup FULL FAILURE");
        } finally {
          await sh("docker", ["image", "rm", "-f", tag]);
          rmSync(root, { recursive: true, force: true });
        }
      }, 150_000);

      it("MUTACIÓN StrictHostKeyChecking yes→no: con known_hosts INCORRECTO, la conexión se ACEPTA igualmente (la vulnerabilidad exacta que el operador prohibió)", async () => {
        const tag = "s9-ai-arena/backup:e2e-mutant-stricthostkey";
        const root = await buildMutant(tag, (src) => {
          const needle = "printf '  StrictHostKeyChecking yes\\n'";
          if (!src.includes(needle))
            throw new Error("no se encontró la línea a mutar (StrictHostKeyChecking yes) — ¿cambió backup.sh?");
          return src.replace(needle, "printf '  StrictHostKeyChecking no\\n'");
        });
        // known_hosts DELIBERADAMENTE incorrecto (huella de otro host, igual
        // que en la prueba negativa de arriba). Con el código real
        // (StrictHostKeyChecking yes) esto rompe la conexión; el objetivo
        // aquí es demostrar que, con el mutante, NO la rompe.
        const wrongKnownHosts = join(tmp, "known_hosts_wrong_for_mutant");
        writeFileSync(
          wrongKnownHosts,
          `${SFTP_CONTAINER} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINVALIDHOSTKEYFORTESTINGPURPOSESONLY\n`,
        );
        try {
          const run = await phase("ejecutar mutante StrictHostKeyChecking", () =>
            sh(
              "docker",
              [
                "run",
                "--rm",
                "--network",
                NET,
                "-v",
                `${tmp}/id_backup:/run/secrets/restic_ssh_key:ro`,
                "-v",
                `${wrongKnownHosts}:/run/secrets/restic_ssh_known_hosts:ro`,
                "-v",
                `${tmp}/restic_password:/run/secrets/restic_password:ro`,
                "-v",
                `${tmp}/postgres_password:/run/secrets/postgres_password:ro`,
                // Esta mutación llega hasta el final del backup (demuestra
                // que con StrictHostKeyChecking=no la conexión se acepta
                // pese al known_hosts incorrecto), así que necesita la
                // fuente crítica `secrets` igual que el contenedor real.
                "-v",
                `${secretsDir}:/secrets:ro`,
                "-e",
                `RESTIC_REPOSITORY=sftp:${SFTP_USER}@${SFTP_CONTAINER}:${CHROOT_PATH}`,
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
                "METRICS_DIR=/textfile",
                // --entrypoint OBLIGATORIO: ver la nota de la mutación
                // anterior. Aquí el síntoma sí era visible (la salida
                // recibida eran las líneas de arranque "cron programado" y
                // "DRY-RUN", nunca un backup), porque la comprobación es
                // POSITIVA y un timeout no puede satisfacerla.
                "--entrypoint",
                "/usr/local/bin/backup.sh",
                tag,
              ],
              { timeoutMs: 60_000 },
            ),
          );
          // Con el mutante, un known_hosts que NO coincide con el host real
          // no impide la conexión: el backup llega a SUCCESS igual. Esto es
          // EXACTAMENTE lo que el operador prohibió ("NUNCA
          // StrictHostKeyChecking=no") — este test documenta, con la imagen
          // real, qué se rompe si alguien quita esa línea.
          expect(run.out).toContain("backup SUCCESS");
          expect(run.code).toBe(0);
        } finally {
          await sh("docker", ["image", "rm", "-f", tag]);
          rmSync(root, { recursive: true, force: true });
        }
      }, 150_000);
    });
  },
);
