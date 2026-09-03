/**
 * CARRIL E · La CADENA COMPLETA, ejercida de verdad.
 *
 * Nada se fabrica a mano: se ejecuta el `backup.sh` REAL (con pg_dump y restic
 * falsos vía PATH, patrón ya establecido en backup.test.ts y
 * manifest-pgdump.test.ts), y sobre el repositorio que ese backup deja se
 * ejecuta el `evidence.sh` REAL, cuyo JSON se interpreta con el módulo REAL
 * `packages/readiness/backup-evidence.ts`. La cadena que se demuestra es:
 *
 *     snapshot real → pg_dump real dentro → checksum real recalculado sobre
 *     los bytes almacenados → manifest real leído de dentro del snapshot
 *
 * Y se demuestra DOS VECES, porque en este proyecto conviven dos contratos:
 *   - `schema2` (el de main): el dump entra en manifest.sha256.
 *   - `legacy`  (el de los 35 snapshots que HOY hay en producción): el
 *     backup.sh desplegado excluía el dump del manifest, así que no hay
 *     checksum del volcado que contrastar.
 * El mecanismo debe distinguirlos y decir cuál está mirando — ni aprobar el
 * legacy por omisión ni acusarlo falsamente de corrupto.
 *
 * El restic falso es FIEL en lo que aquí importa: `snapshots --json` con el
 * campo `id` de 64 hex de primer nivel (incluido un objeto anidado `summary`
 * como el de restic >=0.17, para que un parseo ingenuo se rompa), `ls` con
 * rutas absolutas y `dump` sirviendo los bytes almacenados.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assessBackupEvidence, observationsFromEvidenceJson } from "../../packages/readiness/backup-evidence.ts";

const here = dirname(fileURLToPath(import.meta.url));
const BACKUP = join(here, "..", "backup", "backup.sh");
const EVIDENCE = join(here, "..", "backup", "evidence.sh");
const HEALTHCHECK = join(here, "..", "backup", "healthcheck.sh");

const DUMP_CONTENT = "PGDMP-carga-de-verdad-no-un-fichero-vacio\n";
/** ID de 64 hex por tag: el mismo criterio de identidad que usa restic. */
const idForTag = (tag: string) => createHash("sha256").update(tag).digest("hex");

function writeFakePgDump(fakebin: string, content: string) {
  const escaped = content.replace(/'/g, `'\\''`);
  writeFileSync(
    join(fakebin, "pg_dump"),
    `#!/usr/bin/env bash\nfor ((i=1;i<=$#;i++)); do if [ "\${!i}" = "-f" ]; then j=$((i+1)); printf '%s' '${escaped}' > "\${!j}"; fi; done\nexit 0\n`,
    { mode: 0o755 },
  );
}

/**
 * restic falso con las cuatro operaciones que necesita la cadena: `backup`
 * (guarda preservando la ruta absoluta), `snapshots --json`, `ls` y `dump`.
 * Además REGISTRA cada invocación (orden + si llevaba `--no-lock`) en un
 * fichero de llamadas: así el invariante de solo lectura del recolector se
 * comprueba sobre lo que EJECUTÓ, no sobre lo que dice su código.
 */
function writeFakeRestic(fakebin: string, store: string, snapTime: string) {
  const script = `#!/usr/bin/env bash
store="${store}"
cmd="$1"; shift
args=("$@")
has_no_lock=0
tag=""
latest=0
target=""
prev=""
positional=()
for a in "\${args[@]}"; do
  case "$a" in
    --no-lock) has_no_lock=1 ;;
    --json|--latest|1|--tag|--host|--tag=*) ;;
    -*) ;;
    *) positional+=("$a") ;;
  esac
  [ "$prev" = "--tag" ] && tag="$a"
  [ "$prev" = "--latest" ] && latest=1
  prev="$a"
done

printf '%s|%s\\n' "$cmd" "$has_no_lock" >> "$store/.calls"

id_for_tag() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
tag_for_id() { cat "$store/ids/$1" 2>/dev/null; }

case "$cmd" in
  backup)
    t=""
    for a in "\${args[@]}"; do case "$a" in s9-arena-*) t="$a" ;; esac; done
    src="\${positional[\${#positional[@]}-1]}"
    dest="$store/$t$(dirname "$src")"
    mkdir -p "$dest" "$store/ids"
    cp -a "$src" "$dest/"
    printf '%s' "$t" > "$store/ids/$(id_for_tag "$t")"
    printf '%s' "$src" > "$store/$t/.srcroot"
    ;;
  snapshots)
    out="["
    first=1
    # Señuelo: un snapshot MÁS ANTIGUO de otro hostname histórico, como los
    # que arrastra el repositorio real. Elegir "el primero" en vez de "el más
    # reciente" devolvería este, y la señal de frescura mentiría.
    if [ -z "$tag" ] || [ "$tag" = "s9-arena-data" ]; then
      out="$out{\\"time\\":\\"2001-01-01T00:00:00Z\\",\\"hostname\\":\\"host-historico\\",\\"tags\\":[\\"s9-arena-data\\"],\\"summary\\":{\\"files_new\\":1},\\"id\\":\\"$(id_for_tag "senuelo-antiguo")\\"}"
      first=0
    fi
    for d in "$store"/s9-arena-*; do
      [ -d "$d" ] || continue
      t="$(basename "$d")"
      if [ -n "$tag" ] && [ "$t" != "$tag" ]; then continue; fi
      [ "$first" = 1 ] || out="$out,"
      first=0
      # "summary" anidado como el de restic >=0.17: un parseo ingenuo del
      # objeto más interno se rompería aquí.
      out="$out{\\"time\\":\\"${snapTime}\\",\\"parent\\":\\"$(id_for_tag "parent-$t")\\",\\"tree\\":\\"$(id_for_tag "tree-$t")\\",\\"paths\\":[\\"$(cat "$d/.srcroot" 2>/dev/null)\\"],\\"tags\\":[\\"$t\\"],\\"summary\\":{\\"files_new\\":3,\\"data_added\\":1234},\\"id\\":\\"$(id_for_tag "$t")\\",\\"short_id\\":\\"$(id_for_tag "$t" | cut -c1-8)\\"}"
    done
    printf '%s]\\n' "$out"
    ;;
  ls)
    id="\${positional[0]}"
    t="$(tag_for_id "$id")"
    [ -z "$t" ] && { echo "no matching ID found" >&2; exit 1; }
    # Formato --json del restic real: una línea por nodo, con "type" y "path".
    # Se emiten TAMBIÉN los directorios (como hace el real): si el recolector
    # no filtrara por type=file, los contaría como ficheros sin checksum y
    # acusaría al manifest de incompleto — el falso fallo visto en producción.
    ( cd "$store/$t" && find . -mindepth 1 ! -name '.srcroot' -printf '%y|%p\\n' ) \
      | while IFS='|' read -r ty pa; do
          rel="\${pa#.}"
          if [ "$ty" = "d" ]; then
            printf '{"name":"%s","type":"dir","path":"%s"}\\n' "\${rel##*/}" "$rel"
          else
            printf '{"name":"%s","type":"file","path":"%s"}\\n' "\${rel##*/}" "$rel"
          fi
        done
    ;;
  dump)
    id="\${positional[0]}"
    path="\${positional[1]}"
    t="$(tag_for_id "$id")"
    [ -z "$t" ] && { echo "no matching ID found" >&2; exit 1; }
    f="$store/$t$path"
    [ -f "$f" ] || { echo "no encontrado: $path" >&2; exit 1; }
    cat "$f"
    ;;
  forget|check|unlock|prune)
    # backup.sh SÍ las usa legítimamente (retención e integridad). Lo que no
    # puede usarlas es el recolector de evidencia; eso se comprueba leyendo el
    # registro de llamadas de SU ejecución, no prohibiéndolas aquí.
    :
    ;;
esac
exit 0
`;
  writeFileSync(join(fakebin, "restic"), script, { mode: 0o755 });
}

interface Fixture {
  root: string;
  env: Record<string, string>;
  store: string;
  stagingRoot: string;
  dataTagDir: string;
}

function runRealBackup(snapTime: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), "carril-e-"));
  const fakebin = join(root, "bin");
  const store = join(root, "store");
  mkdirSync(fakebin, { recursive: true });
  mkdirSync(store, { recursive: true });
  for (const d of ["maps", "bot-sources", "replays", "assets", "secrets", "metrics"]) {
    mkdirSync(join(root, d), { recursive: true });
  }
  writeFileSync(join(root, "replays", "battle-1.jsonl"), '{"tick":1}\n');
  writeFileSync(join(root, "secrets", "restic_password.txt"), "s3cr3t-restic-carril-e", { mode: 0o600 });
  writeFileSync(join(root, "secrets", "postgres_password.txt"), "s3cr3t-pg-carril-e", { mode: 0o600 });
  writeFakePgDump(fakebin, DUMP_CONTENT);
  writeFakeRestic(fakebin, store, snapTime);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
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
    METRICS_DIR: join(root, "metrics"),
    BACKUP_SCHEDULER_PROBE: "true",
  };

  const out = execFileSync("bash", [BACKUP], { encoding: "utf8", env });
  expect(out).toContain("backup SUCCESS");

  const dataTagDir = join(store, "s9-arena-data");
  const stagingRoot = readFileSync(join(dataTagDir, ".srcroot"), "utf8");
  return { root, env, store, stagingRoot, dataTagDir };
}

function collectEvidence(f: Fixture, extraEnv: Record<string, string> = {}) {
  const raw = execFileSync("bash", [EVIDENCE], {
    encoding: "utf8",
    env: { ...f.env, ...extraEnv },
  });
  const doc = JSON.parse(raw);
  return { raw, doc };
}

/** Reescribe el staging almacenado al contrato ANTIGUO (el de producción). */
function degradarALegacy(f: Fixture) {
  const stagingInStore = join(f.dataTagDir, f.stagingRoot);
  const manifestPath = join(stagingInStore, "manifest.sha256");
  const jsonPath = join(stagingInStore, "manifest.json");
  const sinDump = readFileSync(manifestPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "" && !/pgdump-[^/]*\.dump$/.test(l))
    .join("\n")
    .concat("\n");
  writeFileSync(manifestPath, sinDump);
  const legacyJson = readFileSync(jsonPath, "utf8").replace(/"schema":\s*\d+,\s*/, "");
  writeFileSync(jsonPath, legacyJson);
}

describe("evidence.sh · cadena completa sobre un backup REAL (contrato schema2)", () => {
  it("observa snapshot, volcado, checksum recalculado y manifest, y da READY", () => {
    const f = runRealBackup(new Date().toISOString());
    try {
      const { doc } = collectEvidence(f, { BACKUP_SCHEDULER_PROBE: "true" });

      // El recolector observó de verdad, no rellenó huecos.
      expect(doc.repository.accessible).toBe(true);
      expect(doc.snapshot.id).toMatch(/^[0-9a-f]{64}$/);
      expect(doc.snapshot.files).toContain("manifest.sha256");
      expect(doc.snapshot.files.some((x: string) => /^pgdump-.*\.dump$/.test(x))).toBe(true);
      // El checksum se RECALCULÓ sobre los bytes almacenados, no se copió del manifest.
      expect(doc.pgDump.sha256).toBe(createHash("sha256").update(DUMP_CONTENT).digest("hex"));
      expect(doc.pgDump.bytes).toBe(DUMP_CONTENT.length);

      const r = assessBackupEvidence(observationsFromEvidenceJson(doc, Date.now()));
      expect(r.contract).toBe("schema2");
      expect(r.blockers).toEqual([]);
      expect(r.verdict).toBe("READY");
      expect(r.corroboratingFamilies.sort()).toEqual(["producer", "repository"]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("si los bytes almacenados cambian, el checksum recalculado lo delata", () => {
    const f = runRealBackup(new Date().toISOString());
    try {
      const stagingInStore = join(f.dataTagDir, f.stagingRoot);
      const dump = execFileSync("bash", ["-c", `ls ${stagingInStore}/pgdump-*.dump`], { encoding: "utf8" }).trim();
      writeFileSync(dump, "CORRUPTO");

      const { doc } = collectEvidence(f, { BACKUP_SCHEDULER_PROBE: "true" });
      const r = assessBackupEvidence(observationsFromEvidenceJson(doc, Date.now()));
      const s = r.outcomes.find((o) => o.spec.id === "backup.pg_dump_sha256")!;
      expect(s.status).toBe("failed");
      expect(r.verdict).toBe("NOT_READY");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("una copia rancia se ve en el DESTINO aunque las métricas del productor estén verdes", () => {
    const hace3dias = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
    const f = runRealBackup(hace3dias);
    try {
      const { doc } = collectEvidence(f, { BACKUP_SCHEDULER_PROBE: "true" });
      const r = assessBackupEvidence(observationsFromEvidenceJson(doc, Date.now()));
      expect(r.outcomes.find((o) => o.spec.id === "backup.last_snapshot_timestamp")!.status).toBe("failed");
      expect(r.verdict).toBe("NOT_READY");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

describe("evidence.sh · contrato LEGACY (los 35 snapshots que hoy hay en producción)", () => {
  it("lo identifica como legacy y deja el checksum del volcado NO EJERCIDO con motivo", () => {
    const f = runRealBackup(new Date().toISOString());
    try {
      degradarALegacy(f);
      const { doc } = collectEvidence(f, { BACKUP_SCHEDULER_PROBE: "true" });
      const r = assessBackupEvidence(observationsFromEvidenceJson(doc, Date.now()));

      expect(r.contract).toBe("legacy");
      const s = r.outcomes.find((o) => o.spec.id === "backup.pg_dump_sha256")!;
      expect(s.status).toBe("not_exercised");
      expect(s.status).not.toBe("verified");
      expect(s.evidence).toContain("LEGACY");
      // Y NO se acusa falsamente al manifest legacy de estar truncado.
      expect(r.outcomes.find((o) => o.spec.id === "backup.manifest_verified")!.status).toBe("verified");
      // El volcado sigue estando dentro del snapshot, sólo que sin checksum.
      expect(r.outcomes.find((o) => o.spec.id === "backup.pg_dump_present")!.status).toBe("verified");
      expect(r.verdict).toBe("NOT_READY");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

describe("evidence.sh · invariantes de solo lectura", () => {
  it("SÓLO invoca consultas, y TODAS con --no-lock (comprobado sobre lo ejecutado)", () => {
    const f = runRealBackup(new Date().toISOString());
    try {
      // Se borra el registro para quedarse con las llamadas de evidence.sh y
      // no con las de backup.sh (que sí usa backup/forget/check legítimamente).
      const callsFile = join(f.store, ".calls");
      writeFileSync(callsFile, "");
      const { doc } = collectEvidence(f, { BACKUP_SCHEDULER_PROBE: "true" });
      expect(doc.repository.accessible).toBe(true);
      expect(doc.manifest.probed).toBe(true);
      expect(doc.pgDump.probed).toBe(true);

      const calls = readFileSync(callsFile, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => l.split("|"));
      expect(calls.length).toBeGreaterThan(3);
      for (const [cmd, noLock] of calls) {
        // Ninguna orden que escriba: ni backup, ni forget, ni prune, ni unlock,
        // ni `check` (que toma lock exclusivo y NO es de solo lectura).
        expect(["snapshots", "ls", "dump"], `restic ${cmd}`).toContain(cmd);
        expect(noLock, `restic ${cmd} sin --no-lock`).toBe("1");
      }
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("el script no NOMBRA ninguna invocación de escritura en su código", () => {
    const src = readFileSync(EVIDENCE, "utf8");
    // Se miran las INVOCACIONES en líneas de código, no las apariciones del
    // texto: los comentarios del script nombran `restic check` precisamente
    // para explicar por qué NO se ejecuta, y contar apariciones daría un falso
    // positivo (o un falso negativo si se contase al revés).
    const lineasDeCodigo = src.split("\n").filter((l) => !/^\s*#/.test(l));
    const consultas = lineasDeCodigo.flatMap((l) => [...l.matchAll(/\brestic\s+(snapshots|ls|dump)\s+--no-lock\b/g)]);
    expect(consultas.length).toBeGreaterThan(2);
    for (const l of lineasDeCodigo) {
      expect(l, "orden de ESCRITURA en el recolector").not.toMatch(
        /\brestic\s+(backup|forget|prune|unlock|check|repair|rewrite|copy|init)\b/,
      );
      // Una consulta sin --no-lock tomaría lock: dejaría de ser lectura.
      const consulta = /\brestic\s+(snapshots|ls|dump|stats|cat)\b/.exec(l);
      if (consulta) expect(l, `sin --no-lock: ${l.trim()}`).toContain("--no-lock");
    }
  });
});

// ── healthcheck.sh ───────────────────────────────────────────────────────────

function runHealthcheck(dir: string, env: Record<string, string> = {}) {
  const res = execFileSync(
    "bash",
    // 2>&1: los motivos de UNHEALTHY salen por stderr (van al log de Docker).
    ["-c", `bash ${HEALTHCHECK} 2>&1; echo "RC=\${PIPESTATUS[0]:-$?}"`],
    {
      encoding: "utf8",
      env: {
        ...(process.env as Record<string, string>),
        METRICS_DIR: dir,
        BACKUP_SCHEDULER_PROBE: "true",
        ...env,
      },
    },
  );
  const rc = Number(/RC=(\d+)/.exec(res)![1]);
  return { rc, out: res };
}

function metricsDir(values: Record<string, number | string>, bootAgeHours = 48) {
  const dir = mkdtempSync(join(tmpdir(), "carril-e-hc-"));
  const lines = Object.entries(values).map(([k, v]) => `${k} ${v}`);
  if (lines.length > 0) writeFileSync(join(dir, "s9_backup.prom"), `# HELP algo\n${lines.join("\n")}\n`);
  writeFileSync(join(dir, ".container_started"), String(Math.floor(Date.now() / 1000) - bootAgeHours * 3600));
  return dir;
}

const NOMINAL_METRICS = () => ({
  s9_backup_last_exit_code: 0,
  s9_backup_run_success: 1,
  s9_backup_postgres_success: 1,
  s9_backup_restic_snapshot_created: 1,
  s9_backup_last_success_timestamp_seconds: Math.floor(Date.now() / 1000) - 6 * 3600,
});

describe("healthcheck.sh · sustituye `pgrep crond` por mirar LA COPIA", () => {
  it("verde cuando la última copia fue un éxito reciente y completo", () => {
    const dir = metricsDir(NOMINAL_METRICS());
    try {
      const { rc, out } = runHealthcheck(dir);
      expect(rc).toBe(0);
      expect(out).toContain("BACKUP OK");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // LA MUTACIÓN QUE JUSTIFICA TODO EL CARRIL: el healthcheck viejo
  // (`pgrep crond`) sale 0 en TODOS los casos rojos de aquí abajo.
  const rojos: Array<[string, Record<string, number | string>]> = [
    ["la copia falló (exit 1)", { ...NOMINAL_METRICS(), s9_backup_last_exit_code: 1, s9_backup_run_success: 0 }],
    ["exit 0 sin snapshot creado", { ...NOMINAL_METRICS(), s9_backup_restic_snapshot_created: 0 }],
    ["la fuente crítica postgres falló", { ...NOMINAL_METRICS(), s9_backup_postgres_success: 0 }],
    [
      "copia rancia: 40 h desde el último éxito",
      { ...NOMINAL_METRICS(), s9_backup_last_success_timestamp_seconds: Math.floor(Date.now() / 1000) - 40 * 3600 },
    ],
    [
      "éxito declarado sin fecha",
      {
        s9_backup_last_exit_code: 0,
        s9_backup_run_success: 1,
        s9_backup_postgres_success: 1,
        s9_backup_restic_snapshot_created: 1,
      },
    ],
  ];
  for (const [nombre, values] of rojos) {
    it(`ROJO · ${nombre} (con crond vivo: el healthcheck viejo habría dicho healthy)`, () => {
      const dir = metricsDir(values);
      try {
        const { rc, out } = runHealthcheck(dir);
        expect(rc).toBe(1);
        expect(out).toContain("BACKUP UNHEALTHY");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("ROJO · el contenedor lleva 48 h y no consta NINGUNA ejecución", () => {
    const dir = metricsDir({}, 48);
    try {
      const { rc, out } = runHealthcheck(dir);
      expect(rc).toBe(1);
      expect(out).toContain("NO consta ninguna ejecución");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("VERDE con motivo · recién arrancado, aún dentro de la ventana: no es un fallo", () => {
    const dir = metricsDir({}, 1);
    try {
      const { rc, out } = runHealthcheck(dir);
      expect(rc).toBe(0);
      expect(out).toContain("BACKUP STARTING");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ROJO · sin métricas y sin poder fechar el arranque, se falla en CERRADO", () => {
    const dir = mkdtempSync(join(tmpdir(), "carril-e-hc-"));
    try {
      const { rc, out } = runHealthcheck(dir);
      expect(rc).toBe(1);
      expect(out).toContain("no se puede fechar el arranque");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ROJO · crond muerto: condición NECESARIA, aunque nunca suficiente", () => {
    const dir = metricsDir(NOMINAL_METRICS());
    try {
      const { rc, out } = runHealthcheck(dir, { BACKUP_SCHEDULER_PROBE: "false" });
      expect(rc).toBe(1);
      expect(out).toContain("crond no está vivo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── El cambio de contrato en el compose y en la imagen ───────────────────────

describe("docker-compose · el healthcheck del servicio backup", () => {
  const compose = readFileSync(join(here, "..", "docker-compose.yml"), "utf8");
  // Bloque del servicio `backup` (hasta el siguiente servicio del mismo nivel).
  const bloque = (() => {
    const m = /\n  backup:\n([\s\S]*?)\n  [a-z0-9-]+:\n/.exec(compose);
    return m ? m[1] : "";
  })();

  it("ya NO es `pgrep crond`: cron alive != backup working", () => {
    expect(bloque.length).toBeGreaterThan(100);
    const test = /healthcheck:\s*\n\s*test:\s*(.+)/.exec(bloque)?.[1] ?? "";
    expect(test).not.toContain("pgrep");
    expect(test).toContain("healthcheck.sh");
  });

  it("la imagen instala healthcheck.sh y evidence.sh y los hace ejecutables", () => {
    const dockerfile = readFileSync(join(here, "..", "docker", "backup", "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/COPY infrastructure\/backup\/healthcheck\.sh \/usr\/local\/bin\/healthcheck\.sh/);
    expect(dockerfile).toMatch(/COPY infrastructure\/backup\/evidence\.sh \/usr\/local\/bin\/evidence\.sh/);
    const chmod = /RUN chmod \+x([\s\S]*?)\n\n/.exec(dockerfile)?.[1] ?? "";
    expect(chmod).toContain("/usr/local/bin/healthcheck.sh");
    expect(chmod).toContain("/usr/local/bin/evidence.sh");
  });

  it("el entrypoint deja la marca de arranque que el healthcheck necesita para no dar falsos fallos", () => {
    const entry = readFileSync(join(here, "..", "backup", "entrypoint.sh"), "utf8");
    expect(entry).toContain("BACKUP_BOOT_MARKER");
    expect(entry).toMatch(/date \+%s > "\$BACKUP_BOOT_MARKER"/);
  });
});
