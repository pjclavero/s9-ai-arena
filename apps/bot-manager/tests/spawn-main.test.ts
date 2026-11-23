/**
 * Calibración del apoyo `support/spawn-main.ts` con un hijo FALSO que reproduce a voluntad las dos
 * carreras que hicieron flaky a `docker-proxy.test.ts` (y, en cadena, a `no-orphans.test.ts`):
 *
 *  - la línea de log de un request llega a la tubería DESPUÉS de que el cliente ya tiene la respuesta;
 *  - el puerto «libre» elegido por `freePort()` lo ocupa otro proceso antes de que el servicio lo abra.
 *
 * Sin el arreglo, estos casos se ponen rojos siempre (no «a veces»). Mutantes: scripts/mutants-spawn-main.sh.
 */
import { afterAll, describe, expect, it } from "vitest";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { killAllServices } from "../../../packages/test-process/index.js";
import { startMain } from "./support/spawn-main.js";

/** Hijo falso: escucha en $PORT, anuncia «escuchando» y registra cada request con 400 ms de retraso. */
const FAKE_SERVER = `
const http = require("node:http");
const srv = http.createServer((req, res) => {
  res.statusCode = 403; res.end("{}");
  setTimeout(() => console.log('{"msg":"decision","allowed":false}'), 400);
});
srv.on("error", (e) => { console.error("no se pudo escuchar: " + e.message); process.exit(1); });
srv.listen(Number(process.env.PORT), "127.0.0.1", () => console.log("proxy escuchando"));
`;
const FAKE = { command: process.execPath, args: ["-e", FAKE_SERVER], untilLog: /proxy escuchando/ };
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function occupy(): Promise<{ port: number; close: () => Promise<void> }> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { port: (s.address() as AddressInfo).port, close: () => new Promise((r) => s.close(() => r())) };
}

describe("spawn-main · carreras del harness del docker-proxy", () => {
  afterAll(() => killAllServices());

  it("LECTURA: la línea de log llega tras la respuesta ⇒ output() inmediato NO la tiene; waitFor sí la espera", async () => {
    const { p, port } = await startMain((port) => ({ PORT: String(port) }), FAKE);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/x`);
      expect(res.status).toBe(403);
      // Control: la carrera existe (el patrón antiguo, expect(p.output()).toMatch, fallaría aquí).
      expect(p.output()).not.toMatch(/"allowed":false/);
      await p.waitFor(/"allowed":false/);
      expect(p.output()).toMatch(/"allowed":false/);
    } finally {
      p.child.kill("SIGKILL");
      await p.exited;
    }
  }, 30_000);

  it("PUERTO: si el puerto elegido ya está ocupado (EADDRINUSE) relanza con otro y arranca", async () => {
    const busy = await occupy();
    try {
      const free = await occupy();
      await free.close();
      const picks = [busy.port, free.port];
      const { p, port, attempts } = await startMain((port) => ({ PORT: String(port) }), {
        ...FAKE,
        pickPort: async () => picks.shift()!,
      });
      try {
        expect(attempts).toBe(2);
        expect(port).toBe(free.port);
      } finally {
        p.child.kill("SIGKILL");
        await p.exited;
      }
    } finally {
      await busy.close();
    }
  }, 30_000);

  it("PUERTO: sólo EADDRINUSE se relanza; cualquier otra salida prematura se propaga sin reintentar", async () => {
    let picks = 0;
    await expect(
      startMain(() => ({}), {
        command: process.execPath,
        args: ["-e", 'console.error("configuración rechazada"); process.exit(78)'],
        untilLog: /proxy escuchando/,
        pickPort: async () => ++picks,
      }),
    ).rejects.toThrow(/salió antes de .*configuración rechazada/s);
    expect(picks).toBe(1);
  }, 30_000);

  it("PUERTO: con el puerto siempre ocupado agota maxAttempts, falla y no deja el hijo vivo", async () => {
    const busy = await occupy();
    let picks = 0;
    try {
      await expect(
        startMain((port) => ({ PORT: String(port) }), {
          ...FAKE,
          maxAttempts: 3,
          pickPort: async () => (++picks, busy.port),
        }),
      ).rejects.toThrow(/EADDRINUSE/);
      expect(picks).toBe(3);
    } finally {
      await busy.close();
    }
  }, 30_000);

  it("FALLO: si el hijo no llega a anunciar, startMain lo mata y espera su salida (sin huérfanos)", async () => {
    const err = await startMain(() => ({}), {
      command: process.execPath,
      args: ["-e", 'console.log("pid=" + process.pid); setInterval(() => {}, 1000)'],
      untilLog: /nunca/,
      timeoutMs: 600,
      pickPort: async () => 1,
    }).catch((e: Error) => e);
    expect(String(err)).toMatch(/timeout esperando/);
    const pid = Number(/pid=(\d+)/.exec(String(err))?.[1]);
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(false);
  }, 30_000);
});
