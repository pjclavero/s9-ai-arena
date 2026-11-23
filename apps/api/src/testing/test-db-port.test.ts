/**
 * Calibración de la carrera de `freePort()` en el arranque del Postgres embebido de los tests:
 * sólo un EADDRINUSE confirmado se relanza (con tope); cualquier otro error se propaga.
 * Mutantes: scripts/mutants-test-db-port.sh.
 */
import { describe, expect, it } from "vitest";
import { createServer, type AddressInfo } from "node:net";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { launchEmbedded, PortBusyError, startOnFreePort } from "./test-db.js";

const isBusy = (e: unknown) => e instanceof PortBusyError;

describe("startOnFreePort · reintento acotado y específico", () => {
  it("PUERTO ocupado confirmado: relanza con otro puerto y arranca", async () => {
    const picks = [111, 222];
    const r = await startOnFreePort(
      async (p) => {
        if (p === 111) throw new PortBusyError("ocupado");
        return "ok";
      },
      { isBusy, pickPort: async () => picks.shift()! },
    );
    expect(r).toMatchObject({ value: "ok", port: 222, attempts: 2 });
  });

  it("OTRO error se propaga sin reintentar", async () => {
    let n = 0;
    await expect(
      startOnFreePort(
        async () => {
          throw new Error("initdb falló");
        },
        { isBusy, pickPort: async () => ++n },
      ),
    ).rejects.toThrow(/initdb falló/);
    expect(n).toBe(1);
  });

  it("TOPE: con el puerto siempre ocupado agota maxAttempts y falla", async () => {
    let n = 0;
    await expect(
      startOnFreePort(
        async () => {
          throw new PortBusyError("ocupado");
        },
        {
          isBusy,
          maxAttempts: 3,
          // Sin tope el bucle sería infinito: se corta a los 10 para que el mutante muera, no cuelgue.
          pickPort: async () => {
            if (++n > 10) throw new Error("sin tope: más de 10 intentos");
            return n;
          },
        },
      ),
    ).rejects.toBeInstanceOf(PortBusyError);
    expect(n).toBe(3);
  });
});

describe("launchEmbedded · señal real de puerto ocupado", () => {
  it("con el puerto ocupado por otro proceso lanza PortBusyError y no deja directorio de datos", async () => {
    const before = new Set(readdirSync(tmpdir()).filter((d) => d.startsWith("e7-pg-")));
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const port = (s.address() as AddressInfo).port;
    try {
      // Si arrancara (mutante), se para en el acto: un clúster vivo mantendría colgado al runner.
      const outcome = await launchEmbedded(port).then(
        async (pg) => {
          await pg.stop();
          return "arrancó" as const;
        },
        (e: unknown) => e,
      );
      expect(outcome).toBeInstanceOf(PortBusyError);
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
    const after = readdirSync(tmpdir()).filter((d) => d.startsWith("e7-pg-") && !before.has(d));
    expect(after.filter((d) => existsSync(`${tmpdir()}/${d}`))).toEqual([]);
  }, 120_000);

  it("FALLO TOTAL: con el puerto ocupado en TODAS las direcciones (Postgres sale) no cuelga, lanza PortBusyError y limpia el dataDir", async () => {
    const before = new Set(readdirSync(tmpdir()).filter((d) => d.startsWith("e7-pg-")));
    // `::` en doble pila ocupa también IPv4. Sin IPv6 en el host no se puede reproducir: se anota y sale.
    const s = createServer();
    const listening = await new Promise<boolean>((r) => {
      s.once("error", () => r(false));
      s.listen(0, "::", () => r(true));
    });
    if (!listening) return;
    const port = (s.address() as AddressInfo).port;
    try {
      // `stop()` tras la salida temprana de Postgres no resuelve nunca: el plazo del test lo delata.
      const outcome = await launchEmbedded(port).then(
        async (pg) => {
          await pg.stop();
          return "arrancó" as const;
        },
        (e: unknown) => e,
      );
      expect(outcome).toBeInstanceOf(PortBusyError);
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
    const after = readdirSync(tmpdir()).filter((d) => d.startsWith("e7-pg-") && !before.has(d));
    expect(after.filter((d) => existsSync(`${tmpdir()}/${d}`))).toEqual([]);
  }, 30_000);
});
