/**
 * V1 ADM-3 · `cli.ts reset-password`: recuperación local de emergencia (un solo administrador).
 *
 * PostgreSQL REAL embebido. El CLI se ejecuta como proceso hijo (el mismo `tsx cli.ts` del operador) para probar
 * stdin, los códigos de salida y que la contraseña no aparece en la salida ni se admite por argv.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startTestDb, type TestDbHandle } from "../testing/test-db.js";
import { hashPassword, verifyPassword } from "../auth/passwords.js";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const OLD = "clave-vieja-larga-001";
const NEW = "clave-nueva-larga-002";
let h: TestDbHandle;

beforeAll(async () => {
  h = await startTestDb();
}, 120_000);
afterAll(async () => {
  await h.stop();
});

function runCli(args: string[], stdin?: string) {
  return spawnSync("npx", ["tsx", CLI, "reset-password", ...args], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: h.url },
    timeout: 90_000,
  });
}

describe("cli.ts reset-password", () => {
  it("CLI_PROCESO: por stdin fija la contraseña, cierra sesiones, audita sin ella; cuenta inexistente = 3; política = 2; argv = 2", async () => {
    const [u] = await h
      .db("users")
      .insert({ email: "emergencia@ejemplo.test", password_hash: await hashPassword(OLD), display_name: "Emergencia" })
      .returning("id");
    await h.db("sessions").insert({
      user_id: u.id,
      refresh_token_hash: "h1",
      expires_at: new Date(Date.now() + 3_600_000),
      absolute_expires_at: new Date(Date.now() + 3_600_000),
    });

    const ok = runCli(["Emergencia@Ejemplo.Test", "--password-stdin"], `${NEW}\n`);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout + ok.stderr).not.toContain(NEW);
    expect(await verifyPassword((await h.db("users").where({ id: u.id }).first()).password_hash, NEW)).toBe(true);
    expect(
      await h.db("sessions").where({ user_id: u.id }).whereNull("revoked_at").count({ n: "*" }).first(),
    ).toMatchObject({
      n: "0",
    });
    const rows = await h.db("audit_log").where({ action: "admin.reset_password_cli", target: `user:${u.id}` });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(NEW);

    const unknown = runCli(["nadie@ejemplo.test", "--password-stdin"], `${NEW}\n`);
    expect(unknown.status).toBe(3);

    const weak = runCli(["emergencia@ejemplo.test", "--password-stdin"], "corta\n");
    expect(weak.status).toBe(2);
    expect(await verifyPassword((await h.db("users").where({ id: u.id }).first()).password_hash, NEW)).toBe(true);

    const argv = runCli(["emergencia@ejemplo.test", "--password=secreta-en-argv-123"]);
    expect(argv.status).toBe(2);
    expect(argv.stdout + argv.stderr).not.toContain("secreta-en-argv-123");
  }, 240_000);
});
