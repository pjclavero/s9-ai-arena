/**
 * Flaky AUD2-13 en PRODUCCIÓN · el Xvfb a demanda (xvfb.ts) y el del modo permanente
 * (entrypoint.sh) se lanzaban sin `-noreset` y se daban por listos con sólo ver el fichero del
 * socket. Servidor X FALSO sobre un socket unix: bind() deja el fichero y listen() llega después.
 * scripts/mutants-streamer-xvfb-readiness.sh reintroduce cada defecto y exige que muera por el
 * test nombrado.
 */
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

describe("Xvfb a demanda: el valor por defecto de la sonda es SIEMPRE el connect real", () => {
  it("XVFB_EXISTS_NO_CAMBIA_EL_DEFECTO: inyectar `exists` (ficheros simulados) NO salta la sonda de conexión", async () => {
    const files = new Set<string>();
    const spawner: Spawner = (cmd, args) => {
      files.add(join(dir, "X874")); // fichero «existe», pero nadie escucha
      return new FakeXvfb(cmd, args) as unknown as SpawnedProcess;
    };
    const d = new XvfbDisplay({
      spawner,
      display: ":874",
      width: 640,
      height: 360,
      sockDir: dir,
      readyTimeoutMs: 200,
      exists: (p) => files.has(p),
      readFile: () => {
        throw new Error("no existe");
      },
      remove: () => {},
    });
    await expect(d.ensure()).rejects.toThrow(/no creó/);
  });
});

const ENTRYPOINT = fileURLToPath(new URL("../../../infrastructure/docker/streamer/entrypoint.sh", import.meta.url));

describe("entrypoint.sh (Xvfb permanente), EJECUTADO con un Xvfb falso", () => {
  const stubXvfb = `#!/usr/bin/env python3
import os, socket, sys, time
disp = sys.argv[1].lstrip(":").split(".")[0]
d = os.environ["X11_SOCKET_DIR"]
open(os.path.join(d, "xvfb.pid"), "w").write(str(os.getpid()))
s = socket.socket(socket.AF_UNIX)
s.bind(os.path.join(d, "X" + disp))  # bind(): el fichero YA existe, aún nadie escucha
open(os.path.join(d, "xvfb.args"), "w").write(" ".join(sys.argv[1:]))
if os.environ.get("STUB_MODE", "late") == "late":
    time.sleep(float(os.environ.get("STUB_DELAY", "0.6")))
    s.listen(8)
while True:
    time.sleep(1)
`;
  // Lo que el supervisor haría al arrancar: conectar al socket. Dice si ACEPTA en el momento del exec.
  const stubTsx = `#!/usr/bin/env python3
import os, socket
c = socket.socket(socket.AF_UNIX)
try:
    c.connect(os.path.join(os.environ["X11_SOCKET_DIR"], "X879"))
    print("CONNECT_OK")
except OSError:
    print("CONNECT_FAIL")
`;
  let work: string;
  let xdir: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "entrypoint-"));
    xdir = join(work, "x11");
    mkdirSync(xdir);
    mkdirSync(join(work, "stubs"));
    writeFileSync(join(work, "stubs", "Xvfb"), stubXvfb);
    writeFileSync(join(work, "stubs", "tsx"), stubTsx);
    chmodSync(join(work, "stubs", "Xvfb"), 0o755);
    chmodSync(join(work, "stubs", "tsx"), 0o755);
  });
  afterEach(() => {
    // Mata SOLO por PID verificado (el que escribió el Xvfb falso).
    try {
      const pid = Number(readFileSync(join(xdir, "xvfb.pid"), "utf8"));
      if (pid > 1) process.kill(pid, "SIGTERM");
    } catch {
      /* ya no existe */
    }
    rmSync(work, { recursive: true, force: true });
  });

  function run(env: Record<string, string>, opts: { path?: string } = {}) {
    const t0 = Date.now();
    const r = spawnSync("bash", [ENTRYPOINT], {
      encoding: "utf8",
      timeout: 15_000,
      env: {
        PATH: opts.path ?? `${join(work, "stubs")}:${process.env.PATH}`,
        DISPLAY: ":879",
        STREAMER_XVFB_ON_DEMAND: "0",
        X11_SOCKET_DIR: xdir,
        ...env,
      },
    });
    return { rc: r.status, signal: r.signal, out: r.stdout, err: r.stderr, ms: Date.now() - t0 };
  }

  it("ENTRYPOINT_NORESET: lanza Xvfb con -noreset (argumentos EJECUTADOS)", () => {
    const r = run({});
    expect(r.rc).toBe(0);
    expect(readFileSync(join(xdir, "xvfb.args"), "utf8")).toMatch(/-nolisten tcp -noreset$/);
  });

  it("ENTRYPOINT_ESPERA_LISTEN: con el socket ya creado (bind) pero sin escuchar, NO sigue hasta que acepta", () => {
    const r = run({ STUB_DELAY: "0.8" });
    expect(r.rc).toBe(0);
    expect(r.out).toContain("CONNECT_OK");
    expect(r.ms).toBeGreaterThanOrEqual(700);
  });

  it("ENTRYPOINT_PLAZO_ACOTADO: un socket que nunca escucha falla cerrado dentro del plazo documentado", () => {
    const r = run({ STUB_MODE: "nolisten", STREAMER_XVFB_READY_TIMEOUT_S: "2" });
    expect(r.signal).toBeNull();
    expect(r.rc).toBe(1);
    expect(r.err).toMatch(/no aceptó conexiones en .* tras 2s/);
    expect(r.ms).toBeGreaterThanOrEqual(1000); // $SECONDS tiene resolución de 1 s
    expect(r.ms).toBeLessThan(8000);
  }, 20_000);

  it("ENTRYPOINT_PLAZO_INVALIDO: un plazo mal formado o fuera de rango es un error claro", () => {
    for (const v of ["abc", "0", "121", "-3"]) {
      const r = run({ STREAMER_XVFB_READY_TIMEOUT_S: v });
      expect(r.rc, v).toBe(1);
      expect(r.err, v).toMatch(/STREAMER_XVFB_READY_TIMEOUT_S (inválido|fuera de rango)/);
    }
  });

  it("ENTRYPOINT_SIN_NODE: si falta node el error lo dice (no «Xvfb no creó el socket»)", () => {
    const bin = join(work, "bin");
    mkdirSync(bin);
    for (const t of ["bash", "sleep", "cat", "tr", "rm", "env", "python3", "dirname"]) {
      const real = spawnSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
      if (real) symlinkSync(real, join(bin, t));
    }
    const r = run({}, { path: `${join(work, "stubs")}:${bin}` });
    expect(r.rc).toBe(1);
    expect(r.err).toMatch(/falta 'node'/);
    expect(existsSync(join(xdir, "xvfb.args"))).toBe(false);
  });

  it("ENTRYPOINT_SONDEO_CON_TIMEOUT: el sondeo node lleva su propio timeout", () => {
    const src = readFileSync(ENTRYPOINT, "utf8");
    expect(src).toMatch(/PROBE_JS='[^']*setTimeout\(\(\)=>process\.exit\(1\),1000\)/);
  });
});
