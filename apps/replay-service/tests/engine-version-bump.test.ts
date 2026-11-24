/**
 * UX-F (DEF-R1) · Un replay grabado con el motor ANTERIOR (0.1.0, sin perímetro)
 * tiene que verificarse como «se grabó con otra versión del motor», nunca como
 * «manipulado».
 *
 * El fixture NO es sintético: se grabó con el motor de `origin/main` (35a4fb9,
 * engine 0.1.0) en un árbol temporal — dos ForwardBot que salen de un mapa sin
 * muros (`v_blue` acaba en x≈201 m en un mapa de 120 m). Con el perímetro de
 * ADR-019 esa batalla ya no se puede reproducir: si la versión del motor no se
 * hubiera subido, `verify` re-simularía con las reglas nuevas y declararía el
 * replay manipulado.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { headerIncompatibility } from "../../arena-engine/src/replay.js";
import engineDeps from "../../arena-engine/src/engine-deps.json" with { type: "json" };
import { verifyFile } from "../src/s9r/verify.js";
import { RecipeCursor } from "../src/s9r/recipe.js";
import { S9rError } from "../src/s9r/errors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "fixtures", "engine-0.1.0-sin-perimetro.replay.jsonl.gz");

beforeAll(async () => {
  await initPhysics();
});

describe("DEF-R1 · replays del motor anterior tras el perímetro", () => {
  it("el motor actual ya no es el 0.1.0 (la simulación cambió con el perímetro)", () => {
    expect(engineDeps.engine.version).not.toBe("0.1.0");
  });

  it("V1 REPLAYS PR-4b · un replay v1 real (motor 0.1.0) no es S9R/1: se rechaza al abrirlo, nunca se re-simula ni se dice «manipulado»", async () => {
    // Tal como quedaría en disco un replay histórico. Corte D-OP-30: no se lee; la API lo trata
    // como «sin replay» (404 uniforme, e8-replay-verify.test.ts).
    const bytes = readFileSync(FIXTURE);
    expect(JSON.parse(gunzipSync(bytes).toString("utf8").split("\n")[0]).formatVersion).toBe(1);
    const dir = mkdtempSync(join(tmpdir(), "uxf-r1-"));
    const path = join(dir, "def-r1-v1.1.s9r");
    writeFileSync(path, bytes);
    const v = await verifyFile(path);
    expect(v.ok).toBe(false);
    expect(v.error).toBeInstanceOf(S9rError);
    await expect(RecipeCursor.open(path)).rejects.toBeInstanceOf(S9rError);
    // Una receta S9R/1 con cabecera de formato 1 tampoco se re-simula: motivo único `unsupported_format`.
    expect(headerIncompatibility({ formatVersion: 1 } as never)).toMatch(/^unsupported_format/);
  });
});
