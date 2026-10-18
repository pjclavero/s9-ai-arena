/**
 * PRC · TD-034 — runner de prueba SIN Docker que reproduce el CONTRATO del
 * bootstrap real (sandbox-bootstrap/bootstrap.{py,mjs}) contra el SandboxHost y
 * el ProtocolServer REALES: descarga el artefacto con su token, envía `ready`,
 * «importa» el código del usuario, conecta por WebSocket, manda HELLO y responde
 * a cada OBSERVATION con un COMMAND válido.
 *
 * Cada fase tiene un retardo configurable para fabricar de verdad (con tiempo
 * real, no con relojes falsos) los casos de TD-034: plataforma lenta antes de
 * `ready`, bot lento tras `ready`, bot que nunca llega, fallos con informe.
 * El retardo es del FIXTURE (simula trabajo); la detección de readiness del
 * código bajo prueba sigue siendo por señales.
 */
import { WebSocket } from "ws";
import type {
  ContainerHandle,
  ContainerRunState,
  ContainerRunner,
  SandboxSpec,
  SecurityPosture,
} from "../src/container-runner.js";
import { compliantBasePosture } from "../src/container-runner.js";

export interface FakeBootstrapBehaviour {
  /** Lo que tarda la Engine en devolver el contenedor (create+start). */
  launchDelayMs?: number;
  /** La Engine falla al lanzar. */
  launchError?: string;
  /** Init del runtime antes de descargar el artefacto (plataforma). */
  preFetchMs?: number;
  /** Tras la descarga/verificación y antes de `ready` (plataforma: SDK, etc.). */
  preReadyMs?: number;
  /** El bootstrap falla ANTES de `ready` con este informe (y sale). */
  failBeforeReady?: { kind: string; detail: string; exitCode?: number };
  /** El contenedor muere antes de `ready` SIN informe. */
  dieBeforeReady?: boolean;
  /** No envía la señal `ready` (canal perdido) pero sigue. */
  skipReady?: boolean;
  /** Tiempo del código del usuario entre `ready` y conectar (import + constructor). */
  userInitMs?: number;
  /** El código del usuario se cuelga tras `ready`: nunca conecta. */
  hangAfterReady?: boolean;
  /** El código del usuario revienta tras `ready` (informe kind import y salida). */
  crashAfterReady?: boolean;
  /** Retardo de cada decisión (COMMAND) tras recibir la OBSERVATION. */
  decisionMs?: number;
}

export interface FakeLaunch {
  spec: SandboxSpec;
  /** Marcas (performance.now()) de lo que hizo el fixture. */
  marks: Record<string, number>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FakeBootstrapRunner implements ContainerRunner {
  readonly launches: FakeLaunch[] = [];
  private readonly sockets: WebSocket[] = [];
  constructor(private readonly behaviour: (spec: SandboxSpec, index: number) => FakeBootstrapBehaviour) {}

  async launch(spec: SandboxSpec): Promise<ContainerHandle> {
    const b = this.behaviour(spec, this.launches.length);
    const record: FakeLaunch = { spec, marks: { launchCalled: performance.now() } };
    this.launches.push(record);
    if (b.launchDelayMs) await sleep(b.launchDelayMs);
    if (b.launchError) throw new Error(b.launchError);
    const state: ContainerRunState = {
      running: true,
      exitCode: null,
      oomKilled: false,
      gone: false,
      startedAtMs: Date.now(),
    };
    record.marks.started = performance.now();
    let stopped = false;
    const exit = (code: number) => {
      state.running = false;
      state.exitCode = code;
    };
    const env = spec.env;
    const headers = { "x-s9-artifact-token": env.ARTIFACT_TOKEN ?? "" };
    const report = async (kind: string, detail: string) => {
      await fetch(env.ARTIFACT_URL + "/report", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ kind, detail }),
      }).catch(() => undefined);
    };
    void (async () => {
      if (b.preFetchMs) await sleep(b.preFetchMs);
      if (stopped) return;
      if (b.dieBeforeReady) return exit(137);
      const res = await fetch(env.ARTIFACT_URL, { headers }).catch(() => null);
      record.marks.fetched = performance.now();
      if (!res || res.status !== 200) {
        await report("fetch", `HTTP ${res?.status ?? "sin respuesta"}`);
        return exit(3);
      }
      await res.arrayBuffer();
      if (b.preReadyMs) await sleep(b.preReadyMs);
      if (stopped) return;
      if (b.failBeforeReady) {
        await report(b.failBeforeReady.kind, b.failBeforeReady.detail);
        return exit(b.failBeforeReady.exitCode ?? 4);
      }
      if (!b.skipReady) {
        await fetch(env.ARTIFACT_URL + "/ready", { method: "POST", headers }).catch(() => undefined);
        record.marks.ready = performance.now();
      }
      if (b.crashAfterReady) {
        await report("import", "Traceback (most recent call last):\nRuntimeError: fallo al importar el bot");
        return exit(7);
      }
      if (b.hangAfterReady) return; // proceso vivo, sin conectar nunca
      if (b.userInitMs) await sleep(b.userInitMs);
      if (stopped) return;
      const ws = new WebSocket(env.WS_URL);
      this.sockets.push(ws);
      let seq = 0;
      ws.on("open", () => {
        record.marks.hello = performance.now();
        ws.send(
          JSON.stringify({
            proto: "arena/1",
            type: "HELLO",
            seq: seq++,
            payload: {
              botId: env.BOT_ID,
              botVersion: "0.1.0",
              sdk: { name: "custom", version: "0" },
              battleToken: env.BATTLE_TOKEN,
            },
          }),
        );
      });
      ws.on("message", (raw) => {
        let msg: { type?: string; payload?: { tick?: number } };
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.type === "SHUTDOWN") {
          ws.close();
          return exit(0);
        }
        if (msg.type === "OBSERVATION" && typeof msg.payload?.tick === "number") {
          const forTick = msg.payload.tick + 3;
          const send = () =>
            ws.readyState === WebSocket.OPEN &&
            ws.send(
              JSON.stringify({
                proto: "arena/1",
                type: "COMMAND",
                seq: seq++,
                tick: forTick,
                payload: { forTick, move: { throttle: 0.6, steer: 0.1 } },
              }),
            );
          if (b.decisionMs) setTimeout(send, b.decisionMs);
          else send();
        }
      });
      ws.on("error", () => undefined);
      ws.on("close", () => exit(0));
    })();
    const posture: SecurityPosture = compliantBasePosture();
    return {
      id: `fake${String(this.launches.length).padStart(12, "0")}`,
      async stop() {
        stopped = true;
        exit(137);
      },
      async posture() {
        return posture;
      },
      async state() {
        return { ...state };
      },
    };
  }

  closeAll(): void {
    for (const ws of this.sockets.splice(0)) {
      try {
        ws.terminate();
      } catch {
        /* noop */
      }
    }
  }
}
