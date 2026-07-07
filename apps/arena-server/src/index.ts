import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type {
  ArenaSnapshot,
  BotCommand,
  BotObservation,
  BotRegistration,
  TankSnapshot,
  TeamId,
} from "@s9/protocol";
import { PROTOCOL_VERSION } from "@s9/protocol";

const port = Number(process.env.ARENA_PORT ?? 8081);
const tickRate = Number(process.env.TICK_RATE ?? 20);
const arena = { width: 1000, height: 650 };
const tankRadius = 22;

interface TankState extends TankSnapshot {
  socket: WebSocket;
  throttle: number;
  turn: number;
  turretTurn: number;
  wantsFire: boolean;
  cooldown: number;
}

interface ProjectileState {
  id: string;
  ownerId: string;
  team: TeamId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ttl: number;
}

const tanks = new Map<string, TankState>();
const viewers = new Set<WebSocket>();
const projectiles: ProjectileState[] = [];
let tick = 0;

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", tick, bots: tanks.size }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (request, socket, head) => {
  const path = new URL(request.url ?? "/", `http://${request.headers.host}`).pathname;
  if (path !== "/bot" && path !== "/viewer") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request, path);
  });
});

wss.on("connection", (socket: WebSocket, _request, path: string) => {
  if (path === "/viewer") {
    viewers.add(socket);
    socket.on("close", () => viewers.delete(socket));
    socket.send(JSON.stringify(buildSnapshot()));
    return;
  }

  let registeredBotId: string | undefined;

  socket.on("message", (raw) => {
    let message: unknown;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      socket.close(1003, "Invalid JSON");
      return;
    }

    if (!registeredBotId) {
      const registration = message as Partial<BotRegistration>;
      if (
        registration.type !== "register" ||
        registration.protocolVersion !== PROTOCOL_VERSION ||
        !registration.botId ||
        !registration.name ||
        (registration.team !== "red" && registration.team !== "blue")
      ) {
        socket.close(1008, "Invalid registration");
        return;
      }
      if (tanks.has(registration.botId)) {
        socket.close(1008, "Bot id already connected");
        return;
      }
      registeredBotId = registration.botId;
      const redSpawn = { x: 120, y: arena.height / 2, heading: 0 };
      const blueSpawn = { x: arena.width - 120, y: arena.height / 2, heading: Math.PI };
      const spawn = registration.team === "red" ? redSpawn : blueSpawn;
      tanks.set(registration.botId, {
        id: registration.botId,
        name: registration.name,
        team: registration.team,
        x: spawn.x,
        y: spawn.y,
        heading: spawn.heading,
        turretHeading: spawn.heading,
        health: 100,
        socket,
        throttle: 0,
        turn: 0,
        turretTurn: 0,
        wantsFire: false,
        cooldown: 0,
      });
      console.log(`Bot connected: ${registration.name} (${registration.team})`);
      return;
    }

    const command = message as Partial<BotCommand>;
    const tank = tanks.get(registeredBotId);
    if (!tank || command.type !== "command" || command.tick !== tick) return;
    tank.throttle = clamp(command.movement?.throttle ?? 0, -1, 1);
    tank.turn = clamp(command.movement?.turn ?? 0, -1, 1);
    tank.turretTurn = clamp(command.turret?.turn ?? 0, -1, 1);
    tank.wantsFire = Boolean(command.turret?.fire);
  });

  socket.on("close", () => {
    if (registeredBotId) {
      tanks.delete(registeredBotId);
      console.log(`Bot disconnected: ${registeredBotId}`);
    }
  });
});

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(min, Math.min(max, value));
}

function normalizeAngle(angle: number): number {
  const tau = Math.PI * 2;
  return ((angle % tau) + tau) % tau;
}

function update(): void {
  tick += 1;
  const dt = 1 / tickRate;

  for (const tank of tanks.values()) {
    if (tank.health <= 0) continue;
    tank.heading = normalizeAngle(tank.heading + tank.turn * 2.2 * dt);
    tank.turretHeading = normalizeAngle(tank.turretHeading + tank.turretTurn * 3.2 * dt);
    const speed = tank.throttle * 150;
    tank.x = clamp(tank.x + Math.cos(tank.heading) * speed * dt, tankRadius, arena.width - tankRadius);
    tank.y = clamp(tank.y + Math.sin(tank.heading) * speed * dt, tankRadius, arena.height - tankRadius);
    tank.cooldown = Math.max(0, tank.cooldown - 1);

    if (tank.wantsFire && tank.cooldown === 0) {
      projectiles.push({
        id: randomUUID(),
        ownerId: tank.id,
        team: tank.team,
        x: tank.x + Math.cos(tank.turretHeading) * 30,
        y: tank.y + Math.sin(tank.turretHeading) * 30,
        vx: Math.cos(tank.turretHeading) * 420,
        vy: Math.sin(tank.turretHeading) * 420,
        ttl: tickRate * 3,
      });
      tank.cooldown = Math.round(tickRate * 0.7);
    }
  }

  for (let i = projectiles.length - 1; i >= 0; i -= 1) {
    const projectile = projectiles[i];
    projectile.x += projectile.vx * dt;
    projectile.y += projectile.vy * dt;
    projectile.ttl -= 1;

    let remove =
      projectile.ttl <= 0 ||
      projectile.x < 0 ||
      projectile.y < 0 ||
      projectile.x > arena.width ||
      projectile.y > arena.height;

    if (!remove) {
      for (const tank of tanks.values()) {
        if (tank.id === projectile.ownerId || tank.team === projectile.team || tank.health <= 0) continue;
        const dx = tank.x - projectile.x;
        const dy = tank.y - projectile.y;
        if (dx * dx + dy * dy <= tankRadius * tankRadius) {
          tank.health = Math.max(0, tank.health - 20);
          remove = true;
          break;
        }
      }
    }

    if (remove) projectiles.splice(i, 1);
  }

  for (const tank of tanks.values()) {
    if (tank.socket.readyState !== WebSocket.OPEN || tank.health <= 0) continue;
    const observation: BotObservation = {
      type: "observation",
      tick,
      self: publicTank(tank),
      visibleEnemies: [...tanks.values()]
        .filter((other) => other.id !== tank.id && other.team !== tank.team && other.health > 0)
        .map(publicTank),
    };
    tank.socket.send(JSON.stringify(observation));
  }

  const snapshot = JSON.stringify(buildSnapshot());
  for (const viewer of viewers) {
    if (viewer.readyState === WebSocket.OPEN) viewer.send(snapshot);
  }
}

function publicTank(tank: TankState): TankSnapshot {
  return {
    id: tank.id,
    name: tank.name,
    team: tank.team,
    x: tank.x,
    y: tank.y,
    heading: tank.heading,
    turretHeading: tank.turretHeading,
    health: tank.health,
  };
}

function buildSnapshot(): ArenaSnapshot {
  return {
    type: "snapshot",
    tick,
    arena,
    tanks: [...tanks.values()].map(publicTank),
    projectiles: projectiles.map(({ id, ownerId, x, y }) => ({ id, ownerId, x, y })),
  };
}

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`S9 Arena server listening on http://0.0.0.0:${port}`);
  console.log(`Bot WebSocket: ws://0.0.0.0:${port}/bot`);
  console.log(`Viewer WebSocket: ws://0.0.0.0:${port}/viewer`);
});

setInterval(update, 1000 / tickRate);
