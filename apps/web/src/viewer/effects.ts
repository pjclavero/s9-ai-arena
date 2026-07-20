/**
 * R3.5 · ERR-VIS-05 — Efectos visuales del visor, reproducibles DESDE EVENTOS.
 *
 * Regla de oro de la Ronda 2 (y requisito duro de esta tarea): la capa de efectos
 * es PURAMENTE VISUAL. Nace de los eventos y snapshots PÚBLICOS que ya llegan al
 * visor y NUNCA muta la simulación, el snapshot ni el estado del motor — de ahí
 * que este módulo:
 *   - sólo LEA los eventos/proyectiles que recibe (jamás escribe en ellos);
 *   - genera OBJETOS NUEVOS (blueprints de partícula), sin tocar la entrada;
 *   - sea determinista: la dispersión de una explosión sale de un hash del propio
 *     evento (posición + índice), no de Math.random ni del reloj de pared, así el
 *     mismo evento produce el mismo efecto en directo y en replay.
 *
 * Mapa evento→efecto (sólo con datos que ya viajan por la red):
 *   - disparo:      un proyectil NUEVO aparece en la balística local → fogonazo
 *                   (muzzle_flash) en su origen; la trazadora/estela la dibuja el
 *                   render siguiendo la balística ya existente.
 *   - impacto:      hit_dealt / hit_taken → chispas (impact) en el objetivo.
 *   - destrucción:  vehicle_destroyed → explosión (flash + chispas + humo) y un
 *                   DECAL persistente (scorch) horneado a la RenderTexture.
 *   - mina:         mine_triggered → explosión + decal.
 *
 * No importa Phaser ni toca el DOM: se prueba con vitest en Node (apps/web/tests).
 */

export type EffectKind = "muzzle_flash" | "impact" | "explosion" | "smoke" | "decal";

/**
 * Frame del atlas (atlas-geometry.ts) que dibuja cada partícula. "muzzle-flash"
 * y "explosion" son frames LÓGICOS: el fogonazo mapea 1:1 al frame homónimo
 * del atlas; la explosión es dinámica — el render (PhaserViewer.ts) resuelve
 * el frame REAL (explosion-0/1/2) por edad vía `explosionFrameForAge`
 * (art-direction.ts), así la fase visual no vive en el dato de la partícula.
 */
export type EffectFrame = "spark" | "smoke" | "pixel" | "muzzle-flash" | "explosion";

/** Una partícula viva. Todos los campos son datos, no referencias a la entrada. */
export interface EffectSpec {
  /** Identidad de instancia (única y monótona), para el pool de sprites del render. */
  id: number;
  kind: EffectKind;
  frame: EffectFrame;
  /** Posición de nacimiento en metros de mundo. */
  x: number;
  y: number;
  /** Deriva por ms (m/ms): las chispas salen despedidas, el humo sube. */
  vx: number;
  vy: number;
  bornMs: number;
  /** Duración total en ms. Los decals NO viven aquí (van a la RenderTexture). */
  lifeMs: number;
  /** Radio en metros al nacer y al morir (interpolado por progreso). */
  size0: number;
  size1: number;
  /** Giro en rad/ms (chispas y humo rotan levemente). */
  spin: number;
  /** Alfa inicial (se desvanece a 0 al morir). */
  alpha0: number;
}

/** Un decal persistente (scorch de explosión) que se hornea UNA vez a la textura. */
export interface DecalSpec {
  x: number;
  y: number;
  /** Radio en metros. */
  radiusM: number;
  /** Opacidad de la mancha. */
  alpha: number;
}

/** Pose muestreada de un efecto en un instante (para que el render sólo pinte). */
export interface EffectSample {
  x: number;
  y: number;
  radiusM: number;
  alpha: number;
  rotation: number;
}

/**
 * Hash determinista pequeño a partir de enteros → [0,1). Sustituye a Math.random
 * para que la dispersión de una explosión sea REPRODUCIBLE (mismo evento ⇒ misma
 * forma en directo y en replay). No pretende ser criptográfico.
 */
function hash01(a: number, b: number): number {
  let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

/** Cuantiza una coordenada a un entero estable para sembrar el hash. */
function seedOf(x: number, y: number): number {
  return (Math.round(x * 16) * 73856093) ^ (Math.round(y * 16) * 19349663);
}

/** Progreso 0..1 de un efecto en el instante `now` (fuera de rango → clamp). */
export function effectProgress(e: EffectSpec, now: number): number {
  if (e.lifeMs <= 0) return 1;
  const t = (now - e.bornMs) / e.lifeMs;
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

/** Muestrea la pose visible de un efecto: integra la deriva y desvanece el alfa. */
export function sampleEffect(e: EffectSpec, now: number): EffectSample {
  const p = effectProgress(e, now);
  const dt = now - e.bornMs;
  return {
    x: e.x + e.vx * dt,
    y: e.y + e.vy * dt,
    radiusM: e.size0 + (e.size1 - e.size0) * p,
    // Desvanecido cuadrático: entra fuerte y se apaga suave (menos parpadeo).
    alpha: e.alpha0 * (1 - p) * (1 - p),
    rotation: e.spin * dt,
  };
}

/** Techo de partículas simultáneas: un chorro de eventos no crea memoria sin fin. */
export const MAX_LIVE_EFFECTS = 512;
/** Techo de decals persistentes en la RenderTexture (los más viejos se olvidan). */
export const MAX_DECALS = 128;

/**
 * Sistema de efectos: acumula partículas vivas y decals pendientes de hornear.
 * Toda su entrada es de SÓLO LECTURA; su salida son objetos nuevos. No conoce
 * Phaser: el render pregunta `active(now)` y `drainDecals()` y pinta.
 */
export class EffectSystem {
  private seq = 0;
  private live: EffectSpec[] = [];
  /** Decals creados y aún no horneados por el render (se drenan una sola vez). */
  private pendingDecals: DecalSpec[] = [];
  /** Ids de proyectil ya vistos: un id nuevo ⇒ un disparo ⇒ un fogonazo. */
  private knownProjectiles = new Set<string>();
  /** Última ventana temporal de humo emitida por vehículo (dedup: una voluta/ventana). */
  private smokeWindow = new Map<string, number>();

  /**
   * Un evento público → cero o más partículas. NUNCA muta `event`: sólo lee.
   * `posOf` resuelve la posición de un vehículo por id cuando el evento no la
   * trae (p. ej. vehicle_destroyed sin campo position, o hit_dealt).
   */
  ingestEvent(event: any, nowMs: number, posOf?: (id: string) => { x: number; y: number } | undefined): void {
    if (!event || typeof event.kind !== "string") return;
    const at = eventPosition(event, posOf);
    switch (event.kind) {
      case "vehicle_destroyed": {
        if (!at) break;
        this.explosion(at.x, at.y, nowMs, 1);
        this.addDecal({ x: at.x, y: at.y, radiusM: 2.4, alpha: 0.5 });
        break;
      }
      case "mine_triggered": {
        if (!at) break;
        this.explosion(at.x, at.y, nowMs, 0.8);
        this.addDecal({ x: at.x, y: at.y, radiusM: 1.8, alpha: 0.45 });
        break;
      }
      case "hit_dealt":
      case "hit_taken": {
        if (!at) break;
        this.impact(at.x, at.y, nowMs);
        break;
      }
      default:
        break; // el resto de eventos no produce partículas
    }
  }

  /**
   * Detecta DISPAROS: cualquier proyectil cuyo id no habíamos visto es un tiro
   * recién nacido ⇒ fogonazo en su origen. Lee los dots, no los modifica.
   */
  ingestProjectiles(dots: readonly { id: string; x: number; y: number }[], nowMs: number): void {
    const seen = new Set<string>();
    for (const d of dots) {
      seen.add(d.id);
      if (!this.knownProjectiles.has(d.id)) {
        this.knownProjectiles.add(d.id);
        this.muzzleFlash(d.x, d.y, nowMs);
      }
    }
    // Olvida ids que ya no vuelan: un id reciclado por el motor cuenta como disparo nuevo.
    for (const id of this.knownProjectiles) if (!seen.has(id)) this.knownProjectiles.delete(id);
  }

  /** Partículas vivas en `now` (purga las expiradas). Sólo lectura para el render. */
  active(nowMs: number): readonly EffectSpec[] {
    if (this.live.length > 0) {
      this.live = this.live.filter((e) => nowMs < e.bornMs + e.lifeMs);
    }
    return this.live;
  }

  /** Decals pendientes de hornear; el render los pinta a la RenderTexture y limpia. */
  drainDecals(): DecalSpec[] {
    if (this.pendingDecals.length === 0) return [];
    const out = this.pendingDecals;
    this.pendingDecals = [];
    return out;
  }

  /** Reset total (reconexión o seek): no arrastrar efectos a través del hueco. */
  reset(): void {
    this.live = [];
    this.pendingDecals = [];
    this.knownProjectiles.clear();
    this.smokeWindow.clear();
  }

  // ─────────────────────────── generadores de partícula (deterministas) ──────

  private muzzleFlash(x: number, y: number, now: number): void {
    // R16.1 · fogonazo REAL (frame propio, ya no una chispa genérica). Sin
    // rotación de cañón: el dato de proyectil no trae heading del disparador,
    // así que nace en el origen del proyectil (fallback explícito del diseño).
    this.spawn({
      kind: "muzzle_flash",
      frame: "muzzle-flash",
      x,
      y,
      vx: 0,
      vy: 0,
      bornMs: now,
      lifeMs: 90,
      size0: 0.9,
      size1: 1.6,
      spin: 0,
      alpha0: 0.95,
    });
  }

  private impact(x: number, y: number, now: number): void {
    const s = seedOf(x, y);
    for (let i = 0; i < 4; i++) {
      const ang = hash01(s, i) * Math.PI * 2;
      const spd = 0.004 + hash01(s, i + 100) * 0.004; // m/ms
      this.spawn({
        kind: "impact",
        frame: "spark",
        x,
        y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        bornMs: now,
        lifeMs: 220,
        size0: 0.5,
        size1: 0.15,
        spin: (hash01(s, i + 7) - 0.5) * 0.02,
        alpha0: 0.9,
      });
    }
  }

  private explosion(x: number, y: number, now: number, scale: number): void {
    const s = seedOf(x, y);
    // Núcleo de la explosión: R16.1 usa la secuencia explosion-0/1/2 (elegida
    // por edad en el render) en vez de una chispa genérica escalada.
    this.spawn({
      kind: "explosion",
      frame: "explosion",
      x,
      y,
      vx: 0,
      vy: 0,
      bornMs: now,
      lifeMs: 320,
      size0: 1.2 * scale,
      size1: 3.4 * scale,
      spin: 0,
      alpha0: 1,
    });
    // Corona de chispas radiales.
    const sparks = Math.round(8 * scale);
    for (let i = 0; i < sparks; i++) {
      const ang = hash01(s, i) * Math.PI * 2;
      const spd = (0.006 + hash01(s, i + 200) * 0.006) * scale;
      this.spawn({
        kind: "explosion",
        frame: "spark",
        x,
        y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        bornMs: now,
        lifeMs: 380 + Math.floor(hash01(s, i + 5) * 200),
        size0: 0.7 * scale,
        size1: 0.2,
        spin: (hash01(s, i + 11) - 0.5) * 0.03,
        alpha0: 0.95,
      });
    }
    // Humo que sube y se expande.
    const puffs = Math.round(4 * scale);
    for (let i = 0; i < puffs; i++) {
      const drift = (hash01(s, i + 300) - 0.5) * 0.0015;
      this.spawn({
        kind: "smoke",
        frame: "smoke",
        x,
        y,
        vx: drift,
        vy: -0.001 - hash01(s, i + 33) * 0.001, // sube
        bornMs: now,
        lifeMs: 900 + Math.floor(hash01(s, i + 9) * 400),
        size0: 1.0 * scale,
        size1: 3.0 * scale,
        spin: (hash01(s, i + 13) - 0.5) * 0.004,
        alpha0: 0.5,
      });
    }
  }

  /**
   * Emisor de HUMO CRECIENTE del casco: dado un nivel 0..1 (a más daño, más humo),
   * decide si sale una voluta este frame y la crea. El ritmo de emisión crece con
   * el nivel; a nivel 0 no emite. Determinista sobre (id, ventana temporal).
   */
  hullSmoke(id: string, level: number, x: number, y: number, now: number): void {
    if (level <= 0) return;
    // Una voluta cada `period` ms; a más daño, período más corto (más humo). El
    // emisor se llama cada frame: se DEDUPLICA por ventana temporal para no crear
    // una voluta por frame (un único disparo por (id, ventana)).
    const period = 600 - 380 * Math.min(1, level);
    const window = Math.floor(now / period);
    if (this.smokeWindow.get(id) === window) return;
    this.smokeWindow.set(id, window);
    const key = hashStr(id) ^ window;
    this.spawn({
      kind: "smoke",
      frame: "smoke",
      x,
      y,
      vx: (hash01(key, 1) - 0.5) * 0.0008,
      vy: -0.0009 - hash01(key, 2) * 0.0006,
      bornMs: now,
      lifeMs: 1100,
      size0: 0.4 + 0.4 * level,
      size1: 1.4 + 1.2 * level,
      spin: (hash01(key, 3) - 0.5) * 0.003,
      alpha0: 0.25 + 0.3 * level,
    });
  }

  private addDecal(d: DecalSpec): void {
    this.pendingDecals.push(d);
    // Cota: si hay una avalancha de destrucciones, no acumular sin fin lo pendiente.
    if (this.pendingDecals.length > MAX_DECALS) {
      this.pendingDecals.splice(0, this.pendingDecals.length - MAX_DECALS);
    }
  }

  private spawn(e: Omit<EffectSpec, "id">): void {
    if (this.live.length >= MAX_LIVE_EFFECTS) return; // techo: descarta bajo presión
    this.live.push({ id: this.seq++, ...e });
  }
}

/** Resuelve la posición de un evento: campo `position` propio o el del vehículo. */
export function eventPosition(
  event: any,
  posOf?: (id: string) => { x: number; y: number } | undefined,
): { x: number; y: number } | null {
  const p = event?.position;
  if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: p.x, y: p.y };
  const id = event?.targetId ?? event?.sourceId;
  if (typeof id === "string" && posOf) {
    const vp = posOf(id);
    if (vp && Number.isFinite(vp.x) && Number.isFinite(vp.y)) return { x: vp.x, y: vp.y };
  }
  return null;
}

/** Hash de cadena → entero, para sembrar el humo por id de vehículo. */
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
