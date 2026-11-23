/**
 * Calibración de la carrera de `freePort()` en el arranque del Postgres embebido de los tests:
 * sólo un EADDRINUSE confirmado se relanza (con tope); cualquier otro error se propaga.
 * Mutantes: scripts/mutants-test-db-port.sh.
 */
import { describe, expect, it } from "vitest";
import { createServer, type AddressInfo } from "node:net";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { launchEmbedded, PortBusyError, startOnFreePort, stopOrKill } from "./test-db.js";

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

  it("FALLO TOTAL: con el puerto ocupado en TODAS las direcciones (Postgres sale) no cuelga, lanza PortBusyError y limpia el dataDir", async (ctx) => {
    const before = new Set(readdirSync(tmpdir()).filter((d) => d.startsWith("e7-pg-")));
    // `::` en doble pila ocupa también IPv4. Sin IPv6 en loopback no se puede reproducir: se SALTA de
    // forma explícita (queda como «skipped» en el informe de vitest, nunca como verde silencioso).
    const s = createServer();
    const listening = await new Promise<boolean>((r) => {
      s.once("error", () => r(false));
      s.listen(0, "::", () => r(true));
    });
    if (!listening) ctx.skip("sin IPv6 en loopback: FALLO TOTAL no se puede reproducir en este host");
    console.log("FALLO TOTAL: ejecutado (IPv6 disponible)");
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

describe("stopOrKill · plazo vencido con Postgres vivo", () => {
  it("si stop() no resuelve, mata el proceso por pid y espera a que desaparezca antes de devolver", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const pid = child.pid!;
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const exited = new Promise<void>((r) => child.on("exit", () => r()));
    try {
      const fake = { stop: () => new Promise<void>(() => {}), process: { pid } };
      await stopOrKill(fake, 150);
      await exited;
      expect(alive()).toBe(false);
    } finally {
      if (alive()) child.kill("SIGKILL");
    }
  }, 30_000);

  it("si stop() resuelve a tiempo no mata nada", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      await stopOrKill({ stop: async () => {}, process: { pid: child.pid } } as never, 5_000);
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally {
      child.kill("SIGKILL");
    }
  }, 30_000);
});
