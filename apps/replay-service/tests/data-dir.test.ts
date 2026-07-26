/**
 * B7 · Preflight del directorio de datos.
 *
 * Reproduce el defecto REAL de producción (VM108, 2026-07-17 → 2026-07-27):
 * el volumen `arena_replays` pertenecía a otro usuario y el proceso del
 * replay-service (uid 1000) no podía escribir. Aquí NO se simula con mocks:
 * se crea un directorio de verdad SIN permiso de escritura para el usuario que
 * corre los tests y se comprueba el comportamiento observable — que la ingesta
 * real revienta con EACCES y que el preflight lo detecta ANTES.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { record, type Replay } from "../../arena-engine/src/replay.js";
import { emptyArena, gunnerLoadout, scoutLoadout } from "../../arena-engine/src/fixtures.js";
import { HunterBot } from "../../arena-engine/src/stubs.js";
import { checkWritableDataDir, dataDirFailureLog } from "../src/data-dir.js";
import { ingestReplay } from "../src/store.js";

let replay: Replay;

beforeAll(async () => {
  // Precondición del método: como root TODO es escribible y estos tests no
  // probarían nada. Se comprueba explícitamente en vez de saltarlos en
  // silencio (un test omitido que parece verde es el bug que estamos matando).
  expect(process.getuid?.(), "esta suite debe correr SIN privilegios de root").not.toBe(0);
  await initPhysics();
  replay = await record(
    {
      battleId: "bat_b7_datadir",
      seed: "b7_datadir",
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 120 }),
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
});

/** Directorio de datos REAL sin permiso de escritura (el caso de VM108). */
function noEscribible(): string {
  const base = mkdtempSync(join(tmpdir(), "b7-datadir-"));
  const dir = join(base, "replays");
  mkdirSync(dir);
  chmodSync(dir, 0o555); // r-xr-xr-x: se puede listar, no se puede crear nada
  return dir;
}

function escribible(): string {
  return mkdtempSync(join(tmpdir(), "b7-datadir-ok-"));
}

describe("B7 · el defecto de VM108 es reproducible", () => {
  it("sobre un directorio sin permiso de escritura, ingestReplay muere con EACCES", () => {
    const dir = noEscribible();
    // Esto es EXACTAMENTE lo que hacía el servicio en producción diez días.
    expect(() => ingestReplay(dir, replay, { official: true })).toThrow(/EACCES|permission denied/i);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("B7 · checkWritableDataDir", () => {
  it("detecta el directorio no escribible ANTES de perder ningún replay", () => {
    const check = checkWritableDataDir(noEscribible());
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/EACCES|permission denied/i);
  });

  it("acepta un directorio escribible y lo deja limpio (la sonda no deja basura)", () => {
    const dir = escribible();
    expect(checkWritableDataDir(dir)).toEqual({ ok: true });
    expect(readdirSync(dir)).toEqual([]);
    // Y sobre ese mismo directorio la ingesta real SÍ funciona.
    const stored = ingestReplay(dir, replay, { official: true });
    expect(existsSync(stored.path)).toBe(true);
  });

  it("crea el directorio si no existe (despliegue desde cero) y lo deja usable", () => {
    const dir = join(escribible(), "anidado", "replays");
    expect(existsSync(dir)).toBe(false);
    expect(checkWritableDataDir(dir).ok).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  it("no puede escribir DENTRO de un directorio cuyo padre no es escribible", () => {
    // Volumen montado root:root ⇒ el servicio no puede ni crear el subdirectorio.
    const padre = noEscribible();
    const check = checkWritableDataDir(join(padre, "replays"));
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/EACCES|permission denied/i);
  });

  it("un fichero de prueba previo (proceso muerto a medias) no rompe el chequeo", () => {
    const dir = escribible();
    writeFileSync(join(dir, ".s9-write-probe-viejo"), "residuo");
    expect(checkWritableDataDir(dir).ok).toBe(true);
  });
});

describe("B7 · el diagnóstico es accionable (lo que faltó en VM108)", () => {
  it("el log de fallo es una línea JSON con dir, uid, motivo y remedio", () => {
    const dir = noEscribible();
    const check = checkWritableDataDir(dir);
    const parsed = JSON.parse(dataDirFailureLog("replay-service", dir, check));
    expect(parsed.level).toBe("error");
    expect(parsed.service).toBe("replay-service");
    expect(parsed.dir).toBe(dir);
    expect(parsed.uid).toBe(process.getuid?.());
    expect(String(parsed.reason)).toMatch(/EACCES|permission denied/i);
    expect(String(parsed.remedy)).toMatch(/ARENA_DATA_DIRS/);
    expect(String(parsed.msg)).toMatch(/NO arranca/);
  });
});
