/**
 * TD-023 · `cli.ts create-admin`: primer administrador sin SQL.
 *
 * PostgreSQL REAL embebido (ADR-E7-002). El CLI se ejecuta como proceso hijo
 * (el mismo `tsx cli.ts` del operador), para probar stdin, el fichero 0600 y
 * que la contraseña no aparece en argv ni en la salida.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestDb, type TestDbHandle } from "../testing/test-db.js";
import { seedContent } from "./seeds/dev.js";
import { createAdmin, CreateAdminError } from "../services/create-admin.js";
import { verifyPassword } from "../auth/passwords.js";
import { parseCreateAdminArgs, PasswordInputError, readPasswordFile, stripTrailingNewline } from "./password-input.js";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const PW = "una-clave-larga-de-prueba-42";
let h: TestDbHandle;
let dir: string;

beforeAll(async () => {
  h = await startTestDb({ migrate: true });
  await seedContent(h.db);
  dir = mkdtempSync(join(tmpdir(), "create-admin-"));
}, 120_000);

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await h.stop();
});

beforeEach(async () => {
  await h.db("user_roles").del();
  await h.db("users").del();
});

function runCli(args: string[], stdin?: string) {
  return spawnSync("npx", ["tsx", CLI, "create-admin", ...args], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: h.url },
    timeout: 90_000,
  });
}

async function rolesOf(email: string): Promise<string[]> {
  const u = await h.db("users").where({ email }).first();
  if (!u) return [];
  return (await h.db("user_roles").where({ user_id: u.id }).select("role")).map((r) => r.role).sort();
}

describe("createAdmin (servicio)", () => {
  it("instalación vacía: crea el admin con roles user+developer+admin y contraseña hasheada", async () => {
    const r = await createAdmin(h.db, { email: "Op@Ejemplo.Test", displayName: "Operador", password: PW });
    expect(r.additional).toBe(false);
    expect(await rolesOf("op@ejemplo.test")).toEqual(["admin", "developer", "user"]);
    const u = await h.db("users").where({ email: "op@ejemplo.test" }).first();
    expect(u.password_hash).not.toContain(PW);
    expect(await verifyPassword(u.password_hash, PW)).toBe(true);
  });

  it("aplica la política de contraseñas (12) y no crea nada si falla", async () => {
    await expect(createAdmin(h.db, { email: "a@b.test", displayName: "A", password: "corta" })).rejects.toThrow(
      /al menos 12/,
    );
    expect(await h.db("users").count({ c: "*" }).first()).toMatchObject({ c: "0" });
  });

  it("se niega si ya existe un admin (admin_exists) y no escribe nada", async () => {
    await createAdmin(h.db, { email: "uno@ejemplo.test", displayName: "Uno", password: PW });
    const e = await createAdmin(h.db, { email: "dos@ejemplo.test", displayName: "Dos", password: PW }).catch((x) => x);
    expect(e).toBeInstanceOf(CreateAdminError);
    expect((e as CreateAdminError).code).toBe("admin_exists");
    expect(await rolesOf("dos@ejemplo.test")).toEqual([]);
  });

  it("con allowAdditionalAdmin crea el segundo y lo AUDITA como adicional, sin la contraseña", async () => {
    // audit_log es de sólo inserción (no se vacía entre tests): se filtra por el objetivo.
    const uno = await createAdmin(h.db, { email: "uno@ejemplo.test", displayName: "Uno", password: PW });
    const r = await createAdmin(h.db, {
      email: "dos@ejemplo.test",
      displayName: "Dos",
      password: PW,
      allowAdditionalAdmin: true,
    });
    expect(r.additional).toBe(true);
    const rows = await h
      .db("audit_log")
      .where({ action: "admin.create_cli" })
      .whereIn("target", [`user:${uno.userId}`, `user:${r.userId}`])
      .orderBy("id");
    expect(rows).toHaveLength(2);
    expect(rows[0].detail.additional).toBe(false);
    expect(rows[1].detail.additional).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(PW);
  });

  it("no promueve una cuenta existente (email_taken)", async () => {
    await h.db("users").insert({ email: "ya@ejemplo.test", password_hash: "x", display_name: "Ya" });
    const e = await createAdmin(h.db, { email: "ya@ejemplo.test", displayName: "Ya", password: PW }).catch((x) => x);
    expect((e as CreateAdminError).code).toBe("email_taken");
    expect(await rolesOf("ya@ejemplo.test")).toEqual([]);
  });

  it("dos altas simultáneas: sólo UNA gana el «primer admin»", async () => {
    const intentos = await Promise.allSettled(
      [1, 2, 3].map((i) => createAdmin(h.db, { email: `c${i}@ejemplo.test`, displayName: `C${i}`, password: PW })),
    );
    expect(intentos.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const n = await h.db("user_roles").where({ role: "admin" }).count({ c: "*" }).first();
    expect(n).toMatchObject({ c: "1" });
  });
});

describe("password-input (argv, fichero 0600)", () => {
  it("rechaza TODA forma de contraseña en argv", () => {
    for (const bad of [["--password", "x"], ["--password=x"], ["-p", "x"], ["-password=x"]]) {
      expect(() => parseCreateAdminArgs(["a@b.test", "N", "--password-stdin", ...bad])).toThrow(PasswordInputError);
    }
  });

  it("exige exactamente una fuente y dos posicionales", () => {
    expect(() => parseCreateAdminArgs(["a@b.test", "N"])).toThrow(/exactamente una fuente/);
    expect(() => parseCreateAdminArgs(["a@b.test", "N", "--password-stdin", "--password-file", "/x"])).toThrow(
      /exactamente una fuente/,
    );
    expect(() => parseCreateAdminArgs(["a@b.test", "--password-stdin"])).toThrow(/email/);
  });

  it("fichero con permisos abiertos se rechaza; 0600 se acepta; quita un único salto de línea", () => {
    const f = join(dir, "pw");
    writeFileSync(f, `${PW}\n`);
    chmodSync(f, 0o644);
    expect(() => readPasswordFile(f)).toThrow(/permisos/);
    chmodSync(f, 0o600);
    expect(readPasswordFile(f)).toBe(PW);
    expect(stripTrailingNewline("a\n\n")).toBe("a\n");
  });
});

describe("cli.ts create-admin (proceso real)", () => {
  it("por stdin: crea el admin, rc=0, y la contraseña no sale por stdout/stderr", async () => {
    const r = runCli(["cli@ejemplo.test", "Operador CLI", "--password-stdin"], `${PW}\n`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toContain(PW);
    expect(await rolesOf("cli@ejemplo.test")).toEqual(["admin", "developer", "user"]);
  }, 120_000);

  it("por fichero 0600: rc=0; por fichero 0644: rc=2 y no crea nada", async () => {
    const f = join(dir, "pw-cli");
    writeFileSync(f, PW);
    chmodSync(f, 0o644);
    const mal = runCli(["f@ejemplo.test", "F", "--password-file", f]);
    expect(mal.status).toBe(2);
    expect(await rolesOf("f@ejemplo.test")).toEqual([]);
    chmodSync(f, 0o600);
    const bien = runCli(["f@ejemplo.test", "F", "--password-file", f]);
    expect(bien.status, bien.stderr).toBe(0);
    expect(await rolesOf("f@ejemplo.test")).toEqual(["admin", "developer", "user"]);
  }, 180_000);

  it("contraseña en argv: rc=2 y no crea nada", async () => {
    const r = runCli(["x@ejemplo.test", "X", `--password=${PW}`]);
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).not.toContain(PW);
    expect(await rolesOf("x@ejemplo.test")).toEqual([]);
  }, 120_000);

  it("con un admin existente: rc=1 sin flag; rc=0 con --allow-additional-admin", async () => {
    expect(runCli(["a1@ejemplo.test", "A1", "--password-stdin"], PW).status).toBe(0);
    const sin = runCli(["a2@ejemplo.test", "A2", "--password-stdin"], PW);
    expect(sin.status).toBe(1);
    expect(sin.stderr).toMatch(/Ya existe al menos un administrador/);
    const con = runCli(["a2@ejemplo.test", "A2", "--password-stdin", "--allow-additional-admin"], PW);
    expect(con.status, con.stderr).toBe(0);
  }, 240_000);

  it("contraseña corta por stdin: rc=2 (política)", async () => {
    const r = runCli(["s@ejemplo.test", "S", "--password-stdin"], "corta\n");
    expect(r.status).toBe(2);
    expect(await rolesOf("s@ejemplo.test")).toEqual([]);
  }, 120_000);
});
