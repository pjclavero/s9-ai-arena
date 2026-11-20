/**
 * AUD2-08 · `.env.example` no instala con `latest` y la puerta de etiquetas falla en cerrado.
 *
 * Se prueba por EFECTO: se ejecuta el script real (proceso hijo, rc real) sobre
 * ficheros `.env` y se comprueba su código de salida y su mensaje.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv, validarEtiquetas } from "../scripts/check-env.mjs";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(RAIZ, "scripts", "check-env.mjs");
const EJEMPLO = readFileSync(join(RAIZ, ".env.example"), "utf8");
const SHA = "sha-0123456789abcdef0123456789abcdef01234567";

function correr(contenido: string | null, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "check-env-"));
  try {
    const f = join(dir, ".env");
    if (contenido !== null) writeFileSync(f, contenido);
    const limpio = { ...process.env } as Record<string, string | undefined>;
    for (const k of Object.keys(limpio)) if (/(^|_)TAG$/.test(k)) delete limpio[k];
    const r = spawnSync("node", [SCRIPT, "--file", f], { encoding: "utf8", env: { ...limpio, ...env } });
    return { rc: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("AUD2-08 · .env.example", () => {
  it("ninguna variable de etiqueta trae `latest` como valor", () => {
    const cfg = parseEnv(EJEMPLO);
    for (const [k, v] of Object.entries(cfg)) {
      if (/(^|_)TAG$/.test(k)) expect(v, k).not.toBe("latest");
    }
    expect(cfg.TAG).toBe("");
    expect(cfg.BACKUP_TAG).toBe("");
  });

  it("copiado tal cual, la puerta FALLA (rc=1) con un mensaje que nombra TAG y BACKUP_TAG", () => {
    const r = correr(EJEMPLO);
    expect(r.rc).toBe(1);
    expect(r.out).toMatch(/TAG está vacía/);
    expect(r.out).toMatch(/BACKUP_TAG está vacía/);
  });

  it("completando TAG y BACKUP_TAG con etiquetas válidas, la puerta pasa (rc=0)", () => {
    const completo = EJEMPLO.replace(/^TAG=$/m, `TAG=${SHA}`).replace(/^BACKUP_TAG=$/m, "BACKUP_TAG=v0.5.0");
    expect(correr(completo).rc).toBe(0);
  });
});

describe("AUD2-08 · puerta de etiquetas", () => {
  it("TAG=latest falla en cerrado y lo dice", () => {
    const r = correr(`TAG=latest\nBACKUP_TAG=${SHA}\n`);
    expect(r.rc).toBe(1);
    expect(r.out).toMatch(/TAG=latest no existe en el registro/);
  });

  it("BACKUP_TAG ausente falla (no hereda de TAG)", () => {
    const r = correr(`TAG=${SHA}\n`);
    expect(r.rc).toBe(1);
    expect(r.out).toMatch(/BACKUP_TAG está vacía o sin definir/);
  });

  it("formas inválidas fallan: rama, sha corto, mayúsculas, espacios", () => {
    for (const malo of ["main", "sha-abc", "sha-ABCDEF1", "v1.2", "sha-0123456 x"]) {
      expect(correr(`TAG=${malo}\nBACKUP_TAG=${SHA}\n`).rc, malo).toBe(1);
    }
  });

  it("un override por servicio con valor inválido falla; vacío o válido, no", () => {
    expect(correr(`TAG=${SHA}\nBACKUP_TAG=${SHA}\nAPI_TAG=latest\n`).rc).toBe(1);
    expect(correr(`TAG=${SHA}\nBACKUP_TAG=${SHA}\nAPI_TAG=\n`).rc).toBe(0);
    expect(correr(`TAG=${SHA}\nBACKUP_TAG=${SHA}\nAPI_TAG=sha-abcdef1\n`).rc).toBe(0);
  });

  it("se valida el valor EFECTIVO: el entorno del shell gana al fichero, como en Compose", () => {
    const f = `TAG=${SHA}\nBACKUP_TAG=${SHA}\n`;
    expect(correr(f, { TAG: "latest" }).rc).toBe(1);
    expect(correr("TAG=latest\nBACKUP_TAG=latest\n", { TAG: SHA, BACKUP_TAG: SHA }).rc).toBe(0);
  });

  it("fichero inexistente es NO COMPROBADO (rc=2), nunca aprobado", () => {
    const r = correr(null);
    expect(r.rc).toBe(2);
    expect(r.out).toMatch(/NO COMPROBADO/);
  });

  it("CONTROL NEGATIVO · validarEtiquetas distingue válido de inválido", () => {
    expect(validarEtiquetas({ TAG: SHA, BACKUP_TAG: SHA }).ok).toBe(true);
    expect(validarEtiquetas({ TAG: "", BACKUP_TAG: SHA }).ok).toBe(false);
    expect(parseEnv("A=1 # c\nB='x y'\n#C=3\n")).toEqual({ A: "1", B: "x y" });
  });
});
