// fix/restore-snapshot-selection — restore.sh sólo sabía restaurar `latest`
// (`restic restore latest --tag …`, sin forma de fijar un snapshot conocido
// bueno). En el simulacro de restauración del 2026-08-18 esto se materializó
// de verdad: se decidió restaurar el snapshot 76a13494, pasaron dos días, el
// cron nocturno añadió snapshots nuevos, y restore.sh restauró 4fac59f8 (otro
// distinto) — se identificó por evidencia externa, no porque el script lo
// hiciera visible. En un desastre real, si el más reciente está corrupto, no
// había forma de retroceder.
//
// Este fichero cubre, SIN Docker (restic sustituido por un fake vía PATH,
// mismo patrón que backup.test.ts): `--snapshot <id>` pasa ese ID a
// `restic restore` en vez de `latest`; `--latest` explícito sigue
// funcionando igual que el comportamiento por defecto; un ID inexistente o
// de OTRO tag falla cerrado (nunca cae en silencio a `latest`, nunca
// restaura nada); y el ID resuelto queda en el log JSON antes y después de
// restaurar. El E2E real contra un backend sftp (restore-sftp-bootstrap.test.ts)
// no toca esta selección — carril separado, no se modifica aquí.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const RESTORE = join(here, "..", "backup", "restore.sh");
const BASH_BIN = execFileSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).trim();

let root: string;
let fakebin: string;
let resticLog: string;
let dest: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "restore-snap-sel-"));
  fakebin = join(root, "bin");
  dest = join(root, "dest");
  mkdirSync(fakebin, { recursive: true });
  mkdirSync(dest, { recursive: true });
  resticLog = join(root, "restic-calls.log");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

// restic falso que entiende lo suficiente del contrato real para probar la
// SELECCIÓN de snapshot (no la restauración de datos en sí, ya cubierta por
// el fake fiel de backup.test.ts):
//   restic snapshots --tag TAG --latest 1 --json   → snapshot más reciente
//                                                      con ese tag (o [])
//   restic snapshots <ID> --json                     → ese snapshot si
//                                                      restic lo conoce, con
//                                                      sus tags reales (o
//                                                      exit 1 si no existe)
//   restic restore <ID> --target DEST                → registra qué ID le
//                                                      llegó de verdad
//
// `known`: mapa id → tags[], el "repositorio" simulado. `latestId`: cuál es
// el más reciente (lo que debe devolver --latest 1).
function writeFakeRestic(
  fb: string,
  log: string,
  known: Record<string, string[]>,
  latestId: string,
  latestTag: string,
) {
  const knownCases = Object.entries(known)
    .map(([id, tags]) => `    "${id}") echo '[{"short_id":"${id}","tags":${JSON.stringify(tags)}}]'; exit 0 ;;`)
    .join("\n");
  const script = `#!/usr/bin/env bash
echo "$@" >> "${log}"
case "$1" in
  snapshots)
    if [ "$2" = "--tag" ]; then
      # snapshots --tag TAG --latest 1 --json
      tag="$3"
      if [ "$tag" = "${latestTag}" ]; then
        echo '[{"short_id":"${latestId}","tags":["${latestTag}"]}]'
      else
        echo '[]'
      fi
      exit 0
    fi
    id="$2"
    case "$id" in
${knownCases}
      *) echo "no matching ID found" >&2; exit 1 ;;
    esac
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
    echo "$id" > "$target/restored-snapshot-id.txt"
    exit 0
    ;;
esac
exit 1
`;
  writeFileSync(join(fb, "restic"), script, { mode: 0o755 });
}

function runRestore(args: string[]) {
  try {
    const out = execFileSync(BASH_BIN, [RESTORE, ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakebin}:${process.env.PATH}`, RESTIC_REPOSITORY: "/tmp/fake-repo" },
    });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status as number, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function resticCalls(): string[] {
  try {
    return readFileSync(resticLog, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function restoredId(): string | undefined {
  const files = readdirSync(dest);
  if (!files.includes("restored-snapshot-id.txt")) return undefined;
  return readFileSync(join(dest, "restored-snapshot-id.txt"), "utf8").trim();
}

describe("restore.sh --restore --snapshot <id> (selección explícita)", () => {
  it("pasa ese ID a `restic restore`, no `latest`", () => {
    writeFakeRestic(fakebin, resticLog, { goodid: ["s9-arena-data"] }, "aaaa1111", "s9-arena-data");
    const { code, out } = runRestore(["--restore", dest, "--snapshot", "goodid"]);
    expect(code).toBe(0);
    expect(restoredId()).toBe("goodid");
    const calls = resticCalls();
    expect(calls.some((c) => c.startsWith("restore goodid"))).toBe(true);
    expect(calls.some((c) => c.startsWith("restore latest"))).toBe(false);
    // Calibración: si restore.sh volviera a ignorar --snapshot y siempre
    // pidiera latest a restic (regresión exacta del defecto real), el fake
    // NUNCA reconocería "latest" como snapshot conocido (sólo conoce
    // "goodid" en este test) y `restic restore latest` fallaría con "no
    // matching ID found" -> code != 0. Es decir: esta aserción por sí sola
    // ya distingue el comportamiento correcto del regresivo.
    expect(out).toContain('"snapshot resuelto: goodid (tag=s9-arena-data)"');
  });

  it("--latest explícito sigue restaurando el snapshot más reciente (comportamiento de hoy)", () => {
    writeFakeRestic(fakebin, resticLog, { goodid: ["s9-arena-data"] }, "aaaa1111", "s9-arena-data");
    const { code } = runRestore(["--restore", dest, "--latest"]);
    expect(code).toBe(0);
    expect(restoredId()).toBe("aaaa1111");
    const calls = resticCalls();
    expect(calls.some((c) => c.startsWith("restore aaaa1111"))).toBe(true);
  });

  it("sin selector (comportamiento por defecto): igual que --latest, y el ID resuelto queda en el log", () => {
    writeFakeRestic(fakebin, resticLog, { goodid: ["s9-arena-data"] }, "aaaa1111", "s9-arena-data");
    const { code, out } = runRestore(["--restore", dest]);
    expect(code).toBe(0);
    expect(restoredId()).toBe("aaaa1111");
    // Constancia ANTES (qué se pidió) y DESPUÉS (qué se resolvió) — el
    // requisito explícito de "nunca debe quedar ambigüedad sobre qué se
    // restauró", incluso en el camino de compatibilidad.
    expect(out).toContain('"snapshot solicitado: latest (tag=s9-arena-data)"');
    expect(out).toContain('"snapshot resuelto: aaaa1111 (tag=s9-arena-data)"');
    expect(out).toContain("snapshot=aaaa1111");
  });

  it("ID inexistente → FALLA con la causa concreta y NO restaura nada", () => {
    writeFakeRestic(fakebin, resticLog, { goodid: ["s9-arena-data"] }, "aaaa1111", "s9-arena-data");
    const { code, out } = runRestore(["--restore", dest, "--snapshot", "doesnotexist"]);
    expect(code).not.toBe(0);
    expect(out).toContain("el snapshot 'doesnotexist' no existe en el repositorio");
    // Causa concreta, no un timeout ni un error genérico disfrazado.
    expect(out).toMatch(/no matching ID found/);
    expect(restoredId()).toBeUndefined();
    // `restic restore` nunca debió invocarse: el fallo cerró ANTES de tocar
    // datos.
    const calls = resticCalls();
    expect(calls.some((c) => c.startsWith("restore "))).toBe(false);
  });

  it("ID que existe pero es de OTRO tag → FALLA (no restaura secretos creyendo que son datos, ni viceversa)", () => {
    writeFakeRestic(fakebin, resticLog, { secretsnap: ["s9-arena-secrets"] }, "aaaa1111", "s9-arena-data");
    const { code, out } = runRestore(["--restore", dest, "--snapshot", "secretsnap"]);
    expect(code).not.toBe(0);
    expect(out).toContain("existe pero no tiene el tag 's9-arena-data'");
    expect(restoredId()).toBeUndefined();
    const calls = resticCalls();
    expect(calls.some((c) => c.startsWith("restore "))).toBe(false);
  });

  it("--restore-secrets con --snapshot de un tag de DATOS → FALLA igual, en el sentido contrario", () => {
    writeFakeRestic(fakebin, resticLog, { datasnap: ["s9-arena-data"] }, "aaaa1111", "s9-arena-secrets");
    const { code, out } = runRestore(["--restore-secrets", dest, "--snapshot", "datasnap"]);
    expect(code).not.toBe(0);
    expect(out).toContain("existe pero no tiene el tag 's9-arena-secrets'");
    expect(restoredId()).toBeUndefined();
  });

  it("--restore-secrets --snapshot <id> correcto: restaura ese ID, registrado en el log", () => {
    writeFakeRestic(fakebin, resticLog, { secretsnap: ["s9-arena-secrets"] }, "bbbb2222", "s9-arena-secrets");
    const { code, out } = runRestore(["--restore-secrets", dest, "--snapshot", "secretsnap"]);
    expect(code).toBe(0);
    expect(restoredId()).toBe("secretsnap");
    expect(out).toContain("snapshot=secretsnap");
  });

  it("--latest sin ningún snapshot con ese tag en el repositorio → FALLA cerrado (no hay 'nada que restaurar' en silencio)", () => {
    // El repo sólo conoce snapshots de otro tag: --latest para s9-arena-data
    // debe fallar, no restaurar por accidente algo del tag equivocado.
    writeFakeRestic(fakebin, resticLog, {}, "bbbb2222", "s9-arena-secrets");
    const { code, out } = runRestore(["--restore", dest, "--latest"]);
    expect(code).not.toBe(0);
    expect(out).toContain("no hay ningún snapshot con tag=s9-arena-data en el repositorio");
    expect(restoredId()).toBeUndefined();
  });

  it("uso incorrecto de --snapshot sin ID: exit 2, mensaje de uso, restic nunca se invoca", () => {
    writeFakeRestic(fakebin, resticLog, { goodid: ["s9-arena-data"] }, "aaaa1111", "s9-arena-data");
    const { code, out } = runRestore(["--restore", dest, "--snapshot"]);
    expect(code).toBe(2);
    expect(out).toContain("uso: restore.sh --restore");
    expect(resticCalls().length).toBe(0);
  });

  it("--snapshot '' (vacío): exit 2, FALLA cerrado, restic nunca se invoca (mismo caso que sin ID, valor vacío no es un ID válido)", () => {
    writeFakeRestic(fakebin, resticLog, { goodid: ["s9-arena-data"] }, "aaaa1111", "s9-arena-data");
    const { code, out } = runRestore(["--restore", dest, "--snapshot", ""]);
    expect(code).toBe(2);
    expect(out).toContain("uso: restore.sh --restore");
    expect(restoredId()).toBeUndefined();
    expect(resticCalls().length).toBe(0);
  });

  // ── El test que da sentido a todo el cambio ─────────────────────────────
  // El escenario real del simulacro del 2026-08-18: existe un snapshot
  // POSTERIOR (más reciente, el que `latest` elegiría) además del snapshot
  // conocido-bueno que el operador quiere. `--snapshot <anterior>` debe
  // restaurar EXACTAMENTE ese, ignorando que exista uno más nuevo — es
  // exactamente la capacidad de retroceder que faltaba.
  it("snapshot ANTERIOR (conocido-bueno) puede restaurarse aunque exista uno POSTERIOR más reciente", () => {
    writeFakeRestic(
      fakebin,
      resticLog,
      { "76a13494": ["s9-arena-data"], "4fac59f8": ["s9-arena-data"] },
      "4fac59f8", // el cron nocturno añadió este DESPUÉS: es lo que "latest" elegiría
      "s9-arena-data",
    );
    const { code, out } = runRestore(["--restore", dest, "--snapshot", "76a13494"]);
    expect(code).toBe(0);
    // El snapshot restaurado es el ANTERIOR pedido explícitamente, no el más
    // reciente del repositorio (que existe y es distinto: 4fac59f8).
    expect(restoredId()).toBe("76a13494");
    expect(restoredId()).not.toBe("4fac59f8");
    const calls = resticCalls();
    expect(calls.some((c) => c.startsWith("restore 76a13494"))).toBe(true);
    expect(calls.some((c) => c.startsWith("restore 4fac59f8"))).toBe(false);
    expect(out).toContain("snapshot=76a13494");
  });
});

// ── Integración con #119 (fix/manifest-pgdump-checksum): dos lógicas que
// NUNCA habían convivido en un test. resolve_snapshot() (esta rama) vive
// ÍNTEGRAMENTE en --restore/--restore-secrets; la bifurcación por `schema`
// (#119) vive ÍNTEGRAMENTE en --verify — no comparten ninguna variable ni
// estado del script (cada invocación de restore.sh es un proceso bash
// nuevo). El único punto de contacto real es de DATOS, no de código: lo
// que --restore --snapshot <id> trae al disco es justo lo que --verify lee
// después. El escenario que de verdad importa en una recuperación
// histórica: seleccionar EXPLÍCITAMENTE un snapshot viejo (anterior a #112/
// #119, contrato legacy — manifest.json SIN "schema", dump de PostgreSQL
// NUNCA con línea propia en manifest.sha256) y comprobar que --verify
// aplica la rama legacy correctamente: verifica lo que puede (maps/
// bot_sources/assets/replays) y declara EXPLÍCITAMENTE lo que no puede
// (el dump, sin checksum en ese manifest) — nunca lo oculta ni lo trata
// como si fuera schema>=2.
describe("Integración: --snapshot explícito + contrato LEGACY (schema<2) — #119 x fix/restore-snapshot-selection", () => {
  // writeFakeResticStore: variante de writeFakeRestic que además sabe
  // "restaurar" contenido de fichero REAL por ID (cp -a desde
  // store/<id>/), a diferencia del writeFakeRestic de arriba (que sólo
  // deja un marcador con el ID — suficiente para probar QUÉ ID se pide,
  // pero no para que --verify tenga algo real que leer). Necesario aquí
  // porque el test ejercita --restore seguido de un --verify real sobre lo
  // restaurado, con un manifest.json/manifest.sha256/dump construidos a
  // mano para representar fielmente un snapshot LEGACY genuino (mismo
  // criterio que usan los fixtures legacy de backup.test.ts: ausencia del
  // campo "schema", nunca "schema":1 explícito — así es como backup.sh
  // anterior a #119 lo produce de verdad).
  function writeFakeResticStore(
    fb: string,
    log: string,
    known: Record<string, string[]>,
    store: string,
    latestId: string,
    latestTag: string,
  ) {
    const knownCases = Object.entries(known)
      .map(([id, tags]) => `    "${id}") echo '[{"short_id":"${id}","tags":${JSON.stringify(tags)}}]'; exit 0 ;;`)
      .join("\n");
    const script = `#!/usr/bin/env bash
echo "$@" >> "${log}"
case "$1" in
  snapshots)
    if [ "$2" = "--tag" ]; then
      tag="$3"
      if [ "$tag" = "${latestTag}" ]; then
        echo '[{"short_id":"${latestId}","tags":["${latestTag}"]}]'
      else
        echo '[]'
      fi
      exit 0
    fi
    id="$2"
    case "$id" in
${knownCases}
      *) echo "no matching ID found" >&2; exit 1 ;;
    esac
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
esac
exit 0
`;
    writeFileSync(join(fb, "restic"), script, { mode: 0o755 });
  }

  // Construye, a mano, la staging directory de un snapshot LEGACY genuino
  // (anterior a #112/#119): un dump de PostgreSQL presente en el árbol
  // pero SIN línea en manifest.sha256, y manifest.json SIN el campo
  // "schema" — exactamente lo que backup.sh producía antes de estos dos
  // fixes. `maps/a.json` es la única fuente con contenido, para poder
  // afirmar checksums reales tras --verify.
  function buildLegacySnapshotStore(store: string, id: string) {
    const staging = join(store, id, "work", "staging");
    const mapsDir = join(staging, "maps");
    mkdirSync(mapsDir, { recursive: true });
    writeFileSync(join(mapsDir, "a.json"), '{"legacy":true}\n');
    const hash = execSync("sha256sum a.json", { cwd: mapsDir, encoding: "utf8" }).split(" ")[0];
    writeFileSync(join(staging, "manifest.sha256"), `${hash}  maps/a.json\n`);
    // El dump SÍ existe en el árbol (backup.sh siempre lo escribió) pero
    // NUNCA tuvo línea en manifest.sha256 en un legacy real — eso es
    // precisamente lo que hace a este snapshot "legacy" y no "schema>=2
    // con manifest vacío": aquí hay contenido en manifest.sha256 (maps), a
    // diferencia del caso "cuatro fuentes vacías" ya cubierto en
    // backup.test.ts.
    writeFileSync(join(staging, "pgdump-20250101120000.dump"), "contenido-de-dump-legacy-sin-checksum\n");
    // Manifest LEGACY genuino: SIN "schema" (backup.sh sólo empezó a
    // escribirlo desde #119) — postgres/secrets declaran 'ok' como
    // cualquier backup real, legacy o no; es la AUSENCIA de "schema" lo
    // que le dice a restore.sh que no debe exigir línea propia para el
    // dump.
    writeFileSync(
      join(staging, "manifest.json"),
      JSON.stringify({
        postgres: { status: "ok" },
        secrets: { status: "ok", files: 1 },
        maps: { status: "ok", files: 1 },
        bot_sources: { status: "empty", files: 0 },
        replays: { status: "empty", files: 0 },
        assets: { status: "empty", files: 0 },
      }),
    );
    return staging;
  }

  it("snapshot ANTIGUO (legacy) seleccionado con --snapshot explícito, aunque exista uno POSTERIOR con schema>=2: --restore trae el legacy, --verify aplica la rama legacy correctamente", () => {
    const store = join(root, "legacy-store");
    buildLegacySnapshotStore(store, "legacy-old-001");
    // Snapshot POSTERIOR (schema>=2) también "existe" en el repositorio —
    // es el que --latest elegiría — para probar que --snapshot explícito
    // lo ignora deliberadamente, igual que el test de snapshot
    // anterior/posterior de más arriba, ahora con contratos DISTINTOS a
    // cada lado.
    writeFakeResticStore(
      fakebin,
      resticLog,
      { "legacy-old-001": ["s9-arena-data"], "nuevo-002": ["s9-arena-data"] },
      store,
      "nuevo-002",
      "s9-arena-data",
    );

    // 1. --restore --snapshot <legacy> — nunca --latest, es la decisión
    // explícita de una recuperación histórica real.
    const restoreR = runRestore(["--restore", dest, "--snapshot", "legacy-old-001"]);
    expect(restoreR.code).toBe(0);
    expect(restoreR.out).toContain("snapshot solicitado: legacy-old-001 (tag=s9-arena-data)");
    expect(restoreR.out).toContain("snapshot resuelto: legacy-old-001 (tag=s9-arena-data)");
    expect(restoreR.out).toContain("snapshot=legacy-old-001");
    // Lo restaurado es EXACTAMENTE el legacy: el dump legacy está presente
    // en disco (backup.sh siempre lo escribió), aunque sin checksum propio.
    const dumpFound = execSync(`find "${dest}" -name 'pgdump-*.dump'`, { encoding: "utf8" }).trim();
    expect(dumpFound).toContain("pgdump-20250101120000.dump");

    // 2. --verify sobre lo restaurado: el schema (#119) se lee del
    // manifest.json RESTAURADO por el paso 1, no de nada que
    // resolve_snapshot() dejara en variables — son procesos bash
    // distintos, no hay estado compartido posible. Debe aplicar la rama
    // LEGACY: verificar maps de verdad, y declarar EXPLÍCITAMENTE que el
    // dump no tiene checksum en este manifest — nunca fallar exigiendo el
    // contrato schema>=2 (eso sería tratar un legacy real como si fuera
    // nuevo, el defecto D3-R2 que #119 tuvo que cerrar bajo NO APTO).
    const verifyR = (() => {
      try {
        return { code: 0, out: execFileSync(BASH_BIN, [RESTORE, "--verify", dest], { encoding: "utf8" }) };
      } catch (e: any) {
        return { code: e.status as number, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
      }
    })();
    expect(verifyR.code, verifyR.out).toBe(0);
    expect(verifyR.out).toContain("integridad verificada");
    expect(verifyR.out).toContain("mapas");
    // La frase que declara explícitamente el hueco de cobertura conocido —
    // el punto central de D3-R2: nunca ocultarlo, nunca darlo por bueno.
    expect(verifyR.out).toContain("snapshot legacy anterior a D3");
    expect(verifyR.out).toContain("el dump de PostgreSQL NO tiene checksum en este manifest");
    // Nunca debe aparecer "postgres" entre las fuentes CUBIERTAS (sería
    // afirmar un checksum que este manifest legacy nunca tuvo).
    expect(verifyR.out).not.toMatch(/integridad verificada: checksums de[^"]*postgres/);

    const calls = resticCalls();
    expect(calls.some((c) => c.startsWith("restore legacy-old-001"))).toBe(true);
    expect(calls.some((c) => c.startsWith("restore nuevo-002"))).toBe(false);
  });

  // ── Orden y ausencia de enmascaramiento ─────────────────────────────────
  // Si resolve_snapshot() falla (ID inválido), --restore debe salir ANTES
  // de escribir nada en $dest — así, un --verify posterior sobre ese mismo
  // destino nunca llega a ejecutar la lógica de `schema` con datos a
  // medias: falla por su propio motivo ("directorio no existe" o "manifest
  // no encontrado"), nunca por un fallo de contrato disfrazado. Un fallo
  // de selección de snapshot no debe poder ENMASCARARSE como un fallo de
  // verificación de contrato, ni al revés.
  it("un --snapshot inválido en --restore no deja NADA en destino: --verify posterior falla por 'no encontrado', nunca por lógica de schema", () => {
    const store = join(root, "legacy-store-2");
    buildLegacySnapshotStore(store, "legacy-old-001");
    writeFakeResticStore(
      fakebin,
      resticLog,
      { "legacy-old-001": ["s9-arena-data"] },
      store,
      "legacy-old-001",
      "s9-arena-data",
    );

    const restoreR = runRestore(["--restore", dest, "--snapshot", "id-que-no-existe"]);
    expect(restoreR.code).not.toBe(0);
    expect(restoreR.out).toContain("no existe en el repositorio");
    // $dest sigue vacío: resolve_snapshot() falló ANTES de invocar
    // `restic restore`.
    expect(readdirSync(dest)).toEqual([]);

    const verifyR = (() => {
      try {
        return { code: 0, out: execFileSync(BASH_BIN, [RESTORE, "--verify", dest], { encoding: "utf8" }) };
      } catch (e: any) {
        return { code: e.status as number, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
      }
    })();
    expect(verifyR.code).not.toBe(0);
    // Falla por AUSENCIA de manifest, no por nada relacionado con `schema`
    // — la lógica de contrato de #119 ni siquiera llega a ejecutarse
    // porque no hay manifest.json que leer.
    expect(verifyR.out).toContain("manifest.sha256 no encontrado");
    expect(verifyR.out).not.toContain("schema");
    const calls = resticCalls();
    expect(calls.some((c) => c.startsWith("restore "))).toBe(false);
  });
});
