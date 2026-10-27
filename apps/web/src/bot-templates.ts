/**
 * UX-B · B3 (G-02) — plantillas del editor de código: el área de texto NO empieza
 * vacía. Un bot mínimo por runtime, ejecutable tal cual y que pasa el build REAL
 * (lo comprueba apps/bot-manager/tests/build-sandbox-docker.test.ts con estas
 * mismas cadenas): implementa el hook (`on_observation` / `onObservation`), lee
 * del WELCOME las ranuras de arma de TU loadout (no asume `turret_main`) y sólo
 * usa el SDK de la plataforma.
 *
 * UX-F (DEF-R7) · antes patrullaban girando en el sitio: con el radar a 50 m y las
 * salidas a ~80 m, dos plantillas no se veían nunca (5 min sin un disparo). Ahora
 * van hacia la salida del rival (WELCOME.map.spawns) y usan el radar o el lidar
 * que traiga el loadout. Lo prueban sdks/python/tests/test_editor_templates.py y
 * apps/web/tests/uxf-bot-templates.test.ts con el motor real.
 */
export type BotRuntime = "python" | "node";

export const PYTHON_TEMPLATE = `import math

from arena_sdk import ArenaBot, angle_diff, angle_to


class Bot(ArenaBot):
    """Plantilla mínima: va hacia el rival; si un sensor lo ve, apunta y dispara."""

    weapons = []
    waypoints = []
    last = None
    stuck = 0
    backing = 0

    def on_welcome(self, welcome):
        # Tu vehículo es el loadout de esta versión: se dispara con SUS armas.
        self.weapons = [m["slot"] for m in welcome["vehicle"]["modules"] if m["category"] == "weapon"]
        # El radar llega a unos 50 m y los vehículos nacen más lejos: girar en el
        # sitio no encuentra a nadie. Se patrulla hacia la salida del rival y el centro.
        world = welcome["map"]
        enemy = [s["position"] for s in world["spawns"] if s["team"] != welcome["team"]]
        self.waypoints = enemy + [{"x": world["widthM"] / 2, "y": world["heightM"] / 2}]

    def on_observation(self, observation):
        # OBLIGATORIO: se llama en cada ciclo de decisión. {} = sin cambios.
        me = observation["self"]
        sensors = observation.get("sensors", {})
        # Radar: posición (con error). Un contacto con "team" es un aliado.
        contacts = [c for r in sensors.get("radar", []) for c in r.get("contacts", []) if "team" not in c]
        target = contacts[0]["position"] if contacts else None
        # Lidar: un rayo que choca con un vehículo da su dirección y distancia.
        if target is None:
            for scan in sensors.get("lidar", []):
                for ray in scan["rays"]:
                    if ray["hit"] == "vehicle":
                        a = me["heading"] + ray["angle"]
                        target = {"x": me["position"]["x"] + ray["distanceM"] * math.cos(a),
                                  "y": me["position"]["y"] + ray["distanceM"] * math.sin(a)}
                        break
        if target is None:
            return {"move": self.unstick(me) or self.drive_to(me, self.next_waypoint(me), 0.8)}
        return {
            "move": self.drive_to(me, target, 0.5),
            "turret": {"targetPoint": target},
            "fire": self.weapons,
        }

    def next_waypoint(self, me):
        if not self.waypoints:
            return me["position"]
        wp = self.waypoints[0]
        if abs(wp["x"] - me["position"]["x"]) + abs(wp["y"] - me["position"]["y"]) < 10:
            self.waypoints.append(self.waypoints.pop(0))  # llegado: al siguiente
        return self.waypoints[0]

    def drive_to(self, me, point, throttle):
        turn = angle_diff(me["heading"], angle_to(me["position"], point))
        return {"throttle": throttle if abs(turn) < 1.2 else 0.2, "steer": max(-1.0, min(1.0, turn * 2))}

    def unstick(self, me):
        # Atascado contra un muro (casi no se mueve): marcha atrás girando un rato.
        p = me["position"]
        moved = abs(p["x"] - self.last["x"]) + abs(p["y"] - self.last["y"]) if self.last else 1.0
        self.last = p
        self.stuck = self.stuck + 1 if moved < 0.05 else 0
        if self.stuck > 8:
            self.stuck, self.backing = 0, 20
        if self.backing > 0:
            self.backing -= 1
            return {"throttle": -0.7, "steer": 1.0}
        return None
`;

export const JAVASCRIPT_TEMPLATE = `import { ArenaBot, angleDiff, angleTo } from "@arena/sdk";

// Plantilla mínima (JavaScript ESM, no TypeScript): va hacia el rival y, si un
// sensor lo ve, apunta y dispara.
export default class Bot extends ArenaBot {
  weapons = [];
  waypoints = [];
  last = null;
  stuck = 0;
  backing = 0;

  onWelcome(welcome) {
    // Tu vehículo es el loadout de esta versión: se dispara con SUS armas.
    this.weapons = welcome.vehicle.modules.filter((m) => m.category === "weapon").map((m) => m.slot);
    // El radar llega a unos 50 m y los vehículos nacen más lejos: girar en el
    // sitio no encuentra a nadie. Se patrulla hacia la salida del rival y el centro.
    const world = welcome.map;
    const enemy = world.spawns.filter((s) => s.team !== welcome.team).map((s) => s.position);
    this.waypoints = [...enemy, { x: world.widthM / 2, y: world.heightM / 2 }];
  }

  onObservation(observation) {
    // OBLIGATORIO: se llama en cada ciclo de decisión. {} = sin cambios.
    const me = observation.self;
    const sensors = observation.sensors ?? {};
    // Radar: posición (con error). Un contacto con "team" es un aliado.
    const contacts = (sensors.radar ?? []).flatMap((r) => r.contacts).filter((c) => !c.team);
    let target = contacts.length > 0 ? contacts[0].position : null;
    // Lidar: un rayo que choca con un vehículo da su dirección y distancia.
    for (const scan of sensors.lidar ?? []) {
      const ray = target ? null : scan.rays.find((r) => r.hit === "vehicle");
      if (ray) {
        const a = me.heading + ray.angle;
        target = { x: me.position.x + ray.distanceM * Math.cos(a), y: me.position.y + ray.distanceM * Math.sin(a) };
      }
    }
    if (!target) return { move: this.unstick(me) ?? this.driveTo(me, this.nextWaypoint(me), 0.8) };
    return { move: this.driveTo(me, target, 0.5), turret: { targetPoint: target }, fire: this.weapons };
  }

  nextWaypoint(me) {
    if (this.waypoints.length === 0) return me.position;
    const wp = this.waypoints[0];
    if (Math.abs(wp.x - me.position.x) + Math.abs(wp.y - me.position.y) < 10) {
      this.waypoints.push(this.waypoints.shift()); // llegado: al siguiente
    }
    return this.waypoints[0];
  }

  driveTo(me, point, throttle) {
    const turn = angleDiff(me.heading, angleTo(me.position, point));
    return { throttle: Math.abs(turn) < 1.2 ? throttle : 0.2, steer: Math.max(-1, Math.min(1, turn * 2)) };
  }

  unstick(me) {
    // Atascado contra un muro (casi no se mueve): marcha atrás girando un rato.
    const p = me.position;
    const moved = this.last ? Math.abs(p.x - this.last.x) + Math.abs(p.y - this.last.y) : 1;
    this.last = p;
    this.stuck = moved < 0.05 ? this.stuck + 1 : 0;
    if (this.stuck > 8) [this.stuck, this.backing] = [0, 20];
    if (this.backing > 0) {
      this.backing -= 1;
      return { throttle: -0.7, steer: 1 };
    }
    return null;
  }
}
`;

export const BOT_TEMPLATES: Record<BotRuntime, string> = { python: PYTHON_TEMPLATE, node: JAVASCRIPT_TEMPLATE };

/** Texto del contrato, junto al editor (sin necesidad de leer el repo). */
export const HOOK_HELP: Record<BotRuntime, string> = {
  python:
    "Python 3.11. Una clase que extiende ArenaBot (de arena_sdk) e implementa on_observation(self, observation), que devuelve la orden del ciclo; {} = sin cambios.",
  node: 'JavaScript ESM (Node 20; TypeScript no se acepta). export default class … extends ArenaBot (de "@arena/sdk") con onObservation(observation), que devuelve la orden del ciclo; {} = sin cambios.',
};

/** ¿El texto es vacío o una plantilla sin tocar? Entonces cambiar de runtime puede sustituirlo. */
export function isUntouchedTemplate(code: string): boolean {
  const t = code.trim();
  return t === "" || Object.values(BOT_TEMPLATES).some((tpl) => tpl.trim() === t);
}
