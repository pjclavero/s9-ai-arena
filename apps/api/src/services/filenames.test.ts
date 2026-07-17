/**
 * R2.6 · ERR-SEC-09 — saneado de source_filename y Content-Disposition seguro.
 * DoD: un source_filename con comillas/CRLF no rompe la cabecera ni permite spoofing.
 */
import { describe, it, expect } from "vitest";
import { MAX_FILENAME_LENGTH, contentDispositionAttachment, sanitizeSourceFilename } from "./filenames.js";

describe("R2.6 sanitizeSourceFilename (ERR-SEC-09)", () => {
  it("conserva nombres razonables", () => {
    expect(sanitizeSourceFilename("mi-bot_v2.zip")).toBe("mi-bot_v2.zip");
  });

  it("se queda con la base: descarta rutas con / y \\", () => {
    expect(sanitizeSourceFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeSourceFilename("C:\\Users\\x\\bot.zip")).toBe("bot.zip");
  });

  it("DoD: comillas, CRLF y caracteres fuera de la allowlist colapsan a _", () => {
    const evil = 'evil".zip\r\nContent-Type: text/html\r\n\r\n<script>';
    const clean = sanitizeSourceFilename(evil)!;
    expect(clean).not.toMatch(/["\r\n<>:]/);
    expect(clean).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("sin puntos iniciales (ni ocultos ni ..) y longitud acotada conservando extensión", () => {
    expect(sanitizeSourceFilename("..bashrc")).toBe("bashrc");
    expect(sanitizeSourceFilename(".hidden")).toBe("hidden");
    const largo = sanitizeSourceFilename("a".repeat(300) + ".zip")!;
    expect(largo.length).toBeLessThanOrEqual(MAX_FILENAME_LENGTH);
    expect(largo.endsWith(".zip")).toBe(true);
  });

  it("devuelve null cuando no queda nada utilizable (el llamante aplica el defecto)", () => {
    expect(sanitizeSourceFilename("")).toBeNull();
    expect(sanitizeSourceFilename("////")).toBeNull();
    expect(sanitizeSourceFilename("....")).toBeNull();
    expect(sanitizeSourceFilename(undefined)).toBeNull();
    expect(sanitizeSourceFilename(42)).toBeNull();
  });
});

describe("R2.6 contentDispositionAttachment (RFC 6266/5987)", () => {
  it("emite fallback ASCII citado + filename* UTF-8", () => {
    expect(contentDispositionAttachment("bot.zip")).toBe(`attachment; filename="bot.zip"; filename*=UTF-8''bot.zip`);
  });

  it("DoD: comillas y CRLF jamás llegan a la cabecera (sin inyección ni spoofing)", () => {
    const header = contentDispositionAttachment('evil".zip\r\nX-Spoof: 1');
    expect(header).not.toMatch(/[\r\n]/);
    // La única comilla sin escapar es la que delimita el propio filename.
    expect(header).toMatch(/^attachment; filename="[^"]*"; filename\*=UTF-8''[A-Za-z0-9%._-]*$/);
  });

  it("no-ASCII va percent-encoded en filename* con fallback ASCII utilizable", () => {
    const header = contentDispositionAttachment("informe-señal.zip");
    expect(header).toContain(`filename="informe-se_al.zip"`);
    expect(header).toContain("filename*=UTF-8''informe-se%C3%B1al.zip");
  });
});
