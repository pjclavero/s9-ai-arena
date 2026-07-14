/**
 * T5.3 · @arena/sdk — SDK de referencia en JavaScript/TypeScript para bots de
 * S9 AI Arena (protocolo arena/1). Paridad funcional con sdks/python: mismo ciclo
 * de vida (onWelcome/onObservation/onEvent/onShutdown), sin reconexión, mismo
 * cálculo de forTick a partir de WELCOME.timing.decisionEveryNTicks.
 */
import { WebSocket } from "ws";
import type {
  CommandPayload,
  Envelope,
  EventPayload,
  HelloPayload,
  ObservationPayload,
  ShutdownPayload,
  WelcomePayload,
} from "./types.js";

export * from "./types.js";

const PROTO = "arena/1" as const;

/** Comando parcial: el bot no tiene por qué rellenar forTick, el SDK lo calcula. */
export type CommandIntent = Omit<CommandPayload, "forTick">;

export abstract class ArenaBot {
  readonly botId: string;
  readonly botVersion: string;
  readonly sdkName: HelloPayload["sdk"]["name"];
  readonly sdkVersion = "0.1.0";
  welcome: WelcomePayload | null = null;

  private ws: WebSocket | null = null;
  private seq = 0;
  private decisionEveryNTicks = 3;

  constructor(botId: string, botVersion = "0.1.0", sdkName: HelloPayload["sdk"]["name"] = "arena-sdk-js") {
    this.botId = botId;
    this.botVersion = botVersion;
    this.sdkName = sdkName;
  }

  // ------------------------------------------------------------ ciclo de vida
  onWelcome(_welcome: WelcomePayload): void {}

  onObservation(_observation: ObservationPayload): CommandIntent {
    return {};
  }

  onEvent(_event: EventPayload): void {}

  onShutdown(_shutdown: ShutdownPayload): void {}

  // ------------------------------------------------------------------- run()
  /** Conecta, hace el handshake y corre hasta SHUTDOWN o hasta que el transporte
   * caiga. Sin reconexión: relanzar el proceso es cosa de quien opera el bot. */
  run(url: string, battleToken: string): Promise<void> {
    return new Promise((resolve) => {
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.on("open", () => {
        this.send("HELLO", {
          botId: this.botId,
          botVersion: this.botVersion,
          sdk: { name: this.sdkName, version: this.sdkVersion },
          battleToken,
        } as HelloPayload);
      });

      ws.on("message", (raw) => this.handleRaw(raw, resolve));
      ws.on("close", () => resolve());
      ws.on("error", () => resolve());
    });
  }

  private handleRaw(raw: unknown, done: () => void): void {
    let msg: any;
    // Regla 5 del protocolo: un mensaje que no se entiende NUNCA hace fallar al SDK.
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null || msg.proto !== PROTO) return;
    const { type, payload } = msg;
    if (typeof payload !== "object" || payload === null) return;
    this.debugOnMessage(msg as Envelope);

    switch (type) {
      case "WELCOME":
        this.welcome = payload as WelcomePayload;
        this.decisionEveryNTicks = (payload as WelcomePayload).timing?.decisionEveryNTicks ?? 3;
        this.onWelcome(payload as WelcomePayload);
        break;
      case "OBSERVATION":
        this.handleObservation(payload as ObservationPayload);
        break;
      case "EVENT":
        this.onEvent(payload as EventPayload);
        break;
      case "SHUTDOWN":
        this.onShutdown(payload as ShutdownPayload);
        done();
        break;
      // Cualquier otro type: se ignora sin más.
    }
  }

  private handleObservation(observation: ObservationPayload): void {
    const intent = this.onObservation(observation) ?? {};
    const forTick = observation.tick + this.decisionEveryNTicks;
    const command: CommandPayload = { ...intent, forTick };
    this.send("COMMAND", command, forTick);
  }

  private send(type: Envelope["type"], payload: object, tick?: number): void {
    if (!this.ws) return;
    const msg: any = { proto: PROTO, type, seq: this.seq++, payload };
    if (tick !== undefined) msg.tick = tick;
    this.debugOnSend(msg as Envelope);
    this.ws.send(JSON.stringify(msg));
  }

  // ---------------------------------------------------------- hooks de prueba
  /** No-op por defecto. tests/contract.test.ts los sobreescribe para capturar
   * cada envelope entrante/saliente real y validarlo contra los esquemas de E1. */
  protected debugOnMessage(_msg: Envelope): void {}
  protected debugOnSend(_msg: Envelope): void {}
}
