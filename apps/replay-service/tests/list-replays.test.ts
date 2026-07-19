/**
 * R7-A · Listado global de replays (`listReplays` + `GET /replays`).
 */
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { listReplays } from "../src/store.js";
import { createReplayServer } from "../src/server.js";

function writeIndex(dir: string, battleId: string, createdAt: string, official = false) {
  const index = {
    formatVersion: 1,
    battleId,
    algo: "gzip",
    sha256: "x".repeat(64),
    sizeBytes: 1234,
    official,
    createdAt,
    expiresAt: official ? null : createdAt,
    ticks: 300,
    snapshotCount: 100,
    versions: {},
    mapChecksum: "m",
    keyframes: [],
    result: { winner: "draw", ticks: 300 },
  };
  writeFileSync(join(dir, `${battleId}.replay.json`), JSON.stringify(index), "utf8");
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe("R7-A · listReplays", () => {
  it("lista los índices, más recientes primero, con resumen", () => {
    const dir = mkdtempSync(join(tmpdir(), "s9-list-"));
    writeIndex(dir, "b_old", "2026-07-01T00:00:00.000Z");
    writeIndex(dir, "b_new", "2026-07-19T00:00:00.000Z", true);
    const items = listReplays(dir);
    expect(items.map((i) => i.battleId)).toEqual(["b_new", "b_old"]);
    expect(items[0]).toMatchObject({ battleId: "b_new", ticks: 300, winner: "draw", official: true, sizeBytes: 1234 });
  });

  it("limit acota y order=asc invierte", () => {
    const dir = mkdtempSync(join(tmpdir(), "s9-list-"));
    writeIndex(dir, "b1", "2026-07-01T00:00:00.000Z");
    writeIndex(dir, "b2", "2026-07-02T00:00:00.000Z");
    writeIndex(dir, "b3", "2026-07-03T00:00:00.000Z");
    expect(listReplays(dir, { limit: 2 }).map((i) => i.battleId)).toEqual(["b3", "b2"]);
    expect(listReplays(dir, { order: "asc" }).map((i) => i.battleId)).toEqual(["b1", "b2", "b3"]);
  });

  it("dir inexistente → lista vacía", () => {
    expect(listReplays(join(tmpdir(), "no-existe-" + Date.now()))).toEqual([]);
  });

  it("GET /replays devuelve {items:[...]}", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s9-list-"));
    writeIndex(dir, "b_a", "2026-07-10T00:00:00.000Z");
    const app = express();
    app.use(createReplayServer({ dir }));
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/replays`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { battleId: string }[] };
    expect(body.items.some((i) => i.battleId === "b_a")).toBe(true);
  });
});
