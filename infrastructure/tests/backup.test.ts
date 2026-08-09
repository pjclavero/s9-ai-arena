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
const SECRET_VALUE = "valor-secreto-que-jamas-debe-aparecer-en-logs";

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "e10-backup-"));
  writeFileSync(join(tmp, "restic_password.txt"), SECRET_VALUE, { mode: 0o600 });
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function runDryRun(env: Record<string, string>) {
  try {
    const out = execFileSync("bash", [BACKUP, "--dry-run"], {
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
  it("cadena completa con las CUATRO fuentes no críticas vacías: --verify pasa (D1, estado real de VM108)", () => {
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

    // El manifest.sha256 restaurado debe existir y estar vacío (cobertura
    // 'empty' declarada, no ausente ni corrupto).
    const manifestPath = execSync(`find "${dest}" -name manifest.sha256`, { encoding: "utf8" }).trim();
    expect(manifestPath).not.toBe("");
    expect(readFileSync(manifestPath, "utf8")).toBe("");

    // Antes de D1 esto lanzaba: sha256sum: manifest.sha256: no properly
    // formatted checksum lines found / exit 1, sobre un backup sano.
    const verifyOut = execFileSync("bash", [RESTORE, "--verify", dest], { encoding: "utf8" });
    expect(verifyOut).toContain("vacío");
    expect(verifyOut).toContain("integridad verificada");
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

    const backupOut = execFileSync("bash", [mutantPath], { encoding: "utf8", env: backupEnv() });
    // El backup "en sí" puede seguir reportando SUCCESS (restic no sabe que
    // le faltan los manifests), pero la integridad restaurada está rota:
    expect(backupOut).toContain("backup SUCCESS");

    const dest = join(root, "restored-mutant");
    execFileSync("bash", [RESTORE, "--restore", dest], { encoding: "utf8", env: backupEnv() });
    // Sin manifest dentro del staging subido a restic, no hay nada que
    // verificar: --verify debe fallar (0 manifests), no colar en silencio.
    expect(() => execFileSync("bash", [RESTORE, "--verify", dest], { stdio: "pipe" })).toThrow();
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

  // Punto 7 (no bloqueante, mitigado): WORK_DIR del staging en un volumen
  // dedicado, no en la capa de escritura del contenedor.
  it("monta un volumen dedicado para el staging temporal (WORK_DIR), no la capa de escritura del contenedor", () => {
    expect(svc.volumes).toContain("backup_work:/tmp/backup-work");
    expect(doc.volumes).toHaveProperty("backup_work");
  });
});
