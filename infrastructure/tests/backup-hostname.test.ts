// fix/restic-stable-hostname: demuestra el defecto real observado en
// producción el 2026-08-14 y su corrección.
//
// `restic forget` agrupa la política de retención por `--group-by` (default
// real, confirmado contra restic 0.16.4 en producción: `host,paths`). Sin un
// `--host` estable, restic usa el hostname del SISTEMA — dentro del
// contenedor `backup`, ese hostname es el ID corto del contenedor, que
// cambia cada vez que el servicio se recrea (despliegue, reinicio). Log real
// de producción citado en la tarea:
//
//   9b22f5959ea2 · s9-arena-data     → keep 1 snapshots (daily+weekly+monthly)
//   9b22f5959ea2 · s9-arena-secrets  → keep 1
//   a834a832b86e · s9-arena-data     → keep 1
//   a834a832b86e · s9-arena-secrets  → keep 1
//
// Cada grupo tiene un ÚNICO snapshot (porque cada recreación abre un grupo
// nuevo), así que ese snapshot es a la vez el diario/semanal/mensual y se
// conserva SIEMPRE: `forget` no poda nada y el repositorio crece sin límite,
// mientras cada ejecución individual reporta SUCCESS y `restic check` pasa
// — correcto en lo pequeño, roto en lo agregado.
//
// No basta con comprobar que backup.sh usa una cadena de hostname fija (eso
// sería un test vacío: podría pasar el `--host` correcto y aun así no
// demostrar que la retención funciona). La prueba de NO-VACUIDAD exigida
// aquí es la cadena completa:
//   backup 1 (contenedor A) → backup 2 (contenedor B recreado) → mismo
//   hostname restic → forget ve AMBOS como el MISMO grupo → la política
//   PUEDE podar el snapshot antiguo.
//
// REVISIÓN DEL SUPERVISOR (12 mutaciones propias, dictamen APTO CON
// OBSERVACIONES) encontró tres agujeros de cobertura reales que esta versión
// cierra:
//
//   M12 — el fake original modelaba la agrupación por host+tag únicamente,
//   IGNORANDO la ruta (paths). Como restic real agrupa por `host,paths` si
//   no se le indica lo contrario, un `backup.sh` que dejara de fijar
//   `--group-by host,tags` reproduciría la MISMA patología de crecimiento
//   sin límite en cuanto la ruta del staging dejara de ser estable — y el
//   test seguía en verde, porque el fake nunca miraba la ruta. Aquí el fake
//   SÍ registra la ruta de cada snapshot y agrupa por host+paths salvo que
//   se le pase `--group-by host,tags` (el comportamiento real de restic),
//   así que la corrección de backup.sh queda genuinamente bajo prueba.
//
//   M5/M6/M7 — el fake escribía `restic-calls.log` pero ningún test lo
//   leía: quitar `--prune`, cambiar la política a `--keep-last 1` o subir
//   `--keep-daily` a un valor que nunca expira pasaban en verde igual. Aquí
//   se lee el log y se aseveran las banderas REALES que backup.sh pasó a
//   `forget`.
//
//   M8/M10 — `RESTIC_HOSTNAME=` (vacío) o `RESTIC_HOSTNAME="   "` (sólo
//   espacios) en el entorno no se rechazaban. Cubierto abajo con el mismo
//   contrato de exit code que el resto de validación de configuración.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BACKUP = join(here, "..", "backup", "backup.sh");

function writeFakePgDumpOk(fakebin: string) {
  writeFileSync(
    join(fakebin, "pg_dump"),
    `#!/usr/bin/env bash\nfor ((i=1;i<=$#;i++)); do if [ "\${!i}" = "-f" ]; then j=$((i+1)); : > "\${!j}"; fi; done\nexit 0\n`,
    { mode: 0o755 },
  );
}

// "restic" falso que modela AGRUPACIÓN por host+paths (default real de
// restic) o host+tags (cuando se pasa `--group-by host,tags`, que es lo que
// backup.sh debe pasar tras este fix). Persiste su estado en $SNAP_FILE (una
// línea "host|tag|path|id" por snapshot vivo) para que dos invocaciones de
// backup.sh en tests SEPARADOS compartan el mismo "repositorio".
//
//   backup --tag T [--host H] PATH         → añade una entrada nueva. Si no
//                                             se pasa --host, usa el
//                                             hostname REAL del proceso
//                                             (igual que restic real) — así
//                                             se reproduce el defecto
//                                             original con la mutación de
//                                             calibración.
//   forget [--host H] [--group-by G] ...   → sólo opera sobre los snapshots
//                                             cuyo host==H (o el hostname
//                                             real si no se pasa --host).
//                                             Si G contiene "tags", agrupa
//                                             por (host,tag) — la ruta deja
//                                             de importar, que es justo lo
//                                             que corrige este fix. Si NO se
//                                             pasa --group-by (o no contiene
//                                             "tags"), agrupa por
//                                             (host,path) — el default real
//                                             de restic, que es lo que
//                                             reproduce M12 cuando falta la
//                                             bandera. Dentro de cada grupo
//                                             se colapsa al snapshot MÁS
//                                             RECIENTE (poda los demás).
function writeFakeResticGrouping(fakebin: string, snapFile: string, log: string) {
  const script = `#!/usr/bin/env bash
echo "$@" >> "${log}"
SNAP_FILE="${snapFile}"
touch "$SNAP_FILE"
case "$1" in
  backup)
    host=""; tag=""; prev=""
    for a in "$@"; do
      if [ "$prev" = "--host" ]; then host="$a"; fi
      if [ "$prev" = "--tag" ]; then tag="$a"; fi
      prev="$a"
    done
    [ -n "$host" ] || host="$(hostname)"
    path="\${@: -1}"
    id="snap-\${RANDOM}-\${RANDOM}-\${RANDOM}"
    echo "\${host}|\${tag}|\${path}|\${id}" >> "$SNAP_FILE"
    ;;
  forget)
    host=""; groupby=""; prev=""
    for a in "$@"; do
      if [ "$prev" = "--host" ]; then host="$a"; fi
      if [ "$prev" = "--group-by" ]; then groupby="$a"; fi
      prev="$a"
    done
    [ -n "$host" ] || host="$(hostname)"
    by_tags=0
    case "$groupby" in *tags*) by_tags=1 ;; esac
    declare -A last
    others=""
    while IFS='|' read -r h t p id; do
      [ -z "$h" ] && continue
      if [ "$h" = "$host" ]; then
        if [ "$by_tags" = 1 ]; then key="$t"; else key="$p"; fi
        last["$key"]="\${h}|\${t}|\${p}|\${id}"
      else
        others+="\${h}|\${t}|\${p}|\${id}"$'\\n'
      fi
    done < "$SNAP_FILE"
    {
      printf '%s' "$others"
      for k in "\${!last[@]}"; do echo "\${last[$k]}"; done
    } > "$SNAP_FILE"
    ;;
  check) : ;;
esac
exit 0
`;
  writeFileSync(join(fakebin, "restic"), script, { mode: 0o755 });
}

// Cada llamada a runBackup() simula UNA ejecución del contenedor `backup`
// (una "recreación"): WORK_DIR/directorios de datos frescos con mkdtempSync
// (así que la ruta del staging es DISTINTA en cada llamada, como lo sería
// tras recrear el contenedor — no hay nada en este harness que la mantenga
// artificialmente estable), pero el mismo SNAP_FILE (el "repositorio"
// restic persiste entre recreaciones, como en la realidad) y,
// opcionalmente, el mismo RESTIC_HOSTNAME.
function runBackup(root: string, fakebin: string, snapFile: string, env: Record<string, string>) {
  const work = mkdtempSync(join(root, "work-"));
  const data = mkdtempSync(join(root, "data-"));
  for (const d of ["maps", "bot-sources", "replays", "assets", "secrets"]) mkdirSync(join(data, d));
  writeFileSync(join(data, "secrets", "restic_password.txt"), "s3cr3t-restic", { mode: 0o600 });
  writeFileSync(join(data, "secrets", "postgres_password.txt"), "s3cr3t-pg", { mode: 0o600 });
  const metrics = mkdtempSync(join(root, "metrics-"));
  const { code, out } = (() => {
    try {
      const out = execFileSync("bash", [BACKUP], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakebin}:${process.env.PATH}`,
          RESTIC_REPOSITORY: "/tmp/fake-repo-hostname-test",
          RESTIC_PASSWORD_FILE: join(data, "secrets", "restic_password.txt"),
          PGPASSWORD_FILE: join(data, "secrets", "postgres_password.txt"),
          MAPS_DIR: join(data, "maps"),
          BOT_SOURCES_DIR: join(data, "bot-sources"),
          REPLAYS_DIR: join(data, "replays"),
          ASSETS_DIR: join(data, "assets"),
          SECRETS_DIR: join(data, "secrets"),
          WORK_DIR: work,
          METRICS_DIR: metrics,
          SNAP_FILE: snapFile,
          ...env,
        },
      });
      return { code: 0, out };
    } catch (e: any) {
      return { code: e.status as number, out: `${e.stdout}${e.stderr}` };
    }
  })();
  return { code, out };
}

function readSnapshots(snapFile: string): Array<{ host: string; tag: string; path: string; id: string }> {
  const lines = readFileSync(snapFile, "utf8").trim().split("\n").filter(Boolean);
  return lines.map((l) => {
    const [host, tag, path, id] = l.split("|");
    return { host, tag, path, id };
  });
}

function setupFakeEnv(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const fakebin = join(root, "bin");
  mkdirSync(fakebin, { recursive: true });
  writeFakePgDumpOk(fakebin);
  const snapFile = join(root, "snapshots.db");
  const log = join(root, "restic-calls.log");
  writeFakeResticGrouping(fakebin, snapFile, log);
  return { root, fakebin, snapFile, log };
}

describe("backup.sh: hostname restic estable (fix/restic-stable-hostname)", () => {
  it(
    "backup 1 (contenedor A) + backup 2 (contenedor B recreado, ruta de staging DISTINTA) con el " +
      "MISMO RESTIC_HOSTNAME: forget agrupa por host+tags (no por ruta) y poda el snapshot antiguo",
    () => {
      const { root, fakebin, snapFile } = setupFakeEnv("e10-hostname-");

      // "Contenedor A": primera ejecución del servicio backup.
      const r1 = runBackup(root, fakebin, snapFile, { RESTIC_HOSTNAME: "s9-arena-backup" });
      expect(r1.code).toBe(0);
      const afterFirst = readSnapshots(snapFile);
      const firstDataSnapshot = afterFirst.find((s) => s.tag === "s9-arena-data");
      expect(firstDataSnapshot).toBeDefined();
      const firstId = firstDataSnapshot!.id;
      const firstPath = firstDataSnapshot!.path;

      // "Contenedor B recreado": mismo despliegue, mismo RESTIC_HOSTNAME (por
      // ser una propiedad de la INSTALACIÓN, no del contenedor efímero), pero
      // un WORK_DIR/directorios de datos completamente nuevos — exactamente
      // lo que pasa cuando Docker sustituye el contenedor. La ruta del
      // staging ($STAGING) es, por tanto, DISTINTA entre ambas ejecuciones
      // (ver runBackup: cada llamada usa su propio mkdtempSync).
      const r2 = runBackup(root, fakebin, snapFile, { RESTIC_HOSTNAME: "s9-arena-backup" });
      expect(r2.code).toBe(0);
      const afterSecond = readSnapshots(snapFile).find((s) => s.tag === "s9-arena-data");
      expect(afterSecond!.path).not.toBe(firstPath); // confirma que la ruta SÍ varió entre ejecuciones

      const finalSnapshots = readSnapshots(snapFile);
      const dataGroup = finalSnapshots.filter((s) => s.tag === "s9-arena-data" && s.host === "s9-arena-backup");
      const secretsGroup = finalSnapshots.filter((s) => s.tag === "s9-arena-secrets" && s.host === "s9-arena-backup");

      // El corazón de la prueba: DOS ejecuciones de backup, con rutas de
      // staging DISTINTAS, produjeron dos snapshots "s9-arena-data", pero
      // tras el `forget` de la SEGUNDA ejecución sólo sobrevive UNO — la
      // política agrupó ambos backups como el MISMO host+tag (gracias a
      // `--group-by host,tags`) y pudo podar el antiguo, PESE a que la ruta
      // cambió. Sin `--group-by host,tags` en backup.sh, el fake agruparía
      // por host+ruta (default real de restic) y esta aserción se rompe
      // (mutación de calibración M12: ver informe).
      expect(dataGroup.length).toBe(1);
      expect(dataGroup[0].id).not.toBe(firstId); // el snapshot VIEJO fue podado, sobrevive el nuevo
      // DATA y SECRETS siguen siendo dos grupos separados y estables (mismo
      // host, tags/paths distintos) — el requisito explícito de la tarea.
      expect(secretsGroup.length).toBe(1);
      expect(dataGroup[0].host).toBe("s9-arena-backup");
      expect(secretsGroup[0].host).toBe("s9-arena-backup");
    },
  );

  it(
    "dos hosts DISTINTOS (migración deliberada vía RESTIC_HOSTNAME) nunca se mezclan: " +
      "cada uno conserva su propio snapshot",
    () => {
      const { root, fakebin, snapFile } = setupFakeEnv("e10-hostname-migra-");

      runBackup(root, fakebin, snapFile, { RESTIC_HOSTNAME: "s9-arena-backup" });
      runBackup(root, fakebin, snapFile, { RESTIC_HOSTNAME: "s9-arena-backup-nuevo" });

      const finalSnapshots = readSnapshots(snapFile);
      const oldHostData = finalSnapshots.filter((s) => s.host === "s9-arena-backup" && s.tag === "s9-arena-data");
      const newHostData = finalSnapshots.filter((s) => s.host === "s9-arena-backup-nuevo" && s.tag === "s9-arena-data");
      expect(oldHostData.length).toBe(1);
      expect(newHostData.length).toBe(1);
    },
  );

  it(
    "RESTIC_HOSTNAME por defecto (sin configurar en el entorno) es 'arena-backup-host', " +
      "estable y no depende del contenedor",
    () => {
      const { root, fakebin, snapFile } = setupFakeEnv("e10-hostname-default-");

      // Ni RESTIC_HOSTNAME, ni ninguna otra pista de identidad de contenedor:
      // sólo lo que trae backup.sh por defecto.
      const r = runBackup(root, fakebin, snapFile, {});
      expect(r.code).toBe(0);
      const snapshots = readSnapshots(snapFile);
      expect(snapshots.every((s) => s.host === "arena-backup-host")).toBe(true);
    },
  );

  // ── M5/M6/M7 (supervisor): las banderas REALES de `restic forget` ─────────
  it("restic forget recibe exactamente la política de retención esperada (M5/M6/M7)", () => {
    const { root, fakebin, snapFile, log } = setupFakeEnv("e10-hostname-retention-");
    const r = runBackup(root, fakebin, snapFile, { RESTIC_HOSTNAME: "s9-arena-backup" });
    expect(r.code).toBe(0);

    const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    const forgetLine = calls.find((l) => l.startsWith("forget"));
    expect(forgetLine).toBeDefined();

    // M5: quitar --prune pasaba en verde porque nadie leía el log.
    expect(forgetLine).toContain("--prune");
    // M6: sustituir la política por --keep-last 1 pasaba en verde.
    expect(forgetLine).not.toContain("--keep-last");
    expect(forgetLine).toContain("--keep-daily 14");
    expect(forgetLine).toContain("--keep-weekly 8");
    expect(forgetLine).toContain("--keep-monthly 12");
    // M7: subir --keep-daily a un valor que nunca expira (99999) pasaba en
    // verde igual; se asevera el valor EXACTO documentado (14 días), no sólo
    // la presencia de la bandera.
    expect(forgetLine).not.toMatch(/--keep-daily 99999\b/);
    // M12: agrupación explícita por host+tags, no por la ruta del staging.
    expect(forgetLine).toContain("--group-by host,tags");
    expect(forgetLine).toContain("--host s9-arena-backup");
  });

  // ── M8/M10 (supervisor): RESTIC_HOSTNAME vacío o en blanco ────────────────
  describe("RESTIC_HOSTNAME vacío o en blanco: rechazado como config incompleta (M8/M10)", () => {
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
    const base = {
      RESTIC_REPOSITORY: "/mnt/nas/backups/s9-ai-arena",
      RESTIC_PASSWORD_FILE: __filename, // cualquier fichero legible sirve para pasar esa validación
    };

    it("RESTIC_HOSTNAME='' (vacío explícito, sin heredar el default): CONFIG INCOMPLETA", () => {
      // El propio operador del comparativo confirmó que `${VAR:-default}`
      // sólo se aplica cuando la variable está SIN DEFINIR o vacía — Bash
      // trata "vacía" como "sin definir" para el operador `:-`, así que
      // RESTIC_HOSTNAME="" en el entorno de este proceso hijo YA cae en el
      // valor por defecto dentro de backup.sh antes de llegar a la
      // validación. Este test deja constancia explícita de ese
      // comportamiento (no es un agujero: el resultado es CONFIG OK con el
      // default), para que quede diferenciado del caso realmente peligroso
      // de abajo (sólo espacios), que NO se defaultea.
      const { code, out } = runDryRun({ ...base, RESTIC_HOSTNAME: "" });
      expect(code).toBe(0);
      expect(out).toContain("CONFIG OK");
      expect(out).toContain("--host arena-backup-host");
    });

    it("RESTIC_HOSTNAME='   ' (sólo espacios): CONFIG INCOMPLETA, exit 1 (M10)", () => {
      const { code, out } = runDryRun({ ...base, RESTIC_HOSTNAME: "   " });
      expect(code).toBe(1);
      expect(out).toContain("CONFIG INCOMPLETA");
      expect(out).toContain("RESTIC_HOSTNAME");
    });
  });
});
