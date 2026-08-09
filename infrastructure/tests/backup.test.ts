// Tests de T10.4 ejecutables SIN Docker: dry-run real de backup.sh y
// restore.sh, verificación de integridad real con manifest.sha256 (sha256sum),
// que los secretos no se filtran a la salida ni están versionados en git, y
// el cableado del servicio backup en el Compose. El simulacro completo de
// recuperación (VM vacía → plataforma, < 2 h) queda pendiente de entorno con
// Docker (runbook y cronómetro en docs/recuperacion.md).
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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

// ── Camino real (#110b): clasificación ok/empty/error de fuentes ───────────
// El backup real nunca se había ejercitado en tests (sólo --dry-run). Aquí
// se inyectan binarios falsos de restic/pg_dump vía PATH en un directorio
// temporal, para probar SUCCESS/PARTIAL/FULL FAILURE sin depender de un
// backend restic ni de una BD real.
describe("backup.sh camino real (restic/pg_dump falsos vía PATH)", () => {
  let root: string;
  let fakebin: string;
  let resticLog: string;

  function makeDirs() {
    root = mkdtempSync(join(tmpdir(), "e10-real-"));
    fakebin = join(root, "bin");
    mkdirSync(fakebin, { recursive: true });
    resticLog = join(root, "restic-calls.log");
    for (const dir of ["maps", "bot-sources", "replays", "assets", "secrets", "work"]) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    writeFileSync(join(root, "secrets", "restic_password.txt"), "s3cr3t-restic", { mode: 0o600 });
    writeFileSync(join(root, "secrets", "postgres_password.txt"), "s3cr3t-pg", { mode: 0o600 });
  }

  // pg_dump falso: crea el fichero de salida (-f es el último argumento
  // relevante) y sale con éxito, simulando un dump correcto.
  function writeFakePgDumpOk() {
    writeFileSync(
      join(fakebin, "pg_dump"),
      `#!/usr/bin/env bash\nfor ((i=1;i<=$#;i++)); do if [ "\${!i}" = "-f" ]; then j=$((i+1)); : > "\${!j}"; fi; done\nexit 0\n`,
      { mode: 0o755 },
    );
  }
  function writeFakePgDumpFail() {
    writeFileSync(join(fakebin, "pg_dump"), `#!/usr/bin/env bash\necho "pg_dump: conexion rechazada" >&2\nexit 1\n`, {
      mode: 0o755,
    });
  }

  // restic falso: registra en un log cada invocación (subcomando + args) y
  // siempre sale con éxito, para poder comprobar QUÉ se le pasó a "backup".
  // También copia manifest.json fuera de $WORK_DIR ANTES de que el trap EXIT
  // del script real lo borre, para poder inspeccionarlo tras la ejecución.
  function writeFakeResticOk() {
    writeFileSync(
      join(fakebin, "restic"),
      `#!/usr/bin/env bash\necho "$@" >> "${resticLog}"\nfor a in "$@"; do case "$a" in *manifest.json) cp "$a" "${join(root, "manifest.json")}" ;; esac; done\nexit 0\n`,
      { mode: 0o755 },
    );
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
          METRICS_DIR: join(root, "metrics"),
          ...env,
        },
      });
      return { code: 0, out };
    } catch (e: any) {
      return { code: e.status as number, out: `${e.stdout}${e.stderr}` };
    }
  }

  it("todas las fuentes no críticas vacías: exit 0 (SUCCESS) y restic SE EJECUTA", () => {
    makeDirs();
    writeFakePgDumpOk();
    writeFakeResticOk();
    const { code, out } = runReal({});
    expect(code).toBe(0);
    expect(out).toContain("backup SUCCESS");
    const calls = readFileSync(resticLog, "utf8");
    expect(calls).toContain("backup --tag s9-arena-data");
    expect(calls).toContain("backup --tag s9-arena-secrets");
    const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
    expect(manifest.maps.status).toBe("empty");
  });

  it("fuente inexistente (directorio nunca creado): empty, no aborta", () => {
    makeDirs();
    rmSync(join(root, "assets"), { recursive: true, force: true }); // no existe de verdad
    writeFakePgDumpOk();
    writeFakeResticOk();
    const { code, out } = runReal({});
    expect(code).toBe(0);
    expect(out).not.toContain("error");
    const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
    expect(manifest.assets.status).toBe("empty");
  });

  it("fuente no crítica con error real (permiso denegado): exit 2 (PARTIAL) y restic SE EJECUTA igual", () => {
    makeDirs();
    writeFileSync(join(root, "maps", "mapa.json"), '{"ok":true}');
    execSync(`chmod 000 ${join(root, "maps")}`);
    writeFakePgDumpOk();
    writeFakeResticOk();
    try {
      const { code, out } = runReal({});
      expect(code).toBe(2);
      expect(out).toContain("PARTIAL SUCCESS");
      const calls = readFileSync(resticLog, "utf8");
      expect(calls).toContain("backup --tag s9-arena-data"); // restic SÍ corrió
      const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
      expect(manifest.maps.status).toBe("error");
    } finally {
      execSync(`chmod 755 ${join(root, "maps")}`); // permite que rmSync limpie después
    }
  });

  it("pg_dump falla (fuente crítica): exit 1 (FULL FAILURE) y restic NO se ejecuta", () => {
    makeDirs();
    writeFakePgDumpFail();
    writeFakeResticOk();
    const { code, out } = runReal({});
    expect(code).toBe(1);
    expect(out).toContain("FULL FAILURE");
    expect(existsSync(resticLog)).toBe(false); // restic nunca se invocó
  });

  it("el dump de PostgreSQL sobrevive a un error de fuente secundaria: restic recibe el dump", () => {
    makeDirs();
    execSync(`chmod 000 ${join(root, "replays")}`);
    // Truco: para forzar un error de lectura real en un directorio "replays"
    // sin permisos, find fallará con "Permission denied" al listarlo.
    writeFakePgDumpOk();
    writeFakeResticOk();
    try {
      const { code } = runReal({});
      expect(code).toBe(2);
      const calls = readFileSync(resticLog, "utf8");
      const dataCall = calls.split("\n").find((l) => l.startsWith("backup --tag s9-arena-data"));
      expect(dataCall).toBeDefined();
      expect(dataCall).toMatch(/pgdump-\d+\.dump/); // el dump SÍ llegó a restic
    } finally {
      execSync(`chmod 755 ${join(root, "replays")}`);
    }
  });

  it("manifest.json refleja la clasificación correcta de cada fuente", () => {
    makeDirs();
    writeFileSync(join(root, "bot-sources", "bot.py"), "print(1)");
    writeFakePgDumpOk();
    writeFakeResticOk();
    const { code } = runReal({});
    expect(code).toBe(0);
    const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
    expect(manifest.postgres.status).toBe("ok");
    expect(manifest.secrets.status).toBe("ok");
    expect(manifest.bot_sources).toEqual({ status: "ok", files: 1 });
    expect(manifest.maps.status).toBe("empty");
  });

  it("ningún valor de secreto aparece en la salida, logs ni manifest", () => {
    makeDirs();
    writeFakePgDumpOk();
    writeFakeResticOk();
    const { out } = runReal({});
    expect(out).not.toContain("s3cr3t-restic");
    expect(out).not.toContain("s3cr3t-pg");
    const manifest = readFileSync(join(root, "manifest.json"), "utf8");
    expect(manifest).not.toContain("s3cr3t");
  });
});

describe("restore.sh --verify: manifest ambiguo o ausente (OBS-1)", () => {
  it("sufijo ambiguo (nombre de fichero parecido pero no manifest.sha256): falla porque no hay manifest real", () => {
    const dir = mkdtempSync(join(tmpdir(), "e10-restore-ambig-"));
    try {
      // Un fichero cuyo nombre "contiene" el sufijo pero no es manifest.sha256
      // exacto no debe colar como manifest válido (find -name es literal, pero
      // se prueba explícitamente el caso "cero manifests reales").
      writeFileSync(join(dir, "not-a-manifest.sha256.bak"), "deadbeef  maps/x.json\n");
      expect(() => execFileSync("bash", [RESTORE, "--verify", dir], { stdio: "pipe" })).toThrow();
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
});
