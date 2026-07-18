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

  it("--verify valida un manifest real y detecta corrupción", () => {
    // Simula un snapshot restaurado: mapas + replay oficial + manifest.
    const restored = join(tmp, "restored");
    mkdirSync(join(restored, "maps"), { recursive: true });
    mkdirSync(join(restored, "official"), { recursive: true });
    writeFileSync(join(restored, "maps", "mvp.json"), '{"map":"mvp"}');
    writeFileSync(join(restored, "official", "battle-1.jsonl"), '{"tick":1}\n');
    execSync("sha256sum maps/mvp.json official/battle-1.jsonl > manifest.sha256", { cwd: restored });

    // Íntegro → exit 0.
    const ok = execFileSync("bash", [RESTORE, "--verify", restored], { encoding: "utf8" });
    expect(ok).toContain("integridad verificada");

    // Corrupto (manipulación de un replay) → falla.
    writeFileSync(join(restored, "official", "battle-1.jsonl"), '{"tick":1,"score":999}\n');
    expect(() => execFileSync("bash", [RESTORE, "--verify", restored], { stdio: "pipe" })).toThrow();
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
