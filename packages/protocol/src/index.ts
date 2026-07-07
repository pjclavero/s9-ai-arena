export const PROTOCOL_VERSION = 1 as const;

export type TeamId = "red" | "blue";

export interface BotRegistration {
  type: "register";
  protocolVersion: typeof PROTOCOL_VERSION;
  botId: string;
  name: string;
  team: TeamId;
}

export interface BotCommand {
  type: "command";
  tick: number;
  movement: {
    throttle: number;
    turn: number;
  };
  turret: {
    turn: number;
    fire: boolean;
  };
}

export interface BotObservation {
  type: "observation";
  tick: number;
  self: TankSnapshot;
  visibleEnemies: TankSnapshot[];
}

export interface TankSnapshot {
  id: string;
  name: string;
  team: TeamId;
  x: number;
  y: number;
  heading: number;
  turretHeading: number;
  health: number;
}

export interface ProjectileSnapshot {
  id: string;
  ownerId: string;
  x: number;
  y: number;
}

export interface ArenaSnapshot {
  type: "snapshot";
  tick: number;
  arena: { width: number; height: number };
  tanks: TankSnapshot[];
  projectiles: ProjectileSnapshot[];
}
