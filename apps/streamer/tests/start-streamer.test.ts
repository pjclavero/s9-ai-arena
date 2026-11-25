/**
 * Calibración de `support/start-streamer.ts` con el `main.ts` REAL del streamer y un puerto ocupado
 * a voluntad: reproduce de forma determinista el flaky de eq6c «CIERRE P2-3 … expected false to be
 * true» (el hijo muere con `listen EADDRINUSE` y el patrón antiguo sondeaba 15 s un puerto ajeno).
 * Sin el arreglo, estos casos se ponen rojos siempre. Mutantes: scripts/mutants-start-streamer.sh.
 */
import { afterAll, describe, expect, it } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killAllServices } from "../../../packages/test-process/index.js";
import { freePort } from "../../bot-manager/tests/support/spawn-main.js";
import { startStreamer } from "./support/start-streamer.js";

/** El caso del flaky de main e69eb0f7: secreto definido pero INEXISTENTE ⇒ /healthz 503. */
const missingSecret = () => join(mkdtempSync(join(tmpdir(), "start-streamer-")), "no-existe");

async function occupyTcp(): Promise<{ port: number; close: () => Promise<void> }> {
  const s = net.createServer((c) => c.destroy());
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { port: (s.address() as AddressInfo).port, close: () => new Promise((r) => s.close(() => r())) };
}

/** Otro servicio HTTP ajeno que contesta 200 a todo (lo que el patrón antiguo tomaba por «up»). */
async function occupyHttp(): Promise<{ port: number; close: () => Promise<void> }> {
  const s = createHttpServer((_req, res) => res.end("ajeno"));
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return {
    port: (s.address() as AddressInfo).port,
    close: () => new Promise((r) => (s.closeAllConnections(), s.close(() => r()))),
  };
}

/** Devuelve primero `first` (ocupado) y luego puertos del SO. */
const firstThenFree = (first: number) => {
  let n = 0;
  return () => (n++ === 0 ? Promise.resolve(first) : freePort());
};

describe("start-streamer · puerto del proceso REAL del streamer", () => {
  afterAll(() => killAllServices());

  it("MECANISMO: con el puerto ocupado el main.ts real MUERE con listen EADDRINUSE (no es lentitud)", async () => {
    const busy = await occupyTcp();
    try {
      const t0 = Date.now();
      const err = await startStreamer(
        { STREAMER_CONTROL_SECRET_FILE: missingSecret() },
        { pickPort: () => Promise.resolve(busy.port), maxAttempts: 1 },
      ).then(
        () => null,
        (e: Error) => e,
      );
      expect(err?.message).toMatch(/salió antes de[\s\S]*listen EADDRINUSE/);
      // Muere en cuanto intenta escuchar: el sondeo antiguo de 15 s esperaba a un proceso ya muerto.
      expect(Date.now() - t0).toBeLessThan(15_000);
    } finally {
      await busy.close();
    }
  }, 30_000);

  it("PUERTO: si el puerto elegido ya está ocupado relanza con otro y el hijo real arranca (secreto inexistente ⇒ 503/401)", async () => {
    const busy = await occupyTcp();
    try {
      const s = await startStreamer(
        { STREAMER_CONTROL_SECRET_FILE: missingSecret() },
        { pickPort: firstThenFree(busy.port) },
      );
      try {
        expect(s.attempts).toBe(2);
        expect(s.port).not.toBe(busy.port);
        expect((await fetch(`${s.base}/healthz`)).status).toBe(503);
        expect((await fetch(`${s.base}/status`)).status).toBe(401);
      } finally {
        await s.stop();
      }
    } finally {
      await busy.close();
    }
  }, 30_000);

  it("IDENTIDAD: un servicio HTTP ajeno en el puerto NO cuenta como «up»; sólo vale el «escuchando» de ESTE hijo", async () => {
    const other = await occupyHttp();
    try {
      // Control: el ocupante contesta en /healthz ⇒ el sondeo antiguo («cualquier respuesta») lo daba por arrancado.
      expect((await fetch(`http://127.0.0.1:${other.port}/healthz`)).status).toBe(200);
      const s = await startStreamer(
        { STREAMER_CONTROL_SECRET_FILE: missingSecret() },
        { pickPort: firstThenFree(other.port) },
      );
      try {
        expect(s.attempts).toBe(2);
        expect(s.port).not.toBe(other.port);
        expect((await fetch(`${s.base}/healthz`)).status).toBe(503);
      } finally {
        await s.stop();
      }
    } finally {
      await other.close();
    }
  }, 30_000);
});
