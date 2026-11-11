# Ejemplos de bots

Seis bots completos, de menor a mayor. Cada uno está en **Python** y en **JavaScript**: son el mismo bot con la sintaxis de cada lenguaje. Se pueden **pegar tal cual** en «Código → Nueva versión» (el hook obligatorio es `on_observation` / `onObservation`).

**Están verificados.** Los ficheros viven en `docs/user/bots/examples/` y se ejecutan contra el motor real y el SDK real en las pruebas del repositorio, validando cada orden que envían contra el contrato `arena/1`; además, el código que ves aquí es idéntico al de los ficheros (si alguien lo edita en un sitio y no en el otro, una prueba falla). Qué se comprueba exactamente aparece en cada ejemplo.

| Ejemplo | Para qué |
|---|---|
| [1. Mínimo](#1-mínimo) | El hook obligatorio y nada más. |
| [2. Patrulla](#2-patrulla) | Conducir hacia puntos usando el tamaño del mapa, sin sensores. |
| [3. Atacante](#3-atacante) | Ir al rival, apuntar con el radar y disparar. |
| [4. Sensores](#4-sensores) | Radar, lidar, acústico y proximidad, con cualquier loadout. |
| [5. Radio](#5-radio) | Enviar y decodificar mensajes respetando el ritmo. |
| [6. Equipo](#6-equipo) | Repartir papeles entre compañeros y capturar la bandera. |

## 1. Mínimo

El bot más pequeño que existe: implementa el hook obligatorio y avanza recto. Sirve para comprobar que tu cuenta, tu loadout y la validación funcionan de punta a punta.

- **Loadout:** Cualquiera.
- **Verificación:** Se ejecuta contra el motor real; se comprueba que avanza y que todas sus órdenes cumplen el contrato.

**Python**

```python
from arena_sdk import ArenaBot


class Bot(ArenaBot):
    def on_observation(self, observation):
        # Se llama en cada ciclo de decisión. Devuelve la orden del ciclo:
        # avanzar recto a media potencia. {} significaría "sin cambios".
        return {"move": {"throttle": 0.5, "steer": 0.0}}
```

**JavaScript**

```javascript
import { ArenaBot } from "@arena/sdk";

export default class Bot extends ArenaBot {
  onObservation(observation) {
    // Se llama en cada ciclo de decisión. Devuelve la orden del ciclo:
    // avanzar recto a media potencia. {} significaría "sin cambios".
    return { move: { throttle: 0.5, steer: 0.0 } };
  }
}
```

## 2. Patrulla

Recorre las cuatro esquinas interiores del mapa **sin sensores**. Enseña a usar `on_welcome` para leer el tamaño del mapa (`widthM`, `heightM`) y a conducir hacia un punto con `angle_to` y `angle_diff`.

- **Loadout:** Cualquiera: no usa sensores.
- **Verificación:** Se comprueba que completa tramos de la ruta sin descalificación.

**Python**

```python
from arena_sdk import ArenaBot, angle_diff, angle_to, distance


class Bot(ArenaBot):
    """Patrulla: recorre las cuatro esquinas interiores del mapa, sin sensores."""

    route = []
    leg = 0

    def on_welcome(self, welcome):
        # Las medidas del mapa llegan en el WELCOME: nunca las supongas.
        ancho = welcome["map"]["widthM"]
        largo = welcome["map"]["heightM"]
        margen = 15  # metros de separación respecto a los muros
        self.route = [
            {"x": margen, "y": margen},
            {"x": ancho - margen, "y": margen},
            {"x": ancho - margen, "y": largo - margen},
            {"x": margen, "y": largo - margen},
        ]

    def on_observation(self, observation):
        if not self.route:
            return {}
        me = observation["self"]
        goal = self.route[self.leg]
        if distance(me["position"], goal) < 6:  # llegado: siguiente tramo
            self.leg = (self.leg + 1) % len(self.route)
            goal = self.route[self.leg]
        giro = angle_diff(me["heading"], angle_to(me["position"], goal))
        # Si el destino queda muy desviado, frena y gira; si no, acelera.
        throttle = 0.9 if abs(giro) < 0.6 else 0.2
        return {"move": {"throttle": throttle, "steer": max(-1.0, min(1.0, giro * 2))}}
```

**JavaScript**

```javascript
import { ArenaBot, angleDiff, angleTo, distance } from "@arena/sdk";

/** Patrulla: recorre las cuatro esquinas interiores del mapa, sin sensores. */
export default class Bot extends ArenaBot {
  route = [];
  leg = 0;

  onWelcome(welcome) {
    // Las medidas del mapa llegan en el WELCOME: nunca las supongas.
    const ancho = welcome.map.widthM;
    const largo = welcome.map.heightM;
    const margen = 15; // metros de separación respecto a los muros
    this.route = [
      { x: margen, y: margen },
      { x: ancho - margen, y: margen },
      { x: ancho - margen, y: largo - margen },
      { x: margen, y: largo - margen },
    ];
  }

  onObservation(observation) {
    if (this.route.length === 0) return {};
    const me = observation.self;
    let goal = this.route[this.leg];
    if (distance(me.position, goal) < 6) {
      // llegado: siguiente tramo
      this.leg = (this.leg + 1) % this.route.length;
      goal = this.route[this.leg];
    }
    const giro = angleDiff(me.heading, angleTo(me.position, goal));
    // Si el destino queda muy desviado, frena y gira; si no, acelera.
    const throttle = Math.abs(giro) < 0.6 ? 0.9 : 0.2;
    return { move: { throttle, steer: Math.max(-1, Math.min(1, giro * 2)) } };
  }
}
```

## 3. Atacante

Va hacia la salida del rival (las salidas de todos los bandos vienen en `welcome.map.spawns`); si el radar ve a un rival, mantiene la distancia, apunta y dispara con las armas de tu loadout. Distingue rivales de aliados mirando si el contacto tiene `team`.

- **Loadout:** Necesita **radar** y un arma (por ejemplo, el arquetipo `gunner`).
- **Verificación:** Gana a un rival inmóvil en el simulador.

**Python**

```python
from arena_sdk import ArenaBot, angle_diff, angle_to, distance


class Bot(ArenaBot):
    """Atacante: va hacia la salida del rival; si el radar ve a alguien, apunta y dispara."""

    weapons = []
    goal = {"x": 60, "y": 40}

    def on_welcome(self, welcome):
        # Se dispara con las armas de TU loadout: sus ranuras salen del WELCOME.
        self.weapons = [m["slot"] for m in welcome["vehicle"]["modules"] if m["category"] == "weapon"]
        rivales = [s["position"] for s in welcome["map"]["spawns"] if s["team"] != welcome["team"]]
        if rivales:
            self.goal = rivales[0]

    def on_observation(self, observation):
        me = observation["self"]
        radar = observation.get("sensors", {}).get("radar", [])
        # Un contacto con "team" es un aliado: aquí sólo nos interesan los rivales.
        rivales = [c for r in radar for c in r["contacts"] if "team" not in c]
        if not rivales:
            return {"move": self.conducir(me, self.goal, 0.9)}
        blanco = min(rivales, key=lambda c: distance(me["position"], c["position"]))
        d = distance(me["position"], blanco["position"])
        # Mantiene la distancia: se acerca si está lejos, retrocede si está encima.
        throttle = 0.6 if d > 30 else (-0.3 if d < 15 else 0.0)
        return {
            "move": {**self.conducir(me, blanco["position"], 0.0), "throttle": throttle},
            "turret": {"targetPoint": blanco["position"]},
            "fire": self.weapons,
        }

    def conducir(self, me, punto, throttle):
        giro = angle_diff(me["heading"], angle_to(me["position"], punto))
        return {"throttle": throttle, "steer": max(-1.0, min(1.0, giro * 2))}
```

**JavaScript**

```javascript
import { ArenaBot, angleDiff, angleTo, distance } from "@arena/sdk";

/** Atacante: va hacia la salida del rival; si el radar ve a alguien, apunta y dispara. */
export default class Bot extends ArenaBot {
  weapons = [];
  goal = { x: 60, y: 40 };

  onWelcome(welcome) {
    // Se dispara con las armas de TU loadout: sus ranuras salen del WELCOME.
    this.weapons = welcome.vehicle.modules.filter((m) => m.category === "weapon").map((m) => m.slot);
    const rivales = welcome.map.spawns.filter((s) => s.team !== welcome.team).map((s) => s.position);
    if (rivales.length > 0) this.goal = rivales[0];
  }

  onObservation(observation) {
    const me = observation.self;
    const radar = observation.sensors?.radar ?? [];
    // Un contacto con "team" es un aliado: aquí sólo nos interesan los rivales.
    const rivales = radar.flatMap((r) => r.contacts).filter((c) => c.team === undefined);
    if (rivales.length === 0) {
      return { move: this.conducir(me, this.goal, 0.9) };
    }
    const blanco = rivales.reduce((a, b) =>
      distance(me.position, a.position) <= distance(me.position, b.position) ? a : b,
    );
    const d = distance(me.position, blanco.position);
    // Mantiene la distancia: se acerca si está lejos, retrocede si está encima.
    const throttle = d > 30 ? 0.6 : d < 15 ? -0.3 : 0.0;
    return {
      move: { ...this.conducir(me, blanco.position, 0.0), throttle },
      turret: { targetPoint: blanco.position },
      fire: this.weapons,
    };
  }

  conducir(me, punto, throttle) {
    const giro = angleDiff(me.heading, angleTo(me.position, punto));
    return { throttle, steer: Math.max(-1, Math.min(1, giro * 2)) };
  }
}
```

## 4. Sensores

Usa los cuatro tipos de sensor si están montados: el lidar para esquivar muros, el radar para apuntar, el acústico para girar la torreta hacia un disparo y la proximidad para recular. Funciona con **cualquier** loadout, aunque no tenga alguno de los sensores.

- **Loadout:** Cualquiera; cuantos más sensores, más hace.
- **Verificación:** Se ejecuta con los arquetipos `scout` (lidar frontal), `gunner` (radar) y `heavy` (lidar 360).

**Python**

```python
from arena_sdk import ArenaBot, distance


class Bot(ArenaBot):
    """Usa lo que haya montado: lidar para esquivar muros, radar para apuntar,
    acústico para mirar hacia un disparo y proximidad para recular."""

    weapons = []

    def on_welcome(self, welcome):
        self.weapons = [m["slot"] for m in welcome["vehicle"]["modules"] if m["category"] == "weapon"]

    def on_observation(self, observation):
        me = observation["self"]
        sensors = observation.get("sensors", {})  # sin sensores operativos no hay clave
        cmd = {"move": {"throttle": 0.7, "steer": 0.2}}

        # Lidar: "angle" es RELATIVO al morro; distanceM es la distancia libre.
        for scan in sensors.get("lidar", []):
            delante = [r["distanceM"] for r in scan["rays"] if abs(r["angle"]) < 0.4]
            if delante and min(delante) < 10:
                libre = max(scan["rays"], key=lambda r: r["distanceM"])
                cmd["move"] = {"throttle": 0.3, "steer": max(-1.0, min(1.0, libre["angle"] * 2))}

        # Radar: posiciones ABSOLUTAS con error (errorM). "team" sólo aparece en aliados.
        rivales = [c for r in sensors.get("radar", []) for c in r["contacts"] if "team" not in c]
        if rivales:
            blanco = min(rivales, key=lambda c: distance(me["position"], c["position"]))
            cmd["turret"] = {"targetPoint": blanco["position"]}
            cmd["fire"] = self.weapons
        else:
            # Acústico: sólo da dirección absoluta (bearing), nunca posición.
            for ac in sensors.get("acoustic", []):
                for fuente in ac["sources"]:
                    if fuente["kind"] == "gunshot":
                        cmd["turret"] = {"targetHeading": fuente["bearing"]}

        # Proximidad: algo (vehículo o mina) muy cerca; retrocede.
        if any(p["triggered"] for p in sensors.get("proximity", [])):
            cmd["move"] = {"throttle": -0.6, "steer": 0.0}
        return cmd
```

**JavaScript**

```javascript
import { ArenaBot, distance } from "@arena/sdk";

/**
 * Usa lo que haya montado: lidar para esquivar muros, radar para apuntar,
 * acústico para mirar hacia un disparo y proximidad para recular.
 */
export default class Bot extends ArenaBot {
  weapons = [];

  onWelcome(welcome) {
    this.weapons = welcome.vehicle.modules.filter((m) => m.category === "weapon").map((m) => m.slot);
  }

  onObservation(observation) {
    const me = observation.self;
    const sensors = observation.sensors ?? {}; // sin sensores operativos no hay clave
    const cmd = { move: { throttle: 0.7, steer: 0.2 } };

    // Lidar: "angle" es RELATIVO al morro; distanceM es la distancia libre.
    for (const scan of sensors.lidar ?? []) {
      const delante = scan.rays.filter((r) => Math.abs(r.angle) < 0.4).map((r) => r.distanceM);
      if (delante.length > 0 && Math.min(...delante) < 10) {
        const libre = scan.rays.reduce((a, b) => (a.distanceM >= b.distanceM ? a : b));
        cmd.move = { throttle: 0.3, steer: Math.max(-1, Math.min(1, libre.angle * 2)) };
      }
    }

    // Radar: posiciones ABSOLUTAS con error (errorM). "team" sólo aparece en aliados.
    const rivales = (sensors.radar ?? []).flatMap((r) => r.contacts).filter((c) => c.team === undefined);
    if (rivales.length > 0) {
      const blanco = rivales.reduce((a, b) =>
        distance(me.position, a.position) <= distance(me.position, b.position) ? a : b,
      );
      cmd.turret = { targetPoint: blanco.position };
      cmd.fire = this.weapons;
    } else {
      // Acústico: sólo da dirección absoluta (bearing), nunca posición.
      for (const ac of sensors.acoustic ?? []) {
        for (const fuente of ac.sources) {
          if (fuente.kind === "gunshot") cmd.turret = { targetHeading: fuente.bearing };
        }
      }
    }

    // Proximidad: algo (vehículo o mina) muy cerca; retrocede.
    if ((sensors.proximity ?? []).some((p) => p.triggered)) {
      cmd.move = { throttle: -0.6, steer: 0.0 };
    }
    return cmd;
  }
}
```

## 5. Radio

Avisa a su equipo por radio de dónde ve a un rival (dos coordenadas en 4 bytes) y decodifica lo que oye. Si juega sin compañeros, no gasta radio. Respeta el límite de **2 mensajes por segundo** y acota los números al rango del formato.

- **Loadout:** Necesita **radio** y **radar** (por ejemplo, `gunner`).
- **Verificación:** Dos compañeros del mismo equipo se mandan mensajes en el simulador, en una batalla por equipos (`tdm_mvp@1`) contra un rival, y se comprueba que se entregan y se decodifican y que el rival no recibe nada. La radio permite compartir información con los bots de tu propio equipo. Los bots rivales no reciben estos mensajes ([Radio](radio.md)).

**Python**

```python
import base64
import struct

from arena_sdk import ArenaBot, angle_diff, angle_to, distance


class Bot(ArenaBot):
    """Avisa a su equipo por radio de dónde ve a un rival (x, y en decímetros,
    4 bytes) y guarda lo que oye. Respeta el límite de mensajes por segundo."""

    radio_slot = None
    teammates = []
    last_sent = -1000
    center = {"x": 60, "y": 40}

    def on_welcome(self, welcome):
        self.heard = []
        # La radio sólo llega a tu equipo: sin compañeros, no hay a quién avisar.
        self.teammates = welcome.get("teammates", [])
        self.center = {"x": welcome["map"]["widthM"] / 2, "y": welcome["map"]["heightM"] / 2}
        self.radio_slot = next(
            (m["slot"] for m in welcome["vehicle"]["modules"] if m["category"] == "radio"), None
        )

    def on_observation(self, observation):
        me = observation["self"]
        tick = observation["tick"]
        # Avanza hacia el centro del mapa, donde se cruzan los caminos.
        giro = angle_diff(me["heading"], angle_to(me["position"], self.center))
        cmd = {"move": {"throttle": 0.6, "steer": max(-1.0, min(1.0, giro * 2))}}

        # Lo recibido llega en observation["radio"]; "data" es base64 opaco.
        for msg in observation.get("radio", []):
            x, y = struct.unpack(">HH", base64.b64decode(msg["data"]))
            self.heard.append({"from": msg["from"], "x": x / 10, "y": y / 10})

        radar = observation.get("sensors", {}).get("radar", [])
        rivales = [c for r in radar for c in r["contacts"] if "team" not in c]
        if rivales and self.radio_slot and self.teammates and tick - self.last_sent >= 30:  # a lo sumo 1 mensaje por segundo
            blanco = min(rivales, key=lambda c: distance(me["position"], c["position"]))
            # Máximo 32 bytes por mensaje; aquí son 4. Se acota para que quepa en 16 bits.
            x = max(0, min(65535, int(blanco["position"]["x"] * 10)))
            y = max(0, min(65535, int(blanco["position"]["y"] * 10)))
            data = base64.b64encode(struct.pack(">HH", x, y)).decode("ascii")
            cmd["radio"] = [{"slot": self.radio_slot, "data": data}]
            self.last_sent = tick
        return cmd
```

**JavaScript**

```javascript
import { ArenaBot, angleDiff, angleTo, distance } from "@arena/sdk";

/**
 * Avisa a su equipo por radio de dónde ve a un rival (x, y en decímetros, 4 bytes)
 * y guarda lo que oye. Respeta el límite de mensajes por segundo.
 */
export default class Bot extends ArenaBot {
  radioSlot = null;
  teammates = [];
  lastSent = -1000;
  center = { x: 60, y: 40 };
  heard = [];

  onWelcome(welcome) {
    this.center = { x: welcome.map.widthM / 2, y: welcome.map.heightM / 2 };
    this.radioSlot = welcome.vehicle.modules.find((m) => m.category === "radio")?.slot ?? null;
    // La radio sólo llega a tu equipo: sin compañeros, no hay a quién avisar.
    this.teammates = welcome.teammates ?? [];
  }

  onObservation(observation) {
    const me = observation.self;
    const tick = observation.tick;
    // Avanza hacia el centro del mapa, donde se cruzan los caminos.
    const giro = angleDiff(me.heading, angleTo(me.position, this.center));
    const cmd = { move: { throttle: 0.6, steer: Math.max(-1, Math.min(1, giro * 2)) } };

    // Lo recibido llega en observation.radio; "data" es base64 opaco.
    for (const msg of observation.radio ?? []) {
      const bytes = Buffer.from(msg.data, "base64");
      this.heard.push({ from: msg.from, x: bytes.readUInt16BE(0) / 10, y: bytes.readUInt16BE(2) / 10 });
    }

    const rivales = (observation.sensors?.radar ?? []).flatMap((r) => r.contacts).filter((c) => c.team === undefined);
    if (rivales.length > 0 && this.radioSlot && this.teammates.length > 0 && tick - this.lastSent >= 30) {
      // a lo sumo 1 mensaje por segundo
      const blanco = rivales.reduce((a, b) =>
        distance(me.position, a.position) <= distance(me.position, b.position) ? a : b,
      );
      // Máximo 32 bytes por mensaje; aquí son 4. Se acota para que quepa en 16 bits.
      const acota = (v) => Math.max(0, Math.min(65535, Math.trunc(v * 10)));
      const bytes = Buffer.alloc(4);
      bytes.writeUInt16BE(acota(blanco.position.x), 0);
      bytes.writeUInt16BE(acota(blanco.position.y), 2);
      cmd.radio = [{ slot: this.radioSlot, data: bytes.toString("base64") }];
      this.lastSent = tick;
    }
    return cmd;
  }
}
```

## 6. Equipo

Captura la bandera en equipo: cada miembro ordena la lista `[selfId, *teammates]` y el de id más bajo ataca mientras los demás defienden la base, **sin necesidad de hablar**. Si llevas la bandera, vuelves a tu base. Muestra cómo usar `welcome.teammates`, `welcome.map.bases` y `self.carryingFlag`.

- **Loadout:** Radar y un arma, en un modo de captura de bandera (por ejemplo, `gunner`).
- **Verificación:** Dos compañeros del mismo equipo reciben papeles distintos en una batalla 2v2 de captura de bandera (JavaScript). **NOT TESTED** en Python con dos compañeros reales: el simulador de Python reparte los bots en bandos alternos; en solitario se comprueba que juega como atacante sin errores.

**Python**

```python
from arena_sdk import ArenaBot, angle_diff, angle_to, distance


class Bot(ArenaBot):
    """Captura la bandera en equipo: el compañero con el id más bajo ataca y el
    resto defiende la base. Todos disparan a lo que vea su radar."""

    weapons = []
    role = "attacker"
    own_base = {"x": 10, "y": 40}
    enemy_base = {"x": 110, "y": 40}

    def on_welcome(self, welcome):
        self.weapons = [m["slot"] for m in welcome["vehicle"]["modules"] if m["category"] == "weapon"]
        # Todos los miembros del equipo ordenan la misma lista, así que reparten
        # los papeles sin hablar: sólo el id más bajo es el atacante.
        escuadra = sorted([welcome["selfId"], *welcome.get("teammates", [])])
        self.role = "attacker" if escuadra[0] == welcome["selfId"] else "defender"
        for base in welcome["map"].get("bases", []):
            if base["team"] == welcome["team"]:
                self.own_base = base["position"]
            else:
                self.enemy_base = base["position"]

    def on_observation(self, observation):
        me = observation["self"]
        radar = observation.get("sensors", {}).get("radar", [])
        rivales = [c for r in radar for c in r["contacts"] if "team" not in c]

        if me.get("carryingFlag"):  # llevo la bandera rival: a mi base
            destino = self.own_base
        elif self.role == "attacker":
            destino = self.enemy_base  # la bandera rival está en su base
        else:
            destino = self.own_base  # el defensor guarda la suya

        giro = angle_diff(me["heading"], angle_to(me["position"], destino))
        parado = self.role == "defender" and distance(me["position"], destino) < 8
        cmd = {"move": {"throttle": 0.0 if parado else 0.8, "steer": max(-1.0, min(1.0, giro * 2))}}
        if rivales:
            blanco = min(rivales, key=lambda c: distance(me["position"], c["position"]))
            cmd["turret"] = {"targetPoint": blanco["position"]}
            cmd["fire"] = self.weapons
        return cmd
```

**JavaScript**

```javascript
import { ArenaBot, angleDiff, angleTo, distance } from "@arena/sdk";

/**
 * Captura la bandera en equipo: el compañero con el id más bajo ataca y el resto
 * defiende la base. Todos disparan a lo que vea su radar.
 */
export default class Bot extends ArenaBot {
  weapons = [];
  role = "attacker";
  ownBase = { x: 10, y: 40 };
  enemyBase = { x: 110, y: 40 };

  onWelcome(welcome) {
    this.weapons = welcome.vehicle.modules.filter((m) => m.category === "weapon").map((m) => m.slot);
    // Todos los miembros del equipo ordenan la misma lista, así que reparten
    // los papeles sin hablar: sólo el id más bajo es el atacante.
    const escuadra = [welcome.selfId, ...(welcome.teammates ?? [])].sort();
    this.role = escuadra[0] === welcome.selfId ? "attacker" : "defender";
    for (const base of welcome.map.bases ?? []) {
      if (base.team === welcome.team) this.ownBase = base.position;
      else this.enemyBase = base.position;
    }
  }

  onObservation(observation) {
    const me = observation.self;
    const rivales = (observation.sensors?.radar ?? []).flatMap((r) => r.contacts).filter((c) => c.team === undefined);

    let destino;
    if (me.carryingFlag) destino = this.ownBase; // llevo la bandera rival: a mi base
    else if (this.role === "attacker") destino = this.enemyBase; // la bandera rival está en su base
    else destino = this.ownBase; // el defensor guarda la suya

    const giro = angleDiff(me.heading, angleTo(me.position, destino));
    const parado = this.role === "defender" && distance(me.position, destino) < 8;
    const cmd = { move: { throttle: parado ? 0.0 : 0.8, steer: Math.max(-1, Math.min(1, giro * 2)) } };
    if (rivales.length > 0) {
      const blanco = rivales.reduce((a, b) =>
        distance(me.position, a.position) <= distance(me.position, b.position) ? a : b,
      );
      cmd.turret = { targetPoint: blanco.position };
      cmd.fire = this.weapons;
    }
    return cmd;
  }
}
```

## Más bots

- Los **cuatro bots oficiales** (Explorador y Defensor en Python; Artillero y Minador en JavaScript) están en `example-bots/`. Son más largos y juegan en equipo; el Artillero predice dónde estará el blanco para acertar a un vehículo en movimiento.
- Los bots tutoriales de cada SDK, en los README de [Python](python.md) y [JavaScript](javascript.md).
- La **plantilla** con la que empieza el editor de código de la web es un bot completo que va al rival, usa el radar o el lidar que traiga tu loadout y dispara.
