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
// Esta suite construye la imagen real (mismo Dockerfile que build-images en
// ci.yml), levanta un servidor SFTP de prueba (atmoz/sftp) CON chroot real
// (el usuario de prueba sólo ve su subdirectorio "restic" como raíz — misma
// topología que el host de respaldo real, ver infrastructure/.env.example),
// arranca el contenedor de backup con su ENTRYPOINT real (sin overrides) y
// ejercita backup.sh dentro de ese contenedor ya en marcha. Nada de esto se
// simula: si `openssh-client` desapareciera del Dockerfile, o si alguien
// "arreglara" un timeout con StrictHostKeyChecking=no, o si la ruta volviera
// a ser la física del host, esta suite falla.
//
// Corre en su propio job obligatorio de la CI, `e2e-backup-sftp`
// (.github/workflows/ci.yml), en ubuntu-latest con daemon Docker
// preinstalado — deliberadamente FUERA del job `unit` (que también corre
// infrastructure/, pero excluye este fichero explícitamente: construir una
// imagen y levantar 3 contenedores no pinta en un informe de cobertura de
// TypeScript, y merece su propio veredicto en el semáforo de ci-gate.mjs).
// Localmente, si Docker no está disponible (p. ej. un entorno de agente sin
// permiso sobre /var/run/docker.sock, como el que escribió esta suite), los
// tests se OMITEN con un aviso — pero NUNCA en CI (ver IS_CI más abajo: ahí
// la ausencia de Docker hace fallar el job a propósito). No se sustituye por
// una comprobación que no ejerza la imagen real, porque eso sería
// reintroducir exactamente el defecto que este fichero existe para atrapar.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..");
const DOCKERFILE = join(REPO_ROOT, "infrastructure", "docker", "backup", "Dockerfile");
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

function sh(cmd: string, args: string[], opts: { input?: string } = {}) {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf8", input: opts.input, stdio: ["pipe", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e: any) {
    return { code: (e.status as number) ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function dockerExec(container: string, args: string[]) {
  return sh("docker", ["exec", container, ...args]);
}

describe.skipIf(SKIP_LOCALLY_WITHOUT_DOCKER)(
  "backup.sh dentro de la imagen real + servidor SFTP con chroot (E2E)",
  () => {
    let tmp: string;
    let sftpIp = "";

    beforeAll(() => {
      // Guarda explícita (hallazgo del coordinador): en CI este describe NUNCA
      // se salta. Si Docker no está disponible aquí, esto debe FALLAR fuerte y
      // pronto, no dejar que cada `it` reviente por separado con errores
      // crípticos de "ENOENT docker" ni, peor, que el runner lo reporte como
      // "skipped".
      if (IS_CI && !HAS_DOCKER) {
        throw new Error(
          "docker no está disponible en este job de CI. El E2E de fix/backup-sftp-scheduled-runtime " +
            "EXIGE Docker real (build de imagen + atmoz/sftp con chroot + postgres) — no tiene sentido " +
            "'saltarlo' en CI: eso es exactamente el escenario ('funciona en el repo, falla en la imagen') " +
            "que este fichero existe para evitar. Revisa que el job use runs-on: ubuntu-latest sin " +
            "`container:` (que aislaría el daemon) y que no se haya movido a un runner sin Docker.",
        );
      }

      tmp = mkdtempSync(join(tmpdir(), "s9-backup-e2e-"));

      // Limpieza defensiva de una ejecución anterior interrumpida.
      for (const c of [SFTP_CONTAINER, PG_CONTAINER, BACKUP_CONTAINER]) sh("docker", ["rm", "-f", c]);
      sh("docker", ["network", "rm", NET]);
      sh("docker", ["network", "create", NET]);

      // 1) Construir la imagen REAL de backup — el mismo Dockerfile que build-images
      // en ci.yml, con el mismo contexto (raíz del repo).
      const build = sh("docker", ["build", "-f", DOCKERFILE, "-t", IMAGE_TAG, REPO_ROOT]);
      if (build.code !== 0) throw new Error(`docker build de la imagen backup falló:\n${build.out}`);

      // 2) Clave SSH de prueba (ed25519, la misma familia que init-secrets.sh genera).
      const keyPath = join(tmp, "id_backup");
      const keygen = sh("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath, "-C", "e2e-test"]);
      if (keygen.code !== 0) throw new Error(`ssh-keygen falló (¿falta en el entorno de test?):\n${keygen.out}`);

      // 3) Servidor SFTP de prueba CON chroot real (atmoz/sftp): el usuario sólo
      // ve "restic/" como raíz de su sesión — misma topología que el host de
      // respaldo real, nunca una ruta plana.
      const runSftp = sh("docker", [
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
      ]);
      if (runSftp.code !== 0) throw new Error(`no se pudo levantar el servidor SFTP de prueba:\n${runSftp.out}`);

      // 4) PostgreSQL de prueba (fuente CRÍTICA de backup.sh: sin ella no hay
      // SUCCESS posible, y el objetivo es demostrar el camino completo).
      const runPg = sh("docker", [
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
      ]);
      if (runPg.code !== 0) throw new Error(`no se pudo levantar postgres de prueba:\n${runPg.out}`);

      // Esperar a que ambos servicios acepten conexiones (sin sleeps fijos: se
      // reintenta con backoff corto y se falla con el motivo si no arrancan).
      waitFor(() => dockerExec(PG_CONTAINER, ["pg_isready", "-U", "arena"]).code === 0, "postgres de prueba");
      // El host key de atmoz/sftp se genera al primer arranque; hay que esperar
      // a que sshd esté escuchando antes de poder capturarlo con ssh-keyscan.
      waitFor(() => sh("docker", ["exec", SFTP_CONTAINER, "true"]).code === 0, "contenedor SFTP arrancado");
      const ipInspect = sh("docker", [
        "inspect",
        "-f",
        `{{.NetworkSettings.Networks.${NET}.IPAddress}}`,
        SFTP_CONTAINER,
      ]);
      sftpIp = ipInspect.out.trim();
      waitFor(
        () => sh("ssh-keyscan", ["-t", "ed25519", sftpIp]).out.includes("ssh-ed25519"),
        "sshd del SFTP de prueba",
      );

      // 5) known_hosts REAL: se captura la huella del servidor de prueba con
      // ssh-keyscan y se guarda — el equivalente exacto de lo que un operador
      // haría a mano UNA VEZ, verificando la huella fuera de banda, nunca con
      // StrictHostKeyChecking=no. Este es el fichero que se monta como el
      // secreto restic_ssh_known_hosts.
      const knownHosts = sh("ssh-keyscan", ["-t", "ed25519", sftpIp]).out;
      if (!knownHosts.includes("ssh-ed25519")) throw new Error("no se pudo capturar la huella del SFTP de prueba");
      writeFileSync(join(tmp, "known_hosts"), knownHosts, { mode: 0o644 });

      writeFileSync(join(tmp, "restic_password"), "e2e-restic-password", { mode: 0o600 });
      writeFileSync(join(tmp, "postgres_password"), "arena-e2e-test", { mode: 0o600 });
      chmodSync(keyPath, 0o600);

      // 6) Contenedor de backup con su ENTRYPOINT REAL, sin overrides — el
      // mismo binario que arrancaría el servicio `backup` del compose en
      // producción. Los secretos se montan como Docker los monta de verdad
      // (sólo lectura); ver el comentario de setup_ssh() en backup.sh sobre
      // por qué hace falta copiarlos a un sitio escribible antes de usarlos.
      const runBackup = sh("docker", [
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
      ]);
      if (runBackup.code !== 0) throw new Error(`no se pudo arrancar el contenedor de backup:\n${runBackup.out}`);
      waitFor(() => sh("docker", ["exec", BACKUP_CONTAINER, "true"]).code === 0, "contenedor de backup arrancado");
    }, 180_000);

    afterAll(() => {
      for (const c of [BACKUP_CONTAINER, SFTP_CONTAINER, PG_CONTAINER]) sh("docker", ["rm", "-f", c]);
      sh("docker", ["network", "rm", NET]);
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    });

    it("openssh-client está instalado en la imagen real (defecto #1: ausente antes de este fix)", () => {
      const r = dockerExec(BACKUP_CONTAINER, ["sh", "-c", "command -v ssh"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("/ssh");
    });

    it("el dry-run de arranque del ENTRYPOINT real ya valida sftp (ssh presente, config OK)", () => {
      const logs = sh("docker", ["logs", BACKUP_CONTAINER]).out;
      expect(logs).toContain("CONFIG OK");
      expect(logs).toContain("ssh presente");
      expect(logs).not.toContain("no está instalado en esta imagen");
    });

    it("backup.sh ejecutado DENTRO del contenedor real crea un snapshot restic vía SFTP con chroot (defecto #2 corregido)", () => {
      const run = dockerExec(BACKUP_CONTAINER, ["/usr/local/bin/backup.sh"]);
      expect(run.out).toContain("backup SUCCESS");
      expect(run.code).toBe(0);

      // Clave usable, permisos correctos (rechazados por ssh si no son 600).
      const perms = dockerExec(BACKUP_CONTAINER, ["sh", "-c", "stat -c %a /root/.ssh/id_backup"]);
      expect(perms.out.trim()).toBe("600");

      // La ruta de chroot es la correcta: restic ve el snapshot en /restic,
      // NUNCA en la ruta física /home/backupuser/restic (invisible desde la
      // sesión confinada — si RESTIC_REPOSITORY hubiera usado esa ruta física,
      // este comando fallaría con "repository does not exist").
      const snapshots = dockerExec(BACKUP_CONTAINER, [
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
      const metrics = dockerExec(BACKUP_CONTAINER, ["cat", "/textfile/s9_backup.prom"]).out;
      expect(metrics).toContain("s9_backup_run_success 1");
      expect(metrics).toContain("s9_backup_last_exit_code 0");
      expect(metrics).toContain("s9_backup_postgres_success 1");
      expect(metrics).toContain("s9_backup_restic_snapshot_created 1");
    }, 120_000);

    it("la huella del host SÍ se verifica: known_hosts vacío/incorrecto rompe la conexión en vez de aceptarla a ciegas", () => {
      // Prueba negativa exigida por el operador: nunca StrictHostKeyChecking=no.
      // Se sustituye known_hosts por uno con la huella de OTRO host (ajena al
      // servidor real) y se comprueba que restic/ssh RECHAZA la conexión —si
      // alguien hubiera "arreglado" un problema de conectividad desactivando
      // la verificación, este snapshot se crearía igualmente y el test fallaría.
      const wrongHostKey =
        "s9-backup-e2e-sftp ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINVALIDHOSTKEYFORTESTINGPURPOSESONLY";
      dockerExec(BACKUP_CONTAINER, ["sh", "-c", `printf '%s\\n' "${wrongHostKey}" > /root/.ssh/known_hosts.wrong`]);
      const attempt = dockerExec(BACKUP_CONTAINER, [
        "sh",
        "-c",
        `ssh -F /root/.ssh/config -o UserKnownHostsFile=/root/.ssh/known_hosts.wrong -o BatchMode=yes ` +
          `${SFTP_USER}@${SFTP_CONTAINER} true`,
      ]);
      expect(attempt.code).not.toBe(0);
      expect(attempt.out.toLowerCase()).toMatch(/host key verification failed|remote host identification has changed/);
    });
  },
);

function waitFor(cond: () => boolean, what: string, timeoutMs = 60_000, stepMs = 500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    execFileSync("sleep", [(stepMs / 1000).toString()]);
  }
  throw new Error(`timeout esperando: ${what}`);
}
