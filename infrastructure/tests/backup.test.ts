// Tests de T10.4 ejecutables SIN Docker: dry-run real de backup.sh y
// restore.sh, verificación de integridad real con manifest.sha256 (sha256sum),
// que los secretos no se filtran a la salida ni están versionados en git, y
// el cableado del servicio backup en el Compose. El simulacro completo de
// recuperación (VM vacía → plataforma, < 2 h) queda pendiente de entorno con
// Docker (runbook y cronómetro en docs/recuperacion.md).
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
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

describe("restore.sh (dry-run y verificación de integridad reales)", () => {
  it("--dry-run: plan completo con configuración", () => {
    const out = execFileSync("bash", [RESTORE, "--dry-run"], {
      encoding: "utf8",
      env: { ...process.env, RESTIC_REPOSITORY: "/mnt/nas/backups" },
    });
    expect(out).toContain("restic restore latest");
    expect(out).toContain("pg_restore");
    expect(out).toContain("CONFIG OK");
  });

  // Issue #107: la verificación comparaba rutas imposibles. El manifest usa
  // rutas lógicas (maps/…, official/…) pero `restic restore --target D`
  // reconstruye bajo D la jerarquía ABSOLUTA de origen, de modo que el
  // manifest queda junto al pgdump y NO junto a maps/ ni official/. Estos
  // tests parten SIEMPRE de ese layout real, no de uno montado a mano.
  //
  //   D/data/maps/…                                     (MAPS_DIR=/data/maps)
  //   D/data/bot-sources/…                              (BOT_SOURCES_DIR)
  //   D/tmp/backup-work/replays-official/official/…     (RECENT_OFFICIAL)
  //   D/tmp/backup-work/pgdump-*.dump
  //   D/tmp/backup-work/manifest.sha256
  function makeResticRestoreLayout(name: string) {
    const dest = join(tmp, name);
    rmSync(dest, { recursive: true, force: true });
    const maps = join(dest, "data", "maps");
    const work = join(dest, "tmp", "backup-work");
    const official = join(work, "replays-official", "official");
    mkdirSync(maps, { recursive: true });
    mkdirSync(official, { recursive: true });
    mkdirSync(join(dest, "data", "bot-sources"), { recursive: true });
    writeFileSync(join(maps, "mvp.json"), '{"map":"mvp"}');
    writeFileSync(join(dest, "data", "bot-sources", "bot.ts"), "export const bot = 1;\n");
    writeFileSync(join(official, "battle-1.jsonl"), '{"tick":1}\n');
    writeFileSync(join(work, "pgdump-20260808120000.dump"), "PGDUMP");
    const manifest = join(work, "manifest.sha256");
    // Manifest generado igual que en backup.sh (rutas lógicas).
    execSync(`find . -type f -exec sha256sum {} + | sed 's| \\./| maps/|' > ${manifest}`, { cwd: maps });
    execSync(`find official -type f -exec sha256sum {} + >> ${manifest}`, {
      cwd: join(work, "replays-official"),
    });
    return { dest, manifest, maps, official };
  }

  function verify(dest: string) {
    try {
      return { code: 0, out: execFileSync("bash", [RESTORE, "--verify", dest], { encoding: "utf8" }) };
    } catch (e: any) {
      return { code: (e.status as number) ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  }

  it("--verify: backup ÍNTEGRO en el layout que produce restic restore → éxito", () => {
    const { dest } = makeResticRestoreLayout("restic-ok");
    const { code, out } = verify(dest);
    expect(code).toBe(0);
    expect(out).toContain("integridad verificada");
    // No vacuidad: debe declarar cuántas entradas verificó (mapa + replay).
    expect(out).toContain("2/2");
  });

  it("--verify: checksum incorrecto (replay manipulado) → fallo", () => {
    const { dest, official } = makeResticRestoreLayout("restic-corrupto");
    writeFileSync(join(official, "battle-1.jsonl"), '{"tick":1,"score":999}\n');
    const { code, out } = verify(dest);
    expect(code).not.toBe(0);
    expect(out).not.toContain("integridad verificada");
  });

  it("--verify: fichero ausente en el árbol restaurado → fallo (no se ignora)", () => {
    const { dest, maps } = makeResticRestoreLayout("restic-ausente");
    rmSync(join(maps, "mvp.json"));
    const { code, out } = verify(dest);
    expect(code).not.toBe(0);
    expect(out).not.toContain("integridad verificada");
  });

  it("--verify: manifest VACÍO → fallo (fail-closed, jamás 'verificado' con cero entradas)", () => {
    const { dest, manifest } = makeResticRestoreLayout("restic-vacio");
    writeFileSync(manifest, "");
    const { code, out } = verify(dest);
    expect(code).not.toBe(0);
    expect(out).not.toContain("integridad verificada");
    expect(out).toContain("sin entradas");
  });

  it("--verify: manifest con líneas malformadas → fallo (no se saltan en silencio)", () => {
    const { dest, manifest } = makeResticRestoreLayout("restic-malformado");
    writeFileSync(manifest, "esto-no-es-un-checksum maps/mvp.json\n");
    const { code, out } = verify(dest);
    expect(code).not.toBe(0);
    expect(out).not.toContain("integridad verificada");
  });

  it("--verify: sin manifest en el destino → fallo", () => {
    const { dest, manifest } = makeResticRestoreLayout("restic-sin-manifest");
    rmSync(manifest);
    const { code, out } = verify(dest);
    expect(code).not.toBe(0);
    expect(out).not.toContain("integridad verificada");
  });

  it("--verify: destino inexistente → fallo", () => {
    const { code, out } = verify(join(tmp, "no-existe-este-destino"));
    expect(code).not.toBe(0);
    expect(out).not.toContain("integridad verificada");
  });
});

describe("backup.sh: el manifest no puede quedar vacío (fail-closed en origen)", () => {
  it("documenta en el dry-run que el manifest cubre mapas y replays oficiales", () => {
    const { out } = runDryRun({
      RESTIC_REPOSITORY: "/mnt/nas/backups/s9-ai-arena",
      RESTIC_PASSWORD_FILE: join(tmp, "restic_password.txt"),
    });
    expect(out).toContain("manifest.sha256");
  });

  it("el script aborta si MAPS_DIR no existe o si el manifest queda vacío", () => {
    const src = readFileSync(BACKUP, "utf8");
    expect(src).toContain("MAPS_DIR inexistente");
    expect(src).toContain("manifest de integridad vacío");
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
      "./secrets:/secrets:ro",
    ]) {
      expect(svc.volumes).toContain(v);
    }
    expect(svc.secrets).toContain("restic_password");
    expect(svc.environment.RESTIC_PASSWORD_FILE).toBe("/run/secrets/restic_password");
  });
});
