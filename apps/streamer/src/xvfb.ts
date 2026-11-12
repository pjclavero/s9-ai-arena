/**
 * OLA2-MF · Xvfb A DEMANDA.
 *
 * Antes el entrypoint arrancaba el Xvfb con el contenedor y lo dejaba vivo para
 * siempre, emitiera o no (≈ un framebuffer de 1920×1080×24 más el proceso). Su
 * único consumidor es la emisión: Chromium pinta en él y FFmpeg (x11grab) y la
 * sonda de render (frame-check) lo leen; /healthz, /status y la API de control
 * no lo tocan. No hay, por tanto, razón técnica para mantenerlo sin emisión: se
 * arranca al pedir una emisión (`ensure`) y se para al terminarla (`release`).
 *
 * Lo que el entrypoint hacía y se conserva aquí:
 *  - #251 · un lock/socket RANCIO (de un Xvfb que ya no existe, p. ej. tras
 *    `docker restart`, que conserva /tmp) se borra; uno de un Xvfb VIVO, no;
 *    no basta `kill -0` porque los PID se reutilizan: se mira /proc/<pid>/comm.
 *  - fallo cerrado: si el Xvfb no crea su socket a tiempo o muere al arrancar,
 *    `ensure` rechaza y el supervisor lo trata como corte (reintento contado).
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import type { SpawnedProcess, Spawner } from "./supervisor.js";

export interface DisplayManager {
  /** Garantiza el display vivo y listo. Idempotente. */
  ensure(): Promise<void>;
  /** Para el display (TERM → KILL tras la gracia). Idempotente. */
  release(): void;
  /** ¿Hay un proceso de display vivo (no parado)? */
  readonly running: boolean;
  /** Procesos de display señalados que aún no han salido. */
  readonly terminating: number;
}

export interface XvfbOptions {
  spawner: Spawner;
  display: string;
  width: number;
  height: number;
  xvfbBin?: string;
  /** Plazo para que aparezca el socket. Def. 5000 ms. */
  readyTimeoutMs?: number;
  stopGraceMs?: number;
  /** Inyectables (tests). */
  exists?: (p: string) => boolean;
  readFile?: (p: string) => string;
  remove?: (p: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export class XvfbDisplay implements DisplayManager {
  private proc: SpawnedProcess | null = null;
  private exited = true;
  private starting: Promise<void> | null = null;
  private dying = 0;
  /** Arranques y paradas (observabilidad y tests). */
  readonly stats = { starts: 0, stops: 0, killed: 0 };

  constructor(private readonly o: XvfbOptions) {}

  private get num(): string {
    return this.o.display.replace(/^:/, "").split(".")[0];
  }
  private get lockPath(): string {
    return `/tmp/.X${this.num}-lock`;
  }
  private get sockPath(): string {
    return `/tmp/.X11-unix/X${this.num}`;
  }

  get running(): boolean {
    return this.proc !== null && !this.exited;
  }

  get terminating(): number {
    return this.dying;
  }

  /** #251 · borra lock/socket sólo si no pertenecen a un Xvfb vivo. Devuelve false si hay uno vivo ajeno. */
  private clearStale(): boolean {
    const exists = this.o.exists ?? existsSync;
    const read = this.o.readFile ?? ((p: string) => readFileSync(p, "utf8"));
    const remove = this.o.remove ?? ((p: string) => rmSync(p, { force: true }));
    if (exists(this.lockPath)) {
      let pid = "";
      try {
        pid = read(this.lockPath).replace(/[^0-9]/g, "");
      } catch {
        /* ilegible = rancio */
      }
      let comm = "";
      try {
        comm = pid ? read(`/proc/${pid}/comm`).trim() : "";
      } catch {
        comm = "";
      }
      if (comm === "Xvfb") return false;
      remove(this.lockPath);
      remove(this.sockPath);
    } else if (exists(this.sockPath)) {
      remove(this.sockPath);
    }
    return true;
  }

  ensure(): Promise<void> {
    if (this.running && !this.starting) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.waitForDying()
      .then(() => this.start())
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  /**
   * Carrera stop→start: `release()` pone proc=null y envía TERM, pero el Xvfb sigue
   * en /proc (comm=Xvfb) y con su lock hasta que sale. Si `start()` corriera ya,
   * `clearStale()` vería un Xvfb "vivo ajeno" y rechazaría. Se espera a que los
   * procesos señalados salgan (acotado: gracia + SIGKILL + margen).
   */
  private async waitForDying(): Promise<void> {
    if (this.dying === 0) return;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = Date.now() + (this.o.stopGraceMs ?? 5000) + 3000;
    while (this.dying > 0 && Date.now() < deadline) await sleep(25);
  }

  private async start(): Promise<void> {
    if (!this.clearStale()) throw new Error(`el display ${this.o.display} ya lo usa un Xvfb vivo ajeno`);
    const exists = this.o.exists ?? existsSync;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const proc = this.o.spawner(this.o.xvfbBin ?? "Xvfb", [
      this.o.display,
      "-screen",
      "0",
      `${this.o.width}x${this.o.height}x24`,
      "-nolisten",
      "tcp",
    ]);
    this.proc = proc;
    this.exited = false;
    this.stats.starts++;
    proc.stdout?.on("data", () => {});
    proc.stderr?.on("data", () => {});
    proc.stdout?.on("error", () => {});
    proc.stderr?.on("error", () => {});
    proc.on("exit", () => {
      if (this.proc === proc) this.exited = true;
    });
    const deadline = Date.now() + (this.o.readyTimeoutMs ?? 5000);
    while (Date.now() < deadline) {
      if (this.proc !== proc || this.exited) throw new Error(`Xvfb terminó al arrancar en ${this.o.display}`);
      if (exists(this.sockPath)) return;
      await sleep(50);
    }
    this.release();
    throw new Error(`Xvfb no creó ${this.sockPath} a tiempo`);
  }

  release(): void {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    if (this.exited) return;
    this.stats.stops++;
    let done = false;
    this.dying++;
    proc.once("exit", () => {
      done = true;
      this.dying--;
    });
    try {
      proc.kill("SIGTERM");
    } catch {
      /* ya no existe */
    }
    const t = setTimeout(() => {
      if (!done) {
        this.stats.killed++;
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ya no existe */
        }
      }
    }, this.o.stopGraceMs ?? 5000);
    t.unref?.();
  }
}
