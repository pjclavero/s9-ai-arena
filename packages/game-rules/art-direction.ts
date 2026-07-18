/**
 * R3.4 · Dirección artística S9 — PALETA DE EQUIPOS (ERR-VIS-05).
 *
 * Las reglas son DATOS (T2.3): el COLOR de un equipo tampoco se decide en el
 * visor con literales sueltos, se resuelve desde aquí (capa de reglas/arte). El
 * visor pinta el chasis en blanco y aplica setTint con el color que devuelve
 * `resolveTeamColors` — así "no hay colores hardcodeados en el render" (DoD) y
 * cualquier equipo distinto de red/blue recibe un color PROPIO y distinto.
 *
 * Estética: táctica/industrial. Tonos señal saturados pero terrosos sobre el
 * fondo verde-oscuro del mapa; contrastan entre sí y con el terreno.
 *
 * Módulo PURO (sin DOM ni Phaser): se prueba con vitest en Node.
 */

/** Color canónico por NOMBRE de equipo conocido (los habituales tienen identidad fija). */
const CANONICAL: Record<string, number> = {
  red: 0xd4453a,
  blue: 0x3f7fd1,
  green: 0x4fae5a,
  yellow: 0xd8a43a,
  amber: 0xd8a43a,
  purple: 0x9153c4,
  teal: 0x35b0a6,
  cyan: 0x35b0a6,
  orange: 0xd9772e,
  pink: 0xd45c9b,
};

/**
 * Rotación de tintes para equipos SIN nombre canónico (t1, alpha, "equipo-3"…):
 * se reparten en orden estable y sin repetir con los ya asignados.
 */
const ROTATION: readonly number[] = [0xd4453a, 0x3f7fd1, 0x4fae5a, 0xd8a43a, 0x9153c4, 0x35b0a6, 0xd9772e, 0xd45c9b];

/** Gris industrial: sin equipo o paleta agotada (nunca deja un sprite sin color). */
export const NEUTRAL_TEAM_COLOR = 0x9aa4a0;

/**
 * Asigna un color a cada equipo presente. DETERMINISTA e independiente del orden
 * de entrada (ordena los equipos), así el rojo es siempre el mismo rojo y dos
 * equipos jamás comparten color mientras quede paleta. Los nombres canónicos
 * mandan; el resto toma el siguiente tinte libre de la rotación.
 */
export function resolveTeamColors(teams: Iterable<string>): Map<string, number> {
  const uniq = [...new Set(teams)].sort();
  const used = new Set<number>();
  const out = new Map<string, number>();
  // 1ª pasada: colores canónicos (identidad fija de los equipos conocidos).
  for (const t of uniq) {
    const c = CANONICAL[t.toLowerCase()];
    if (c !== undefined) {
      out.set(t, c);
      used.add(c);
    }
  }
  // 2ª pasada: el resto toma el siguiente tinte de la rotación que no esté usado.
  let ri = 0;
  for (const t of uniq) {
    if (out.has(t)) continue;
    let color = NEUTRAL_TEAM_COLOR;
    for (let guard = 0; guard < ROTATION.length; guard++) {
      const candidate = ROTATION[ri % ROTATION.length];
      ri++;
      if (!used.has(candidate)) {
        color = candidate;
        break;
      }
    }
    out.set(t, color);
    used.add(color);
  }
  return out;
}

/** Atajo: color de UN equipo dado el conjunto de equipos presentes. */
export function teamColor(team: string, teams: Iterable<string>): number {
  return resolveTeamColors(teams).get(team) ?? NEUTRAL_TEAM_COLOR;
}
