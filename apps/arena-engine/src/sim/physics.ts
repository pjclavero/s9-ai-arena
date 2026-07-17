/**
 * Capa de física (T2.2). Rapier2D compat, build fijada por checksum (D4).
 *
 * El motor se NIEGA A ARRANCAR si el WASM no coincide con el hash registrado en
 * engine-deps.json: el determinismo de Rapier depende de la build exacta, y una
 * actualización silenciosa de dependencia invalidaría todos los replays oficiales.
 *
 * Unidades: metros, radianes, kg (D1). Gravedad nula: es un mundo cenital.
 */
import RAPIER from "@dimforge/rapier2d-compat";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { TICK_DT } from "../../../../packages/game-rules/index.js";
import deps from "../engine-deps.json" with { type: "json" };

export type Vec2 = { x: number; y: number };

let initialized = false;

/** Verifica el checksum del WASM y arranca Rapier. Idempotente. */
export async function initPhysics(opts: { skipChecksum?: boolean } = {}): Promise<void> {
  if (initialized) return;

  if (!opts.skipChecksum) {
    // El campo "exports" del paquete no publica ni el .wasm ni su package.json como
    // subpaths, así que resolvemos el entry point principal (que sí está exportado) y
    // componemos la ruta: el binario vive en el mismo directorio.
    const require = createRequire(import.meta.url);
    const entry = require.resolve("@dimforge/rapier2d-compat");
    const wasmPath = join(dirname(entry), deps.physics.wasmFile);
    const actual = createHash("sha256").update(readFileSync(wasmPath)).digest("hex");
    if (actual !== deps.physics.wasmSha256) {
      throw new Error(
        `[D4] Checksum del WASM de Rapier no coincide.\n` +
          `  esperado: ${deps.physics.wasmSha256}\n` +
          `  obtenido: ${actual}\n` +
          `El motor no arranca: una build distinta de Rapier puede romper el determinismo ` +
          `y con él todos los replays oficiales. Actualice engine-deps.json mediante un ADR ` +
          `y regenere las batallas golden.`,
      );
    }
  }

  await RAPIER.init();
  initialized = true;
}

export interface BodyHandle {
  readonly id: string;
  readonly rb: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
}

export type HitKind =
  | "vehicle"
  | "wall"
  | "destructible"
  | "projectile"
  | "mine"
  | "unknown";

export interface RayHit {
  distanceM: number;
  kind: HitKind;
  entityId: string | null;
  point: Vec2;
}

/**
 * Mundo físico. Envuelve Rapier para que el resto del motor no dependa de su API:
 * si algún día D4 se revisa (Rust, otro motor), solo cambia este archivo.
 */
export class PhysicsWorld {
  private world: RAPIER.World;
  private bodies = new Map<string, BodyHandle>();
  /** collider.handle → id de entidad, para traducir los resultados de raycast. */
  private colliderToId = new Map<number, string>();
  private kinds = new Map<string, HitKind>();
  /** Hay altas/bajas de cuerpos sin reflejar en el pipeline de consultas. */
  private dirty = true;

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: 0 });
    // Timestep FIJO. Nunca se deriva del reloj de pared (T2.1).
    this.world.timestep = TICK_DT;
  }

  addVehicle(id: string, position: Vec2, heading: number, radiusM: number, massKg: number): BodyHandle {
    const rbDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y)
      .setRotation(heading)
      .setLinearDamping(0.8)
      .setAngularDamping(4.0)
      .setCcdEnabled(true); // evita el túnel a velocidad máxima
    const rb = this.world.createRigidBody(rbDesc);

    const colDesc = RAPIER.ColliderDesc.ball(radiusM)
      .setDensity(0)
      .setMass(massKg)
      .setRestitution(0.2)
      .setFriction(0.5);
    const collider = this.world.createCollider(colDesc, rb);

    const handle: BodyHandle = { id, rb, collider };
    this.bodies.set(id, handle);
    this.colliderToId.set(collider.handle, id);
    this.kinds.set(id, "vehicle");
    this.dirty = true;
    return handle;
  }

  addWall(id: string, position: Vec2, halfWidth: number, halfHeight: number, rotation = 0): BodyHandle {
    const rb = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(position.x, position.y).setRotation(rotation),
    );
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(halfWidth, halfHeight),
      rb,
    );
    const handle: BodyHandle = { id, rb, collider };
    this.bodies.set(id, handle);
    this.colliderToId.set(collider.handle, id);
    this.kinds.set(id, "wall");
    this.dirty = true;
    return handle;
  }

  addDestructible(id: string, position: Vec2, halfWidth: number, halfHeight: number): BodyHandle {
    const h = this.addWall(id, position, halfWidth, halfHeight);
    this.kinds.set(id, "destructible");
    return h;
  }

  remove(id: string): void {
    const h = this.bodies.get(id);
    if (!h) return;
    this.colliderToId.delete(h.collider.handle);
    this.world.removeRigidBody(h.rb);
    this.bodies.delete(id);
    this.kinds.delete(id);
    this.dirty = true;
  }

  get(id: string): BodyHandle | undefined {
    return this.bodies.get(id);
  }

  pose(id: string): { position: Vec2; heading: number; velocity: Vec2; angularVelocity: number } | null {
    const h = this.bodies.get(id);
    if (!h) return null;
    const t = h.rb.translation();
    const v = h.rb.linvel();
    return {
      position: { x: t.x, y: t.y },
      heading: h.rb.rotation(),
      velocity: { x: v.x, y: v.y },
      angularVelocity: h.rb.angvel(),
    };
  }

  /**
   * Movimiento arcade (D3): fijamos velocidad objetivo, no fuerzas realistas.
   * La aceleración limita cuánto puede cambiar la velocidad en un tick.
   */
  driveVehicle(
    id: string,
    throttle: number,
    steer: number,
    caps: { maxSpeedMs: number; accelerationMs2: number; turnRateRads: number },
  ): void {
    const h = this.bodies.get(id);
    if (!h) return;

    // Última barrera antes del WASM. Aunque las capas de arriba ya sanean, un NaN aquí
    // aborta el proceso entero, así que se verifica también en el punto de entrada.
    const th = finiteClamped(throttle, -1, 1);
    const st = finiteClamped(steer, -1, 1);
    const maxSpeed = finite(caps.maxSpeedMs, 0);
    const accel = finite(caps.accelerationMs2, 0);
    const turn = finite(caps.turnRateRads, 0);

    const heading = h.rb.rotation();
    const targetSpeed = th * maxSpeed;
    const cur = h.rb.linvel();
    const forward = { x: Math.cos(heading), y: Math.sin(heading) };
    const curForwardSpeed = cur.x * forward.x + cur.y * forward.y;

    const maxDelta = accel * TICK_DT;
    const delta = clamp(targetSpeed - curForwardSpeed, -maxDelta, maxDelta);
    const newSpeed = finite(curForwardSpeed + delta, 0);

    h.rb.setLinvel({ x: forward.x * newSpeed, y: forward.y * newSpeed }, true);
    h.rb.setAngvel(st * turn, true);
  }

  /** Empuja un cuerpo (retroceso, explosiones). */
  applyImpulse(id: string, impulse: Vec2): void {
    this.bodies.get(id)?.rb.applyImpulse(impulse, true);
  }

  /**
   * Raycast. Base de los sensores (T2.4) y de la línea de visión.
   * `ignoreId` evita que un vehículo se detecte a sí mismo.
   */
  castRay(origin: Vec2, angle: number, maxDistance: number, ignoreId?: string): RayHit | null {
    this.syncQueries();
    const dir = { x: Math.cos(angle), y: Math.sin(angle) };
    const ray = new RAPIER.Ray(origin, dir);
    const ignoreHandle = ignoreId ? this.bodies.get(ignoreId)?.collider : undefined;

    const hit = this.world.castRay(
      ray,
      maxDistance,
      true,
      undefined,
      undefined,
      ignoreHandle,
    );
    if (!hit) return null;

    const id = this.colliderToId.get(hit.collider.handle) ?? null;
    const d = hit.timeOfImpact;
    return {
      distanceM: d,
      kind: id ? (this.kinds.get(id) ?? "unknown") : "unknown",
      entityId: id,
      point: { x: origin.x + dir.x * d, y: origin.y + dir.y * d },
    };
  }

  /**
   * ¿Este punto está DENTRO de un sólido (muro o destructible)?
   *
   * No sirve un raycast para esto: un rayo que nace dentro de un collider no lo
   * intersecta. Hay que hacer una consulta de punto. Lo usa la validación de minas
   * (cap. 12.3): un bot no puede sembrar una mina dentro de una pared.
   */
  isPointInsideSolid(point: Vec2): boolean {
    this.syncQueries();
    let inside = false;
    this.world.intersectionsWithPoint(point, (c: any) => {
      // Según la build, el callback entrega el Collider o directamente su handle.
      const handle: number = typeof c === "number" ? c : c.handle;
      const id = this.colliderToId.get(handle);
      const kind = id ? this.kinds.get(id) : undefined;
      if (kind === "wall" || kind === "destructible") {
        inside = true;
        return false; // basta con uno: paramos la búsqueda
      }
      return true;
    });
    return inside;
  }

  /** ¿Hay línea de visión limpia entre dos puntos? Usado por radar y por el daño de área. */
  hasLineOfSight(from: Vec2, to: Vec2, ignoreId?: string): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) return true;
    const hit = this.castRay(from, Math.atan2(dy, dx), dist, ignoreId);
    // Solo muros y destructibles bloquean la visión; otro vehículo no la corta.
    return !hit || (hit.kind !== "wall" && hit.kind !== "destructible");
  }

  /**
   * El pipeline de consultas de Rapier (raycast, point query) solo se refresca en step().
   * Si se consulta tras añadir o quitar un cuerpo y ANTES del siguiente step, la consulta
   * mira una escena obsoleta y devuelve resultados falsos —silenciosamente.
   *
   * Dentro del bucle no ocurre (el paso 4 siempre precede al 5), pero es una trampa para
   * cualquiera que use PhysicsWorld directamente. Un step con dt=0 refresca las consultas
   * sin integrar nada: la simulación no avanza y el determinismo no se ve afectado.
   */
  private syncQueries(): void {
    if (!this.dirty) return;
    const dt = this.world.timestep;
    this.world.timestep = 0;
    this.world.step();
    this.world.timestep = dt;
    this.dirty = false;
  }

  step(): void {
    this.world.step();
    this.dirty = false;
  }

  /**
   * Huella del SOLVER para el hash de estado (ERR-ENG-04).
   *
   * Las poses cuantizadas no bastan: dos simulaciones pueden divergir dentro del solver
   * (un cuerpo dormido en una y despierto en la otra, un par de contacto de más) con
   * posiciones aún idénticas a 1e-5, y esa divergencia sigue viva y explota más tarde.
   * Contar cuerpos despiertos y pares de contacto la hace visible YA, a coste casi nulo.
   *
   * Determinista: los cuerpos se recorren en el orden estable del mapa (orden de alta,
   * idéntico en toda re-simulación) y solo se cuentan agregados, no se serializan handles.
   */
  solverFingerprint(): { awakeBodies: number; contactPairs: number } {
    let awakeBodies = 0;
    let contactPairs = 0;
    for (const h of this.bodies.values()) {
      if (h.rb.isDynamic() && !h.rb.isSleeping()) awakeBodies++;
      this.world.contactPairsWith(h.collider, (other) => {
        // Cada par aparece dos veces (una por cada collider); se cuenta una sola.
        if (other.handle > h.collider.handle) contactPairs++;
      });
    }
    return { awakeBodies, contactPairs };
  }

  free(): void {
    this.world.free();
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Saneamiento de la FRONTERA con el código no confiable.
 *
 * Todo número que venga de un bot pasa por aquí antes de tocar nada. Motivo: un NaN o
 * un Infinity que llegue a Rapier hace que el WASM aborte con "unreachable" y se lleve
 * por delante la batalla entera. Un bot podría tumbar el motor con `{throttle: NaN}` —
 * una línea de JSON. El sandbox de E6 aísla el PROCESO del bot, pero no puede protegernos
 * de un valor que nosotros mismos le pasamos a la física.
 *
 * Regla: lo que no sea un número finito, no existe. Se sustituye por el valor por defecto.
 */
export function finite(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Número finito Y dentro de rango. La combinación que se usa en casi todas partes. */
export function finiteClamped(v: unknown, lo: number, hi: number, fallback = 0): number {
  return clamp(finite(v, fallback), lo, hi);
}
