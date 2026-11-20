/**
 * MG · FAIL-CLOSED del cableado de ajustes en el tournament-worker (el que usa main.ts).
 *  - WORKER_FAILCLOSED_STARTUP: BD caída al arrancar con el entorno en true ⇒ FALSE.
 *  - WORKER_FAILCLOSED_HOT: BD caída en caliente ⇒ último valor sólo 3 × refreshMs; luego FALSE.
 *  - El worker no crea la fila (sin fila ⇒ FALSE, no el entorno).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import type { Db } from "../../api/src/db/connection.js";
import { startWorkerRuntimeSettings } from "./runtime-settings-wiring.js";

let h: TestDbHandle;

function flaky(db: Db) {
  let down = false;
  const f: any = (t: string) => {
    if (down) throw new Error("db down");
    return db(t);
  };
  f.transaction = db.transaction.bind(db);
  f.fn = db.fn;
  return { db: f as Db, setDown: (v: boolean) => (down = v) };
}

beforeAll(async () => {
  h = await startTestDb();
}, 180_000);
afterEach(() => {
  delete process.env.S9_PUBLIC_SPECTATE_ENABLED;
});
afterAll(async () => {
  await h.stop();
});

async function setRow(spectate: boolean) {
  await h.db("app_runtime_settings").del();
  await h
    .db("app_runtime_settings")
    .insert({ id: 1, public_spectate_enabled: spectate, public_replays_enabled: false });
}

describe("MG · WORKER_FAILCLOSED_STARTUP", () => {
  it("BD caída al arrancar con S9_PUBLIC_SPECTATE_ENABLED=true ⇒ el gateway recibe FALSE", async () => {
    process.env.S9_PUBLIC_SPECTATE_ENABLED = "true";
    const f = flaky(h.db);
    f.setDown(true);
    const w = await startWorkerRuntimeSettings(f.db, { refreshMs: 500 });
    try {
      expect(w.publicSpectateEnabled()).toBe(false);
    } finally {
      w.store.stop();
    }
  });

  it("BD viva sin fila ⇒ FALSE y el worker NO crea la fila; con fila a true ⇒ true", async () => {
    process.env.S9_PUBLIC_SPECTATE_ENABLED = "true";
    await h.db("app_runtime_settings").del();
    const w = await startWorkerRuntimeSettings(h.db, { refreshMs: 500 });
    try {
      expect(w.publicSpectateEnabled()).toBe(false);
      expect(await h.db("app_runtime_settings").first()).toBeUndefined();
      await setRow(true);
      await w.store.refresh();
      expect(w.publicSpectateEnabled()).toBe(true);
    } finally {
      w.store.stop();
    }
  });
});

describe("MG · WORKER_FAILCLOSED_HOT", () => {
  it("BD caída en caliente: true durante la ventana y FALSE al vencer; se recupera al volver", async () => {
    await setRow(true);
    const f = flaky(h.db);
    let t = 5_000_000;
    const w = await startWorkerRuntimeSettings(f.db, { refreshMs: 1000, now: () => t });
    try {
      expect(w.publicSpectateEnabled()).toBe(true);
      f.setDown(true);
      t += 2500;
      await w.store.refresh();
      expect(w.publicSpectateEnabled()).toBe(true);
      t += 1000;
      await w.store.refresh();
      expect(w.publicSpectateEnabled()).toBe(false);
      f.setDown(false);
      await w.store.refresh();
      expect(w.publicSpectateEnabled()).toBe(true);
    } finally {
      w.store.stop();
    }
  });
});
