import WebSocket from "ws";
import { PROTOCOL_VERSION } from "@s9/protocol";
import type { BotCommand, BotObservation } from "@s9/protocol";

connect();
function connect(): void {
  const socket = new WebSocket(process.env.ARENA_WS_URL ?? "ws://localhost:8081/bot");
  socket.on("open", () => socket.send(JSON.stringify({
    type: "register", protocolVersion: PROTOCOL_VERSION,
    botId: process.env.BOT_ID ?? "bot-blue", name: process.env.BOT_NAME ?? "Blue Spinner", team: "blue"
  })));
  socket.on("message", (raw) => {
    const observation = JSON.parse(raw.toString()) as BotObservation;
    if (observation.type !== "observation") return;
    const enemy = observation.visibleEnemies[0];
    const desired = enemy ? Math.atan2(enemy.y - observation.self.y, enemy.x - observation.self.x) : observation.self.turretHeading;
    const command: BotCommand = {
      type: "command", tick: observation.tick,
      movement: { throttle: 0.55, turn: -0.5 },
      turret: { turn: angleTurn(observation.self.turretHeading, desired), fire: Boolean(enemy) && observation.tick % 2 === 0 }
    };
    socket.send(JSON.stringify(command));
  });
  socket.on("close", () => setTimeout(connect, 1500));
}
function angleTurn(current: number, target: number): number {
  const d = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return Math.max(-1, Math.min(1, d * 2));
}
