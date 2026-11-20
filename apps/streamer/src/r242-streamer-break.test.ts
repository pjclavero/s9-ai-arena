/**
 * REVISIÓN INDEPENDIENTE de #242 (STREAMER real) · prueba de rotura §20 traída
 * de `review/streamer-242` (#243, commits 097849a + a33b4c1) por STREAMER-2 (H1).
 * Sólo se trae el bloque del pipe de Chromium; el resto de #243 queda allí.
 *
 * Convención: `DEFECTO` afirma el comportamiento CORRECTO (rojo mientras el
 * defecto exista); `CONTROL` calibra el arnés.
 */
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger, DEFAULT_CONFIG, type StreamerConfig } from "./config.js";
import { realSpawner } from "./main.js";
import { StreamSupervisor } from "./supervisor.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── procesos REALES ─────────────────────────────────────────────────────────
function script(dir: string, name: string, body: string): string {
  const bin = join(dir, name);
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function realSup(dir: string, chromiumBin: string, ffmpegBin: string, over: Partial<StreamerConfig> = {}) {
  const lines: string[] = [];
  const sup = new StreamSupervisor({
    config: { ...DEFAULT_CONFIG, mode: "record", recordDir: dir, retryDelayMs: 50, maxRetries: 50, ...over },
    spawner: realSpawner,
    logger: createLogger(null, (l) => lines.push(l)),
    processTree: true,
    stopGraceMs: 300,
    chromiumBin,
    ffmpegBin,
  });
  return { sup, lines };
}

describe("R242 · §20 la salida de Chromium no se consume (pipe sin lector)", () => {
  // Chromium se lanza con stdout/stderr en `pipe` (realSpawner) y el supervisor
  // NO lee esos pipes (sólo los de ffmpeg). Un proceso que escribe más de lo
  // que cabe en el pipe + el búfer de Node se BLOQUEA en write(2).
  for (const [label, bytes, expectBlocked] of [
    ["CONTROL (calibración) · 4 KiB a stderr: el «chromium» sigue vivo y avanza", 4096, false],
    [
      "CIERRE (STREAMER-2 H1; era DEFECTO P3 en #243) · 1 MiB a stderr: el «chromium» NO se bloquea en write() y avanza (sobre 588c842 se quedaba BLOQUEADO)",
      1024 * 1024,
      true,
    ],
  ] as const) {
    it(
      label,
      async () => {
        const dir = mkdtempSync(join(tmpdir(), "s9-r242-pipe-"));
        const marker = join(dir, "avanzo");
        const chromium = script(
          dir,
          "chromium.sh",
          `head -c ${bytes} /dev/zero | tr '\\0' 'x' >&2\ntouch ${marker}\nexec sleep 300`,
        );
        const ffmpeg = script(dir, "ffmpeg.sh", "exec sleep 300");
        const { sup } = realSup(dir, chromium, ffmpeg);
        sup.start();
        for (let i = 0; i < 100 && !existsSync(marker); i++) await sleep(20);
        const advanced = existsSync(marker);
        sup.stop();
        await sleep(400);
        // DEFECTO afirma lo correcto: el navegador NO debe bloquearse por su propia salida.
        if (expectBlocked) expect({ advanced }).toEqual({ advanced: true });
        else expect(advanced).toBe(true);
      },
      15_000,
    );
  }
});
