/**
 * V1 ADM-SETUP · Lectura y comparación del token de instalación (sin BD).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSetupTokenFile,
  setupBannerLines,
  setupTokenFingerprint,
  setupTokenMatches,
  setupTokenSourceFromEnv,
} from "./setup-token.js";

let dir: string;
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "setup-token-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("setup-token", () => {
  it("[ST1-lectura] lee el fichero (quitando el salto final); ausente, vacío, enlace, directorio o enorme ⇒ null", () => {
    const ok = join(dir, "ok");
    writeFileSync(ok, `${TOKEN}\n`, { mode: 0o400 });
    expect(readSetupTokenFile(ok)).toBe(TOKEN);
    expect(readSetupTokenFile(join(dir, "no-existe"))).toBeNull();
    const empty = join(dir, "vacio");
    writeFileSync(empty, "");
    expect(readSetupTokenFile(empty)).toBeNull();
    const blank = join(dir, "blanco");
    writeFileSync(blank, "  \n");
    expect(readSetupTokenFile(blank)).toBeNull();
    const link = join(dir, "enlace");
    symlinkSync(ok, link);
    expect(readSetupTokenFile(link)).toBeNull();
    const sub = join(dir, "sub");
    mkdirSync(sub);
    expect(readSetupTokenFile(sub)).toBeNull();
    const big = join(dir, "grande");
    writeFileSync(big, "x".repeat(300));
    expect(readSetupTokenFile(big)).toBeNull();
    expect(setupTokenSourceFromEnv({ SETUP_TOKEN_FILE: ok })()).toBe(TOKEN);
  });

  it("[ST2-comparacion] compara exacto (tolerando espacios al copiar) y rechaza no-strings, vacíos y enormes", () => {
    expect(setupTokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(setupTokenMatches(TOKEN, ` ${TOKEN}\n`)).toBe(true);
    expect(setupTokenMatches(TOKEN, TOKEN.slice(0, -1))).toBe(false);
    expect(setupTokenMatches(TOKEN, TOKEN.toLowerCase())).toBe(false);
    for (const bad of [undefined, null, 42, "", "x".repeat(300), { t: TOKEN }]) {
      expect(setupTokenMatches(TOKEN, bad)).toBe(false);
    }
  });

  it("[ST3-huella] la huella es sha256 truncado y el aviso nunca contiene el token", () => {
    const fp = setupTokenFingerprint(TOKEN);
    expect(fp).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(fp).not.toContain(TOKEN);
    const lines = setupBannerLines(TOKEN, "https://arena.example/").join("\n");
    expect(lines).toContain("https://arena.example/#/setup");
    expect(lines).toContain(fp);
    expect(lines).not.toContain(TOKEN);
  });
});
