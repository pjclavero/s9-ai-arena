// Tests de T10.4 ejecutables SIN Docker: dry-run real de backup.sh y
// restore.sh, verificación de integridad real con manifest.sha256 (sha256sum),
// que los secretos no se filtran a la salida ni están versionados en git, y
// el cableado del servicio backup en el Compose. El simulacro completo de
// recuperación (VM vacía → plataforma, < 2 h) queda pendiente de entorno con
// Docker (runbook y cronómetro en docs/recuperacion.md).
//
// #112 → revisión del supervisor → #112 (continuación): la primera versión
// de esta suite probaba `restore.sh --verify` contra un directorio MONTADO A
// MANO (mkdir + writeFileSync + sha256sum manual), con una jerarquía que
// `backup.sh` no produce jamás. Eso enmascaró el defecto real: el manifest
// usaba rutas relativas mientras los datos se subían con su ruta absoluta de
// origen, así que `--verify` estaba roto en el mundo real aunque el test
// pasara. La cadena obligatoria ahora es SIEMPRE:
//   datos fixture → backup.sh (real) → restic falso FIEL (preserva rutas
//   absolutas como el real) → restore.sh --restore → restore.sh --verify.
// Ver el describe "cadena E2E real" más abajo.
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..");
const BACKUP = join(here, "..", "backup", "backup.sh");
const RESTORE = join(here, "..", "backup", "restore.sh");
const ENTRYPOINT = join(here, "..", "backup", "entrypoint.sh");
const SECRET_VALUE = "valor-secreto-que-jamas-debe-aparecer-en-logs";

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "e10-backup-"));
  writeFileSync(join(tmp, "restic_password.txt"), SECRET_VALUE, { mode: 0o600 });
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// Ruta absoluta de bash: algún test de sftp restringe PATH a propósito (para
// comprobar que el dry-run detecta 'ssh' ausente); si aquí se invocara
// "bash" a secas, Node lo resolvería con ESE MISMO PATH restringido y el
// intérprete ni arrancaría (spawn ENOENT) — un fallo distinto, no el que se
// quiere probar.
const BASH_BIN = execFileSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).trim();

function runDryRun(env: Record<string, string>) {
  try {
    const out = execFileSync(BASH_BIN, [BACKUP, "--dry-run"], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status as number, out: `${e.stdout}${e.stderr}` };
  }
}

describe("backup.sh --dry-run (ejecutado de verdad, sin docker)", () => {
  it("con configuración completa: exit 0 y plan de 5 pasos + métricas", () => {
    const { code, out } = runDryRun({
      RESTIC_REPOSITORY: "/mnt/nas/backups/s9-ai-arena",
      RESTIC_PASSWORD_FILE: join(tmp, "restic_password.txt"),
    });
    expect(code).toBe(0);
    for (const step of ["PLAN 1/5", "PLAN 2/5", "PLAN 3/5", "PLAN 4/5", "PLAN 5/5", "MÉTRICAS", "CONFIG OK"]) {
      expect(out).toContain(step);
    }
    expect(out).toContain("pg_dump");
    expect(out).toContain("manifest.sha256");
    expect(out).toContain("restic forget --keep-daily 14");
  });

  it("sin RESTIC_REPOSITORY: exit 1 y aviso de configuración incompleta", () => {
    const { code, out } = runDryRun({ RESTIC_REPOSITORY: "", RESTIC_PASSWORD_FILE: "", RESTIC_PASSWORD: "" });
    expect(code).toBe(1);
    expect(out).toContain("CONFIG INCOMPLETA");
    expect(out).toContain("RESTIC_REPOSITORY sin definir");
  });

  it("los valores de los secretos NUNCA aparecen en la salida (DoD T10.4)", () => {
    const { out } = runDryRun({
      RESTIC_REPOSITORY: "/mnt/nas/backups/s9-ai-arena",
      RESTIC_PASSWORD_FILE: join(tmp, "restic_password.txt"),
    });
    expect(out).not.toContain(SECRET_VALUE);
  });
});

// fix/backup-sftp-scheduled-runtime: el backup PROGRAMADO fallaba en
// EJECUCIÓN con el backend sftp: por dos defectos que un `restic … snapshots`
// desde el host jamás reproducía (ver infrastructure/tests/backup-sftp-e2e.test.ts
// para la demostración con la imagen real). Estos tests cubren la parte de
// VALIDACIÓN DE CONFIGURACIÓN de ese fix (ejecutable sin Docker); el camino
// de ejecución real (setup_ssh, restic contra un SFTP con chroot) sólo lo
// demuestra el E2E con contenedores — un dry-run, por diseño, no toca la red.
describe("backup.sh --dry-run: backend sftp (fix/backup-sftp-scheduled-runtime)", () => {
  // Código 3 (no 1): backend sftp CONFIGURADO pero roto es un defecto de
  // imagen/despliegue, no un estado transitorio de bootstrap — ver el
  // comentario junto a `sftp_errors` en backup.sh. entrypoint.sh usa
  // justamente este código para negarse a arrancar el contenedor (probado
  // más abajo, "entrypoint.sh real: arranque").
  it("sftp con ssh ausente del PATH: exit 3 y CONFIG INCOMPLETA (defecto real #1, reproducido sin Docker)", () => {
    // PATH reducido a un único binario (`date`, que log() necesita incluso en
    // dry-run): sin él la comparación sería injusta (el script fallaría por
    // otro motivo). `ssh` queda deliberadamente fuera. El intérprete bash se
    // invoca por su ruta ABSOLUTA (fuera de este PATH restringido) — si se
    // invocara como "bash" a secas, Node tendría que resolverlo con el MISMO
    // PATH restringido y el proceso ni siquiera arrancaría (spawn ENOENT),
    // dando un falso "CONFIG INCOMPLETA" por el motivo equivocado.
    const dateBin = execFileSync("sh", ["-c", "command -v date"], { encoding: "utf8" }).trim();
    const fakeBin = mkdtempSync(join(tmpdir(), "e10-nossh-"));
    execFileSync("ln", ["-s", dateBin, join(fakeBin, "date")]);
    try {
      const { code, out } = runDryRun({
        RESTIC_REPOSITORY: "sftp:backup@example.invalid:/restic",
        RESTIC_PASSWORD_FILE: join(tmp, "restic_password.txt"),
        RESTIC_SSH_KEY_FILE: join(tmp, "restic_password.txt"), // presente pero irrelevante: lo que se prueba es ssh ausente
        RESTIC_SSH_KNOWN_HOSTS_FILE: join(tmp, "restic_password.txt"),
        PATH: fakeBin,
      });
      expect(code).toBe(3);
      expect(out).toContain("CONFIG INCOMPLETA");
      expect(out).toContain("openssh-client");
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("sftp sin RESTIC_SSH_KEY_FILE ni RESTIC_SSH_KNOWN_HOSTS_FILE: exit 3 con ambos avisos", () => {
    const { code, out } = runDryRun({
      RESTIC_REPOSITORY: "sftp:backup@example.invalid:/restic",
      RESTIC_PASSWORD_FILE: join(tmp, "restic_password.txt"),
      RESTIC_SSH_KEY_FILE: "",
      RESTIC_SSH_KNOWN_HOSTS_FILE: "",
    });
    expect(code).toBe(3);
    expect(out).toContain("falta RESTIC_SSH_KEY_FILE");
    expect(out).toContain("falta RESTIC_SSH_KNOWN_HOSTS_FILE");
  });

  it("sftp con known_hosts vacío: exit 3 (un known_hosts vacío equivale a no verificar nada)", () => {
    const emptyKnownHosts = join(tmp, "empty_known_hosts");
    writeFileSync(emptyKnownHosts, "");
    const { code, out } = runDryRun({
      RESTIC_REPOSITORY: "sftp:backup@example.invalid:/restic",
      RESTIC_PASSWORD_FILE: join(tmp, "restic_password.txt"),
      RESTIC_SSH_KEY_FILE: join(tmp, "restic_password.txt"),
      RESTIC_SSH_KNOWN_HOSTS_FILE: emptyKnownHosts,
    });
    expect(code).toBe(3);
    expect(out).toContain("está vacío o no es legible");
  });

  it("config de bootstrap incompleta (sin sftp:) sigue en exit 1, no 3 — no se penaliza el día 1 del operador", () => {
    const { code, out } = runDryRun({ RESTIC_REPOSITORY: "", RESTIC_PASSWORD_FILE: "", RESTIC_PASSWORD: "" });
    expect(code).toBe(1);
    expect(out).toContain("CONFIG INCOMPLETA");
  });

  it("sftp con toda la configuración correcta: CONFIG OK y el plan menciona la verificación de huella", () => {
    const knownHosts = join(tmp, "ok_known_hosts");
    writeFileSync(knownHosts, "example.invalid ssh-ed25519 AAAAtest");
    const { code, out } = runDryRun({
      RESTIC_REPOSITORY: "sftp:backup@example.invalid:/restic",
      RESTIC_PASSWORD_FILE: join(tmp, "restic_password.txt"),
      RESTIC_SSH_KEY_FILE: join(tmp, "restic_password.txt"),
      RESTIC_SSH_KNOWN_HOSTS_FILE: knownHosts,
    });
    expect(code).toBe(0);
    expect(out).toContain("CONFIG OK");
    expect(out).toContain("ssh presente");
    expect(out).toContain("StrictHostKeyChecking yes, nunca 'no'");
  });

  it("repositorio local (no sftp:): no exige ssh ni claves SSH (no regresiona el caso ya soportado)", () => {
    const { code, out } = runDryRun({
      RESTIC_REPOSITORY: "/mnt/nas/backups/s9-ai-arena",
      RESTIC_PASSWORD_FILE: join(tmp, "restic_password.txt"),
    });
    expect(code).toBe(0);
    expect(out).toContain("CONFIG OK");
    expect(out).not.toContain("SFTP ·");
  });
});

// Hallazgo del coordinador tras la primera versión de este fix: un
// `backup.sh --dry-run` que detecta el fallo no sirve de nada si
// entrypoint.sh (lo que REALMENTE arranca en el contenedor) se traga el
// código de salida con `|| true` y deja correr crond igual — "arranca y se
// cae luego en la primera ejecución del cron", 24 h después, es el mismo
// silencio que este fix existe para romper. Esta suite ejecuta
// entrypoint.sh DE VERDAD (bash real, sin Docker: no hace falta para probar
// SU lógica de arranque, sólo para probar la imagen completa — eso lo cubre
// backup-sftp-e2e.test.ts), con BACKUP_SH/CRONTAB_FILE apuntando a dobles de
// prueba controlados, para demostrar que el contenedor se niega a arrancar
// (no ejecuta `crond`) cuando backup.sh señala sftp_errors (exit 3), y que
// SÍ arranca con una config de bootstrap simplemente incompleta (exit 1) —
// el comportamiento preexistente y documentado que no había que romper.
describe("entrypoint.sh real: arranque del contenedor (fail-closed en sftp, sin Docker)", () => {
  let tmp2: string;
  let fakeBin: string;
  let mockBackupPath: string;
  let crondMarker: string;

  beforeAll(() => {
    tmp2 = mkdtempSync(join(tmpdir(), "e10-entrypoint-"));
    fakeBin = join(tmp2, "bin");
    mkdirSync(fakeBin);
    crondMarker = join(tmp2, "crond-invoked");

    // Doble de `crond -f -l 2`: si entrypoint.sh llega a `exec crond`, este
    // script dejará constancia en crondMarker. No necesita simular `-f`
    // (foreground) porque el test no espera que el proceso quede colgado:
    // basta con demostrar que SE INVOCÓ o que NO se invocó.
    const crondMock = join(fakeBin, "crond");
    writeFileSync(crondMock, `#!/bin/sh\necho "crond $*" > "${crondMarker}"\nexit 0\n`, { mode: 0o755 });
  });
  afterAll(() => rmSync(tmp2, { recursive: true, force: true }));

  function runEntrypoint(backupExitCode: number, extraEnv: Record<string, string> = {}) {
    mockBackupPath = join(tmp2, `mock-backup-${backupExitCode}-${Date.now()}.sh`);
    // Doble de backup.sh: ignora sus argumentos (--dry-run) y se limita a
    // reproducir el código de salida que se quiere probar, con un mensaje
    // reconocible en la salida — igual que haría backup.sh real al fallar.
    writeFileSync(
      mockBackupPath,
      `#!/bin/sh\necho '{"level":"error","service":"backup","msg":"MOCK dry-run exit ${backupExitCode}"}'\nexit ${backupExitCode}\n`,
      { mode: 0o755 },
    );
    const crontabFile = join(tmp2, `crontab-${backupExitCode}-${Date.now()}`);
    rmSync(crondMarker, { force: true });
    try {
      const out = execFileSync(BASH_BIN, [ENTRYPOINT], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          BACKUP_SH: mockBackupPath,
          CRONTAB_FILE: crontabFile,
          BACKUP_CRON: "15 4 * * *",
          ...extraEnv,
        },
      });
      return { code: 0, out, crontabFile };
    } catch (e: any) {
      return { code: e.status as number, out: `${e.stdout ?? ""}${e.stderr ?? ""}`, crontabFile };
    }
  }

  it("backup.sh --dry-run devuelve 3 (sftp mal configurado): el contenedor NO arranca crond", () => {
    const { code, out } = runEntrypoint(3);
    expect(code).not.toBe(0);
    expect(out).toContain("ARRANQUE ABORTADO");
    expect(out).toContain("MOCK dry-run exit 3");
    expect(existsSync(crondMarker)).toBe(false);
  });

  it("backup.sh --dry-run devuelve 1 (config de bootstrap incompleta, no sftp): el contenedor SÍ arranca crond (comportamiento preexistente)", () => {
    const { code, out } = runEntrypoint(1);
    expect(code).toBe(0);
    expect(out).not.toContain("ARRANQUE ABORTADO");
    expect(existsSync(crondMarker)).toBe(true);
    expect(readFileSync(crondMarker, "utf8")).toContain("crond -f -l 2");
  });

  it("backup.sh --dry-run devuelve 0 (config completa): el contenedor arranca crond y programa el cron", () => {
    const { code, crontabFile } = runEntrypoint(0);
    expect(code).toBe(0);
    expect(existsSync(crondMarker)).toBe(true);
    expect(readFileSync(crontabFile, "utf8")).toContain("15 4 * * * /usr/local/bin/backup.sh");
  });

  // Pregunta directa del coordinador tras la primera versión de este fix:
  // "comprueba que el arranque del contenedor con known_hosts vacío falla en
  // cerrado con un mensaje claro, y no que arranca y se cae luego en la
  // primera ejecución del cron". Las tres pruebas de arriba usan un DOBLE de
  // backup.sh (para aislar la lógica de entrypoint.sh); esta usa el
  // backup.sh REAL con BACKUP_SH, cerrando el círculo end-to-end sin mocks
  // en ninguno de los dos scripts (Docker sólo hace falta para la ejecución
  // contra un SFTP real, no para demostrar esta decisión de arranque).
  it("con el backup.sh REAL y RESTIC_SSH_KNOWN_HOSTS_FILE vacío: el contenedor se niega a arrancar (no un fallo diferido al cron)", () => {
    const emptyKnownHosts = join(tmp2, "real-empty-known-hosstestfile");
    writeFileSync(emptyKnownHosts, "");
    const { code, out } = runEntrypoint(/* backupExitCode ignorado, ver abajo */ 0, {
      BACKUP_SH: BACKUP, // backup.sh real, no el doble
      RESTIC_REPOSITORY: "sftp:backup@example.invalid:/restic",
      RESTIC_PASSWORD_FILE: join(tmp, "restic_password.txt"),
      RESTIC_SSH_KEY_FILE: join(tmp, "restic_password.txt"),
      RESTIC_SSH_KNOWN_HOSTS_FILE: emptyKnownHosts,
    });
    expect(code).not.toBe(0);
    expect(out).toContain("ARRANQUE ABORTADO");
    expect(out).toContain("está vacío o no es legible"); // mensaje real de backup.sh, no del mock
    expect(existsSync(crondMarker)).toBe(false);
  });
});

describe("restore.sh --dry-run (ejecutado de verdad, sin docker)", () => {
  it("--dry-run: plan completo con configuración", () => {
    const out = execFileSync("bash", [RESTORE, "--dry-run"], {
      encoding: "utf8",
      env: { ...process.env, RESTIC_REPOSITORY: "/mnt/nas/backups" },
    });
    expect(out).toContain("restic restore latest");
    expect(out).toContain("pg_restore");
    expect(out).toContain("CONFIG OK");
  });

  // ── D4-R3c (ronda 4, mutación superviviente cerrada): restore.sh tiene
  // su PROPIA copia de json_escape (no comparte código con backup.sh), y
  // nada probaba que la usara de verdad — podía reducirse a la identidad
  // sin que fallara ningún test. Aquí se fuerza un mensaje de log con
  // comillas embebidas a través de un argumento real de línea de comandos
  // ($dir, tal cual lo interpola "manifest.sha256 no encontrado en $dir")
  // y se comprueba que la línea de log resultante sigue siendo JSON válido.
  it("restore.sh: --verify con un directorio con comillas en el nombre no rompe el JSON del log (D4-R3c)", () => {
    // El directorio debe EXISTIR de verdad: con `set -e` activo, un `find`
    // sobre una ruta inexistente aborta el script antes de llegar al log()
    // controlado de "no encontrado" (eso probaría otra cosa, no el escape).
    const parent = mkdtempSync(join(tmpdir(), "e10-d4r3c-"));
    const evilName = 'pwn", "level":"info", "forged":"si';
    const evilDir = join(parent, evilName);
    mkdirSync(evilDir, { recursive: true });
    let output = "";
    try {
      execFileSync("bash", [RESTORE, "--verify", evilDir], { encoding: "utf8", stdio: "pipe" });
    } catch (e: any) {
      output = `${e.stdout}${e.stderr}`;
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
    const line = output.split("\n").find((l) => l.includes("no encontrado"));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line as string);
    expect(parsed.level).toBe("error");
    expect(parsed).not.toHaveProperty("forged");
  });
});

describe("secretos fuera del repositorio (revisión automatizada, DoD T10.4)", () => {
  it("ningún archivo de infrastructure/secrets/ (salvo README/.gitignore) está versionado", () => {
    const tracked = execSync("git ls-files infrastructure/secrets/", {
      cwd: join(here, "..", ".."),
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(tracked.sort()).toEqual(["infrastructure/secrets/.gitignore", "infrastructure/secrets/README.md"]);
  });
});

// ── Fakes fieles de restic/pg_dump ──────────────────────────────────────────
// `pg_dump` falso: crea el fichero de salida (-f es el argumento anterior al
// valor) y sale con éxito, simulando un dump correcto. `writeFakePgDumpFail`
// simula un fallo real de conexión.
function writeFakePgDumpOk(fakebin: string) {
  writeFileSync(
    join(fakebin, "pg_dump"),
    `#!/usr/bin/env bash\nfor ((i=1;i<=$#;i++)); do if [ "\${!i}" = "-f" ]; then j=$((i+1)); : > "\${!j}"; fi; done\nexit 0\n`,
    { mode: 0o755 },
  );
}
function writeFakePgDumpFail(fakebin: string) {
  writeFileSync(join(fakebin, "pg_dump"), `#!/usr/bin/env bash\necho "pg_dump: conexion rechazada" >&2\nexit 1\n`, {
    mode: 0o755,
  });
}

// `restic` falso FIEL (exigencia del coordinador tras la revisión del
// supervisor): preserva la ruta ABSOLUTA de origen al "guardar", igual que
// el restic real, y sabe "restaurar" esa misma estructura bajo --target. Es
// justo el comportamiento donde estaba el defecto real de #112 (el manifest
// no coincidía con la ruta restaurada) — un fake que no lo reprodujera no
// serviría para probar el fix. Registra cada invocación en `log` para poder
// comprobar qué se le pasó a "backup" (p.ej. que el dump SÍ llegó).
function writeFakeResticFaithful(fakebin: string, store: string, log: string, opts: { failBackup?: boolean } = {}) {
  const failBackup = opts.failBackup ? "1" : "0";
  const script = `#!/usr/bin/env bash
echo "$@" >> "${log}"
case "$1" in
  backup)
    if [ "${failBackup}" = "1" ]; then
      echo "restic: fake backend unreachable" >&2
      exit 7
    fi
    tag=""
    for a in "$@"; do case "$a" in s9-arena-*) tag="$a" ;; esac; done
    src="\${@: -1}"
    destdir="${store}/$tag$(dirname "$src")"
    mkdir -p "$destdir"
    cp -a "$src" "$destdir/"
    ;;
  restore)
    tag=""
    target=""
    prev=""
    for a in "$@"; do
      [ "$prev" = "--tag" ] && tag="$a"
      [ "$prev" = "--target" ] && target="$a"
      prev="$a"
    done
    mkdir -p "$target"
    cp -a "${store}/$tag/." "$target/"
    ;;
  forget|check)
    :
    ;;
esac
exit 0
`;
  writeFileSync(join(fakebin, "restic"), script, { mode: 0o755 });
}

// runLogFromScript: extrae las definiciones REALES de json_escape()+log() de
// backup.sh/restore.sh (no una copia en el test) y ejecuta `log error "$1"`
// con el mensaje pasado como argv — sin pasar por shell quoting ni por el
// citado (quotearg) que aplica `find` a sus propios mensajes de error.
// Necesario porque un ataque con el payload dentro de un nombre de fichero
// listado por `find` puede quedar neutralizado por el citado del propio
// `find` ANTES de llegar a json_escape (ver D2-R3a más abajo) — lo que
// produce una cobertura de test falsa: el test "pasa" sin que json_escape
// haya hecho nada. Esta vía ejercita la función tal cual vive en el script.
function runLogFromScript(scriptPath: string, msg: string): string {
  const content = readFileSync(scriptPath, "utf8");
  const startIdx = content.indexOf("json_escape() {");
  const logLineMatch = content.match(/^log\(\) \{ printf.*$/m);
  if (startIdx === -1 || !logLineMatch) {
    throw new Error(`no se pudo extraer json_escape()/log() de ${scriptPath}`);
  }
  const logLine = logLineMatch[0];
  const logIdx = content.indexOf(logLine, startIdx);
  const funcBlock = content.slice(startIdx, logIdx + logLine.length);
  const wrapper = `#!/usr/bin/env bash\n${funcBlock}\nlog error "$1"\n`;
  const wrapperPath = join(tmpdir(), `log-wrapper-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
  try {
    return execFileSync("bash", [wrapperPath, msg], { encoding: "utf8" });
  } finally {
    rmSync(wrapperPath, { force: true });
  }
}

// runLogFromScriptRawBytes: como runLogFromScript, pero el mensaje se
// EMBEBE en el propio fichero del script (como bytes crudos, vía Buffer),
// no se pasa por argv. Necesario para probar bytes UTF-8 inválidos de
// verdad: al pasar una cadena JS por execFileSync, Node la reencuentra
// como UTF-8 válido (un "\xff" en JS es el carácter U+00FF, dos bytes
// UTF-8 válidos — NO el byte crudo 0xFF inválido que se quiere probar).
// Escribiendo el script como Buffer se controla el byte exacto.
// Devuelve BYTES CRUDOS (Buffer, no string): pedirle a execFileSync
// `encoding: "utf8"` decodifica el stdout con el decoder tolerante de
// Node, que reemplaza en SILENCIO cualquier byte inválido por el carácter
// de reemplazo U+FFFD antes de que el test llegue a verlo — el propio
// Node neutralizaría la mutación igual que `find`/quotearg lo hacía en
// D2-R3a. Hay que inspeccionar los bytes tal cual salieron del script.
function runLogFromScriptRawBytes(scriptPath: string, prefixMsg: string, rawByte: number, suffixMsg: string): Buffer {
  const content = readFileSync(scriptPath, "utf8");
  const startIdx = content.indexOf("json_escape() {");
  const logLineMatch = content.match(/^log\(\) \{ printf.*$/m);
  if (startIdx === -1 || !logLineMatch) {
    throw new Error(`no se pudo extraer json_escape()/log() de ${scriptPath}`);
  }
  const logLine = logLineMatch[0];
  const logIdx = content.indexOf(logLine, startIdx);
  const funcBlock = content.slice(startIdx, logIdx + logLine.length);
  const head = Buffer.from(`#!/usr/bin/env bash\n${funcBlock}\nlog error "${prefixMsg}`, "utf8");
  const mid = Buffer.from([rawByte]);
  const tail = Buffer.from(`${suffixMsg}"\n`, "utf8");
  const wrapperBuf = Buffer.concat([head, mid, tail]);
  const wrapperPath = join(tmpdir(), `log-wrapper-raw-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(wrapperPath, wrapperBuf, { mode: 0o755 });
  try {
    return execFileSync("bash", [wrapperPath]); // sin `encoding`: Buffer crudo
  } finally {
    rmSync(wrapperPath, { force: true });
  }
}

// runValidateManifestJson: extrae la función REAL `validate_manifest_json`
// de restore.sh y la invoca directamente sobre un contenido de fichero
// dado, devolviendo su exit code. D3-R6 (ronda 7, hallazgo del supervisor):
// los tests anteriores de esta función pasaban por la cadena completa de
// --verify, donde OTROS chequeos (claves de fuente) confirmaban el mismo
// resultado por su cuenta — "mutando uno a uno: llaves balanceadas
// SOBREVIVE, prefijo/sufijo SOBREVIVE […] sólo el de las 6 claves mata
// tests". Invocar la función aislada, sin las demás comprobaciones de
// --verify alrededor, es la única forma de que cada test mate SÓLO su
// propio sub-chequeo.
function runValidateManifestJson(jsonContent: string): number {
  const content = readFileSync(RESTORE, "utf8");
  const startIdx = content.indexOf("validate_manifest_json() {");
  if (startIdx === -1) throw new Error("no se pudo extraer validate_manifest_json() de restore.sh");
  // La función cierra con un "}" en su propia línea (columna 4, mismo
  // indentado que el "validate_manifest_json() {" de apertura).
  const closeMatch = content.slice(startIdx).match(/\n {4}\}\n/);
  if (!closeMatch || closeMatch.index === undefined) {
    throw new Error("no se pudo encontrar el cierre de validate_manifest_json() en restore.sh");
  }
  const funcBlock = content.slice(startIdx, startIdx + closeMatch.index + closeMatch[0].length);
  const mjPath = join(tmpdir(), `d3r6-manifest-json-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(mjPath, jsonContent);
  const wrapper = `#!/usr/bin/env bash\n${funcBlock}\nvalidate_manifest_json "${mjPath}"\nexit $?\n`;
  const wrapperPath = join(tmpdir(), `validate-mj-wrapper-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
  try {
    execFileSync("bash", [wrapperPath], { stdio: "pipe" });
    return 0;
  } catch (e: any) {
    return e.status ?? 1;
  } finally {
    rmSync(wrapperPath, { force: true });
    rmSync(mjPath, { force: true });
  }
}

// ── Camino real (#110b): clasificación ok/empty/error de fuentes ───────────
// El backup real nunca se había ejercitado en tests (sólo --dry-run). Aquí
// se inyectan binarios falsos de restic/pg_dump vía PATH en un directorio
// temporal, para probar SUCCESS/PARTIAL/FULL FAILURE sin depender de un
// backend restic ni de una BD real.
describe("backup.sh camino real (restic/pg_dump falsos vía PATH)", () => {
  let root: string;
  let fakebin: string;
  let resticLog: string;
  let store: string;
  let metricsDir: string;

  function makeDirs() {
    root = mkdtempSync(join(tmpdir(), "e10-real-"));
    fakebin = join(root, "bin");
    store = join(root, "store");
    metricsDir = join(root, "metrics");
    mkdirSync(fakebin, { recursive: true });
    mkdirSync(store, { recursive: true });
    resticLog = join(root, "restic-calls.log");
    for (const dir of ["maps", "bot-sources", "replays", "assets", "secrets", "work"]) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    writeFileSync(join(root, "secrets", "restic_password.txt"), "s3cr3t-restic", { mode: 0o600 });
    writeFileSync(join(root, "secrets", "postgres_password.txt"), "s3cr3t-pg", { mode: 0o600 });
  }

  function runReal(env: Record<string, string>) {
    try {
      const out = execFileSync("bash", [BACKUP], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakebin}:${process.env.PATH}`,
          RESTIC_REPOSITORY: "/tmp/fake-repo",
          RESTIC_PASSWORD_FILE: join(root, "secrets", "restic_password.txt"),
          PGPASSWORD_FILE: join(root, "secrets", "postgres_password.txt"),
          MAPS_DIR: join(root, "maps"),
          BOT_SOURCES_DIR: join(root, "bot-sources"),
          REPLAYS_DIR: join(root, "replays"),
          ASSETS_DIR: join(root, "assets"),
          SECRETS_DIR: join(root, "secrets"),
          WORK_DIR: join(root, "work"),
          METRICS_DIR: metricsDir,
          ...env,
        },
      });
      return { code: 0, out };
    } catch (e: any) {
      return { code: e.status as number, out: `${e.stdout}${e.stderr}` };
    }
  }

  // El manifest.json ya no se copia aparte: vive DENTRO del staging que
  // restic "almacena" de verdad, así que se lee desde el store fiel.
  function readManifest() {
    const path = join(store, "s9-arena-data", join(root, "work"), "staging", "manifest.json");
    return JSON.parse(readFileSync(path, "utf8"));
  }
  function readMetrics() {
    return readFileSync(join(metricsDir, "s9_backup.prom"), "utf8");
  }
  function metricValue(metrics: string, name: string, labels = "") {
    const re = new RegExp(`^${name}${labels ? `\\{${labels}\\}` : ""} (\\S+)$`, "m");
    const m = metrics.match(re);
    return m ? m[1] : undefined;
  }

  it("todas las fuentes no críticas vacías: exit 0 (SUCCESS) y restic SE EJECUTA", () => {
    makeDirs();
    writeFakePgDumpOk(fakebin);
    writeFakeResticFaithful(fakebin, store, resticLog);
    const { code, out } = runReal({});
    expect(code).toBe(0);
    expect(out).toContain("backup SUCCESS");
    const calls = readFileSync(resticLog, "utf8");
    expect(calls).toContain("backup --tag s9-arena-data");
    expect(calls).toContain("backup --tag s9-arena-secrets");
    const manifest = readManifest();
    expect(manifest.maps.status).toBe("empty");
  });

  it("fuente inexistente (directorio nunca creado): empty, no aborta", () => {
    makeDirs();
    rmSync(join(root, "assets"), { recursive: true, force: true }); // no existe de verdad
    writeFakePgDumpOk(fakebin);
    writeFakeResticFaithful(fakebin, store, resticLog);
    const { code, out } = runReal({});
    expect(code).toBe(0);
    expect(out).not.toContain("error");
    const manifest = readManifest();
    expect(manifest.assets.status).toBe("empty");
  });

  it("fuente no crítica con error real (permiso denegado): exit 2 (PARTIAL) y restic SE EJECUTA igual", () => {
    makeDirs();
    writeFileSync(join(root, "maps", "mapa.json"), '{"ok":true}');
    execSync(`chmod 000 ${join(root, "maps")}`);
    writeFakePgDumpOk(fakebin);
    writeFakeResticFaithful(fakebin, store, resticLog);
    try {
      const { code, out } = runReal({});
      expect(code).toBe(2);
      expect(out).toContain("PARTIAL SUCCESS");
      const calls = readFileSync(resticLog, "utf8");
      expect(calls).toContain("backup --tag s9-arena-data"); // restic SÍ corrió
      const manifest = readManifest();
      expect(manifest.maps.status).toBe("error");
    } finally {
      execSync(`chmod 755 ${join(root, "maps")}`); // permite que rmSync limpie después
    }
  });

  it("pg_dump falla (fuente crítica): exit 1 (FULL FAILURE) y restic NO se ejecuta", () => {
    makeDirs();
    writeFakePgDumpFail(fakebin);
    writeFakeResticFaithful(fakebin, store, resticLog);
    const { code, out } = runReal({});
    expect(code).toBe(1);
    expect(out).toContain("FULL FAILURE");
    expect(existsSync(resticLog)).toBe(false); // restic nunca se invocó
  });

  it("el dump de PostgreSQL sobrevive a un error de fuente secundaria: restic recibe el dump", () => {
    makeDirs();
    execSync(`chmod 000 ${join(root, "replays")}`);
    writeFakePgDumpOk(fakebin);
    writeFakeResticFaithful(fakebin, store, resticLog);
    try {
      const { code } = runReal({});
      expect(code).toBe(2);
      const staged = join(store, "s9-arena-data", join(root, "work"), "staging");
      const dumpFiles = execSync(`find "${staged}" -maxdepth 1 -name 'pgdump-*.dump'`, { encoding: "utf8" }).trim();
      expect(dumpFiles).not.toBe(""); // el dump SÍ llegó al staging que restic guardó
    } finally {
      execSync(`chmod 755 ${join(root, "replays")}`);
    }
  });

  it("manifest.json refleja la clasificación correcta de cada fuente", () => {
    makeDirs();
    writeFileSync(join(root, "bot-sources", "bot.py"), "print(1)");
    writeFakePgDumpOk(fakebin);
    writeFakeResticFaithful(fakebin, store, resticLog);
    const { code } = runReal({});
    expect(code).toBe(0);
    const manifest = readManifest();
    expect(manifest.postgres.status).toBe("ok");
    expect(manifest.secrets.status).toBe("ok");
    expect(manifest.bot_sources).toEqual({ status: "ok", files: 1 });
    expect(manifest.maps.status).toBe("empty");
  });

  it("ningún valor de secreto aparece en la salida, logs ni manifest", () => {
    makeDirs();
    writeFakePgDumpOk(fakebin);
    writeFakeResticFaithful(fakebin, store, resticLog);
    const { out } = runReal({});
    expect(out).not.toContain("s3cr3t-restic");
    expect(out).not.toContain("s3cr3t-pg");
    const manifest = JSON.stringify(readManifest());
    expect(manifest).not.toContain("s3cr3t");
  });

  // ── M1 (supervisor): secrets vacío se clasificaba como `error` por un
  // efecto de `pipefail` sobre `grep -c .`, contradiciendo la cabecera del
  // propio script (empty nunca aborta). Un directorio de secretos vacío
  // pero LEGIBLE debe seguir siendo SUCCESS. ──────────────────────────────
  it("secrets vacío (legible, 0 ficheros): NO es error, SUCCESS (issue 5 / M1)", () => {
    makeDirs();
    // makeDirs() ya deja 2 ficheros de secretos; para este caso se necesita
    // el directorio vacío pero existente y legible.
    rmSync(join(root, "secrets", "restic_password.txt"));
    rmSync(join(root, "secrets", "postgres_password.txt"));
    // RESTIC_PASSWORD_FILE/PGPASSWORD_FILE deben apuntar a algo legible para
    // pasar la validación de configuración previa; se ponen fuera de
    // SECRETS_DIR para no repoblarlo.
    writeFileSync(join(root, "restic_password_out.txt"), "s3cr3t-restic-out");
    writeFileSync(join(root, "pg_password_out.txt"), "s3cr3t-pg-out");
    writeFakePgDumpOk(fakebin);
    writeFakeResticFaithful(fakebin, store, resticLog);
    const { code, out } = runReal({
      RESTIC_PASSWORD_FILE: join(root, "restic_password_out.txt"),
      PGPASSWORD_FILE: join(root, "pg_password_out.txt"),
    });
    expect(code).toBe(0);
    expect(out).toContain("backup SUCCESS");
    const manifest = readManifest();
    expect(manifest.secrets.status).toBe("empty");
  });

  // ── M1 (supervisor), caso crítico real: secrets ILEGIBLE (permiso
  // denegado) sí debe ser FULL FAILURE — la criticidad de `secrets` no se
  // ha invertido, sólo se corrigió el falso positivo de "vacío". ──────────
  it("secrets ilegible (permiso denegado): FULL FAILURE exit 1, restic NO se ejecuta", () => {
    makeDirs();
    execSync(`chmod 000 ${join(root, "secrets")}`);
    writeFakePgDumpOk(fakebin);
    writeFakeResticFaithful(fakebin, store, resticLog);
    try {
      const { code, out } = runReal({});
      expect(code).toBe(1);
      expect(out).toContain("FULL FAILURE");
      expect(existsSync(resticLog)).toBe(false);
    } finally {
      execSync(`chmod 755 ${join(root, "secrets")}`);
    }
  });

  // ── M9 (supervisor): si `restic backup` falla, el backup completo NO
  // puede reportar SUCCESS ni "snapshot creado". Antes de este test, nada
  // ejercitaba una fuga real de restic — sólo el camino feliz. ───────────
  it("restic backup falla: exit 1 (FULL FAILURE), snapshot NO creado, métricas reflejan el fallo (M9)", () => {
    makeDirs();
    writeFakePgDumpOk(fakebin);
    writeFakeResticFaithful(fakebin, store, resticLog, { failBackup: true });
    const { code, out } = runReal({});
    expect(code).toBe(1);
    expect(out).toContain("FULL FAILURE");
    const metrics = readMetrics();
    expect(metricValue(metrics, "s9_backup_run_success")).toBe("0");
    expect(metricValue(metrics, "s9_backup_restic_snapshot_created")).toBe("0");
    expect(metricValue(metrics, "s9_backup_last_exit_code")).toBe("1");
    // El store fiel no debe contener nada bajo s9-arena-data: no se guardó.
    expect(existsSync(join(store, "s9-arena-data"))).toBe(false);
  });

  // ── M6 (supervisor): `find | xargs -I{}` (separador de línea) excluía la
  // fuente ENTERA de restic si algún nombre de fichero rompía la iteración.
  // Se sustituyó por `find -print0` + `read -d ''`. Aquí se prueba que,
  // dentro del mismo directorio, un fichero con un nombre "raro" no hace
  // desaparecer al resto de replays del backup. ──────────────────────────
  it("un nombre de fichero con salto de línea no excluye toda la fuente replays (M6)", () => {
    makeDirs();
    const officialDir = join(root, "replays", "official");
    mkdirSync(officialDir, { recursive: true });
    writeFileSync(join(officialDir, "normal.jsonl"), '{"tick":1}\n');
    // Nombre de fichero con un salto de línea literal embebido: rompe la
    // lectura línea-a-línea de `xargs -I{}`, no la de `-print0`/`read -d ''`.
    writeFileSync(join(officialDir, "raro\nnombre.jsonl"), '{"tick":2}\n');
    writeFakePgDumpOk(fakebin);
    writeFakeResticFaithful(fakebin, store, resticLog);
    const { code } = runReal({});
    expect([0, 2]).toContain(code); // SUCCESS o PARTIAL, nunca FULL FAILURE
    const manifest = readManifest();
    expect(manifest.replays.status).toBe("ok");
    expect(manifest.replays.files).toBe(2); // los DOS ficheros, no 0 ni 1
    // `wc -l` cuenta SALTOS DE LÍNEA, y uno de los dos ficheros tiene un
    // salto de línea embebido en su propio nombre: contar líneas de `find`
    // infla el recuento en un asterisco falso. Se cuentan entradas NUL-
    // delimitadas (`-print0`) para que el propio nombre "raro" no falsee la
    // cuenta, igual que hace el script real al copiarlas.
    const staged = join(store, "s9-arena-data", join(root, "work"), "staging", "replays", "official");
    const nulCount = execSync(`find "${staged}" -type f -print0 | tr -cd '\\0' | wc -c`, {
      encoding: "utf8",
    }).trim();
    expect(nulCount).toBe("2"); // ambos llegaron de verdad a lo que restic guardó
  });

  // ── M3 (supervisor): ningún test leía el fichero de métricas; por eso
  // podía sobrevivir una mutación que dejara `s9_backup_source_error`
  // siempre a 0. Aquí se lee el fichero .prom real, no sólo exit/stdout. ──
  it("fichero de métricas: s9_backup_source_error/_empty/_files por fuente son correctos (M3)", () => {
    makeDirs();
    writeFileSync(join(root, "maps", "m.json"), "{}");
    execSync(`chmod 000 ${join(root, "maps")}`);
    writeFakePgDumpOk(fakebin);
    writeFakeResticFaithful(fakebin, store, resticLog);
    try {
      const { code } = runReal({});
      expect(code).toBe(2);
      const metrics = readMetrics();
      expect(metricValue(metrics, "s9_backup_source_error", 'source="maps"')).toBe("1");
      expect(metricValue(metrics, "s9_backup_source_empty", 'source="maps"')).toBe("0");
      expect(metricValue(metrics, "s9_backup_source_error", 'source="assets"')).toBe("0");
      expect(metricValue(metrics, "s9_backup_source_empty", 'source="assets"')).toBe("1");
    } finally {
      execSync(`chmod 755 ${join(root, "maps")}`);
    }
  });

  // ── M7 (supervisor): `s9_backup_last_success_timestamp_seconds` sólo debe
  // avanzar con exit==0. Se comprueba con ejecuciones reales encadenadas:
  // SUCCESS fija el valor; un PARTIAL posterior debe conservarlo intacto
  // (si avanzara, BackupTooOld jamás dispararía con un PARTIAL sostenido). ─
  it("timestamp de último éxito NO avanza en una ejecución PARTIAL posterior a un SUCCESS (M7)", () => {
    makeDirs();
    writeFakePgDumpOk(fakebin);
    writeFakeResticFaithful(fakebin, store, resticLog);

    const first = runReal({});
    expect(first.code).toBe(0);
    const tsAfterSuccess = metricValue(readMetrics(), "s9_backup_last_success_timestamp_seconds");
    expect(tsAfterSuccess).toBeDefined();

    // `date +%s` sólo tiene resolución de 1s: sin esperar, una mutación que
    // reescribiera el timestamp en CADA ejecución podría "colar" si ambas
    // corridas caen en el mismo segundo de reloj. Se espera de verdad para
    // que la comparación de igualdad sea una prueba real, no una coincidencia.
    execSync("sleep 1.1");

    // Segunda ejecución: fuente no crítica en error → PARTIAL SUCCESS.
    writeFileSync(join(root, "maps", "m.json"), "{}");
    execSync(`chmod 000 ${join(root, "maps")}`);
    try {
      const second = runReal({});
      expect(second.code).toBe(2);
      const tsAfterPartial = metricValue(readMetrics(), "s9_backup_last_success_timestamp_seconds");
      expect(tsAfterPartial).toBe(tsAfterSuccess); // congelado, no avanza
    } finally {
      execSync(`chmod 755 ${join(root, "maps")}`);
    }
  });

  it("con RESTIC_REPOSITORY sin configurar: exit 1 y s9_backup_run_success=0 (destaparía el incidente de VM108)", () => {
    makeDirs();
    writeFakePgDumpOk(fakebin);
    writeFakeResticFaithful(fakebin, store, resticLog);
    const { code } = runReal({ RESTIC_REPOSITORY: "", RESTIC_PASSWORD_FILE: "", RESTIC_PASSWORD: "" });
    expect(code).toBe(1);
    const metrics = readMetrics();
    expect(metricValue(metrics, "s9_backup_run_success")).toBe("0");
  });

  // ── D2 (ronda 3, seguridad): `log()` interpolaba mensajes sin escapar en
  // una plantilla JSON. Un nombre de fichero de `bot_sources` (contenido
  // subido por usuarios) como `pwn", "level":"info", "forged":"si` producía
  // un JSON "válido" cuyo `level` efectivo dejaba de ser `error` —
  // ocultando el fallo a Loki/Promtail— e inyectaba campos arbitrarios.
  // Demostrado aquí con el mismo payload, parseando la línea de log real. ──
  it("nombre de fichero con comillas/JSON embebido no falsea el log (D2, inyección de campos)", () => {
    makeDirs();
    const evilName = 'pwn", "level":"info", "forged":"si';
    const evilDir = join(root, "bot-sources", evilName);
    mkdirSync(evilDir, { recursive: true });
    writeFileSync(join(evilDir, "x.py"), "print(1)");
    // execFileSync con argv en array: evilDir contiene comillas dobles que
    // romperían el quoting de una cadena de shell interpolada.
    execFileSync("chmod", ["000", evilDir]);
    writeFakePgDumpOk(fakebin);
    writeFakeResticFaithful(fakebin, store, resticLog);
    try {
      const { out } = runReal({});
      const line = out.split("\n").find((l) => l.includes("bot_sources") && l.includes("ilegible"));
      expect(line).toBeDefined();
      // Debe seguir siendo JSON válido línea a línea, con level="error" REAL
      // (no sobrescrito por el payload) y SIN el campo inyectado "forged".
      const parsed = JSON.parse(line as string);
      expect(parsed.level).toBe("error");
      expect(parsed).not.toHaveProperty("forged");
    } finally {
      execFileSync("chmod", ["755", evilDir]);
    }
  });

  // ── D4-R3c (ronda 4, mutación superviviente cerrada): nada probaba
  // ESPECÍFICAMENTE el escape de backslash — el test de comillas (D2) no
  // lo cazaba. `s="${s//\\/\\\\}"` podía borrarse sin que fallara ningún
  // test: un backslash sin escapar sólo rompe el JSON si cae INMEDIATAMENTE
  // antes de la comilla de cierre que `log()` añade en su propia plantilla
  // (entonces esa comilla queda escapada por el backslash del atacante en
  // vez de cerrar la cadena). Un intento inicial de este test metía el
  // backslash en un nombre de fichero de `bot_sources` esperando verlo en
  // el mensaje de `find` — pero el citado (quotearg) de `find` en este
  // sistema envuelve el nombre en comillas simples, así que el backslash
  // nunca queda pegado a la comilla doble de cierre del JSON: otro falso
  // positivo de cobertura, igual que D2-R3a. Se usa `runLogFromScript`
  // para invocar `log()` (la función REAL del fichero) con un mensaje que
  // termina en backslash justo antes del cierre, sin intermediarios. ─────
  it("mensaje que termina en backslash no rompe el cierre de la cadena JSON (D4-R3c)", () => {
    const out = runLogFromScript(BACKUP, "fuente ilegible: ruta\\con\\backslashes\\");
    expect(() => JSON.parse(out.trim())).not.toThrow();
    expect(JSON.parse(out.trim()).level).toBe("error");
  });

  // ── D2-R3a (ronda 4, hallazgo del supervisor): la primera versión de
  // json_escape sólo escapaba `\n \r \t`. Bytes de control como 0x0b
  // (vertical tab) se interpolaban crudos: `JSON.parse` (y cualquier
  // pipeline estricto, incluido Loki/Promtail) rechaza la línea entera
  // como inválida — mismo impacto práctico que D2 (el fallo desaparece de
  // la alertería), pero por malformación en vez de por forja de campos.
  //
  // OJO de método: un intento inicial de este test metía el byte de
  // control en un nombre de fichero de `bot_sources` y esperaba verlo en
  // el mensaje de error de `find`. Eso NO ejercitaba el escape real: el
  // `find` de GNU coreutils de este sistema ya cita (quotearg) los
  // caracteres no imprimibles en SU PROPIO mensaje de error (los convierte
  // en la secuencia visible `\v`, no el byte crudo 0x0b), así que el test
  // "pasaba" sin que json_escape hubiera hecho nada — un falso positivo de
  // cobertura que se habría colado si no se hubiera verificado con la
  // mutación real (ver ronda de verificación). El byte crudo SÍ llega tal
  // cual a `log()` cuando viene de un argumento de línea de comandos
  // ($dir en restore.sh --verify), que no pasa por el citado de `find`. ──
  it("directorio con byte de control 0x0b (no \\n\\r\\t) en su nombre no rompe el JSON del log (D2-R3a)", () => {
    const parent = mkdtempSync(join(tmpdir(), "e10-d2r3a-"));
    const evilName = "pwn\x0bname";
    const evilDir = join(parent, evilName);
    mkdirSync(evilDir, { recursive: true });
    let output = "";
    try {
      execFileSync("bash", [RESTORE, "--verify", evilDir], { encoding: "utf8", stdio: "pipe" });
    } catch (e: any) {
      output = `${e.stdout}${e.stderr}`;
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
    const line = output.split("\n").find((l) => l.includes("no encontrado"));
    expect(line).toBeDefined();
    expect(() => JSON.parse(line as string)).not.toThrow();
    expect(JSON.parse(line as string).level).toBe("error");
  });

  // ── N1 (supervisor, cobertura nueva): un fallo de `cp` AL STAGING (no de
  // lectura al listar con `find`, que ya se clasifica en `classify_source`)
  // debía degradar la fuente a `error` y marcar PARTIAL — el código ya lo
  // hacía, pero no había ningún test que lo demostrara, así que una
  // regresión futura (p.ej. borrar el chequeo de `stage_source`) no la
  // cazaría nadie. Se fuerza un fallo de LECTURA DE CONTENIDO (chmod 000 en
  // el FICHERO, no en el directorio: `find` puede listarlo con sólo permiso
  // de lectura+ejecución del directorio, pero `cp -a` sí necesita leer el
  // contenido del fichero) para que `classify_source` marque `ok` y sea
  // `stage_source` quien detecte el fallo real de copia. ──────────────────
  it("fallo de cp al copiar al staging degrada la fuente a error y marca PARTIAL (N1)", () => {
    makeDirs();
    const mapFile = join(root, "maps", "m1.json");
    writeFileSync(mapFile, '{"m":1}');
    execSync(`chmod 000 "${mapFile}"`);
    writeFakePgDumpOk(fakebin);
    writeFakeResticFaithful(fakebin, store, resticLog);
    try {
      const { code, out } = runReal({});
      expect(code).toBe(2);
      expect(out).toContain("PARTIAL SUCCESS");
      expect(out).toContain("fallo copiando 'maps' al staging");
      const manifest = readManifest();
      expect(manifest.maps.status).toBe("error"); // NUNCA "ok" con contenido que no llegó a restic
      const metrics = readMetrics();
      expect(metricValue(metrics, "s9_backup_source_error", 'source="maps"')).toBe("1");
      // El staging que restic SÍ guardó no debe contener el fichero que
      // falló al copiar (no hay "ok" a medias, ni promesas falsas).
      const staged = join(store, "s9-arena-data", join(root, "work"), "staging", "maps");
      expect(existsSync(staged) && existsSync(join(staged, "m1.json"))).toBe(false);
    } finally {
      execSync(`chmod 644 "${mapFile}"`);
    }
  });

  // ── N4 (supervisor, cobertura nueva): REPLAY_RETENTION_DAYS no tenía NI
  // UN test — era el titular de #110b ("nunca se había copiado ni un solo
  // replay") y su semántica de ventana temporal quedó completamente sin
  // ejercitar. Se crean un replay reciente (dentro de retención), uno
  // antiguo (fuera de retención, y NO bajo official/) y se fija
  // REPLAY_RETENTION_DAYS a un valor pequeño para no depender de fechas
  // lejanas. ────────────────────────────────────────────────────────────
  it("REPLAY_RETENTION_DAYS excluye replays antiguos fuera de official/ (N4)", () => {
    makeDirs();
    const replaysDir = join(root, "replays");
    writeFileSync(join(replaysDir, "reciente.jsonl"), '{"tick":1}\n');
    writeFileSync(join(replaysDir, "antiguo.jsonl"), '{"tick":0}\n');
    // 10 días en el pasado; retención de la prueba = 2 días.
    const oldTime = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    const touchStamp = `${oldTime.getFullYear()}${String(oldTime.getMonth() + 1).padStart(2, "0")}${String(oldTime.getDate()).padStart(2, "0")}0000`;
    execSync(`touch -t ${touchStamp} "${join(replaysDir, "antiguo.jsonl")}"`);
    writeFakePgDumpOk(fakebin);
    writeFakeResticFaithful(fakebin, store, resticLog);
    const { code } = runReal({ REPLAY_RETENTION_DAYS: "2" });
    expect([0, 2]).toContain(code);
    const manifest = readManifest();
    expect(manifest.replays.status).toBe("ok");
    expect(manifest.replays.files).toBe(1); // sólo el reciente
    const staged = join(store, "s9-arena-data", join(root, "work"), "staging", "replays");
    expect(existsSync(join(staged, "reciente.jsonl"))).toBe(true);
    expect(existsSync(join(staged, "antiguo.jsonl"))).toBe(false);
  });

  it("REPLAY_RETENTION_DAYS NO se aplica dentro de official/ (siempre preferente)", () => {
    makeDirs();
    const officialDir = join(root, "replays", "official");
    mkdirSync(officialDir, { recursive: true });
    writeFileSync(join(officialDir, "muy-viejo.jsonl"), '{"tick":0}\n');
    const oldTime = new Date(Date.now() - 400 * 24 * 3600 * 1000); // > 1 año
    const touchStamp = `${oldTime.getFullYear()}${String(oldTime.getMonth() + 1).padStart(2, "0")}${String(oldTime.getDate()).padStart(2, "0")}0000`;
    execSync(`touch -t ${touchStamp} "${join(officialDir, "muy-viejo.jsonl")}"`);
    writeFakePgDumpOk(fakebin);
    writeFakeResticFaithful(fakebin, store, resticLog);
    const { code } = runReal({ REPLAY_RETENTION_DAYS: "1" }); // retención mínima
    expect([0, 2]).toContain(code);
    const manifest = readManifest();
    expect(manifest.replays.status).toBe("ok");
    expect(manifest.replays.files).toBe(1); // official/ ignora la retención
  });

  // ── D1-R5 (ronda 6, HALLAZGO DEL SUPERVISOR — bloqueante, ALTA): un
  // nombre de fichero con salto de línea en maps/bot_sources/assets
  // ABORTABA EL BACKUP COMPLETO y perdía el dump de PostgreSQL — el mismo
  // incidente que motiva la cabecera de este fichero, reintroducido por
  // otra puerta. Causa: `classify_source` contaba con `find … | grep -c .`
  // (líneas), mientras `sha256sum` emite UNA línea por fichero escapando
  // el `\n` del nombre; el contraste de backup.sh comparaba dos unidades
  // distintas. La ronda 4 ya había arreglado esto para `replays`
  // (`-print0`/`read -d ''`) pero dejó `maps`/`bot_sources`/`assets`
  // contando por líneas — los tres que pasan por `classify_source`.
  // `bot_sources` es contenido que suben los usuarios: un usuario podía
  // tumbar el backup de TODA la plataforma con un solo nombre de fichero. ─
  it("nombre de fichero con salto de línea en maps: backup SUCCESS, dump preservado (D1-R5)", () => {
    makeDirs();
    const evilName = "salto\nlinea.json";
    writeFileSync(join(root, "maps", evilName), '{"m":1}');
    writeFakePgDumpOk(fakebin);
    writeFakeResticFaithful(fakebin, store, resticLog);
    const { code, out } = runReal({});
    expect(code).toBe(0); // NUNCA FULL FAILURE por un nombre de fichero legítimo
    expect(out).toContain("backup SUCCESS");
    expect(out).not.toContain("manifest.sha256 inconsistente");
    const metrics = readMetrics();
    expect(metricValue(metrics, "s9_backup_restic_snapshot_created")).toBe("1");
    expect(metricValue(metrics, "s9_backup_postgres_success")).toBe("1");
    const manifest = readManifest();
    expect(manifest.maps.status).toBe("ok");
    expect(manifest.maps.files).toBe(1);
  });

  // Mismo defecto, en bot_sources (contenido subido por USUARIOS: el
  // vector de ataque real que señaló el supervisor) y assets.
  it("nombre de fichero con salto de línea en bot_sources (contenido de usuario): backup SUCCESS (D1-R5)", () => {
    makeDirs();
    writeFileSync(join(root, "bot-sources", "bot\ncon-salto.py"), "print(1)");
    writeFakePgDumpOk(fakebin);
    writeFakeResticFaithful(fakebin, store, resticLog);
    const { code, out } = runReal({});
    expect(code).toBe(0);
    expect(out).not.toContain("manifest.sha256 inconsistente");
    const manifest = readManifest();
    expect(manifest.bot_sources.status).toBe("ok");
    expect(manifest.bot_sources.files).toBe(1);
  });

  it("nombre de fichero con salto de línea en assets: backup SUCCESS (D1-R5)", () => {
    makeDirs();
    writeFileSync(join(root, "assets", "sprite\ncon-salto.png"), "fake-bytes");
    writeFakePgDumpOk(fakebin);
    writeFakeResticFaithful(fakebin, store, resticLog);
    const { code, out } = runReal({});
    expect(code).toBe(0);
    expect(out).not.toContain("manifest.sha256 inconsistente");
    const manifest = readManifest();
    expect(manifest.assets.status).toBe("ok");
    expect(manifest.assets.files).toBe(1);
  });

  // ── D1-R3 (ronda 4, HALLAZGO DEL SUPERVISOR): backup.sh generaba el
  // manifest con `(cd "$STAGING" && find … -exec sha256sum … | sed …) >
  // fichero` SIN comprobar el estado de salida de esa subshell — un fallo
  // de `find`/`sha256sum` (disco lleno, binario ausente, permiso revocado
  // a mitad de ejecución) podía dejar un manifest.sha256 vacío o truncado
  // con el staging poblado, y el backup seguía reportando SUCCESS. Se
  // fuerza el fallo inyectando un `sha256sum` falso que siempre sale con
  // error, y se comprueba que el backup entero pasa a FULL FAILURE (no
  // SUCCESS ni PARTIAL) en vez de generar un manifest silenciosamente roto.
  it("fallo de sha256sum al generar el manifest: FULL FAILURE, no SUCCESS con manifest roto (D1-R3, lado backup.sh)", () => {
    makeDirs();
    writeFileSync(join(root, "maps", "m.json"), '{"m":1}');
    writeFakePgDumpOk(fakebin);
    writeFakeResticFaithful(fakebin, store, resticLog);
    writeFileSync(
      join(fakebin, "sha256sum"),
      `#!/usr/bin/env bash\necho "sha256sum: fallo simulado (disco lleno)" >&2\nexit 1\n`,
      { mode: 0o755 },
    );
    const { code, out } = runReal({});
    expect(code).toBe(1); // FULL FAILURE, nunca 0 ni 2 con un manifest no fiable
    expect(out).toContain("fallo generando manifest.sha256");
    expect(existsSync(join(store, "s9-arena-data"))).toBe(false); // restic no llegó a subir nada
  });

  // ── D1-R3 (ronda 4): el chequeo anterior cubre "el comando falla". Este
  // cubre el caso más sutil que el supervisor pidió explícitamente: el
  // comando puede salir con éxito (exit 0) pero producir MENOS líneas de
  // las que corresponden — p.ej. un `sed`/pipeline que pierde una línea
  // sin fallar. Se inyecta un `sed` falso que descarta una línea de cada
  // dos, y se comprueba que el cruce "líneas del manifest vs. suma de
  // ficheros 'ok'" detecta la inconsistencia aunque el pipeline entero
  // haya salido con éxito. ────────────────────────────────────────────────
  it("manifest con menos líneas de las esperadas (pipeline OK pero incompleto): FULL FAILURE (D1-R3)", () => {
    makeDirs();
    writeFileSync(join(root, "maps", "m1.json"), '{"m":1}');
    writeFileSync(join(root, "maps", "m2.json"), '{"m":2}');
    writeFakePgDumpOk(fakebin);
    writeFakeResticFaithful(fakebin, store, resticLog);
    // `sed` falso: deja pasar sólo la primera línea que recibe (simula un
    // manifest truncado a mitad de escritura, sin que el pipeline falle).
    writeFileSync(join(fakebin, "sed"), `#!/usr/bin/env bash\nhead -n 1\n`, { mode: 0o755 });
    const { code, out } = runReal({});
    expect(code).toBe(1);
    expect(out).toContain("manifest.sha256 inconsistente");
    expect(existsSync(join(store, "s9-arena-data"))).toBe(false);
  });

  // ── N2 (supervisor, cobertura nueva, menor): el `trap` de limpieza de
  // $WORK_DIR no tenía test — una regresión que lo quitara dejaría el
  // staging (con el dump de PostgreSQL sin cifrar) residual en el
  // contenedor entre ejecuciones. ──────────────────────────────────────────
  it("el trap de limpieza borra $WORK_DIR (staging con el dump) al terminar (N2)", () => {
    makeDirs();
    writeFakePgDumpOk(fakebin);
    writeFakeResticFaithful(fakebin, store, resticLog);
    const { code } = runReal({});
    expect(code).toBe(0);
    expect(existsSync(join(root, "work"))).toBe(false);
  });

  // ── N3 (supervisor, cobertura nueva, menor): `unset PGPASSWORD` tras
  // pg_dump no tenía test — una regresión que lo quitara dejaría la
  // contraseña de PostgreSQL en el entorno de los pasos siguientes
  // (incluida la invocación real de `restic`). Se instrumenta el `restic`
  // falso para volcar su propio entorno y se comprueba que PGPASSWORD no
  // viaja hasta ahí. ────────────────────────────────────────────────────
  it("PGPASSWORD no sigue en el entorno tras pg_dump (N3, no llega a restic)", () => {
    makeDirs();
    writeFakePgDumpOk(fakebin);
    const envDump = join(root, "restic-env.log");
    writeFileSync(
      join(fakebin, "restic"),
      // "^PGPASSWORD=" a propósito (no "PGPASSWORD_FILE=", que es la ruta de
      // configuración legítima y SÍ debe seguir presente en el entorno).
      `#!/usr/bin/env bash\nenv | grep -E '^PGPASSWORD=' >> "${envDump}" || true\nexit 0\n`,
      { mode: 0o755 },
    );
    const { code } = runReal({});
    expect(code).toBe(0);
    expect(existsSync(envDump) && readFileSync(envDump, "utf8").trim() !== "").toBe(false);
  });
});

// ── Cadena E2E real (exigencia del coordinador tras la revisión del
// supervisor): backup.sh real → restic falso FIEL (preserva rutas absolutas)
// → restore.sh --restore → restore.sh --verify. NINGÚN directorio se monta
// a mano: todo lo que verifica `--verify` lo produjo `backup.sh`. ─────────
describe("backup.sh → restic falso fiel → restore.sh --restore/--verify (E2E real)", () => {
  let root: string;
  let fakebin: string;
  let store: string;
  let workDir: string;

  function setup() {
    root = mkdtempSync(join(tmpdir(), "e10-e2e-"));
    fakebin = join(root, "bin");
    store = join(root, "store");
    workDir = join(root, "work");
    mkdirSync(fakebin, { recursive: true });
    mkdirSync(store, { recursive: true });
    for (const dir of ["maps", "bot-sources", "replays/official", "assets", "secrets"]) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    writeFileSync(join(root, "maps", "mvp.json"), '{"map":"mvp"}\n');
    writeFileSync(join(root, "bot-sources", "bot.py"), "print('hola')\n");
    writeFileSync(join(root, "assets", "sprite.png"), "fake-png-bytes\n");
    writeFileSync(join(root, "replays", "official", "battle-1.jsonl"), '{"tick":1}\n');
    writeFileSync(join(root, "secrets", "restic_password.txt"), "s3cr3t-restic-e2e", { mode: 0o600 });
    writeFileSync(join(root, "secrets", "postgres_password.txt"), "s3cr3t-pg-e2e", { mode: 0o600 });
    writeFakePgDumpOk(fakebin);
  }

  function backupEnv(extra: Record<string, string> = {}) {
    return {
      ...process.env,
      PATH: `${fakebin}:${process.env.PATH}`,
      RESTIC_REPOSITORY: "/tmp/fake-repo",
      RESTIC_PASSWORD_FILE: join(root, "secrets", "restic_password.txt"),
      PGPASSWORD_FILE: join(root, "secrets", "postgres_password.txt"),
      MAPS_DIR: join(root, "maps"),
      BOT_SOURCES_DIR: join(root, "bot-sources"),
      REPLAYS_DIR: join(root, "replays"),
      ASSETS_DIR: join(root, "assets"),
      SECRETS_DIR: join(root, "secrets"),
      WORK_DIR: workDir,
      METRICS_DIR: join(root, "metrics"),
      ...extra,
    } as Record<string, string>;
  }

  it("cadena completa: backup real → restore --restore → restore --verify pasa con datos genuinos", () => {
    setup();
    const log = join(root, "restic-calls.log");
    writeFakeResticFaithful(fakebin, store, log);

    const backupOut = execFileSync("bash", [BACKUP], { encoding: "utf8", env: backupEnv() });
    expect(backupOut).toContain("backup SUCCESS");

    const dest = join(root, "restored");
    execFileSync("bash", [RESTORE, "--restore", dest], { encoding: "utf8", env: backupEnv() });

    // El manifest y los datos deben convivir en el MISMO árbol restaurado
    // (el defecto real de #112: antes esto era imposible de cumplir).
    const verifyOut = execFileSync("bash", [RESTORE, "--verify", dest], { encoding: "utf8" });
    expect(verifyOut).toContain("integridad verificada");
    expect(verifyOut).toContain("mvp.json");
    expect(verifyOut).toContain("bot.py");
    expect(verifyOut).toContain("sprite.png"); // assets llega hasta la verificación (punto 6)
    expect(verifyOut).toContain("battle-1.jsonl");

    // Los datos realmente están ahí, no sólo "el comando no lanzó excepción".
    const found = execSync(`find "${dest}" -name mvp.json -o -name sprite.png`, { encoding: "utf8" }).trim();
    expect(found.split("\n").length).toBe(2);
  });

  it("cadena completa con corrupción tras restaurar: --verify falla (sha256 no coincide)", () => {
    setup();
    const log = join(root, "restic-calls.log");
    writeFakeResticFaithful(fakebin, store, log);
    execFileSync("bash", [BACKUP], { encoding: "utf8", env: backupEnv() });
    const dest = join(root, "restored");
    execFileSync("bash", [RESTORE, "--restore", dest], { encoding: "utf8", env: backupEnv() });

    const mapFile = execSync(`find "${dest}" -name mvp.json`, { encoding: "utf8" }).trim();
    writeFileSync(mapFile, '{"map":"CORRUPTO"}\n');

    expect(() => execFileSync("bash", [RESTORE, "--verify", dest], { stdio: "pipe" })).toThrow();
  });

  // ── D1 (ronda 3, BLOQUEANTE para el simulacro): reproducido con backup.sh
  // real que, con las cuatro fuentes no críticas vacías (el estado ACTUAL
  // de producción en VM108, y el de cualquier instalación recién
  // desplegada), `manifest.sha256` queda en 0 bytes y `sha256sum -c` sobre
  // un fichero vacío sale con exit 1 ("no properly formatted checksum
  // lines found"). Un operador siguiendo la Fase 7 del runbook obtendría un
  // FALLO DURO sobre un backup perfecto. Es el mismo TIPO de defecto que
  // hundió la ronda 1 (--verify roto en un escenario real sin test), sólo
  // que en el extremo opuesto: aquí "no hay nada que verificar" debe ser
  // éxito, no fallo. ──────────────────────────────────────────────────────
  // D3 (#112, aplicado): antes de este fix, con las cuatro fuentes no
  // críticas vacías el manifest quedaba a 0 bytes (el dump se excluía a
  // propósito). Desde D3 el pg_dump SIEMPRE deja una línea en el manifest
  // cuando postgres está 'ok' — y postgres siempre está 'ok' si el script
  // llega a generar el manifest (si pg_dump falla, aborta antes en FULL
  // FAILURE) — así que "las cuatro fuentes vacías" ya NO produce un
  // manifest vacío: produce un manifest de UNA línea (el dump), y --verify
  // debe recorrer la rama de `sha256sum -c` normal, no la de "vacío
  // legítimo". Se actualiza el contrato de este test para reflejar eso.
  it("cadena completa con las CUATRO fuentes no críticas vacías: --verify pasa con el dump como única entrada del manifest (D1+D3)", () => {
    root = mkdtempSync(join(tmpdir(), "e10-e2e-empty-"));
    fakebin = join(root, "bin");
    store = join(root, "store");
    workDir = join(root, "work");
    mkdirSync(fakebin, { recursive: true });
    mkdirSync(store, { recursive: true });
    // maps/bot-sources/replays/assets existen (son los volúmenes montados
    // por el compose) pero están VACÍOS, exactamente como en VM108 hoy.
    for (const dir of ["maps", "bot-sources", "replays", "assets", "secrets"]) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    writeFileSync(join(root, "secrets", "restic_password.txt"), "s3cr3t-restic-empty", { mode: 0o600 });
    writeFileSync(join(root, "secrets", "postgres_password.txt"), "s3cr3t-pg-empty", { mode: 0o600 });
    writeFakePgDumpOk(fakebin);
    const log = join(root, "restic-calls.log");
    writeFakeResticFaithful(fakebin, store, log);

    const backupOut = execFileSync("bash", [BACKUP], { encoding: "utf8", env: backupEnv() });
    expect(backupOut).toContain("backup SUCCESS");

    const dest = join(root, "restored-empty");
    execFileSync("bash", [RESTORE, "--restore", dest], { encoding: "utf8", env: backupEnv() });

    // El manifest.sha256 restaurado debe existir y tener EXACTAMENTE una
    // línea: la del pg_dump (única fuente 'ok' con contenido cuando las
    // cuatro no críticas están vacías). Ya NO está vacío desde D3.
    const manifestPath = execSync(`find "${dest}" -name manifest.sha256`, { encoding: "utf8" }).trim();
    expect(manifestPath).not.toBe("");
    const manifestLines = readFileSync(manifestPath, "utf8").split("\n").filter(Boolean);
    expect(manifestLines.length).toBe(1);
    expect(manifestLines[0]).toMatch(/pgdump-\d+\.dump$/);

    // Con contenido en el manifest, --verify recorre la rama normal de
    // sha256sum -c (ya NO la rama de "manifest vacío legítimo" de D1) y
    // debe afirmar la integridad del dump de verdad.
    const verifyOut = execFileSync("bash", [RESTORE, "--verify", dest], { encoding: "utf8" });
    expect(verifyOut).toContain("integridad verificada: checksums de postgres, mapas y replays correctos");
  });

  // ── D1-R3 (ronda 4, HALLAZGO DEL SUPERVISOR — bloqueante): la primera
  // versión de este fix (ronda 3) trataba CUALQUIER manifest.sha256 de 0
  // bytes como "vacío legítimo" sin comprobar nada más — cambió un falso
  // positivo (rechazar un backup sano) por un falso NEGATIVO (aceptar un
  // backup roto). Demostrado por el supervisor: con maps/replays POBLADOS
  // pero manifest.sha256 en 0 bytes (p.ej. truncado por disco lleno),
  // `--verify` pasaba con exit 0 y afirmaba "checksums correctos" sin
  // haber comprobado ni uno. Aquí se reproduce el escenario partiendo de
  // un backup REAL con datos (no un manifest vacío hecho a mano): se corre
  // la cadena normal con contenido, y se simula la corrupción post-restore
  // truncando manifest.sha256 a 0 bytes dejando los datos intactos — el
  // caso real que un disco lleno o un `sha256sum` interrumpido dejaría. ──
  it("manifest.sha256 vacío pero con datos poblados en el árbol: --verify FALLA (D1-R3, falso negativo cerrado)", () => {
    setup(); // datos reales: mvp.json, bot.py, sprite.png, battle-1.jsonl
    const log = join(root, "restic-calls.log");
    writeFakeResticFaithful(fakebin, store, log);
    execFileSync("bash", [BACKUP], { encoding: "utf8", env: backupEnv() });
    const dest = join(root, "restored-truncated");
    execFileSync("bash", [RESTORE, "--restore", dest], { encoding: "utf8", env: backupEnv() });

    // Simula el manifest truncado/corrupto que un disco lleno dejaría: los
    // DATOS siguen ahí (maps, bot_sources, assets, replays), pero el
    // manifest que debería cubrirlos queda vacío.
    const manifestPath = execSync(`find "${dest}" -name manifest.sha256`, { encoding: "utf8" }).trim();
    writeFileSync(manifestPath, "");

    let threw = false;
    let output = "";
    try {
      output = execFileSync("bash", [RESTORE, "--verify", dest], { encoding: "utf8", stdio: "pipe" });
    } catch (e: any) {
      threw = true;
      output = `${e.stdout}${e.stderr}`;
    }
    expect(threw).toBe(true); // NUNCA debe salir 0 con datos sin verificar
    expect(output).toContain("SIN verificar");
    expect(output).not.toContain("integridad verificada");
  });

  // ── D1-R3 (ronda 4): segundo ángulo del mismo hallazgo — manifest.json
  // (que viaja en el mismo directorio) declarando una fuente `ok` mientras
  // manifest.sha256 está vacío es una inconsistencia real del backup (no
  // "cobertura vacía legítima"), incluso si no queda NINGÚN fichero de
  // datos residual en el árbol (p.ej. porque también se perdieron). Este
  // test aísla específicamente el cruce con manifest.json — construcción
  // deliberada y adversarial de la entrada para probar el propio guard de
  // restore.sh, no una fabricación que enmascare un defecto de backup.sh
  // (ver la nota de la ronda 1 sobre por qué eso sería distinto). ────────
  it("manifest.json declara una fuente 'ok' mientras manifest.sha256 está vacío: --verify FALLA (D1-R3)", () => {
    const dir = mkdtempSync(join(tmpdir(), "e10-d1r3-manifestjson-"));
    try {
      writeFileSync(join(dir, "manifest.sha256"), "");
      writeFileSync(
        join(dir, "manifest.json"),
        '{"postgres":{"status":"ok","files":1},"secrets":{"status":"ok","files":2},"maps":{"status":"ok","files":9999},"bot_sources":{"status":"empty","files":0},"replays":{"status":"empty","files":0},"assets":{"status":"empty","files":0}}',
      );
      let threw = false;
      let output = "";
      try {
        output = execFileSync("bash", [RESTORE, "--verify", dir], { encoding: "utf8", stdio: "pipe" });
      } catch (e: any) {
        threw = true;
        output = `${e.stdout}${e.stderr}`;
      }
      expect(threw).toBe(true);
      expect(output).toContain("declara 'maps' como 'ok'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── D1-R4 (ronda 5, HALLAZGO DEL SUPERVISOR — bloqueante): el fix de
  // D1-R3 sólo vivía en la rama de manifest VACÍO. La rama de manifest CON
  // contenido —la que se usa el 99% de las veces, porque es la de un
  // backup con datos— sólo hacía `sha256sum -c`, que no detecta un
  // manifest TRUNCADO (menos líneas de las que el backup realmente
  // produjo) mientras los datos siguen intactos en el árbol. Demostrado
  // por el supervisor con backup.sh real: manifest a la mitad, exit 0,
  // "integridad verificada: checksums de mapas y replays correctos" sobre
  // un fichero (maps/arena.json) que nunca se comprobó. Reproducido aquí
  // partiendo de un backup REAL con datos (no un manifest hecho a mano
  // desde cero): se trunca el manifest generado de verdad por backup.sh,
  // dejando los datos intactos. ──────────────────────────────────────────
  it("manifest.sha256 TRUNCADO (menos líneas de las que produjo el backup) con datos intactos: --verify FALLA (D1-R4)", () => {
    setup(); // datos reales: mvp.json, bot.py, sprite.png, battle-1.jsonl
    const log = join(root, "restic-calls.log");
    writeFakeResticFaithful(fakebin, store, log);
    execFileSync("bash", [BACKUP], { encoding: "utf8", env: backupEnv() });
    const dest = join(root, "restored-truncated-r4");
    execFileSync("bash", [RESTORE, "--restore", dest], { encoding: "utf8", env: backupEnv() });

    const manifestPath = execSync(`find "${dest}" -name manifest.sha256`, { encoding: "utf8" }).trim();
    const original = readFileSync(manifestPath, "utf8");
    const lines = original.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(1); // el fixture tiene varias fuentes con contenido
    // Trunca a UNA sola línea: los datos de las demás fuentes siguen en el
    // árbol restaurado, pero el manifest ya no las cubre.
    writeFileSync(manifestPath, lines[0] + "\n");

    let threw = false;
    let output = "";
    try {
      output = execFileSync("bash", [RESTORE, "--verify", dest], { encoding: "utf8", stdio: "pipe" });
    } catch (e: any) {
      threw = true;
      output = `${e.stdout}${e.stderr}`;
    }
    expect(threw).toBe(true); // NUNCA exit 0 con datos sin cubrir por el manifest
    expect(output).toContain("manifest.sha256 inconsistente");
    expect(output).not.toContain("integridad verificada");
  });

  // ── D1-R4 (ronda 5): segundo ángulo — un fichero INYECTADO en el árbol
  // restaurado (p.ej. `maps/backdoor.json`) que nunca estuvo en el
  // manifest.sha256 original. `sha256sum -c` no lo detecta porque sólo
  // recorre las líneas que SÍ están listadas; el chequeo de "residuales"
  // (ficheros de datos vs líneas del manifest) es lo único que lo caza. ──
  it("fichero inyectado en el árbol restaurado SIN entrada en el manifest: --verify FALLA (D1-R4)", () => {
    setup();
    const log = join(root, "restic-calls.log");
    writeFakeResticFaithful(fakebin, store, log);
    execFileSync("bash", [BACKUP], { encoding: "utf8", env: backupEnv() });
    const dest = join(root, "restored-injected-r4");
    execFileSync("bash", [RESTORE, "--restore", dest], { encoding: "utf8", env: backupEnv() });

    const manifestPath = execSync(`find "${dest}" -name manifest.sha256`, { encoding: "utf8" }).trim();
    const mapsDir = join(dirname(manifestPath), "maps");
    writeFileSync(join(mapsDir, "backdoor.json"), '{"injected":true}\n');

    let threw = false;
    let output = "";
    try {
      output = execFileSync("bash", [RESTORE, "--verify", dest], { encoding: "utf8", stdio: "pipe" });
    } catch (e: any) {
      threw = true;
      output = `${e.stdout}${e.stderr}`;
    }
    expect(threw).toBe(true);
    expect(output).toContain("SIN entrada en el manifest");
  });

  // ── D2-R5 (ronda 6, HALLAZGO DEL SUPERVISOR — bloqueante, ALTA): la
  // misma premisa rota de D1-R5 se propagó al chequeo de residuales de
  // restore.sh (`find … | wc -l`): sobre un backup SANO con un nombre de
  // fichero con salto de línea, --verify denunciaba el backup ÍNTEGRO
  // como manipulado — la columna de falsos positivos que esta ronda debía
  // preservar. Cadena E2E real (sin fixtures a mano): backup.sh con datos
  // reales + un nombre "raro" → restore --restore → restore --verify DEBE
  // pasar limpio. ─────────────────────────────────────────────────────
  it("cadena completa: nombre de fichero con salto de línea en un backup SANO → --verify pasa SIN falsos positivos (D2-R5)", () => {
    setup();
    writeFileSync(join(root, "maps", "salto\nlinea.json"), '{"m":1}\n');
    const log = join(root, "restic-calls.log");
    writeFakeResticFaithful(fakebin, store, log);
    const backupOut = execFileSync("bash", [BACKUP], { encoding: "utf8", env: backupEnv() });
    expect(backupOut).toContain("backup SUCCESS");
    const dest = join(root, "restored-newline-d2r5");
    execFileSync("bash", [RESTORE, "--restore", dest], { encoding: "utf8", env: backupEnv() });
    const verifyOut = execFileSync("bash", [RESTORE, "--verify", dest], { encoding: "utf8" });
    expect(verifyOut).toContain("integridad verificada");
  });

  // ── D6-R5 (ronda 6, hallazgo del supervisor): un fichero de USUARIO
  // dentro de maps/ literalmente llamado "pgdump-x" escapaba a la
  // exclusión `! -name 'pgdump-*'` (coincide por nombre base en TODO el
  // árbol, no sólo en la raíz del staging) — ni se respaldaba en el
  // manifest NI se detectaba como residual. Ahora la exclusión es por
  // `-path` y sólo afecta a la raíz. ───────────────────────────────────
  it("fichero de usuario llamado 'pgdump-x' dentro de maps/ SÍ se respalda y SÍ se verifica (D6-R5)", () => {
    setup();
    writeFileSync(join(root, "maps", "pgdump-x"), '{"no soy el dump real":true}\n');
    const log = join(root, "restic-calls.log");
    writeFakeResticFaithful(fakebin, store, log);
    execFileSync("bash", [BACKUP], { encoding: "utf8", env: backupEnv() });
    const dest = join(root, "restored-pgdumpx-d6r5");
    execFileSync("bash", [RESTORE, "--restore", dest], { encoding: "utf8", env: backupEnv() });
    // Si "pgdump-x" hubiera sido excluido silenciosamente, no aparecería
    // ni en el manifest ni en el árbol restaurado bajo maps/.
    const found = execSync(`find "${dest}" -path '*/maps/pgdump-x'`, { encoding: "utf8" }).trim();
    expect(found).not.toBe("");
    const verifyOut = execFileSync("bash", [RESTORE, "--verify", dest], { encoding: "utf8" });
    expect(verifyOut).toContain("integridad verificada"); // se verificó de verdad, no se ignoró
  });

  // ── D1-R6/D2-R6 (ronda 7, HALLAZGO DEL SUPERVISOR — el mismo patrón por
  // sexta vez): el `find` que localiza manifest.sha256 en --verify seguía
  // siendo `-name` sin anclar (los otros tres `find` ya se habían migrado
  // a `-path` en la ronda 6) y contaba con `grep -c .` (líneas). Un
  // fichero llamado literalmente "manifest.sha256" DENTRO de una fuente
  // (maps/bot_sources/assets/replays) se contaba como un SEGUNDO manifest
  // y disparaba el guard de ambigüedad sobre un backup perfecto.
  // Reproducido para las cuatro fuentes, cadena E2E real. ────────────────
  it.each(["maps", "bot_sources", "assets", "replays"])(
    "fichero llamado 'manifest.sha256' dentro de %s no rompe --verify (D1-R6)",
    (source) => {
      setup();
      const dirName = source === "bot_sources" ? "bot-sources" : source;
      writeFileSync(join(root, dirName, "manifest.sha256"), "esto-no-es-el-manifest-real\n");
      const log = join(root, "restic-calls.log");
      writeFakeResticFaithful(fakebin, store, log);
      const backupOut = execFileSync("bash", [BACKUP], { encoding: "utf8", env: backupEnv() });
      expect(backupOut).toContain("backup SUCCESS");
      const dest = join(root, `restored-d1r6-${source}`);
      execFileSync("bash", [RESTORE, "--restore", dest], { encoding: "utf8", env: backupEnv() });
      const verifyOut = execFileSync("bash", [RESTORE, "--verify", dest], { encoding: "utf8" });
      expect(verifyOut).toContain("integridad verificada");
      expect(verifyOut).not.toContain("ambiguo");
    },
  );

  // D2-R6: el conteo por líneas (`grep -c .`) también inflaba el recuento
  // si la propia RUTA DE DESTINO (--restore/--verify <dest>) tenía un
  // salto de línea en algún componente — sin necesidad de ningún fichero
  // "raro" dentro del backup. Ahora se cuenta con NUL (mapfile -d '').
  it("ruta de destino con salto de línea en el nombre no rompe --verify (D2-R6)", () => {
    setup();
    const log = join(root, "restic-calls.log");
    writeFakeResticFaithful(fakebin, store, log);
    execFileSync("bash", [BACKUP], { encoding: "utf8", env: backupEnv() });
    const dest = join(root, "restored-con\nsalto-d2r6");
    execFileSync("bash", [RESTORE, "--restore", dest], { encoding: "utf8", env: backupEnv() });
    const verifyOut = execFileSync("bash", [RESTORE, "--verify", dest], { encoding: "utf8" });
    expect(verifyOut).toContain("integridad verificada");
    expect(verifyOut).not.toContain("ambiguo");
  });

  // ── Ronda 6 (hueco encontrado al enumerar caminos): $dir inexistente en
  // --verify moría por `set -e` sin ninguna línea de log JSON — la
  // alertería no veía nada. Ahora hay un chequeo explícito primero. ──────
  it("restore.sh --verify con directorio inexistente: exit 1 CON línea de log JSON (no aborta en silencio)", () => {
    const nonexistent = join(tmpdir(), `e10-no-existe-de-verdad-${Math.random().toString(36).slice(2)}`);
    let threw = false;
    let output = "";
    try {
      output = execFileSync("bash", [RESTORE, "--verify", nonexistent], { encoding: "utf8", stdio: "pipe" });
    } catch (e: any) {
      threw = true;
      output = `${e.stdout}${e.stderr}`;
    }
    expect(threw).toBe(true);
    const line = output.split("\n").find((l) => l.trim().startsWith("{"));
    expect(line).toBeDefined(); // hay AL MENOS una línea de log JSON, no sólo stderr crudo
    const parsed = JSON.parse(line as string);
    expect(parsed.level).toBe("error");
  });

  // ── D2-R4 (ronda 5) / D5-R5 (ronda 6, hallazgo del supervisor): manifest.
  // json truncado (el mismo escenario "disco lleno" que justifica media
  // PR) debía FALLAR --verify, no convertirse en un no-op silencioso que
  // además afirma "confirmado contra manifest.json" sobre algo que no es
  // JSON. El supervisor señaló que un solo test cubría los cuatro
  // sub-chequeos de `validate_manifest_json` COLECTIVAMENTE, y bastaba el
  // chequeo de prefijo (`'{'*'}'`) para "pasarlo" sin ejercitar el resto —
  // la función es correcta, pero la cobertura declarada no lo era. Aquí
  // cada sub-chequeo tiene su propio test, con un payload que
  // deliberadamente pasa TODOS los demás sub-chequeos salvo el que se
  // quiere aislar. ─────────────────────────────────────────────────────
  function verifyAgainstManifestJson(manifestJsonContent: string): { threw: boolean; output: string } {
    const dir = mkdtempSync(join(tmpdir(), "e10-d5r5-manifestjson-"));
    try {
      writeFileSync(join(dir, "manifest.sha256"), "");
      writeFileSync(join(dir, "manifest.json"), manifestJsonContent);
      try {
        const output = execFileSync("bash", [RESTORE, "--verify", dir], { encoding: "utf8", stdio: "pipe" });
        return { threw: false, output };
      } catch (e: any) {
        return { threw: true, output: `${e.stdout}${e.stderr}` };
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("manifest.json truncado a mitad de clave (sin llave de cierre): --verify FALLA (D5-R5, sub-chequeo 1/4: prefijo)", () => {
    // Ni siquiera pasa el chequeo de prefijo '{'*'}': no hay '}' final.
    const { threw, output } = verifyAgainstManifestJson('{"postgres":{"status":"ok","files":1},"secrets":{"stat');
    expect(threw).toBe(true);
    expect(output).toContain("no tiene forma válida");
    expect(output).not.toContain("confirmado contra manifest.json");
  });

  it("manifest.json con llaves desbalanceadas pero prefijo '{...}' válido: --verify FALLA (D5-R5, sub-chequeo 2/4: balance)", () => {
    // Pasa el chequeo de prefijo (empieza por '{', termina por '}') pero
    // tiene una llave de apertura de más sin cerrar en medio — el chequeo
    // de balance (nopen == nclose) es el único que lo caza.
    const { threw, output } = verifyAgainstManifestJson(
      '{"postgres":{{"status":"ok","files":1},"secrets":{"status":"ok","files":2},"maps":{"status":"empty","files":0},"bot_sources":{"status":"empty","files":0},"replays":{"status":"empty","files":0},"assets":{"status":"empty","files":0}}',
    );
    expect(threw).toBe(true);
    expect(output).toContain("no tiene forma válida");
  });

  it("manifest.json bien formado pero le falta una clave de fuente ('assets'): --verify FALLA (D5-R5, sub-chequeo 3/4: claves)", () => {
    // Prefijo OK, llaves balanceadas, pero sólo 5 de las 6 fuentes — el
    // bucle "for src in postgres secrets maps bot_sources replays assets"
    // es el único que lo caza.
    const { threw, output } = verifyAgainstManifestJson(
      '{"postgres":{"status":"ok","files":1},"secrets":{"status":"ok","files":2},"maps":{"status":"empty","files":0},"bot_sources":{"status":"empty","files":0},"replays":{"status":"empty","files":0}}',
    );
    expect(threw).toBe(true);
    expect(output).toContain("no tiene forma válida");
  });

  it("manifest.json es basura envuelta en '{...}' balanceado, sin ninguna clave real: --verify FALLA (D5-R5, sub-chequeo 4/4: no basta con prefijo+balance)", () => {
    // El supervisor lo señaló explícitamente: un chequeo que sólo mirara
    // prefijo ('{'*'}') + balance de llaves pasaría CUALQUIER JSON válido
    // arbitrario, aunque no tenga ninguna de las 6 claves de fuente
    // esperadas. Empieza por '{', termina por '}', UNA sola llave
    // balanceada — y aun así debe fallar, porque el bucle de claves de
    // fuente es lo único que comprueba el CONTENIDO real.
    const { threw, output } = verifyAgainstManifestJson('{"basura":"si","otracosa":123}');
    expect(threw).toBe(true);
    expect(output).toContain("no tiene forma válida");
  });

  // ── D3-R6 (ronda 7, HALLAZGO DEL SUPERVISOR): los cuatro sub-chequeos de
  // validate_manifest_json NO tenían cobertura independiente de verdad —
  // los tests de arriba pasaban por la cadena completa de --verify, donde
  // el bucle de claves de fuente confirmaba el mismo resultado por su
  // cuenta y enmascaraba si el prefijo/balance realmente fallaban. Aquí se
  // invoca `validate_manifest_json` AISLADA (extraída del fichero real,
  // sin el resto de --verify alrededor), con un payload que pasa TODOS
  // los demás sub-chequeos salvo el que se quiere aislar. ────────────────
  const VALID_ALL_SOURCES =
    '{"postgres":{"status":"ok","files":1},"secrets":{"status":"ok","files":2},"maps":{"status":"empty","files":0},"bot_sources":{"status":"empty","files":0},"replays":{"status":"empty","files":0},"assets":{"status":"empty","files":0}}';

  it("validate_manifest_json aislada: prefijo/sufijo inválido con llaves balanceadas y las 6 claves presentes → return 1 (D3-R6)", () => {
    // Balance OK (todas las llaves internas cierran), las 6 claves
    // presentes con forma válida — sólo el string NO empieza por '{' ni
    // termina por '}' (hay texto extra fuera). Sólo el chequeo de
    // prefijo/sufijo puede rechazar esto.
    const payload = `basura-antes${VALID_ALL_SOURCES}basura-despues`;
    expect(runValidateManifestJson(payload)).not.toBe(0);
  });

  it("validate_manifest_json aislada: llaves desbalanceadas con prefijo/sufijo y las 6 claves válidas → return 1 (D3-R6)", () => {
    // Prefijo/sufijo OK ('{'...'}'), las 6 claves presentes con forma
    // válida (el bucle de claves las encuentra por substring, no le
    // importa el resto del documento) — pero se añade una llave de
    // apertura suelta dentro de un valor de cadena, que NO tiene su cierre
    // correspondiente. Sólo el chequeo de balance (nopen == nclose) puede
    // rechazar esto.
    const withExtraBrace = VALID_ALL_SOURCES.replace('"secrets":{"status":"ok"', '"nota":"{","secrets":{"status":"ok"');
    expect(withExtraBrace.startsWith("{")).toBe(true);
    expect(withExtraBrace.endsWith("}")).toBe(true);
    expect(runValidateManifestJson(withExtraBrace)).not.toBe(0);
  });

  it("validate_manifest_json aislada: JSON con las 6 claves válidas SÍ pasa (control positivo, D3-R6)", () => {
    // Control: confirma que el helper y el payload base son correctos —
    // sin esto, los dos tests de arriba podrían estar "pasando" porque
    // CUALQUIER cosa devuelve 1, no porque aíslen su sub-chequeo.
    expect(runValidateManifestJson(VALID_ALL_SOURCES)).toBe(0);
  });

  // El cuarto sub-chequeo que el supervisor señaló ("-ne→-gt en
  // residuales SOBREVIVE") no vive en validate_manifest_json sino en el
  // contraste de --verify que compara el nº de ficheros de datos
  // restaurados con las líneas del manifest. Una entrada DUPLICADA en
  // manifest.sha256 referenciando el MISMO fichero real dos veces infla
  // "actual_lines" (2) por encima de los ficheros reales presentes (1)
  // SIN que sha256sum -c lo detecte (comprueba la misma línea dos veces
  // con éxito) y SIN disparar el chequeo de líneas-vs-manifest.json (se
  // ajusta manifest.json para declarar 2 "para que ese chequeo, anterior
  // en la cadena, no dispare primero y enmascare cuál sub-chequeo es el
  // que realmente está aislado aquí). Sólo `total_data_files -ne
  // actual_lines` (no `-gt`, que sólo mira el sentido "de más") lo caza:
  // aquí total_data_files(1) < actual_lines(2), el sentido "de menos".
  it("entrada duplicada en manifest.sha256 (mismo fichero real dos veces): --verify FALLA (D3-R6, residual -ne no -gt)", () => {
    const dir = mkdtempSync(join(tmpdir(), "e10-d3r6-duplicado-"));
    try {
      const mapsDir = join(dir, "maps");
      mkdirSync(mapsDir, { recursive: true });
      writeFileSync(join(mapsDir, "a.json"), '{"a":1}\n');
      const hash = execSync(`sha256sum a.json`, { cwd: mapsDir, encoding: "utf8" }).split(" ")[0];
      // manifest.sha256 con DOS líneas para el MISMO fichero real: 1
      // fichero de verdad, 2 líneas de manifest.
      writeFileSync(join(dir, "manifest.sha256"), `${hash}  maps/a.json\n${hash}  maps/a.json\n`);
      // manifest.json declara maps.files=2 para que el chequeo de
      // "líneas vs manifest.json" (anterior en la cadena) NO dispare —
      // aísla el chequeo de residuales, que es el que de verdad debe
      // notar que sólo hay 1 fichero real por 2 líneas de manifest.
      // D3 (#112, aplicado): esta fixture no incluye un pg_dump real (no
      // hay pgdump-*.dump en el árbol ni línea suya en manifest.sha256),
      // así que postgres se declara 'error' (sin campo "files", igual que
      // el backup.sh real cuando pg_dump falla) para que el nuevo bucle de
      // `expected_lines` de restore.sh (que desde D3 también cuenta
      // 'postgres' cuando está 'ok') no sume una entrada inexistente y
      // dispare el chequeo de líneas ANTES de llegar al de residuales que
      // este test quiere aislar.
      writeFileSync(
        join(dir, "manifest.json"),
        '{"postgres":{"status":"error"},"secrets":{"status":"ok","files":2},"maps":{"status":"ok","files":2},"bot_sources":{"status":"empty","files":0},"replays":{"status":"empty","files":0},"assets":{"status":"empty","files":0}}',
      );
      let threw = false;
      let output = "";
      try {
        output = execFileSync("bash", [RESTORE, "--verify", dir], { encoding: "utf8", stdio: "pipe" });
      } catch (e: any) {
        threw = true;
        output = `${e.stdout}${e.stderr}`;
      }
      expect(threw).toBe(true); // NUNCA exit 0 con una entrada duplicada sin explicar
      expect(output).toContain("SIN entrada en el manifest");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── D3-R4 (ronda 5, hallazgo del supervisor): el saneado de UTF-8
  // inválido (`iconv -c`) es la única pieza de json_escape de la ronda 4
  // sin ningún test — quitarlo rompe el parseo con un byte inválido como
  // 0xff. Dos precauciones de método, ambas descubiertas verificando la
  // mutación real antes de dar el test por bueno (no dando por sentado que
  // "existe un test" basta):
  //   1. `runLogFromScriptRawBytes` (no `runLogFromScript`): pasar "\xff"
  //      como cadena JS por argv se reencuentra a UTF-8 válido (dos bytes,
  //      el carácter U+00FF), no el byte crudo inválido.
  //   2. Capturar la salida como BUFFER (`encoding` sin especificar) y
  //      decodificarla con `TextDecoder({ fatal: true })`, no con
  //      `JSON.parse` sobre una cadena que Node ya decodificó como utf8:
  //      `execFileSync(..., { encoding: "utf8" })` reemplaza en silencio
  //      cualquier byte inválido por U+FFFD ANTES de que el test lo vea —
  //      la mutación (quitar iconv) no fallaba con ese método, igual que
  //      D2-R3a no fallaba pasando el payload por un nombre de fichero que
  //      `find` ya citaba. `TextDecoder` con `fatal: true` simula un
  //      consumidor estricto de verdad (equivalente a `json.loads(strict=
  //      True)` en Python, que es el que motivó este hallazgo). ─────────
  it("byte UTF-8 inválido (0xff) en el mensaje no rompe el parseo del log (D3-R4)", () => {
    const out = runLogFromScriptRawBytes(BACKUP, "fuente ilegible: nombre-", 0xff, "-invalido");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "";
    expect(() => {
      text = decoder.decode(out).trim();
    }).not.toThrow();
    expect(() => JSON.parse(text)).not.toThrow();
    expect(JSON.parse(text).level).toBe("error");
  });

  // ── D3-R5 (ronda 6, hallazgo del supervisor — misma familia que D2-R3a/
  // D4-R3c): restore.sh tiene su PROPIA copia de json_escape (no comparte
  // código con backup.sh), y el test de iconv de arriba sólo apuntaba a
  // BACKUP. Quitar `iconv` de restore.sh dejaba la suite en verde con el
  // bug puesto: no es equivalente probar sólo un script cuando los dos
  // tienen la misma función duplicada. Mismo test, apuntando a RESTORE. ──
  it("byte UTF-8 inválido (0xff) en restore.sh no rompe el parseo del log (D3-R5)", () => {
    const out = runLogFromScriptRawBytes(RESTORE, "fuente ilegible: nombre-", 0xff, "-invalido");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "";
    expect(() => {
      text = decoder.decode(out).trim();
    }).not.toThrow();
    expect(() => JSON.parse(text)).not.toThrow();
    expect(JSON.parse(text).level).toBe("error");
  });

  // ── Mutación M2 (obligatoria, coordinador): "el manifest apunta a una
  // ruta incorrecta → --verify falla". Se reintroduce EXACTAMENTE el
  // defecto real de #112 (manifest escrito en $WORK_DIR en vez de dentro
  // del $STAGING que sube restic) sobre una COPIA de backup.sh, ejecutando
  // la cadena completa igual que en el test de arriba, para demostrar con
  // salida real que sin el fix la cadena E2E falla. ──────────────────────
  it("mutación M2: manifest fuera del staging (bug original de #112) → --verify falla en la cadena real", () => {
    setup();
    const log = join(root, "restic-calls.log");
    writeFakeResticFaithful(fakebin, store, log);

    const original = readFileSync(BACKUP, "utf8");
    const mutated = original
      .replace('> "$STAGING/manifest.sha256"', '> "$WORK_DIR/manifest.sha256"')
      .replace('} > "$STAGING/manifest.json"', '} > "$WORK_DIR/manifest.json"');
    expect(mutated).not.toBe(original); // la sustitución realmente se aplicó
    const mutantPath = join(root, "backup-mutant-M2.sh");
    writeFileSync(mutantPath, mutated, { mode: 0o755 });

    // D1-R3 (ronda 4) endureció backup.sh: ahora comprueba que el número de
    // líneas de manifest.sha256 coincide con los ficheros 'ok' esperados.
    // Con el manifest desviado fuera del staging, esa comprobación falla
    // en el propio backup.sh — detección MÁS temprana que antes (antes
    // sólo se cazaba en restore.sh --verify; ahora ni siquiera llega a
    // subirse a restic un staging con un manifest incompleto).
    let backupThrew = false;
    let backupOut = "";
    try {
      backupOut = execFileSync("bash", [mutantPath], { encoding: "utf8", env: backupEnv() });
    } catch (e: any) {
      backupThrew = true;
      backupOut = `${e.stdout}${e.stderr}`;
    }
    expect(backupThrew).toBe(true);
    expect(backupOut).toContain("FULL FAILURE");
    expect(backupOut).not.toContain("backup SUCCESS");
  });
});

// ── Punto 5 del coordinador: docs/recuperacion.md desincronizado con el
// script real (nombres viejos, bucle sin assets). Test de regresión sobre
// el runbook en sí, para que una futura reescritura de backup.sh no lo
// desincronice otra vez en silencio. ────────────────────────────────────
describe("docs/recuperacion.md sincronizado con backup.sh/restore.sh (#110b)", () => {
  const runbook = readFileSync(join(REPO_ROOT, "docs", "recuperacion.md"), "utf8");

  it("no referencia el nombre obsoleto 'replays-official' (el alcance de replays ya no se limita a official/)", () => {
    expect(runbook).not.toContain("replays-official");
  });

  it("el bucle de restauración de volúmenes incluye 'assets' (backup.sh lo captura desde #110b)", () => {
    expect(runbook).toMatch(/for name in maps bot_sources replays assets/);
    expect(runbook).toContain("arena_assets");
  });

  it("localiza el staging real vía manifest.sha256, no una ruta fija a mano", () => {
    expect(runbook).toContain("find /tmp/restore-data -name manifest.sha256");
  });
});

describe("restore.sh --verify: manifest ambiguo o ausente (OBS-1 / M4)", () => {
  // M4 (supervisor): el test anterior sólo comprobaba "lanza excepción",
  // que también sería cierto si el guard de "0 manifests" se borrara y el
  // fallo viniera de `sha256sum -c ""` por otro motivo. Aquí se comprueba
  // el MENSAJE concreto que sólo emite el guard explícito.
  it("cero manifests: falla con 'no encontrado', no con un error genérico de sha256sum", () => {
    const dir = mkdtempSync(join(tmpdir(), "e10-restore-none-"));
    try {
      writeFileSync(join(dir, "not-a-manifest.sha256.bak"), "deadbeef  maps/x.json\n");
      let threw = false;
      let output = "";
      try {
        output = execFileSync("bash", [RESTORE, "--verify", dir], { encoding: "utf8", stdio: "pipe" });
      } catch (e: any) {
        threw = true;
        output = `${e.stdout}${e.stderr}`;
      }
      expect(threw).toBe(true);
      expect(output).toContain("no encontrado");
      expect(output).not.toContain("sha256sum: WARNING");
      expect(output).not.toContain("no properly formatted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dos manifests en el mismo directorio: falla (ambiguo) en lugar de elegir uno arbitrario", () => {
    const dir = mkdtempSync(join(tmpdir(), "e10-restore-dup-"));
    try {
      mkdirSync(join(dir, "snap-a"), { recursive: true });
      mkdirSync(join(dir, "snap-b"), { recursive: true });
      writeFileSync(join(dir, "snap-a", "manifest.sha256"), "");
      writeFileSync(join(dir, "snap-b", "manifest.sha256"), "");
      let threw = false;
      let output = "";
      try {
        output = execFileSync("bash", [RESTORE, "--verify", dir], { encoding: "utf8", stdio: "pipe" });
      } catch (e: any) {
        threw = true;
        output = `${e.stdout}${e.stderr}`;
      }
      expect(threw).toBe(true);
      expect(output).toContain("ambiguo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("servicio backup en el Compose", () => {
  const doc = parse(readFileSync(join(here, "..", "docker-compose.yml"), "utf8"), { merge: true });
  const svc = doc.services.backup;

  it("corre en producción (también con BD externa), con cron y métricas para la alerta de 26 h", () => {
    expect(svc.profiles.sort()).toEqual(["external-db", "production"]);
    expect(JSON.stringify(svc.environment)).toContain("BACKUP_CRON");
    expect(svc.volumes).toContain("backup_metrics:/textfile");
  });

  it("monta los volúmenes de datos SOLO en lectura y los secretos por archivo", () => {
    for (const v of [
      "arena_maps:/data/maps:ro",
      "arena_bot_sources:/data/bot-sources:ro",
      "arena_replays:/data/replays:ro",
      "arena_assets:/data/assets:ro",
      "./secrets:/secrets:ro",
    ]) {
      expect(svc.volumes).toContain(v);
    }
    expect(svc.secrets).toContain("restic_password");
    expect(svc.environment.RESTIC_PASSWORD_FILE).toBe("/run/secrets/restic_password");
  });

  // fix/backup-sftp-scheduled-runtime: la clave SSH y el known_hosts del
  // backend sftp: montados como secretos por archivo (nunca en claro), igual
  // que el resto — ver infrastructure/tests/backup-sftp-e2e.test.ts para la
  // demostración de que de verdad funcionan dentro de la imagen real.
  it("monta la clave SSH y el known_hosts del backend sftp como secretos por archivo", () => {
    expect(svc.secrets).toContain("restic_ssh_key");
    expect(svc.secrets).toContain("restic_ssh_known_hosts");
    expect(svc.environment.RESTIC_SSH_KEY_FILE).toBe("/run/secrets/restic_ssh_key");
    expect(svc.environment.RESTIC_SSH_KNOWN_HOSTS_FILE).toBe("/run/secrets/restic_ssh_known_hosts");
    expect(doc.secrets.restic_ssh_key.file).toBe("./secrets/restic_ssh_key");
    expect(doc.secrets.restic_ssh_known_hosts.file).toBe("./secrets/restic_ssh_known_hosts");
  });

  // Punto 7 (no bloqueante, mitigado): WORK_DIR del staging en un volumen
  // dedicado, no en la capa de escritura del contenedor.
  it("monta un volumen dedicado para el staging temporal (WORK_DIR), no la capa de escritura del contenedor", () => {
    expect(svc.volumes).toContain("backup_work:/tmp/backup-work");
    expect(doc.volumes).toHaveProperty("backup_work");
  });
});

// ── --init-repo ────────────────────────────────────────────────────────────
// El repositorio de producción se creó A MANO y ese paso no estaba ni en el
// código ni en las pruebas: el E2E de SFTP le pedía a backup.sh que
// escribiera en un repositorio inexistente y restic contestaba "unable to
// open config file / Is there a repository at ...". Estas pruebas fijan las
// tres propiedades que hacen seguro el modo: no inicializa con configuración
// incompleta, crea el repo cuando falta, y NO lo toca cuando ya existe. La
// tercera es la que importa de verdad: si `restic backup` inicializase solo
// al no encontrar repositorio, una errata en RESTIC_REPOSITORY crearía un
// repositorio vacío, el backup "tendría éxito", el histórico real quedaría
// huérfano en la ruta correcta y además se apagaría la alerta.
describe("backup.sh --init-repo", () => {
  function runInitRepo(env: Record<string, string>, fakebin: string) {
    try {
      const out = execFileSync(BASH_BIN, [BACKUP, "--init-repo"], {
        encoding: "utf8",
        env: { ...process.env, ...env, PATH: `${fakebin}:${process.env.PATH}` },
      });
      return { code: 0, out };
    } catch (e: any) {
      return { code: e.status as number, out: `${e.stdout}${e.stderr}` };
    }
  }

  // restic falso que registra cada invocación y cuya respuesta a
  // `cat config` (la comprobación de existencia) se controla con un fichero.
  function writeFakeResticInit(fakebin: string, log: string, repoExistsMarker: string) {
    writeFileSync(
      join(fakebin, "restic"),
      `#!/usr/bin/env bash\necho "$@" >> "${log}"\ncase "$1" in\n  cat) [ -f "${repoExistsMarker}" ] && exit 0 || exit 1 ;;\n  init) touch "${repoExistsMarker}"; exit 0 ;;\nesac\nexit 0\n`,
      { mode: 0o755 },
    );
  }

  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "e10-init-"));
    const fakebin = join(dir, "bin");
    mkdirSync(fakebin);
    const log = join(dir, "restic.log");
    const marker = join(dir, "repo-existe");
    writeFakeResticInit(fakebin, log, marker);
    writeFileSync(join(dir, "restic_password.txt"), SECRET_VALUE, { mode: 0o600 });
    return { dir, fakebin, log, marker, pwd: join(dir, "restic_password.txt") };
  }

  it("con configuración incompleta: exit 1 y NO invoca restic siquiera", () => {
    const f = fixture();
    // Sin RESTIC_REPOSITORY: justo el estado de bootstrap del día 1.
    const { code, out } = runInitRepo({ RESTIC_REPOSITORY: "", RESTIC_PASSWORD_FILE: f.pwd }, f.fakebin);
    expect(code).toBe(1);
    expect(out).toContain("configuración incompleta");
    expect(existsSync(f.log)).toBe(false);
    rmSync(f.dir, { recursive: true, force: true });
  });

  it("si el repositorio no existe: lo crea", () => {
    const f = fixture();
    const { code, out } = runInitRepo(
      { RESTIC_REPOSITORY: join(f.dir, "repo"), RESTIC_PASSWORD_FILE: f.pwd },
      f.fakebin,
    );
    expect(code).toBe(0);
    expect(out).toContain("repositorio creado");
    expect(readFileSync(f.log, "utf8")).toContain("init");
    rmSync(f.dir, { recursive: true, force: true });
  });

  it("si el repositorio YA existe: no lo vuelve a inicializar (idempotente)", () => {
    const f = fixture();
    writeFileSync(f.marker, "");
    const { code, out } = runInitRepo(
      { RESTIC_REPOSITORY: join(f.dir, "repo"), RESTIC_PASSWORD_FILE: f.pwd },
      f.fakebin,
    );
    expect(code).toBe(0);
    expect(out).toContain("ya existe");
    // La distinción que importa: consultó, pero NO inicializó.
    const invocaciones = readFileSync(f.log, "utf8");
    expect(invocaciones).toContain("cat config");
    expect(invocaciones).not.toContain("init");
    rmSync(f.dir, { recursive: true, force: true });
  });
});
