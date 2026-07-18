/**
 * T8.1 · replay-service: formato, ingesta, verify, manipulación, retención y HTTP.
 *
 * Todas las batallas de estas pruebas son REALES: se graban con el motor de E2
 * (record() de apps/arena-engine/src/replay.ts) — nada de replays sintéticos, porque
 * el servicio existe para el formato real y las mentiras sintéticas no encuentran bugs.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { fromJsonl, record, toJsonl, type Replay } from "../../arena-engine/src/replay.js";
import { emptyArena, gunnerLoadout, scoutLoadout } from "../../arena-engine/src/fixtures.js";
import { HunterBot } from "../../arena-engine/src/stubs.js";
import { PREFERRED_ALGO, buildKeyframes, nearestKeyframe } from "../src/format.js";
import { ingestReplay, loadStored, replayPath, sweepRetention, validateReplay, verifyStored } from "../src/store.js";
import { createReplayServer } from "../src/server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..", "..");

/**
 * DoD: "verify reproduce el resultado oficial de 50 batallas de regresión (test en
 * nightly)". Las 50 corren con NIGHTLY=1 (el cambio es UNA constante, mismo criterio
 * que las 1000 batallas de determinismo de E2); por PR corren 8 para no castigar
 * cada push con minutos de re-simulación.
 */
const REGRESSION_BATTLES = process.env.NIGHTLY === "1" ? 50 : 8;

beforeAll(async () => {
  await initPhysics();
});

/** Batalla real corta: dos cazadores, arena vacía, límite de ticks bajo. */
async function recordBattle(seed: string, timeLimitTicks = 240): Promise<Replay> {
  return record(
    {
      battleId: `bat_${seed}`,
      seed,
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks }),
      map: emptyArena(),
      participants: [
        { id: "v_red", botId: "bot_red", team: "red", spec: gunnerLoadout() },
        { id: "v_blue", botId: "bot_blue", team: "blue", spec: scoutLoadout() },
      ],
    },
    (b) => {
      b.attachBot("v_red", new HunterBot("bot_red"));
      b.attachBot("v_blue", new HunterBot("bot_blue"));
    },
  );
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "e8-replays-"));
}

describe("T8.1 ingesta y validación", () => {
  it("un replay real del motor pasa la validación de cabecera", async () => {
    const replay = await recordBattle("ingest_ok");
    expect(validateReplay(replay)).toEqual([]);
  });

  it("un replay sin hashes intermedios o sin checksum de mapa se rechaza", async () => {
    const replay = await recordBattle("ingest_bad");
    const sinHashes = { ...replay, stateHashes: [] };
    expect(validateReplay(sinHashes as Replay).join(" ")).toContain("hashes intermedios");
    const sinChecksum = { ...replay, header: { ...replay.header, map: { ...replay.header.map, checksum: "" } } };
    expect(validateReplay(sinChecksum as Replay).join(" ")).toContain("checksum");
    const dir = tmp();
    expect(() => ingestReplay(dir, sinHashes as Replay, { official: false })).toThrow(/no se almacena/);
  });

  it("la ingesta comprime, indexa keyframes y el round-trip es exacto", async () => {
    const replay = await recordBattle("ingest_roundtrip");
    const dir = tmp();
    const stored = ingestReplay(dir, replay, { official: true });
    // Nota de entorno: en Node 20 el algoritmo real es gzip (reserva documentada).
    expect(stored.index.algo).toBe(PREFERRED_ALGO);
    expect(stored.index.sizeBytes).toBeLessThan(Buffer.byteLength(toJsonl(replay)));
    expect(stored.index.keyframes.length).toBeGreaterThan(0);
    expect(stored.index.keyframes[0].tick).toBe(replay.snapshots[0].tick);

    const loaded = loadStored(dir, replay.header.battleId);
    expect(loaded.valid).toBe(true);
    expect(toJsonl(loaded.replay!)).toBe(toJsonl(replay));
  });
});

describe("T8.1 verify (criterio cap. 28)", () => {
  it(`verify reproduce el resultado oficial de ${REGRESSION_BATTLES} batallas de regresión`, async () => {
    const dir = tmp();
    for (let i = 0; i < REGRESSION_BATTLES; i++) {
      const replay = await recordBattle(`regr_${String(i).padStart(4, "0")}`);
      ingestReplay(dir, replay, { official: true });
      const r = await verifyStored(dir, replay.header.battleId);
      expect(r.valid, `batalla ${i}: ${r.reason}`).toBe(true);
      expect(r.verification!.matches, `batalla ${i} divergió en tick ${r.verification!.divergedAtTick}`).toBe(true);
      expect(r.verification!.recomputedHash).toBe(replay.result.finalStateHash);
    }
  }, 300000);

  it("un byte alterado en el archivo se detecta por checksum y se marca inválido", async () => {
    const replay = await recordBattle("tamper_byte");
    const dir = tmp();
    ingestReplay(dir, replay, { official: true });
    const p = replayPath(dir, replay.header.battleId);
    const bytes = readFileSync(p);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff; // un solo byte
    writeFileSync(p, bytes);

    const loaded = loadStored(dir, replay.header.battleId);
    expect(loaded.valid).toBe(false);
    expect(loaded.reason).toBe("checksum_mismatch");
    const r = await verifyStored(dir, replay.header.battleId);
    expect(r.valid).toBe(false);
  });

  it("un comando manipulado (checksum re-calculado) lo caza la re-simulación", async () => {
    // Ataque más serio: alterar un comando Y regenerar el archivo con checksum válido.
    // El checksum ya no protege; la re-simulación sí — los hashes intermedios divergen.
    const replay = await recordBattle("tamper_cmd");
    const manipulated = fromJsonl(toJsonl(replay));
    const cmd = manipulated.commands.find((c) => c.command?.move);
    expect(cmd).toBeTruthy();
    cmd!.command.move.throttle = -(cmd!.command.move.throttle || 1);

    const dir = tmp();
    ingestReplay(dir, manipulated, { official: true });
    const r = await verifyStored(dir, manipulated.header.battleId);
    expect(r.valid).toBe(true); // el ARCHIVO es íntegro…
    expect(r.verification!.matches).toBe(false); // …pero la batalla que cuenta es falsa
    expect(r.verification!.divergedAtTick).not.toBeNull();
  });

  it("si la cabecera registra otra versión de motor, verify se niega en vez de mentir", async () => {
    const replay = await recordBattle("tamper_version");
    const otra = fromJsonl(toJsonl(replay));
    otra.header.versions = { ...otra.header.versions, engine: "otro-motor@9.9.9" };
    const dir = tmp();
    ingestReplay(dir, otra, { official: true });
    const r = await verifyStored(dir, otra.header.battleId);
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("engine_version_mismatch");
  });

  it("el comando `replay-service verify <id>` funciona de verdad (CLI)", async () => {
    const replay = await recordBattle("cli_verify");
    const dir = tmp();
    ingestReplay(dir, replay, { official: true });
    const out = execFileSync(
      join(REPO, "node_modules", ".bin", "tsx"),
      ["apps/replay-service/src/cli.ts", "verify", replay.header.battleId, "--dir", dir],
      { cwd: REPO, encoding: "utf8" },
    );
    const parsed = JSON.parse(out);
    expect(parsed.valid).toBe(true);
    expect(parsed.verification.matches).toBe(true);
  }, 120000);
});

describe("T8.1 retención (política 23.1)", () => {
  it("elimina los temporales caducados y NUNCA los oficiales (reloj simulado)", async () => {
    const dir = tmp();
    const t0 = Date.parse("2026-07-16T00:00:00Z");
    let fakeNow = t0;
    const clock = () => fakeNow;

    const oficial = await recordBattle("ret_oficial");
    const temporal = await recordBattle("ret_temporal");
    const reciente = await recordBattle("ret_reciente");
    ingestReplay(dir, oficial, { official: true, now: clock });
    ingestReplay(dir, temporal, { official: false, temporaryTtlMs: 24 * 3600_000, now: clock });

    // 3 días después: el temporal de 24 h caduca; se ingesta otro temporal fresco.
    fakeNow = t0 + 3 * 24 * 3600_000;
    ingestReplay(dir, reciente, { official: false, temporaryTtlMs: 24 * 3600_000, now: clock });
    const sweep1 = sweepRetention(dir, clock);
    expect(sweep1.deleted).toEqual([temporal.header.battleId]);
    expect(sweep1.kept.sort()).toEqual([oficial.header.battleId, reciente.header.battleId].sort());
    expect(loadStored(dir, temporal.header.battleId).valid).toBe(false);
    expect(loadStored(dir, oficial.header.battleId).valid).toBe(true);

    // Diez años después: el oficial sigue ahí. Los oficiales no caducan JAMÁS.
    fakeNow = t0 + 10 * 365 * 24 * 3600_000;
    const sweep2 = sweepRetention(dir, clock);
    expect(sweep2.deleted).toEqual([reciente.header.battleId]);
    expect(sweep2.kept).toEqual([oficial.header.battleId]);
    expect(loadStored(dir, oficial.header.battleId).valid).toBe(true);
  });
});

describe("T8.1 índice de keyframes", () => {
  it("nearestKeyframe encuentra el keyframe correcto por búsqueda binaria", () => {
    const snaps = Array.from({ length: 100 }, (_, i) => ({ tick: i * 3 }));
    const kfs = buildKeyframes(snaps, 10); // keyframes en ticks 0,30,60,…
    expect(nearestKeyframe(kfs, 0)!.tick).toBe(0);
    expect(nearestKeyframe(kfs, 29)!.tick).toBe(0);
    expect(nearestKeyframe(kfs, 30)!.tick).toBe(30);
    expect(nearestKeyframe(kfs, 31)!.tick).toBe(30);
    expect(nearestKeyframe(kfs, 297)!.tick).toBe(270);
    expect(nearestKeyframe(kfs, 99999)!.tick).toBe(270);
    expect(nearestKeyframe([], 5)).toBeNull();
  });
});

describe("T8.1 HTTP: rango, índice y segmentos", () => {
  it("sirve el replay completo, por rango de bytes (206) y su índice", async () => {
    const replay = await recordBattle("http_srv");
    const dir = tmp();
    const stored = ingestReplay(dir, replay, { official: true });
    const app = createReplayServer({ dir });
    const id = replay.header.battleId;

    const full = await request(app).get(`/replays/${id}`).buffer(true).parse(binary);
    expect(full.status).toBe(200);
    expect(full.headers["accept-ranges"]).toBe("bytes");
    expect((full.body as Buffer).length).toBe(stored.index.sizeBytes);

    const partial = await request(app).get(`/replays/${id}`).set("Range", "bytes=10-19").buffer(true).parse(binary);
    expect(partial.status).toBe(206);
    expect(partial.headers["content-range"]).toBe(`bytes 10-19/${stored.index.sizeBytes}`);
    expect(Buffer.compare(partial.body as Buffer, (full.body as Buffer).subarray(10, 20))).toBe(0);

    const suffix = await request(app).get(`/replays/${id}`).set("Range", "bytes=-5").buffer(true).parse(binary);
    expect(suffix.status).toBe(206);
    expect((suffix.body as Buffer).length).toBe(5);

    const bad = await request(app)
      .get(`/replays/${id}`)
      .set("Range", `bytes=${stored.index.sizeBytes + 10}-`);
    expect(bad.status).toBe(416);

    const idx = await request(app).get(`/replays/${id}/index`);
    expect(idx.status).toBe(200);
    expect(idx.body.sha256).toBe(stored.index.sha256);
    expect(idx.body.keyframes.length).toBeGreaterThan(0);

    expect((await request(app).get("/replays/no-existe")).status).toBe(404);
  });

  it("segmento por ticks: arranca en el keyframe anterior y respeta el rango", async () => {
    const replay = await recordBattle("http_seg", 600);
    const dir = tmp();
    const stored = ingestReplay(dir, replay, { official: true, keyframeEveryNSnapshots: 20 });
    const app = createReplayServer({ dir });
    const id = replay.header.battleId;

    const midTick = Math.floor(stored.index.ticks / 2);
    const r = await request(app).get(`/replays/${id}/segment?fromTick=${midTick}&toTick=${midTick + 90}`);
    expect(r.status).toBe(200);
    const kf = nearestKeyframe(stored.index.keyframes, midTick)!;
    expect(r.body.fromKeyframeTick).toBe(kf.tick);
    expect(r.body.snapshots[0].tick).toBe(kf.tick);
    expect(r.body.snapshots.at(-1)!.tick).toBeLessThanOrEqual(midTick + 90);
    // Contiene el snapshot necesario para aterrizar en midTick (±1 tick, DoD T8.3)
    expect(r.body.snapshots.some((s: { tick: number }) => Math.abs(s.tick - midTick) <= 3)).toBe(true);
  });

  it("la ingesta HTTP rechaza basura y acepta un replay real", async () => {
    const replay = await recordBattle("http_ingest");
    const dir = tmp();
    const app = createReplayServer({ dir });
    const id = replay.header.battleId;

    const bad = await request(app)
      .post(`/replays/${id}`)
      .set("Content-Type", "application/x-ndjson")
      .send("no es jsonl");
    expect([400, 422]).toContain(bad.status);

    const ok = await request(app)
      .post(`/replays/${id}?official=true`)
      .set("Content-Type", "application/x-ndjson")
      .send(toJsonl(replay));
    expect(ok.status).toBe(201);
    expect(ok.body.battleId).toBe(id);

    const verifyRes = await request(app).post(`/replays/${id}/verify`);
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.matches).toBe(true);
  });
});

/** Snapshots públicos a 10 Hz con objetivo < 100 KB/s por espectador (E8.M): medido. */
describe("E8.M presupuesto de ancho de banda de espectador", () => {
  it("el stream de snapshots de una batalla real queda por debajo de 100 KB/s", async () => {
    const replay = await recordBattle("bandwidth", 900); // 30 s de juego
    const seconds = replay.result.ticks / 30;
    const bytes = replay.snapshots.reduce((acc, s) => acc + Buffer.byteLength(JSON.stringify(s)), 0);
    const kbPerSecond = bytes / 1024 / seconds;
    expect(kbPerSecond).toBeLessThan(100);
  });
});

function binary(res: request.Response, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
}
