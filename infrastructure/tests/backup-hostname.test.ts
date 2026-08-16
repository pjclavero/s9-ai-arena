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
// REVISIÓN DEL SUPERVISOR, RONDA 1 (12 mutaciones propias, APTO CON
// OBSERVACIONES) — cerrado:
//   M12 — el fake original modelaba la agrupación por host+tag únicamente,
//   IGNORANDO la ruta (paths). Ahora el fake registra la ruta de cada
//   snapshot y agrupa por host+paths salvo que se le indique lo contrario,
//   igual que restic real.
//   M5/M6/M7 — el fake escribía `restic-calls.log` pero ningún test lo
//   leía: quitar `--prune`, cambiar la política a `--keep-last 1` o subir
//   `--keep-daily` a un valor que nunca expira pasaban en verde. Cubierto
//   leyendo el log y aseverando las banderas reales.
//   M8/M10 — RESTIC_HOSTNAME vacío o en blanco no se rechazaba. Cubierto.
//
// REVISIÓN DEL SUPERVISOR, RONDA 2 (sobre el fake de la ronda 1) — cerrado
// aquí:
//   H2 (el que pesa) — el parser del fake se quedaba con el ÚLTIMO --tag,
//   modelando un tag ESCALAR en vez de un CONJUNTO. Restic real agrupa por
//   el conjunto COMPLETO de tags cuando `--group-by` incluye "tags". Con un
//   tag inestable añadido (`--tag "run-$RANDOM" --tag s9-arena-data`), cada
//   ejecución sigue teniendo el tag "oficial" constante, pero el CONJUNTO de
//   tags de la instantánea varía — y ese conjunto variable es la clave de
//   agrupación real. El fake anterior no lo veía (se quedaba con
//   "s9-arena-data", el último) y el test seguía en verde: la misma
//   patología de producción, reabierta por otra puerta. Ahora el fake
//   registra el CONJUNTO ordenado de --tag de cada invocación (no sólo el
//   último) y agrupa por ese conjunto completo.
//
//   H2b — `--group-by` se evaluaba por SUBSTRING (`case "$groupby" in
//   *tags*)`), así que `--group-by host,paths,tags` (que REINTRODUCE la
//   dependencia de la ruta) pasaba el chequeo de "contiene tags" sin que el
//   fake reflejara que TAMBIÉN agrupa por ruta. Ahora el fake separa
//   `--group-by` en su lista real de campos (split por coma) y construye la
//   clave de agrupación combinando TODOS los campos presentes (paths y/o
//   tags), no sólo comprobando si "tags" aparece en algún sitio de la
//   cadena.
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

// "restic" falso que modela la semántica REAL de agrupación de restic:
//   - cada snapshot se registra con su host, el CONJUNTO COMPLETO y
//     ORDENADO de --tag pasados (unidos por "+"; ningún tag real de este
//     script contiene "+"), la ruta (último argumento posicional) y un id.
//   - `forget [--host H] [--group-by CAMPOS]` sólo opera sobre los
//     snapshots cuyo host==H (o el hostname real si no se pasa --host).
//     CAMPOS se separa por coma, como el --group-by real; la clave de
//     agrupación combina TODOS los campos presentes: si incluye "tags", el
//     conjunto completo de tags forma parte de la clave; si incluye
//     "paths", la ruta forma parte de la clave. Si no se pasa --group-by (o
//     no incluye ninguno de los dos), se usa "paths" (el default real de
//     restic una vez fijado el host). Dentro de cada grupo se colapsa al
//     snapshot MÁS RECIENTE (poda los demás).
// Persiste su estado en $SNAP_FILE (una línea "host|tags|path|id" por
// snapshot vivo) para que dos invocaciones de backup.sh en tests SEPARADOS
// compartan el mismo "repositorio".
function writeFakeResticGrouping(fakebin: string, snapFile: string, log: string) {
  const script = `#!/usr/bin/env bash
echo "$@" >> "${log}"
SNAP_FILE="${snapFile}"
touch "$SNAP_FILE"
case "$1" in
  backup)
    host=""; tags=""; prev=""
    for a in "$@"; do
      if [ "$prev" = "--host" ]; then host="$a"; fi
      if [ "$prev" = "--tag" ]; then
        if [ -z "$tags" ]; then tags="$a"; else tags="\${tags}+\${a}"; fi
      fi
      prev="$a"
    done
    [ -n "$host" ] || host="$(hostname)"
    path="\${@: -1}"
    id="snap-\${RANDOM}-\${RANDOM}-\${RANDOM}"
    echo "\${host}|\${tags}|\${path}|\${id}" >> "$SNAP_FILE"
    ;;
  forget)
    host=""; groupby=""; prev=""
    for a in "$@"; do
      if [ "$prev" = "--host" ]; then host="$a"; fi
      if [ "$prev" = "--group-by" ]; then groupby="$a"; fi
      prev="$a"
    done
    [ -n "$host" ] || host="$(hostname)"
    by_tags=0; by_paths=0
    IFS=',' read -ra fields <<< "$groupby"
    for f in "\${fields[@]}"; do
      case "$f" in
        tags) by_tags=1 ;;
        paths) by_paths=1 ;;
      esac
    done
    # Default real de restic una vez fijado --host: agrupa por paths si no
    # se especifica ningún campo reconocido.
    if [ "$by_tags" = 0 ] && [ "$by_paths" = 0 ]; then by_paths=1; fi
    declare -A last
    others=""
    while IFS='|' read -r h tg p id; do
      [ -z "$h" ] && continue
      if [ "$h" = "$host" ]; then
        key=""
        [ "$by_paths" = 1 ] && key="\${key}P:\${p}|"
        [ "$by_tags" = 1 ] && key="\${key}T:\${tg}|"
        last["$key"]="\${h}|\${tg}|\${p}|\${id}"
      else
        others+="\${h}|\${tg}|\${p}|\${id}"$'\\n'
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

function readSnapshots(snapFile: string): Array<{ host: string; tags: string; path: string; id: string }> {
  const lines = readFileSync(snapFile, "utf8").trim().split("\n").filter(Boolean);
  return lines.map((l) => {
    const [host, tags, path, id] = l.split("|");
    return { host, tags, path, id };
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

// Extrae de restic-calls.log las líneas "backup ..." con su CONJUNTO de
// --tag, en orden de aparición, para comparar entre ejecuciones.
function backupTagSets(log: string): string[][] {
  const lines = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  const sets: string[][] = [];
  for (const line of lines) {
    const parts = line.split(" ");
    if (parts[0] !== "backup") continue;
    const tags: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === "--tag") tags.push(parts[i + 1]);
    }
    sets.push(tags);
  }
  return sets;
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
      const firstDataSnapshot = afterFirst.find((s) => s.tags === "s9-arena-data");
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
      const afterSecond = readSnapshots(snapFile).find((s) => s.tags === "s9-arena-data");
      expect(afterSecond!.path).not.toBe(firstPath); // confirma que la ruta SÍ varió entre ejecuciones

      const finalSnapshots = readSnapshots(snapFile);
      const dataGroup = finalSnapshots.filter((s) => s.tags === "s9-arena-data" && s.host === "s9-arena-backup");
      const secretsGroup = finalSnapshots.filter((s) => s.tags === "s9-arena-secrets" && s.host === "s9-arena-backup");

      // El corazón de la prueba: DOS ejecuciones de backup, con rutas de
      // staging DISTINTAS, produjeron dos snapshots "s9-arena-data", pero
      // tras el `forget` de la SEGUNDA ejecución sólo sobrevive UNO — la
      // política agrupó ambos backups como el MISMO host+tags (gracias a
      // `--group-by host,tags`) y pudo podar el antiguo, PESE a que la ruta
      // cambió. Sin `--group-by host,tags` en backup.sh, el fake agruparía
      // por host+ruta (default real de restic) y esta aserción se rompe
      // (mutación de calibración M12).
      expect(dataGroup.length).toBe(1);
      expect(dataGroup[0].id).not.toBe(firstId); // el snapshot VIEJO fue podado, sobrevive el nuevo
      // DATA y SECRETS siguen siendo dos grupos separados y estables (mismo
      // host, tags/paths distintos) — el requisito explícito de la tarea.
      expect(secretsGroup.length).toBe(1);
      expect(dataGroup[0].host).toBe("s9-arena-backup");
      expect(secretsGroup[0].host).toBe("s9-arena-backup");

      // H2 (ronda 2 del supervisor): el CONJUNTO de tags pasado a `backup`
      // debe ser idéntico entre las dos ejecuciones — es la propiedad de la
      // que depende toda la defensa de arriba (restic agrupa por el
      // conjunto COMPLETO de tags, no por un tag escalar). Si backup.sh
      // añadiera un tag adicional no constante (p.ej. un identificador de
      // ejecución), esta aserción lo detecta directamente, sin depender de
      // que la mutación además rompa la poda.
      const sets = backupTagSets(join(root, "restic-calls.log"));
      // Cada ejecución hace 2 invocaciones de "backup" (data + secrets); se
      // compara la ejecución 1 contra la ejecución 2 por posición.
      expect(sets.length).toBe(4);
      expect(sets[0]).toEqual(sets[2]); // data: run1 vs run2, mismo conjunto de tags
      expect(sets[1]).toEqual(sets[3]); // secrets: run1 vs run2, mismo conjunto de tags
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
      const oldHostData = finalSnapshots.filter((s) => s.host === "s9-arena-backup" && s.tags === "s9-arena-data");
      const newHostData = finalSnapshots.filter(
        (s) => s.host === "s9-arena-backup-nuevo" && s.tags === "s9-arena-data",
      );
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

  // ── M5/M6/M7 (supervisor, ronda 1): las banderas REALES de `forget` ───────
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

  // ── H2/H2b (supervisor, ronda 2): agrupación por CONJUNTO de tags, no ─────
  // por substring de --group-by. Mutaciones propias del supervisor,
  // reproducidas literalmente como calibración.
  describe("agrupación por conjunto de tags, no por substring de --group-by (H2/H2b)", () => {
    it(
      'N2 — tag inestable además del oficial (--tag "run-$RANDOM" --tag s9-arena-data): ' +
        "el conjunto de tags varía entre ejecuciones y forget NO puede podar",
      () => {
        // Reproduce la mutación N2 del supervisor añadiendo un backend
        // `restic` falso adicional que se comporta EXACTAMENTE como
        // backup.sh lo invocaría si tuviera un tag extra no constante: se
        // simula pasando el tag inestable directamente al fake, sin tocar
        // backup.sh (backup.sh en su versión actual NO añade ese tag; esto
        // demuestra que EL TEST detectaría la regresión si backup.sh la
        // introdujera).
        const { root, fakebin, snapFile } = setupFakeEnv("e10-hostname-n2-");
        const work1 = mkdtempSync(join(root, "work-n2-"));
        // Invocación manual del fake restic simulando exactamente la
        // mutación N2: un --tag inestable ANTES del --tag oficial.
        execFileSync("bash", [
          join(fakebin, "restic"),
          "backup",
          "--tag",
          `run-${Math.floor(Math.random() * 1e9)}`,
          "--tag",
          "s9-arena-data",
          "--host",
          "s9-arena-backup",
          join(work1, "staging"),
        ]);
        const work2 = mkdtempSync(join(root, "work-n2-"));
        execFileSync("bash", [
          join(fakebin, "restic"),
          "backup",
          "--tag",
          `run-${Math.floor(Math.random() * 1e9)}`,
          "--tag",
          "s9-arena-data",
          "--host",
          "s9-arena-backup",
          join(work2, "staging"),
        ]);
        execFileSync("bash", [
          join(fakebin, "restic"),
          "forget",
          "--keep-daily",
          "14",
          "--keep-weekly",
          "8",
          "--keep-monthly",
          "12",
          "--prune",
          "--host",
          "s9-arena-backup",
          "--group-by",
          "host,tags",
        ]);
        const snapshots = readSnapshots(snapFile).filter((s) => s.host === "s9-arena-backup");
        // Con un tag inestable, cada ejecución abre su PROPIO grupo (mismo
        // patrón que el defecto original de producción, reabierto por otra
        // puerta): las DOS instantáneas sobreviven, forget no puede podar.
        expect(snapshots.length).toBe(2);
      },
    );

    it(
      "N3 — --group-by host,paths,tags (reintroduce la dependencia de la ruta): " +
        "con rutas de staging distintas, forget NO puede podar aunque los tags sean constantes",
      () => {
        const { root, fakebin, snapFile } = setupFakeEnv("e10-hostname-n3-");
        const work1 = mkdtempSync(join(root, "work-n3-"));
        execFileSync("bash", [
          join(fakebin, "restic"),
          "backup",
          "--tag",
          "s9-arena-data",
          "--host",
          "s9-arena-backup",
          join(work1, "staging"),
        ]);
        const work2 = mkdtempSync(join(root, "work-n3-"));
        execFileSync("bash", [
          join(fakebin, "restic"),
          "backup",
          "--tag",
          "s9-arena-data",
          "--host",
          "s9-arena-backup",
          join(work2, "staging"),
        ]);
        // Mutación N3: --group-by incluye "paths" ADEMÁS de "tags". Un
        // `case "$groupby" in *tags*)` (substring) lo trataría igual que
        // "host,tags" puro; el fake corregido separa los campos y exige que
        // TODOS coincidan (incluida la ruta, que aquí varía).
        execFileSync("bash", [
          join(fakebin, "restic"),
          "forget",
          "--keep-daily",
          "14",
          "--keep-weekly",
          "8",
          "--keep-monthly",
          "12",
          "--prune",
          "--host",
          "s9-arena-backup",
          "--group-by",
          "host,paths,tags",
        ]);
        const snapshots = readSnapshots(snapFile).filter((s) => s.host === "s9-arena-backup");
        // Con "paths" en el group-by, la ruta (distinta entre ejecuciones)
        // vuelve a fragmentar la retención: las DOS instantáneas sobreviven.
        expect(snapshots.length).toBe(2);
      },
    );

    it("backup.sh real: el --group-by que emite es exactamente 'host,tags', sin 'paths' (defensa contra N3)", () => {
      const { root, fakebin, snapFile, log } = setupFakeEnv("e10-hostname-n3-real-");
      const r = runBackup(root, fakebin, snapFile, { RESTIC_HOSTNAME: "s9-arena-backup" });
      expect(r.code).toBe(0);
      const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
      const forgetLine = calls.find((l) => l.startsWith("forget"))!;
      const m = forgetLine.match(/--group-by (\S+)/);
      expect(m).not.toBeNull();
      const fields = m![1].split(",");
      expect(fields).toContain("tags");
      expect(fields).not.toContain("paths");
    });
  });

  // ── M8/M10/H1 (supervisor): RESTIC_HOSTNAME vacío o en blanco ─────────────
  describe("RESTIC_HOSTNAME vacío o en blanco: rechazado como config incompleta (M8/M10/H1)", () => {
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
      // de abajo (sólo espacio en blanco), que NO se defaultea.
      const { code, out } = runDryRun({ ...base, RESTIC_HOSTNAME: "" });
      expect(code).toBe(0);
      expect(out).toContain("CONFIG OK");
      expect(out).toContain("--host arena-backup-host");
    });

    it("RESTIC_HOSTNAME='   ' (sólo espacios ASCII): CONFIG INCOMPLETA, exit 1 (M10)", () => {
      const { code, out } = runDryRun({ ...base, RESTIC_HOSTNAME: "   " });
      expect(code).toBe(1);
      expect(out).toContain("CONFIG INCOMPLETA");
      expect(out).toContain("RESTIC_HOSTNAME");
    });

    // H1 (ronda 2, demostrado por el supervisor con --dry-run real): la
    // primera versión de la validación usaba `${RESTIC_HOSTNAME// /}`, que
    // sólo sustituye el ESPACIO ASCII (0x20) — tabuladores y saltos de línea
    // sobrevivían y la validación decía "CONFIG OK, --host <TAB><TAB>".
    it("RESTIC_HOSTNAME de solo tabuladores ($'\\t\\t'): CONFIG INCOMPLETA, exit 1 (H1)", () => {
      const { code, out } = runDryRun({ ...base, RESTIC_HOSTNAME: "\t\t" });
      expect(code).toBe(1);
      expect(out).toContain("CONFIG INCOMPLETA");
      expect(out).toContain("RESTIC_HOSTNAME");
    });

    it("RESTIC_HOSTNAME de solo un salto de línea ($'\\n'): CONFIG INCOMPLETA, exit 1 (H1)", () => {
      const { code, out } = runDryRun({ ...base, RESTIC_HOSTNAME: "\n" });
      expect(code).toBe(1);
      expect(out).toContain("CONFIG INCOMPLETA");
      expect(out).toContain("RESTIC_HOSTNAME");
    });
  });
});
