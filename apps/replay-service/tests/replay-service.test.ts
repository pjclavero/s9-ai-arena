/**
 * T8.1 · replays: formato, verify, manipulación y CLI — sobre S9R/1 (V1 REPLAYS PR-4b).
 *
 * Todas las batallas de estas pruebas son REALES: se graban con el motor de E2 (record()) y se
 * escriben con el MISMO grabador y publicación que el worker (`writeS9rReplay`). El almacén JSONL,
 * su ingesta HTTP, `verifyStored`, la retención por índice `.replay.json` y las rutas HTTP del
 * replay-service están RETIRADOS (D-OP-30); sus sustitutos se listan en
 * V1-REPLAYS-PR4B-INFORME.md (tabla «tests reescritos»).
 */
import { writeS9rReplay, readS9rReplay } from "../src/testing/s9r-fixture.js";
import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { record, type Replay } from "../../arena-engine/src/replay.js";
import { emptyArena, gunnerLoadout, scoutLoadout } from "../../arena-engine/src/fixtures.js";
import { HunterBot } from "../../arena-engine/src/stubs.js";
import { verifyRecipePath } from "../src/recipe-verify.js";
import { verifyFile } from "../src/s9r/verify.js";
import { ViewReader } from "../src/s9r/view.js";
import { PREFERRED_ALGO } from "../src/s9r/codec.js";
import { S9rReader } from "../src/s9r/reader.js";
import { validateReplay } from "../src/s9r/replay-file.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..", "..");

/**
 * DoD: "verify reproduce el resultado oficial de 50 batallas de regresión (test en
 * nightly)". Las 50 corren con NIGHTLY=1; por PR corren 8.
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

describe("T8.1 grabación S9R/1 y validación", () => {
  // V1 REPLAYS PR-4b · sustituye a «un replay real pasa la validación» y «sin hashes o sin checksum
  // de mapa se rechaza» (validateReplay de store.ts, retirado): misma función, mismas aserciones, y
  // la escritura validada (la que usan CLI y smoke en lugar de la ingesta) no deja nada en disco.
  it("un replay real del motor pasa la validación de cabecera", async () => {
    const replay = await recordBattle("ingest_ok");
    expect(validateReplay(replay)).toEqual([]);
  });

  it("un replay sin hashes intermedios o sin checksum de mapa se rechaza y no se almacena", async () => {
    const replay = await recordBattle("ingest_bad_v");
    const sinHashes = { ...replay, stateHashes: [] };
    expect(validateReplay(sinHashes as Replay).join(" ")).toContain("hashes intermedios");
    const sinChecksum = { ...replay, header: { ...replay.header, map: { ...replay.header.map, checksum: "" } } };
    expect(validateReplay(sinChecksum as Replay).join(" ")).toContain("checksum");
    const dir = tmp();
    await expect(writeS9rReplay(dir, sinHashes as Replay, { validate: true })).rejects.toThrow(/no se almacena/);
    await expect(writeS9rReplay(dir, sinChecksum as Replay, { validate: true })).rejects.toThrow(/no se almacena/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("un replay sin hashes intermedios no verifica (la receta exige sus hashes)", async () => {
    const replay = await recordBattle("ingest_bad");
    const fx = await writeS9rReplay(tmp(), { ...replay, stateHashes: [] });
    const { verification } = await verifyRecipePath(fx.path);
    expect(verification.matches).toBe(false);
    expect(verification.mismatches.map((m) => m.field)).toContain("stateHashes");
  });

  it("la grabación comprime, indexa keyframes y el round-trip es exacto", async () => {
    const replay = await recordBattle("ingest_roundtrip");
    const fx = await writeS9rReplay(tmp(), replay);
    const r = await S9rReader.open(fx.path);
    // Nota de entorno: sin zstd en el runtime el algoritmo real es gzip (reserva documentada).
    expect(r.algo).toBe(PREFERRED_ALGO);
    await r.close();
    expect(fx.bytes).toBeLessThan(Buffer.byteLength(JSON.stringify(replay)));
    const view = await ViewReader.open(fx.viewPath);
    expect(view.summary.keyframes.length).toBeGreaterThan(0);
    expect(view.summary.keyframes[0].tick).toBe(replay.snapshots[0].tick);
    await view.close();
    expect(await readS9rReplay(fx.path)).toEqual(replay);
  });
});

describe("T8.1 verify (criterio cap. 28)", () => {
  it(`verify reproduce el resultado oficial de ${REGRESSION_BATTLES} batallas de regresión`, async () => {
    const dir = tmp();
    for (let i = 0; i < REGRESSION_BATTLES; i++) {
      const replay = await recordBattle(`regr_${String(i).padStart(4, "0")}`);
      const fx = await writeS9rReplay(dir, replay);
      const { verification } = await verifyRecipePath(fx.path);
      expect(verification.rejected, `batalla ${i}`).toBeNull();
      expect(verification.matches, `batalla ${i} divergió en tick ${verification.divergedAtTick}`).toBe(true);
      expect(verification.recomputedHash).toBe(replay.result.finalStateHash);
    }
  }, 300000);

  it("un byte alterado en el archivo se detecta por checksum y se marca inválido", async () => {
    const replay = await recordBattle("tamper_byte");
    const fx = await writeS9rReplay(tmp(), replay);
    const bytes = readFileSync(fx.path);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff; // un solo byte
    writeFileSync(fx.path, bytes);
    const v = await verifyFile(fx.path, { expectSha256: fx.sha256 });
    expect(v.ok).toBe(false);
    await expect(verifyRecipePath(fx.path)).rejects.toBeTruthy(); // ni se re-simula
  });

  it("un comando manipulado (fichero íntegro re-grabado) lo caza la re-simulación", async () => {
    // Ataque más serio: alterar un comando Y regenerar el fichero con todos sus sha válidos.
    // La integridad ya no protege; la re-simulación sí — los hashes intermedios divergen.
    const replay = await recordBattle("tamper_cmd");
    const manipulated: Replay = structuredClone(replay);
    const cmd = manipulated.commands.find((c) => c.command?.move);
    expect(cmd).toBeTruthy();
    cmd!.command.move.throttle = -(cmd!.command.move.throttle || 1);
    const fx = await writeS9rReplay(tmp(), manipulated);
    expect((await verifyFile(fx.path, { expectSha256: fx.sha256 })).ok).toBe(true); // el FICHERO es íntegro…
    const { verification } = await verifyRecipePath(fx.path);
    expect(verification.matches).toBe(false); // …pero la batalla que cuenta es falsa
    expect(verification.divergedAtTick).not.toBeNull();
  });

  it("si la cabecera registra otra versión de motor, verify se niega en vez de mentir", async () => {
    const replay = await recordBattle("tamper_version");
    const otra: Replay = structuredClone(replay);
    otra.header.versions = { ...otra.header.versions, engine: "otro-motor@9.9.9" };
    const fx = await writeS9rReplay(tmp(), otra);
    const { verification } = await verifyRecipePath(fx.path);
    expect(verification.matches).toBe(false);
    expect(verification.rejected).toContain("engine_version_mismatch");
  });

  it("el comando `replay-service verify <id>` funciona de verdad (CLI, receta S9R/1)", async () => {
    const replay = await recordBattle("cli_verify");
    const dir = tmp();
    await writeS9rReplay(dir, replay);
    const out = execFileSync(
      join(REPO, "node_modules", ".bin", "tsx"),
      ["apps/replay-service/src/cli.ts", "verify", replay.header.battleId, "--dir", dir],
      { cwd: REPO, encoding: "utf8" },
    );
    const parsed = JSON.parse(out);
    expect(parsed.valid).toBe(true);
    expect(parsed.verification.matches).toBe(true);
  }, 120000);

  // V1 REPLAYS PR-4b · sustituye a los tests de ingesta HTTP y de retención (POST /replays, sweep):
  // los comandos de CLI `ingest`, `sweep` y `serve` ya no existen y no tocan el directorio.
  it("los comandos retirados `ingest`, `sweep` y `serve` no existen: salen con 2 y no tocan el directorio", async () => {
    const replay = await recordBattle("cli_retired");
    const dir = tmp();
    await writeS9rReplay(dir, replay);
    const before = readdirSync(dir).sort();
    for (const cmd of ["ingest", "sweep", "serve"]) {
      let code = 0;
      try {
        execFileSync(join(REPO, "node_modules", ".bin", "tsx"), ["apps/replay-service/src/cli.ts", cmd, "--dir", dir], {
          cwd: REPO,
          encoding: "utf8",
          stdio: "pipe",
        });
      } catch (e: any) {
        code = e.status;
      }
      expect(code, cmd).toBe(2);
    }
    expect(readdirSync(dir).sort()).toEqual(before);
  }, 120000);
});

describe("T8.1 índice de keyframes (vista S9R/1)", () => {
  it("nearestKeyframe encuentra el keyframe correcto por búsqueda binaria", async () => {
    const replay = await recordBattle("kf", 900);
    const fx = await writeS9rReplay(tmp(), replay);
    const view = await ViewReader.open(fx.viewPath);
    const kf = view.summary.keyframes;
    expect(kf.length).toBeGreaterThan(2);
    expect(view.nearestKeyframe(-5)).toEqual(kf[0]);
    expect(view.nearestKeyframe(kf[1].tick)).toEqual(kf[1]);
    expect(view.nearestKeyframe(kf[1].tick + 1)).toEqual(kf[1]);
    expect(view.nearestKeyframe(kf[2].tick - 1)).toEqual(kf[1]);
    expect(view.nearestKeyframe(1e9)).toEqual(kf[kf.length - 1]);
    await view.close();
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
