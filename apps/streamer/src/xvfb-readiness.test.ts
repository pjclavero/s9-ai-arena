/**
 * Flaky AUD2-13 en PRODUCCIÓN · el Xvfb a demanda (xvfb.ts) y el del modo permanente
 * (entrypoint.sh) se lanzaban sin `-noreset` y se daban por listos con sólo ver el fichero del
 * socket. Servidor X FALSO sobre un socket unix: bind() deja el fichero y listen() llega después.
 * scripts/mutants-streamer-xvfb-readiness.sh reintroduce cada defecto y exige que muera por el
 * test nombrado.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpawnedProcess, Spawner } from "./supervisor.js";
import { canConnectX, xvfbArgs, XvfbDisplay } from "./xvfb.js";

let dir: string;
const servers: Server[] = [];
const timers: NodeJS.Timeout[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xvfb-readiness-"));
});
afterEach(() => {
  for (const t of timers.splice(0)) clearTimeout(t);
  for (const s of servers.splice(0)) s.close();
  rmSync(dir, { recursive: true, force: true });
});

class FakeXvfb extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  constructor(
    readonly cmd: string,
    readonly args: string[],
  ) {
    super();
  }
  kill() {
    if (this.exitCode === null) {
      this.exitCode = 0;
      setImmediate(() => this.emit("exit", 0));
    }
    return true;
  }
}

/** Spawner cuyo «Xvfb» hace bind() YA (aparece el fichero) y listen() a los lateMs. */
function lateListenSpawner(sock: string, lateMs: number) {
  const procs: FakeXvfb[] = [];
  const spawner: Spawner = (cmd, args) => {
    const p = new FakeXvfb(cmd, args);
    procs.push(p);
    writeFileSync(sock, ""); // bind(): el fichero ya existe, nadie escucha
    timers.push(
      setTimeout(() => {
        rmSync(sock, { force: true });
        const srv = createServer((c) => c.on("error", () => {}));
        servers.push(srv);
        srv.listen(sock);
      }, lateMs),
    );
    return p as unknown as SpawnedProcess;
  };
  return { spawner, procs };
}

describe("Xvfb a demanda: readiness y -noreset", () => {
  it("XVFB_NORESET: el Xvfb se lanza con -noreset y sin escuchar en tcp (resto de args intacto)", async () => {
    const sock = join(dir, "X871");
    const { spawner, procs } = lateListenSpawner(sock, 0);
    const d = new XvfbDisplay({ spawner, display: ":871", width: 1920, height: 1080, sockDir: dir });
    await d.ensure();
    const a = procs[0].args;
    expect(a).toContain("-noreset");
    expect(a).toEqual([":871", "-screen", "0", "1920x1080x24", "-nolisten", "tcp", "-noreset"]);
    expect(xvfbArgs(":871", 1920, 1080)).toEqual(a);
    d.release();
  });

  it("XVFB_LISTO_ES_ACEPTAR: con el fichero del socket ya creado pero sin escuchar, ensure() NO resuelve hasta que acepta conexiones", async () => {
    const sock = join(dir, "X872");
    const { spawner } = lateListenSpawner(sock, 300);
    const d = new XvfbDisplay({
      spawner,
      display: ":872",
      width: 640,
      height: 360,
      sockDir: dir,
      readyTimeoutMs: 3000,
    });
    const t0 = Date.now();
    await d.ensure();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(await canConnectX(sock)).toBe(true);
    d.release();
  });

  it("XVFB_FALLA_CERRADO: un fichero de socket que nunca escucha sigue siendo fallo (no «listo»)", async () => {
    const sock = join(dir, "X873");
    const spawner: Spawner = (cmd, args) => {
      writeFileSync(sock, "");
      return new FakeXvfb(cmd, args) as unknown as SpawnedProcess;
    };
    const d = new XvfbDisplay({ spawner, display: ":873", width: 640, height: 360, sockDir: dir, readyTimeoutMs: 200 });
    await expect(d.ensure()).rejects.toThrow(/no creó/);
  });
});

describe("entrypoint.sh (Xvfb permanente)", () => {
  const src = readFileSync(new URL("../../../infrastructure/docker/streamer/entrypoint.sh", import.meta.url), "utf8");
  it("ENTRYPOINT_NORESET: lanza Xvfb con -noreset", () => {
    const line = src.split("\n").find((l) => /^\s*Xvfb "\$DISPLAY"/.test(l));
    expect(line).toBeDefined();
    expect(line).toMatch(/-nolisten tcp -noreset &/);
  });
  it("ENTRYPOINT_LISTO_ES_ACEPTAR: la espera comprueba una conexión al socket, no sólo `-S`", () => {
    const cond = src.split("\n").find((l) => /if \[ -S "\$X_SOCK" \]/.test(l));
    expect(cond).toBeDefined();
    expect(cond).toMatch(/net"\)\.connect\(process\.argv\[1\]\)/);
  });
});
