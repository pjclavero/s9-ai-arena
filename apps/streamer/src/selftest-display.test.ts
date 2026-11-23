/**
 * Flaky del build `streamer` (AUD2-13) · carrera del display de la autoprueba de render.
 * Sin Xvfb/Chromium reales: un servidor X FALSO sobre un socket unix que reproduce lo que hace
 * Xvfb sin `-noreset` (cierra la escucha al irse el último cliente y la reabre RESET_MS después).
 *
 * Cada test se llama por lo que protege; scripts/mutants-streamer-selftest.sh reintroduce cada
 * carrera y exige que muera por el test nombrado.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canConnect,
  displaySocketPath,
  runIsolatedCases,
  startDisplay,
  waitForDisplay,
  xvfbArgs,
  type DisplayHandle,
} from "./selftest-display.js";

let dir: string;
let sock: string;
const servers: Server[] = [];
const timers: NodeJS.Timeout[] = [];
let stopped = false;
beforeEach(() => {
  stopped = false;
  dir = mkdtempSync(join(tmpdir(), "selftest-display-"));
  sock = join(dir, "X95");
});
afterEach(() => {
  stopped = true;
  for (const t of timers.splice(0)) clearTimeout(t);
  for (const s of servers.splice(0)) s.close();
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const listen = (path: string) =>
  new Promise<Server>((resolve) => {
    const s = createServer((c: Socket) => c.on("error", () => {}));
    servers.push(s);
    s.listen(path, () => resolve(s));
  });

/** Xvfb sin -noreset: al irse el ÚLTIMO cliente cierra la escucha y la reabre pasados resetMs. */
async function resettingServer(path: string, resetMs: number) {
  let clients = 0;
  let srv: Server;
  const open = async () => {
    if (stopped) return;
    srv = createServer((c: Socket) => {
      clients++;
      c.on("error", () => {});
      c.on("close", () => {
        if (--clients === 0 && !stopped) {
          srv.close();
          timers.push(setTimeout(() => void open(), resetMs));
        }
      });
    });
    servers.push(srv);
    await new Promise<void>((r) => {
      srv.once("error", () => r());
      srv.listen(path, r);
    });
  };
  await open();
}

class FakeProc extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  signals: string[] = [];
  constructor(private readonly exitAfterTermMs = 0) {
    super();
  }
  kill(sig: string = "SIGTERM") {
    this.signals.push(sig);
    setTimeout(
      () => {
        if (this.exitCode === null) {
          this.exitCode = 0;
          this.emit("exit", 0);
        }
      },
      sig === "SIGKILL" ? 0 : this.exitAfterTermMs,
    );
    return true;
  }
}

describe("reproducción de la carrera (Xvfb sin -noreset)", () => {
  it("RESET_REPRODUCIDO: un cliente que conecta justo tras irse el último es rechazado; waitForDisplay espera a que vuelva", async () => {
    await resettingServer(sock, 300);
    const c = await new Promise<Socket>((resolve) => {
      const s = connect(sock, () => resolve(s));
    });
    c.destroy(); // se va el último cliente (el positivo para Chromium y ffmpeg)
    await sleep(40);
    // Esto es lo que vio Chromium del negativo: «Missing X server or $DISPLAY».
    expect(await canConnect(sock)).toBe(false);
    const t0 = Date.now();
    await waitForDisplay(sock, { timeoutMs: 3000, pollMs: 20 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    expect(await canConnect(sock)).toBe(true);
  });
});

describe("startDisplay", () => {
  it("NORESET: el Xvfb se lanza con -noreset y sin escuchar en tcp", () => {
    const a = xvfbArgs(":95");
    expect(a).toContain("-noreset");
    expect(a).toEqual(expect.arrayContaining(["-nolisten", "tcp"]));
    expect(a[0]).toBe(":95");
  });

  it("LISTO_ES_ACEPTAR: con el fichero de socket ya creado pero sin escuchar, NO está listo hasta que acepta conexiones", async () => {
    // bind() ya hizo aparecer el fichero; listen() llega 300 ms después.
    writeFileSync(sock, "");
    const proc = new FakeProc();
    const startedListening = { at: 0 };
    timers.push(
      setTimeout(() => {
        rmSync(sock, { force: true });
        void listen(sock).then(() => (startedListening.at = Date.now()));
      }, 300),
    );
    const t0 = Date.now();
    const h = await startDisplay(":95", {
      spawnXvfb: () => proc as never,
      socketPath: sock,
      pollMs: 20,
      timeoutMs: 3000,
    });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(await canConnect(sock)).toBe(true);
    await h.stop();
  });

  it("FALLA_CERRADO: si el Xvfb nunca acepta, rechaza al plazo y no deja el proceso vivo", async () => {
    const proc = new FakeProc();
    await expect(
      startDisplay(":95", { spawnXvfb: () => proc as never, socketPath: sock, pollMs: 10, timeoutMs: 150 }),
    ).rejects.toThrow(/no aceptó conexiones/);
    expect(proc.signals).toContain("SIGTERM");
    expect(proc.exitCode).toBe(0);
  });

  it("STOP_ESPERA_SALIDA: stop() no resuelve hasta que el Xvfb ha salido", async () => {
    await listen(sock);
    const proc = new FakeProc(200);
    const h = await startDisplay(":95", { spawnXvfb: () => proc as never, socketPath: sock, pollMs: 10 });
    const t0 = Date.now();
    await h.stop();
    expect(proc.exitCode).toBe(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
  });

  it("STOP_ESCALA_A_KILL: si ignora SIGTERM, stop() escala a SIGKILL y resuelve", async () => {
    await listen(sock);
    const proc = new FakeProc(60_000);
    const h = await startDisplay(":95", {
      spawnXvfb: () => proc as never,
      socketPath: sock,
      pollMs: 10,
      stopGraceMs: 50,
    });
    await h.stop();
    expect(proc.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("displaySocketPath sigue el número de display", () => {
    expect(displaySocketPath(":96.0")).toBe("/tmp/.X11-unix/X96");
  });
});

describe("runIsolatedCases", () => {
  function harness(opts: { runFails?: string } = {}) {
    const events: string[] = [];
    const start = async (display: string): Promise<DisplayHandle> => {
      events.push(`start ${display}`);
      return {
        display,
        stop: async () => {
          await sleep(30);
          events.push(`stop ${display}`);
        },
      };
    };
    const run = async (name: string, display: string) => {
      events.push(`run ${name}@${display}`);
      if (opts.runFails === name) throw new Error("boom");
      return name;
    };
    return { events, start, run };
  }
  const cases = [
    { name: "ok", display: ":95" },
    { name: "white", display: ":96" },
  ];

  it("UN_DISPLAY_POR_CASO: cada caso corre en su display y el anterior está PARADO Y ESPERADO antes del siguiente", async () => {
    const h = harness();
    const r = await runIsolatedCases(cases, h.start, h.run);
    expect(r).toEqual(["ok", "white"]);
    expect(h.events).toEqual(["start :95", "run ok@:95", "stop :95", "start :96", "run white@:96", "stop :96"]);
  });

  it("PARA_AUNQUE_FALLE: si el caso lanza, su display se para igualmente", async () => {
    const h = harness({ runFails: "ok" });
    await expect(runIsolatedCases(cases, h.start, h.run)).rejects.toThrow("boom");
    expect(h.events).toEqual(["start :95", "run ok@:95", "stop :95"]);
  });
});

describe("render-selftest.ts usa el display aislado", () => {
  it("SELFTEST_CABLEADO: no vuelve a levantar un Xvfb compartido ni a darlo por listo por el fichero", () => {
    const src = readFileSync(new URL("./render-selftest.ts", import.meta.url), "utf8");
    expect(src).toMatch(/runIsolatedCases\(/);
    expect(src).toMatch(/startDisplay\(/);
    expect(src).not.toMatch(/spawn\(\s*"Xvfb"/);
    expect(src).not.toMatch(/existsSync\(/);
  });
});
