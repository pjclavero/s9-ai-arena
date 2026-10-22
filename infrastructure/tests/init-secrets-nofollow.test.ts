// TD-064 · init-secrets.sh no sigue enlaces ni escribe en directorios ajenos.
//
// El script lo ejecuta root sobre infrastructure/secrets, que en producción era
// de un usuario sin privilegios. La versión anterior seguía enlaces en gen()
// ([ -s f ] y `> f`), en harden() (chown/chmod sin -h) y en
// `openssl -out artifact_verify_key.pem.tmp`: un enlace plantado acababa en
// escritura o cambio de dueño/modo de un fichero arbitrario del host.
//
// Prueba capaz de ponerse ROJA: con INIT_SECRETS_UNDER_TEST apuntando al
// script anterior (4cc7651) los casos de enlace/hardlink fallan, porque la
// víctima cambia. Los casos sin root valen en cualquier runner (la víctima es
// del propio usuario: chmod sí la cambia). Los casos con root real se ejecutan
// en un user namespace (unshare --map-root-user --map-auto); si el runner no lo
// permite se OMITEN de forma explícita y visible (skipped no es PASS).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, copyFileSync, writeFileSync, symlinkSync, linkSync, rmSync,
  lstatSync, readFileSync, readlinkSync, chmodSync, existsSync, readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, createPublicKey } from "node:crypto";

const REPO = resolve(__dirname, "../..");
const SUT = process.env.INIT_SECRETS_UNDER_TEST
  ? resolve(process.env.INIT_SECRETS_UNDER_TEST)
  : join(REPO, "infrastructure/scripts/init-secrets.sh");
const ROOT_SCENARIOS = join(__dirname, "fixtures/init-secrets-root-scenarios.sh");

const GENERATED = [
  "postgres_password.txt", "jwt_secret.txt", "grafana_admin_password.txt", "restic_password.txt",
  "arena_engine_internal_secret.txt", "replay_ingest_secret.txt", "artifact_signing_key.pem",
  "artifact_verify_key.pem", "stream_key.txt", "restic_ssh_key", "restic_ssh_known_hosts",
];

let base: string;
let secrets: string;
let victim: string;
const uid = process.getuid ? process.getuid() : 0;

function run(env: Record<string, string> = {}) {
  return spawnSync("bash", [join(base, "infrastructure/scripts/init-secrets.sh")], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", RUNTIME_UID: String(uid), RUNTIME_GID: String(process.getgid?.() ?? 0), ...env },
  });
}
function sha(p: string) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }
function victimState() { const s = lstatSync(victim); return { mode: (s.mode & 0o7777).toString(8), size: s.size, sha: sha(victim) }; }
function tree() {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n); const r = rel ? `${rel}/${n}` : n; const s = lstatSync(p);
      if (s.isSymbolicLink()) out[r] = `l:${readlinkSync(p)}`;
      else if (s.isDirectory()) { out[r] = "d"; walk(p, r); }
      else out[r] = `f:${(s.mode & 0o7777).toString(8)}:${s.nlink}:${sha(p)}`;
    }
  };
  walk(secrets, "");
  return out;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "td064-"));
  mkdirSync(join(base, "infrastructure/scripts"), { recursive: true });
  secrets = join(base, "infrastructure/secrets");
  mkdirSync(secrets, { mode: 0o755 });
  copyFileSync(SUT, join(base, "infrastructure/scripts/init-secrets.sh"));
  victim = join(base, "victim");
  writeFileSync(victim, "victima-legitima\n", { mode: 0o644 });
  chmodSync(victim, 0o644);
});
afterEach(() => {
  spawnSync("chmod", ["-R", "u+rwX", base]);
  rmSync(base, { recursive: true, force: true });
});

describe("TD-064 · init-secrets.sh: funcionamiento normal", () => {
  it("genera todo en un directorio limpio, regular y 0400, y la pública casa con la privada", () => {
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    for (const f of GENERATED) {
      const s = lstatSync(join(secrets, f));
      expect(s.isFile(), f).toBe(true);
      expect(s.nlink, f).toBe(1);
      expect((s.mode & 0o777).toString(8), f).toBe("400");
    }
    expect(lstatSync(join(secrets, "tls/fullchain.pem")).isFile()).toBe(true);
    const pub = createPublicKey(readFileSync(join(secrets, "artifact_signing_key.pem")))
      .export({ type: "spki", format: "pem" }).toString();
    expect(readFileSync(join(secrets, "artifact_verify_key.pem"), "utf8")).toBe(pub);
    expect(readdirSync(secrets).filter((n) => n.includes(".tmp") || n.startsWith(".init-secrets."))).toEqual([]);
  });

  it("es idempotente: la segunda ejecución no cambia ni un byte ni un modo", () => {
    expect(run().status).toBe(0);
    const before = tree();
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(tree()).toEqual(before);
  });

  it("S9_SECRETS_DIR: una copia del script fuera del árbol escribe en el directorio indicado", () => {
    const copy = join(base, "copia-de-confianza.sh");
    copyFileSync(SUT, copy);
    const r = spawnSync("bash", [copy], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", RUNTIME_UID: String(uid), RUNTIME_GID: String(process.getgid?.() ?? 0), S9_SECRETS_DIR: secrets },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(lstatSync(join(secrets, "jwt_secret.txt")).isFile()).toBe(true);
  });

  it("por stdin sin S9_SECRETS_DIR se niega (antes derivaba DIR=/secrets)", () => {
    const r = spawnSync("bash", ["-s"], {
      encoding: "utf8", input: readFileSync(SUT), cwd: join(base, "infrastructure/scripts"),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("S9_SECRETS_DIR");
  });

  it("respeta el enlace admitido restic_ssh_key -> s9backup_ssh_key (destino literal sin '/')", () => {
    writeFileSync(join(secrets, "s9backup_ssh_key"), "clave-ficticia\n", { mode: 0o600 });
    symlinkSync("s9backup_ssh_key", join(secrets, "restic_ssh_key"));
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(lstatSync(join(secrets, "restic_ssh_key")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(secrets, "restic_ssh_key"))).toBe("s9backup_ssh_key");
    expect((lstatSync(join(secrets, "s9backup_ssh_key")).mode & 0o777).toString(8)).toBe("400");
    expect(readFileSync(join(secrets, "s9backup_ssh_key"), "utf8")).toBe("clave-ficticia\n");
  });
});

describe("TD-064 · init-secrets.sh: enlaces y hardlinks plantados no tocan nada fuera", () => {
  const cases: Array<[string, () => void]> = [
    ["jwt_secret.txt -> víctima (gen/harden)", () => symlinkSync(victim, join(secrets, "jwt_secret.txt"))],
    ["jwt_secret.txt -> ../../victim (relativo)", () => symlinkSync("../../victim", join(secrets, "jwt_secret.txt"))],
    ["artifact_verify_key.pem.tmp -> víctima (openssl -out)", () => symlinkSync(victim, join(secrets, "artifact_verify_key.pem.tmp"))],
    ["artifact_verify_key.pem -> víctima", () => symlinkSync(victim, join(secrets, "artifact_verify_key.pem"))],
    ["stream_key.txt -> víctima", () => symlinkSync(victim, join(secrets, "stream_key.txt"))],
    ["restic_ssh_known_hosts -> víctima", () => symlinkSync(victim, join(secrets, "restic_ssh_known_hosts"))],
    ["jwt_secret.txt = hardlink de la víctima", () => linkSync(victim, join(secrets, "jwt_secret.txt"))],
  ];
  for (const [name, plant] of cases) {
    it(`${name}: la víctima no cambia (modo, tamaño, sha)`, () => {
      const before = victimState();
      plant();
      run();
      expect(victimState()).toEqual(before);
    });
  }

  it("enlace a destino INEXISTENTE (gen lo crearía): el destino no llega a existir", () => {
    const target = join(base, "nuevo-fuera");
    symlinkSync(target, join(secrets, "replay_ingest_secret.txt"));
    run();
    expect(existsSync(target)).toBe(false);
  });

  it("enlace a fichero VACÍO (gen lo sobrescribiría): sigue vacío", () => {
    const target = join(base, "vacio-fuera");
    writeFileSync(target, "", { mode: 0o644 });
    symlinkSync(target, join(secrets, "postgres_password.txt"));
    run();
    expect(readFileSync(target, "utf8")).toBe("");
    expect((lstatSync(target).mode & 0o777).toString(8)).toBe("644");
  });

  it("tls/fullchain.pem como enlace colgante (openssl req -out): no se crea fuera", () => {
    const target = join(base, "cert-fuera");
    mkdirSync(join(secrets, "tls"), { mode: 0o755 });
    symlinkSync(target, join(secrets, "tls/fullchain.pem"));
    run();
    expect(existsSync(target)).toBe(false);
  });

  it("secrets/ sustituido por un enlace a otro directorio: no escribe en él", () => {
    const other = join(base, "otro");
    mkdirSync(other);
    rmSync(secrets, { recursive: true });
    symlinkSync(other, secrets);
    const r = run();
    expect(r.status).not.toBe(0);
    expect(readdirSync(other)).toEqual([]);
  });

  it("un enlace no admitido aborta con rc != 0 (fail-closed) antes de generar los siguientes", () => {
    symlinkSync(victim, join(secrets, "jwt_secret.txt"));
    const r = run();
    expect(r.status).not.toBe(0);
    expect(existsSync(join(secrets, "grafana_admin_password.txt"))).toBe(false);
  });
});

// ---------------------------------------------------------------- root real
const probe = spawnSync("unshare", ["--map-root-user", "--map-auto", "true"], { encoding: "utf8" });
const userns = probe.status === 0;
describe.skipIf(!userns)("TD-064 · como root (user namespace con propietarios reales)", () => {
  it("se niega en un dir ajeno, se apropia con ADOPT, y lo plantado antes sigue bloqueando", () => {
    const r = spawnSync("unshare", ["--map-root-user", "--map-auto", "bash", ROOT_SCENARIOS, SUT, base], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const res = Object.fromEntries(
      r.stdout.trim().split("\n").filter(Boolean).map((l) => { const j = JSON.parse(l); return [j.id, j]; }),
    );
    expect(res["R1-refuse"].rc).not.toBe(0);
    expect(res["R1-refuse"].files).toBe(0);
    expect(res["R1-refuse"].dir_owner).toBe("1002:1002 755");
    expect(res["R2-adopt"].rc).toBe(0);
    expect(res["R2-adopt"].dir_owner).toBe("0:0 755");
    for (const id of ["R3-adopt-planted-link", "R4-adopt-tmp-link"]) {
      expect(res[id].victim_after, id).toBe(res[id].victim_before);
    }
    expect(res["R3-adopt-planted-link"].rc).not.toBe(0);
    expect(res["R5-adopt-dangling"].victim_after).toBe("absent");
    expect(res["R6-root-dir-allowed-link"].rc).toBe(0);
    expect(res["R6-root-dir-allowed-link"].victim_after).toBe("symbolic link 400 1000:1000");
    expect(res["R7-secrets-is-link"].rc).not.toBe(0);
    expect(res["R7-secrets-is-link"].evil_files).toBe(0);
  });
});
