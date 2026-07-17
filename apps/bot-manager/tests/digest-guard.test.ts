/**
 * Issue #12 — Guard contra digests placeholder (auditoría 2026-07-16 §3.2).
 *
 * Dos frentes:
 *  1) el bot-manager NO lanza bots sobre una imagen con digest placeholder
 *     (container-runner: buildRunArgs y launch);
 *  2) scripts/verify-runtime-digests.ts NO da OK mientras runtimes/ contenga
 *     placeholders (DIGESTS.lock, FROM de Dockerfiles, hashes de lockfiles).
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isPlaceholderSha256,
  isPlaceholderDigest,
  assertRealDigest,
  PlaceholderDigestError,
  PLACEHOLDER_MSG,
} from "../src/digest-guard.js";
import { DockerContainerRunner, DEFAULT_LIMITS, type SandboxSpec } from "../src/container-runner.js";
import { placeholderViolations } from "../../../scripts/verify-runtime-digests.js";

const ZEROS = "0".repeat(64);
const ONES = "1".repeat(64);
const REAL = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"; // sha256 real

describe("issue #12 · detección de placeholders", () => {
  it("un sha256 con el mismo carácter repetido es placeholder; uno real no", () => {
    expect(isPlaceholderSha256(ZEROS)).toBe(true);
    expect(isPlaceholderSha256(ONES)).toBe(true);
    expect(isPlaceholderSha256("f".repeat(64))).toBe(true);
    expect(isPlaceholderSha256(REAL)).toBe(false);
  });

  it("detecta el placeholder dentro de una referencia de imagen o de un --hash", () => {
    expect(isPlaceholderDigest(`arena/bot-runtime-python@sha256:${ZEROS}`)).toBe(true);
    expect(isPlaceholderDigest(`numpy==1.26.4 --hash=sha256:${ZEROS}`)).toBe(true);
    expect(isPlaceholderDigest(`arena/bot-runtime-python@sha256:${REAL}`)).toBe(false);
    expect(isPlaceholderDigest("arena/bot-runtime-python:latest")).toBe(false); // sin digest: lo cubre digestViolations
  });

  it("assertRealDigest lanza con el mensaje canónico 'digests placeholder: ejecuta el build real'", () => {
    expect(() => assertRealDigest(`img@sha256:${ZEROS}`, "test")).toThrow(PlaceholderDigestError);
    expect(() => assertRealDigest(`img@sha256:${ZEROS}`, "test")).toThrow(/digests placeholder: ejecuta el build real/);
    expect(() => assertRealDigest(`img@sha256:${REAL}`, "test")).not.toThrow();
  });
});

function spec(imageDigest: string): SandboxSpec {
  return {
    imageDigest,
    botId: "bot_x",
    version: 1,
    battleId: "btl_1",
    network: "arena",
    engineEndpoint: "ws://arena-engine:8081/bot",
    env: {},
    limits: DEFAULT_LIMITS,
    seccompProfilePath: "/security/seccomp-bot.json",
  };
}

describe("issue #12 · el bot-manager no lanza bots con digest placeholder", () => {
  it("buildRunArgs se niega a componer el docker run", () => {
    expect(() => DockerContainerRunner.buildRunArgs(spec(`arena/bot-runtime-python@sha256:${ZEROS}`), "c1"))
      .toThrow(/digests placeholder: ejecuta el build real/);
    expect(() => DockerContainerRunner.buildRunArgs(spec(`arena/bot-runtime-python@sha256:${REAL}`), "c1"))
      .not.toThrow();
  });

  it("launch rechaza el placeholder ANTES del error de entorno sin Docker", async () => {
    const runner = new DockerContainerRunner();
    await expect(runner.launch(spec(`arena/bot-runtime-node@sha256:${ONES}`)))
      .rejects.toThrow(/digests placeholder: ejecuta el build real/);
  });
});

describe("issue #12 · verify-runtime-digests no da OK con placeholders", () => {
  it("placeholderViolations detecta DIGESTS.lock, Dockerfiles y hashes de lockfile placeholder (fixture)", () => {
    const root = mkdtempSync(join(tmpdir(), "digests-"));
    writeFileSync(join(root, "DIGESTS.lock"), `python python@sha256:${ZEROS} arena/rt-py@sha256:${ONES}\n`);
    mkdirSync(join(root, "python"));
    writeFileSync(join(root, "python", "Dockerfile"), `FROM python@sha256:${ZEROS} AS base\n`);
    writeFileSync(join(root, "python", "allowed-requirements.lock"), `numpy==1.26.4 --hash=sha256:${ZEROS}\n`);
    const v = placeholderViolations(root);
    expect(v.length).toBe(4); // 2 en DIGESTS.lock + FROM + --hash
    for (const x of v) expect(x).toContain(PLACEHOLDER_MSG);
  });

  it("con digests reales no hay violaciones (fixture)", () => {
    const root = mkdtempSync(join(tmpdir(), "digests-real-"));
    writeFileSync(join(root, "DIGESTS.lock"), `python python@sha256:${REAL} arena/rt-py@sha256:${REAL}\n`);
    mkdirSync(join(root, "python"));
    writeFileSync(join(root, "python", "Dockerfile"), `FROM python@sha256:${REAL} AS base\n`);
    expect(placeholderViolations(root)).toEqual([]);
  });

  // R6.1 cerro el gate del issue #12: las imagenes se construyeron de verdad y sus
  // digests reales estan fijados, asi que en runtimes/ ya no queda ningun placeholder.
  // Este test estaba escrito al reves a proposito ("el repo lleva placeholders y el
  // guard los reporta"), porque mientras existieran era la prueba de que el gate seguia
  // vivo; su comentario decia que invertirlo formaba parte de este cierre.
  //
  // Que el guard SIGUE detectando placeholders si alguien los reintroduce no se deja de
  // probar: los tests de arriba se los pasan a mano. Lo que se afirma aqui es el estado
  // del repo, y si alguien vuelve a meter un 000.../111... este test se pone rojo.
  it("el repo ya no lleva placeholders: los runtimes estan fijados por digest real", () => {
    expect(placeholderViolations()).toEqual([]);
  });
});
