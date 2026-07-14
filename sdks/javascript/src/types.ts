/**
 * Re-exportes con nombres limpios de sdks/javascript/src/generated-types.ts
 * (generado con json-schema-to-typescript desde packages/protocol/schemas/*.json —
 * ver sdks/javascript/generate-types.mjs) más helpers de geometría.
 */
export type {
  EnvelopeArena1 as Envelope,
  HELLOBotMotor as HelloPayload,
  WELCOMEMotorBot as WelcomePayload,
  OBSERVATIONMotorBot as ObservationPayload,
  COMMANDBotMotor as CommandPayload,
  EVENTMotorBot as EventPayload,
  SHUTDOWNMotorBot as ShutdownPayload,
  Vec2,
} from "./generated-types.js";

import type { Vec2 } from "./generated-types.js";

/** Distancia euclídea en metros (D1). */
export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Ángulo absoluto (radianes, antihorario, 0 = eje +X, D1) de `from` a `to`. */
export function angleTo(from: Vec2, to: Vec2): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

/** Diferencia angular normalizada a [-pi, pi]: cuánto girar desde `a` hasta `b`. */
export function angleDiff(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
