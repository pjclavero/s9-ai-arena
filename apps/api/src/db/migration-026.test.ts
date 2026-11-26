/**
 * V1 · TORNEOS POR INVITACIÓN · Migración 026_tournament_invitations contra PostgreSQL REAL:
 *  1. aplicada, detrás de la 024 (la 025 la reserva ADM-3, #347);
 *  2. invariantes: modalidad cerrada con 'open' por defecto, sha256 hex de 64, una sola invitación
 *     activa por torneo, borrado en cascada con el torneo;
 *  3. ROLLBACK POR NOMBRE: se van su tabla y su columna y se puede volver a aplicar.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../testing/test-db.js";
import { seedDev, DEFAULT_RULESET_ID } from "./seeds/dev.js";
import { MIGRATIONS, migrateNamed, NAMED_ROLLBACK_ALLOWED, rollbackNamed } from "./migrations.js";

let h: TestDbHandle;
const NAME = "026_tournament_invitations";
const SHA = "a".repeat(64);

async function tournament(): Promise<string> {
  const [t] = await h
    .db("tournaments")
    .insert({ name: "m026", format: "league", mode: "deathmatch", ruleset_id: DEFAULT_RULESET_ID, state: "open" })
    .returning("id");
  return t.id as string;
}
async function tables(): Promise<string[]> {
  const r = await h.db.raw(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
  return r.rows.map((x: { tablename: string }) => x.tablename);
}
async function hasEnrollment(): Promise<boolean> {
  const r = await h.db.raw(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'tournaments' AND column_name = 'enrollment'`,
  );
  return r.rows.length === 1;
}

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
}, 120_000);
afterAll(async () => {
  await h.stop();
});

describe("migración 026_tournament_invitations", () => {
  it("M026_APPLIED aplicada, detrás de la 024 y revertible por nombre", async () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(names).toContain(NAME);
    expect(names[names.indexOf(NAME) - 1]).toBe("024_replay_artifacts");
    expect(NAMED_ROLLBACK_ALLOWED).toContain(NAME);
    expect(await tables()).toContain("tournament_invitations");
    expect(await hasEnrollment()).toBe(true);
  });

  it("M026_INVARIANTS modalidad cerrada (open por defecto), sha256 hex y UNA invitación activa por torneo", async () => {
    const id = await tournament();
    expect((await h.db("tournaments").where({ id }).first()).enrollment).toBe("open");
    await expect(h.db("tournaments").where({ id }).update({ enrollment: "secret" })).rejects.toMatchObject({
      code: "23514",
    });
    await h.db("tournament_invitations").insert({ tournament_id: id, token_sha256: SHA });
    // Segunda activa: viola el índice único parcial.
    await expect(
      h.db("tournament_invitations").insert({ tournament_id: id, token_sha256: "b".repeat(64) }),
    ).rejects.toMatchObject({ code: "23505" });
    for (const bad of ["XYZ", "a".repeat(63), "A".repeat(64)]) {
      await expect(
        h.db("tournament_invitations").insert({ tournament_id: id, token_sha256: bad }),
      ).rejects.toMatchObject({
        code: "23514",
      });
    }
    // Revocada la primera, cabe otra activa.
    await h.db("tournament_invitations").where({ tournament_id: id }).update({ revoked_at: h.db.fn.now() });
    await h.db("tournament_invitations").insert({ tournament_id: id, token_sha256: "c".repeat(64) });
    await h.db("tournaments").where({ id }).del();
    expect(await h.db("tournament_invitations").where({ tournament_id: id })).toHaveLength(0);
  });

  it("M026_PREEXISTING filas ANTERIORES a la 026 quedan open y el down deja tournaments idéntico (sonda RM1)", async () => {
    await rollbackNamed(h.db, NAME);
    const [t] = await h
      .db("tournaments")
      .insert({ name: "pre026", format: "league", mode: "deathmatch", ruleset_id: DEFAULT_RULESET_ID, state: "open" })
      .returning("*");
    expect("enrollment" in t).toBe(false);
    const before = await h.db("tournaments").orderBy("id");
    await migrateNamed(h.db, NAME);
    expect((await h.db("tournaments").where({ id: t.id }).first()).enrollment).toBe("open");
    const all = (await h.db("tournaments").select("enrollment")) as { enrollment: string }[];
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((r) => r.enrollment === "open")).toBe(true);
    // Con datos propios de la 026, el down deja el resto de columnas y filas tal cual.
    await h.db("tournaments").where({ id: t.id }).update({ enrollment: "invitation" });
    await h.db("tournament_invitations").insert({ tournament_id: t.id, token_sha256: "d".repeat(64) });
    await rollbackNamed(h.db, NAME);
    expect(await h.db("tournaments").orderBy("id")).toEqual(before);
    await migrateNamed(h.db, NAME);
    expect((await h.db("tournaments").where({ id: t.id }).first()).enrollment).toBe("open");
  });

  it("M026_ROLLBACK rollback por nombre quita tabla y columna; se puede volver a aplicar", async () => {
    await rollbackNamed(h.db, NAME);
    expect(await tables()).not.toContain("tournament_invitations");
    expect(await hasEnrollment()).toBe(false);
    await migrateNamed(h.db, NAME);
    expect(await tables()).toContain("tournament_invitations");
    expect(await hasEnrollment()).toBe(true);
  });
});
