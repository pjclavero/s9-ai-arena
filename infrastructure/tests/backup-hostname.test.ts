// fix/restic-stable-hostname: demuestra el defecto real observado en
// producción el 2026-08-14 y su corrección.
//
// `restic forget` agrupa la política de retención por HOST + PATHS. Sin un
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
// El "restic" falso de este fichero es deliberadamente distinto del
// `writeFakeResticFaithful` de backup.test.ts (que modela fidelidad de
// RUTAS para restore.sh --verify, un carril distinto): aquí lo que hace
// falta modelar es la semántica de AGRUPACIÓN de `backup --host`/`forget
// --host` de restic real — cada snapshot se registra con su host+tag, y
// `forget` (al recibir un --host) sólo opera sobre los snapshots de ESE
// host, colapsando cada grupo host+tag a su snapshot más reciente. Eso es
// justo el mecanismo cuya rotura causó el crecimiento sin límite.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
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

// "restic" falso que modela AGRUPACIÓN por host+tag (proxy de host+paths: en
// este script cada tipo de copia usa un --tag fijo distinto — s9-arena-data,
// s9-arena-secrets —, así que agrupar por tag es equivalente a agrupar por
// paths aquí). Persiste su estado en $SNAP_FILE (una línea "host|tag|id" por
// snapshot vivo) para que dos invocaciones de backup.sh en tests SEPARADOS
// compartan el mismo "repositorio".
//
//   backup --tag T [--host H] PATH   → añade una entrada host|tag|id nueva.
//                                       Si no se pasa --host, usa el
//                                       hostname REAL del proceso (lo mismo
//                                       que haría restic real) — así es como
//                                       se reproduce el defecto original con
//                                       la mutación de calibración.
//   forget [--host H] --keep-* ...   → sólo opera sobre los snapshots cuyo
//                                       host==H (o el hostname real si no se
//                                       pasa --host); dentro de ese
//                                       subconjunto, colapsa cada grupo
//                                       "tag" a su snapshot MÁS RECIENTE
//                                       (poda los demás). Snapshots de otros
//                                       hosts se dejan intactos, igual que
//                                       restic real nunca mezcla grupos de
//                                       hosts distintos.
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
    id="snap-\${RANDOM}-\${RANDOM}-\${RANDOM}"
    echo "\${host}|\${tag}|\${id}" >> "$SNAP_FILE"
    ;;
  forget)
    host=""; prev=""
    for a in "$@"; do
      if [ "$prev" = "--host" ]; then host="$a"; fi
      prev="$a"
    done
    [ -n "$host" ] || host="$(hostname)"
    declare -A last
    others=""
    while IFS='|' read -r h t id; do
      [ -z "$h" ] && continue
      if [ "$h" = "$host" ]; then
        last["$t"]="\${h}|\${t}|\${id}"
      else
        others+="\${h}|\${t}|\${id}"$'\\n'
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
// (una "recreación"): directorios de datos y WORK_DIR frescos, pero el
// mismo SNAP_FILE (el "repositorio" restic persiste entre recreaciones,
// como en la realidad) y, opcionalmente, el mismo RESTIC_HOSTNAME.
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

function readSnapshots(snapFile: string): Array<{ host: string; tag: string; id: string }> {
  const lines = readFileSync(snapFile, "utf8").trim().split("\n").filter(Boolean);
  return lines.map((l) => {
    const [host, tag, id] = l.split("|");
    return { host, tag, id };
  });
}

describe("backup.sh: hostname restic estable (fix/restic-stable-hostname)", () => {
  it(
    "backup 1 (contenedor A) + backup 2 (contenedor B recreado) con el MISMO RESTIC_HOSTNAME: " +
      "forget ve un solo grupo por tag y poda el snapshot antiguo",
    () => {
      const root = mkdtempSync(join(tmpdir(), "e10-hostname-"));
      const fakebin = join(root, "bin");
      mkdirSync(fakebin, { recursive: true });
      writeFakePgDumpOk(fakebin);
      const snapFile = join(root, "snapshots.db");
      const log = join(root, "restic-calls.log");
      writeFakeResticGrouping(fakebin, snapFile, log);

      // "Contenedor A": primera ejecución del servicio backup.
      const r1 = runBackup(root, fakebin, snapFile, { RESTIC_HOSTNAME: "s9-arena-backup" });
      expect(r1.code).toBe(0);
      const afterFirst = readSnapshots(snapFile);
      const firstDataSnapshot = afterFirst.find((s) => s.tag === "s9-arena-data");
      expect(firstDataSnapshot).toBeDefined();
      const firstId = firstDataSnapshot!.id;

      // "Contenedor B recreado": mismo despliegue, mismo RESTIC_HOSTNAME (por
      // ser una propiedad de la INSTALACIÓN, no del contenedor efímero), pero
      // un WORK_DIR/directorios de datos completamente nuevos — exactamente
      // lo que pasa cuando Docker sustituye el contenedor.
      const r2 = runBackup(root, fakebin, snapFile, { RESTIC_HOSTNAME: "s9-arena-backup" });
      expect(r2.code).toBe(0);

      const finalSnapshots = readSnapshots(snapFile);
      const dataGroup = finalSnapshots.filter((s) => s.tag === "s9-arena-data" && s.host === "s9-arena-backup");
      const secretsGroup = finalSnapshots.filter((s) => s.tag === "s9-arena-secrets" && s.host === "s9-arena-backup");

      // El corazón de la prueba: DOS ejecuciones de backup produjeron dos
      // snapshots "s9-arena-data", pero tras el `forget` de la SEGUNDA
      // ejecución sólo sobrevive UNO — la política agrupó ambos backups como
      // el MISMO host+tag y pudo podar el antiguo. Sin la corrección, cada
      // ejecución habría abierto su propio grupo (un snapshot cada uno) y
      // `forget` jamás habría tenido más de un snapshot por grupo que podar
      // (ver la prueba de calibración: la misma aserción se rompe con la
      // mutación que reintroduce el hostname efímero).
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
      const root = mkdtempSync(join(tmpdir(), "e10-hostname-migra-"));
      const fakebin = join(root, "bin");
      mkdirSync(fakebin, { recursive: true });
      writeFakePgDumpOk(fakebin);
      const snapFile = join(root, "snapshots.db");
      const log = join(root, "restic-calls.log");
      writeFakeResticGrouping(fakebin, snapFile, log);

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
      const root = mkdtempSync(join(tmpdir(), "e10-hostname-default-"));
      const fakebin = join(root, "bin");
      mkdirSync(fakebin, { recursive: true });
      writeFakePgDumpOk(fakebin);
      const snapFile = join(root, "snapshots.db");
      const log = join(root, "restic-calls.log");
      writeFakeResticGrouping(fakebin, snapFile, log);

      // Ni RESTIC_HOSTNAME, ni ninguna otra pista de identidad de contenedor:
      // sólo lo que trae backup.sh por defecto.
      const r = runBackup(root, fakebin, snapFile, {});
      expect(r.code).toBe(0);
      const snapshots = readSnapshots(snapFile);
      expect(snapshots.every((s) => s.host === "arena-backup-host")).toBe(true);
    },
  );
});
