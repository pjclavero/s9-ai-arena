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
import { execFileSync } from "node:child_process";
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
