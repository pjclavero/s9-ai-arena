// D3 (#112): el pg_dump quedaba fuera de manifest.sha256 a propósito
// (`! -path './pgdump-*'`), documentado como limitación conocida a la
// espera de decisión del operador — así que el activo más crítico del
// backup (la base de datos) era el ÚNICO sin checksum propio en ninguna
// parte. Este ticket ES esa decisión: el dump entra en manifest.sha256
// como un activo más, calculado sobre el fichero ya escrito y cerrado
// (pg_dump corre síncrono en el paso 1/5; el manifest se genera en el
// 4/5, cuando el dump ya está completo).
//
// Fichero exclusivo de esta suite: NO toca backup.test.ts (salvo las 2
// aserciones ya actualizadas ahí, autorizadas aparte) ni ningún otro test
// existente. Cadena SIEMPRE real: fixture → backup.sh (real, con pg_dump
// y restic falsos vía PATH) → restic falso FIEL (preserva rutas absolutas
// como el real) → restore.sh --restore → restore.sh --verify. Ningún
// manifest se fabrica a mano.
import { describe, expect, it } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const BACKUP = join(here, "..", "backup", "backup.sh");
const RESTORE = join(here, "..", "backup", "restore.sh");

// pg_dump falso que escribe contenido NO trivial y determinista (no un
// fichero vacío): así el checksum que se comprueba en los tests es el de
// datos reales, no el hash fijo de "fichero vacío" que sería el mismo
// para cualquier dump, roto o no.
function writeFakePgDumpWithContent(fakebin: string, content: string) {
  const escaped = content.replace(/'/g, `'\\''`);
  writeFileSync(
    join(fakebin, "pg_dump"),
    `#!/usr/bin/env bash\nfor ((i=1;i<=$#;i++)); do if [ "\${!i}" = "-f" ]; then j=$((i+1)); printf '%s' '${escaped}' > "\${!j}"; fi; done\nexit 0\n`,
    { mode: 0o755 },
  );
}

// restic falso FIEL: preserva la ruta ABSOLUTA de origen al "guardar" y
// sabe "restaurar" esa misma estructura bajo --target, igual que el
// restic real (mismo patrón que backup.test.ts, reimplementado aquí para
// mantener este fichero autónomo).
//
// fix/restore-snapshot-selection (rebase sobre #119): restore.sh ahora
// resuelve un ID de snapshot ANTES de restaurar (`restic snapshots --tag …
// --latest 1 --json`) y llama a `restic restore <id> --target <dest>` — ya
// no pasa `--tag`. Este fake, igual que su gemelo en backup.test.ts, usa el
// propio NOMBRE DEL TAG como "ID" fake (short_id=tag), consistente con
// `store/<tag>/`: así `snapshots --tag X --latest 1 --json` devuelve
// short_id=X y `restore X --target dest` encuentra `store/X/` sin tabla
// id→tag aparte. Este fichero es DELIBERADAMENTE autónomo (no importa el
// fixture de backup.test.ts) — ver cabecera — así que el fix se replica
// aquí en vez de compartir código entre ficheros de test.
function writeFakeResticFaithful(fakebin: string, store: string) {
  const script = `#!/usr/bin/env bash
case "$1" in
  backup)
    tag=""
    for a in "$@"; do case "$a" in s9-arena-*) tag="$a" ;; esac; done
    src="\${@: -1}"
    destdir="${store}/$tag$(dirname "$src")"
    mkdir -p "$destdir"
    cp -a "$src" "$destdir/"
    ;;
  snapshots)
    if [ "$2" = "--tag" ]; then
      tag="$3"
      if [ -d "${store}/$tag" ]; then
        echo "[{\\"short_id\\":\\"$tag\\",\\"tags\\":[\\"$tag\\"]}]"
      else
        echo "[]"
      fi
      exit 0
    fi
    id="$2"
    if [ -d "${store}/$id" ]; then
      echo "[{\\"short_id\\":\\"$id\\",\\"tags\\":[\\"$id\\"]}]"
    else
      echo "no matching ID found" >&2
      exit 1
    fi
    ;;
  restore)
    id="$2"
    target=""
    prev=""
    for a in "$@"; do
      [ "$prev" = "--target" ] && target="$a"
      prev="$a"
    done
    mkdir -p "$target"
    cp -a "${store}/$id/." "$target/"
    ;;
  forget|check)
    :
    ;;
esac
exit 0
`;
  writeFileSync(join(fakebin, "restic"), script, { mode: 0o755 });
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// Monta un backup real completo (pg_dump con contenido + maps + replays) y
// lo restaura, devolviendo el directorio restaurado y el contenido de dump
// usado (para poder recalcular el hash de forma independiente al test).
function setupRealBackupAndRestore(dumpContent: string) {
  const root = mkdtempSync(join(tmpdir(), "e-pgdump-"));
  const fakebin = join(root, "bin");
  const store = join(root, "store");
  const workDir = join(root, "work");
  mkdirSync(fakebin, { recursive: true });
  mkdirSync(store, { recursive: true });
  for (const dir of ["maps", "bot-sources", "replays/official", "assets", "secrets"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, "maps", "mvp.json"), '{"map":"mvp"}\n');
  writeFileSync(join(root, "replays", "official", "battle-1.jsonl"), '{"tick":1}\n');
  writeFileSync(join(root, "secrets", "restic_password.txt"), "s3cr3t-restic-pgdump", { mode: 0o600 });
  writeFileSync(join(root, "secrets", "postgres_password.txt"), "s3cr3t-pg-pgdump", { mode: 0o600 });
  writeFakePgDumpWithContent(fakebin, dumpContent);
  writeFakeResticFaithful(fakebin, store);

  const env = {
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
  } as Record<string, string>;

  const backupOut = execFileSync("bash", [BACKUP], { encoding: "utf8", env });
  expect(backupOut).toContain("backup SUCCESS");

  const dest = join(root, "restored");
  execFileSync("bash", [RESTORE, "--restore", dest], { encoding: "utf8", env });

  const manifestPath = execSync(`find "${dest}" -name manifest.sha256`, { encoding: "utf8" }).trim();
  const manifestContent = readFileSync(manifestPath, "utf8");
  const dumpPath = execSync(`find "${dest}" -name 'pgdump-*.dump'`, { encoding: "utf8" }).trim();

  return { root, dest, env, manifestPath, manifestContent, dumpPath };
}

const DUMP_CONTENT = "PGDMP-fake-binary-dump-payload-con-datos-de-verdad\n";

describe("manifest.sha256 incluye el pg_dump (D3, #112)", () => {
  it("el manifest CONTIENE una línea para pgdump-*.dump con su sha256 correcto", () => {
    const { manifestContent, dumpPath } = setupRealBackupAndRestore(DUMP_CONTENT);

    const dumpBasename = dumpPath.split("/").pop()!;
    const line = manifestContent.split("\n").find((l) => l.endsWith(dumpBasename));
    expect(line, `manifest.sha256:\n${manifestContent}`).toBeTruthy();

    // Formato "portable" de sha256sum: "<hash>  <ruta>" (dos espacios).
    const [hashInManifest, pathInManifest] = line!.split(/\s+/);
    expect(hashInManifest).toMatch(/^[0-9a-f]{64}$/);
    expect(pathInManifest.endsWith(dumpBasename)).toBe(true);
  });

  it("el sha256 del manifest COINCIDE con el hash real del fichero (calculado de forma independiente)", () => {
    const { manifestContent, dumpPath } = setupRealBackupAndRestore(DUMP_CONTENT);

    const dumpBasename = dumpPath.split("/").pop()!;
    const line = manifestContent.split("\n").find((l) => l.endsWith(dumpBasename))!;
    const hashInManifest = line.split(/\s+/)[0];

    // Hash independiente: (a) recalculado en Node a partir del contenido
    // real escrito por el pg_dump falso, y (b) recalculado por sha256sum
    // sobre el fichero restaurado — ninguno de los dos pasa por el código
    // de backup.sh/restore.sh que se está probando.
    const expectedFromContent = sha256(DUMP_CONTENT);
    const expectedFromDisk = execSync(`sha256sum "${dumpPath}"`, { encoding: "utf8" }).split(/\s+/)[0];

    expect(hashInManifest).toBe(expectedFromContent);
    expect(hashInManifest).toBe(expectedFromDisk);
  });

  it("manifest sigue cubriendo lo que ya cubría antes (maps y replays no se pierden por incluir el dump)", () => {
    const { manifestContent } = setupRealBackupAndRestore(DUMP_CONTENT);

    const lines = manifestContent.split("\n").filter(Boolean);
    expect(lines.some((l) => l.endsWith("maps/mvp.json"))).toBe(true);
    expect(lines.some((l) => l.endsWith("replays/official/battle-1.jsonl"))).toBe(true);
    expect(lines.some((l) => /pgdump-\d+\.dump$/.test(l))).toBe(true);
    // 3 fuentes con contenido real (postgres + maps + replays) → 3 líneas.
    expect(lines.length).toBe(3);
  });

  it("dump CORROMPIDO tras generar el manifest: --verify FALLA señalando el dump, no otra cosa", () => {
    const { dest, env, dumpPath } = setupRealBackupAndRestore(DUMP_CONTENT);

    // Corrompe SÓLO el dump, después de que backup.sh ya generó el
    // manifest y restore.sh ya restauró el árbol. maps/ y replays/ quedan
    // intactos: si --verify fallara por OTRA vía (residuales, conteo de
    // líneas...) en vez de por el checksum del dump, este test debe
    // detectarlo por el mensaje, no sólo por el exit code.
    writeFileSync(dumpPath, "CONTENIDO-CORROMPIDO-A-PROPOSITO\n");

    let threw = false;
    let output = "";
    try {
      output = execFileSync("bash", [RESTORE, "--verify", dest], { encoding: "utf8", stdio: "pipe", env });
    } catch (e: any) {
      threw = true;
      output = `${e.stdout}${e.stderr}`;
    }
    expect(threw).toBe(true);
    // sha256sum -c reporta la línea que falla como "<ruta>: <no coincide>"
    // (la cadena exacta depende del locale: "FAILED" en C/POSIX, "La suma
    // no coincide" visto en este entorno) — debe ser la del pgdump, no
    // maps/replays (que siguen intactos y deben seguir "OK"/"la suma
    // coincide", nunca la variante de fallo).
    const dumpBasename = dumpPath.split("/").pop()!;
    const FAIL_WORD = /(FAILED|no coincide)/;
    const dumpLine = output.split("\n").find((l) => l.startsWith(`${dumpBasename}:`));
    expect(dumpLine, output).toBeTruthy();
    expect(dumpLine).toMatch(FAIL_WORD);
    const mapsLine = output.split("\n").find((l) => l.startsWith("maps/mvp.json:"));
    const replaysLine = output.split("\n").find((l) => l.startsWith("replays/official/battle-1.jsonl:"));
    expect(mapsLine, output).toBeTruthy();
    expect(replaysLine, output).toBeTruthy();
    expect(mapsLine).not.toMatch(FAIL_WORD);
    expect(replaysLine).not.toMatch(FAIL_WORD);
  });

  it("dump INTACTO: --verify PASA y confirma la integridad de las tres fuentes (postgres incluido)", () => {
    const { dest, env } = setupRealBackupAndRestore(DUMP_CONTENT);

    const verifyOut = execFileSync("bash", [RESTORE, "--verify", dest], { encoding: "utf8", env });
    // D3-R2: el mensaje enumera dinámicamente las fuentes con contenido
    // real cubiertas por el manifest, separadas por coma.
    expect(verifyOut).toContain("integridad verificada: checksums de postgres, mapas, replays correctos");
  });

  // ── D3-R2 (supervisión independiente de #119, DEFECTO 1, BLOQUEANTE,
  // corregido): reproduce EXACTAMENTE el ataque demostrado por el
  // supervisor sobre la cadena real, con las cuatro fuentes no críticas
  // vacías — el estado real de producción hoy: (1) backup nuevo sano
  // (schema>=2); (2) se vacía manifest.sha256 Y se sustituye el dump por
  // basura, dejando manifest.json intacto (sigue declarando postgres/
  // secrets 'ok'); (3) --verify debe FALLAR, nunca EXIT=0. Antes de la
  // corrección de este defecto, la rama de "manifest vacío legítimo" (D1)
  // no distinguía este caso de un snapshot legacy auténtico y aceptaba el
  // ataque con el mensaje falso "ninguna fuente 'ok'". El marcador
  // "schema" en manifest.json es lo que ahora permite distinguirlos.
  it("D3-R2: manifest.sha256 vaciado + dump sustituido en backup NUEVO (schema>=2) — --verify FALLA, nunca EXIT=0", () => {
    const root = mkdtempSync(join(tmpdir(), "e-pgdump-d3r2-"));
    const fakebin = join(root, "bin");
    const store = join(root, "store");
    const workDir = join(root, "work");
    mkdirSync(fakebin, { recursive: true });
    mkdirSync(store, { recursive: true });
    // Las CUATRO fuentes no críticas existen pero están vacías — el
    // estado real de producción citado por el supervisor.
    for (const dir of ["maps", "bot-sources", "replays", "assets", "secrets"]) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    writeFileSync(join(root, "secrets", "restic_password.txt"), "s3cr3t-restic-d3r2", { mode: 0o600 });
    writeFileSync(join(root, "secrets", "postgres_password.txt"), "s3cr3t-pg-d3r2", { mode: 0o600 });
    writeFakePgDumpWithContent(fakebin, DUMP_CONTENT);
    writeFakeResticFaithful(fakebin, store);

    const env = {
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
    } as Record<string, string>;

    // 1. Backup nuevo sano: manifest de 1 línea (el dump), --verify EXIT=0.
    const backupOut = execFileSync("bash", [BACKUP], { encoding: "utf8", env });
    expect(backupOut).toContain("backup SUCCESS");
    const dest = join(root, "restored");
    execFileSync("bash", [RESTORE, "--restore", dest], { encoding: "utf8", env });
    const sanityOut = execFileSync("bash", [RESTORE, "--verify", dest], { encoding: "utf8", env });
    expect(sanityOut).toContain("integridad verificada");

    // 2. Se vacía manifest.sha256 y se SUSTITUYE el dump por basura.
    //    manifest.json NO se toca: sigue declarando postgres/secrets 'ok'.
    const manifestPath = execSync(`find "${dest}" -name manifest.sha256`, { encoding: "utf8" }).trim();
    const dumpPath = execSync(`find "${dest}" -name 'pgdump-*.dump'`, { encoding: "utf8" }).trim();
    writeFileSync(manifestPath, "");
    writeFileSync(dumpPath, "BASURA-SUSTITUIDA-TRAS-VACIAR-EL-MANIFEST\n");

    // 3. --verify sobre la copia degradada: NUNCA EXIT=0.
    let threw = false;
    let output = "";
    try {
      output = execFileSync("bash", [RESTORE, "--verify", dest], { encoding: "utf8", stdio: "pipe", env });
    } catch (e: any) {
      threw = true;
      output = `${e.stdout}${e.stderr}`;
    }
    expect(threw, `--verify debió fallar; salida real:\n${output}`).toBe(true);
    expect(output).not.toContain("no había nada que verificar");
    expect(output).not.toContain("integridad verificada");
    // Exigencia explícita del operador: el mensaje NO puede volver a decir
    // "ninguna fuente 'ok'" (falso: manifest.json declara postgres/secrets
    // 'ok') — tiene que señalar la CONTRADICCIÓN real entre lo declarado y
    // los checksums ausentes.
    expect(output).not.toContain("ninguna fuente");
    expect(output).toContain("schema=2");
    expect(output).toMatch(/postgres.*'ok'|'ok'.*postgres/);
  });

  // ── Caso hostil #3 aislado (operador, ronda de re-supervisión): el
  // ataque de arriba combina "manifest vacío" + "dump sustituido". Este
  // test aísla SÓLO la primera mitad — manifest.sha256 vaciado, dump
  // INTACTO en el árbol — para confirmar que el gate de schema>=2 rechaza
  // el manifest vacío por sí solo, sin depender de que el dump también
  // esté corrupto.
  it("snapshot NUEVO (schema>=2) con manifest.sha256 vacío y dump INTACTO: --verify FALLA igual", () => {
    const { dest, env, manifestPath } = setupRealBackupAndRestore(DUMP_CONTENT);
    writeFileSync(manifestPath, "");

    let threw = false;
    let output = "";
    try {
      output = execFileSync("bash", [RESTORE, "--verify", dest], { encoding: "utf8", stdio: "pipe", env });
    } catch (e: any) {
      threw = true;
      output = `${e.stdout}${e.stderr}`;
    }
    expect(threw, `--verify debió fallar; salida real:\n${output}`).toBe(true);
    expect(output).not.toContain("integridad verificada");
    expect(output).toContain("schema=2");
  });

  // ── Caso hostil #5 (operador, ronda de re-supervisión): snapshot LEGACY
  // real y representativo — la forma EXACTA del restore drill del 18-ago:
  // manifest.json sin "schema" (backup.sh anterior a este fix nunca lo
  // escribió), manifest.sha256 con líneas de maps/replays pero SIN el
  // dump, y el dump presente en el árbol (backup.sh legacy lo genera, sólo
  // no lo hashea). Comportamiento exigido y documentado en
  // docs/recuperacion.md: --verify PASA, verifica maps/replays de verdad,
  // y dice EXPLÍCITAMENTE que el dump no tiene checksum en ese manifest —
  // nunca aborta con un diagnóstico de "truncado/corrupto" falso.
  it("snapshot LEGACY real (sin schema, dump fuera del manifest, forma del restore drill 18-ago): --verify PASA y documenta la cobertura real", () => {
    const root = mkdtempSync(join(tmpdir(), "e-pgdump-legacy-"));
    const dest = join(root, "restored");
    mkdirSync(join(dest, "maps"), { recursive: true });
    mkdirSync(join(dest, "replays", "official"), { recursive: true });
    writeFileSync(join(dest, "maps", "mvp.json"), '{"map":"mvp"}\n');
    writeFileSync(join(dest, "replays", "official", "battle-1.jsonl"), '{"tick":1}\n');
    const hMaps = execSync(`sha256sum "${join(dest, "maps", "mvp.json")}"`, { encoding: "utf8" }).split(/\s+/)[0];
    const hReplays = execSync(`sha256sum "${join(dest, "replays", "official", "battle-1.jsonl")}"`, {
      encoding: "utf8",
    }).split(/\s+/)[0];
    writeFileSync(
      join(dest, "manifest.sha256"),
      `${hMaps}  maps/mvp.json\n${hReplays}  replays/official/battle-1.jsonl\n`,
    );
    // Legacy real: SIN "schema" — exactamente lo que backup.sh escribía
    // antes de este fix (postgres 'ok' declarado, pero sin línea propia).
    writeFileSync(
      join(dest, "manifest.json"),
      '{"postgres":{"status":"ok","files":1},"secrets":{"status":"ok","files":1},"maps":{"status":"ok","files":1},"bot_sources":{"status":"empty","files":0},"replays":{"status":"ok","files":1},"assets":{"status":"empty","files":0}}',
    );
    // El dump SIGUE presente en el árbol (backup.sh legacy sí lo genera,
    // sólo no lo incluye en el manifest) — no debe contarse como residual.
    writeFileSync(join(dest, "pgdump-20250101000000.dump"), "dump-legacy-sin-checksum\n");

    const verifyOut = execFileSync("bash", [RESTORE, "--verify", dest], { encoding: "utf8" });
    // PASA (no aborta con "truncado o corrupto", el defecto 2 reportado).
    expect(verifyOut).toContain("integridad verificada");
    // Cobertura real: mapas y replays SÍ verificados.
    expect(verifyOut).toContain("mapas");
    expect(verifyOut).toContain("replays");
    // Honestidad exigida por el operador: dice EXPLÍCITAMENTE qué NO cubrió.
    expect(verifyOut).toContain("legacy");
    expect(verifyOut.toLowerCase()).toContain("no tiene checksum");
  });
});
