/**
 * E9 · T9.2 — Los seis formatos de la tabla del capítulo 19 como GENERADORES
 * PUROS de calendario: entradas (inscritos ya congelados) → lista de
 * rondas/emparejamientos. Nada de BD aquí: la materialización (matches,
 * battles, semillas commit-reveal, lados) es de scheduler.ts.
 *
 * Un Pairing puede depender de resultados futuros (eliminatorias): entonces
 * home/away son null y homeSource/awaySource señalan el slot del que sale el
 * participante. El scheduler crea la batalla cuando ambos lados se resuelven.
 *
 * Reglas de desempate documentadas por formato:
 *  - Liga / round robin: 1) puntos (victoria 3, empate 1); 2) enfrentamiento
 *    directo; 3) diferencia de puntuación total; 4) orden de seed.
 *  - Suizo: 1) puntos; 2) Buchholz (suma de puntos de los rivales); 3) seed.
 *  - Eliminatorias: no hay tabla; el desempate por emparejamiento es el de la
 *    propia serie (rounds_per_pairing impar decide; con serie empatada gana el
 *    mejor seed, documentado en la entrega).
 *  - Equipos: como liga, sobre el marcador agregado de la plantilla.
 */

export interface Entrant {
  id: string;
  /** 1 = mejor cabeza de serie. Determina el sembrado de eliminatorias. */
  seed: number;
  /** Dueño (E9.M anti-colusión): evitar cruces tempranos del mismo dueño. */
  ownerId?: string;
}

export interface Source {
  slot: string;
  take: "winner" | "loser";
}

export interface Pairing {
  /** Identificador estable y único del partido dentro del torneo (p.ej. "W1M2"). */
  slot: string;
  /** Ronda de juego (1-based, orden cronológico dentro de su bracket). */
  round: number;
  bracket: "main" | "winners" | "losers" | "grand_final";
  home: string | null;
  away: string | null;
  homeSource?: Source;
  awaySource?: Source;
  /** Descanso: un solo participante, pasa de ronda sin jugar. */
  bye?: boolean;
  /** La final del torneo: se marca para modo visible (19.1). */
  final?: boolean;
  /**
   * Bracket reset de la doble eliminación: este match solo se JUEGA si el
   * ganador del slot indicado (la final del bracket de ganadores) PERDIÓ la
   * gran final; si la ganó, el match se resuelve solo (formalidad) porque el
   * rival ya acumula dos derrotas. Garantiza la propiedad "nadie queda fuera
   * con una sola derrota" también para el ganador del bracket W.
   */
  conditionalOn?: string;
}

// ---------------------------------------------------------------- round robin

/**
 * Round robin por el método del círculo: todos contra todos EXACTAMENTE una
 * vez. Con n impar se añade un descanso (bye) que rota. Los lados se asignan
 * alternando por ronda y mesa para que nadie encadene siempre el mismo lado.
 */
export function generateRoundRobin(
  entrants: Entrant[],
  opts: { startRound?: number; swapSides?: boolean; slotPrefix?: string } = {},
): Pairing[] {
  const ids: (string | null)[] = entrants.map((e) => e.id);
  if (ids.length % 2 === 1) ids.push(null); // descanso rotatorio
  const n = ids.length;
  const rounds = n - 1;
  const start = opts.startRound ?? 1;
  const prefix = opts.slotPrefix ?? "";
  const pairings: Pairing[] = [];
  const arr = ids.slice();
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i];
      const b = arr[n - 1 - i];
      const round = start + r;
      const slot = `${prefix}RR${round}M${i + 1}`;
      if (a === null || b === null) {
        const resting = a ?? b;
        if (resting !== null) pairings.push({ slot, round, bracket: "main", home: resting, away: null, bye: true });
        continue;
      }
      // Alternancia de lados: la paridad de ronda+mesa decide quién es local.
      let [home, away] = (r + i) % 2 === 0 ? [a, b] : [b, a];
      if (opts.swapSides) [home, away] = [away, home];
      pairings.push({ slot, round, bracket: "main", home, away });
    }
    // rotación del círculo: fijo arr[0], el resto gira
    arr.splice(1, 0, arr.pop()!);
  }
  return pairings;
}

// --------------------------------------------------------------------- liga

/**
 * Liga por temporadas: round robin a `legs` vueltas (por defecto ida y
 * vuelta, con lados invertidos en cada vuelta: cada emparejamiento juega el
 * MISMO número de veces por lado, requisito de T9.4).
 */
export function generateLeague(entrants: Entrant[], opts: { legs?: number } = {}): Pairing[] {
  const legs = opts.legs ?? 2;
  const perLeg = entrants.length % 2 === 0 ? entrants.length - 1 : entrants.length;
  const pairings: Pairing[] = [];
  for (let leg = 0; leg < legs; leg++) {
    pairings.push(
      ...generateRoundRobin(entrants, {
        startRound: leg * perLeg + 1,
        swapSides: leg % 2 === 1,
        slotPrefix: `L${leg + 1}`,
      }),
    );
  }
  return pairings;
}

// ------------------------------------------------------------- eliminatorias

/** Posiciones clásicas de sembrado: el 1 y el 2 solo pueden verse en la final. */
export function seedPositions(bracketSize: number): number[] {
  let r = [1, 2];
  while (r.length < bracketSize) {
    const next: number[] = [];
    for (const x of r) next.push(x, r.length * 2 + 1 - x);
    r = next;
  }
  return r;
}

/**
 * E9.M anti-colusión: en la primera ronda evita cruces entre bots del MISMO
 * dueño intercambiando visitantes entre mesas, si es posible sin dejar otro
 * cruce del mismo dueño (mejor esfuerzo; el dueño queda registrado en el
 * emparejamiento en cualquier caso).
 */
function avoidSameOwnerRound1(matches: { home: Entrant | null; away: Entrant | null }[]): void {
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (!m.home || !m.away || !m.home.ownerId || m.home.ownerId !== m.away.ownerId) continue;
    for (let j = 0; j < matches.length; j++) {
      if (j === i) continue;
      const other = matches[j];
      if (!other.away || !m.away) continue;
      const swapOkThere = !other.home?.ownerId || other.home.ownerId !== m.away.ownerId;
      const swapOkHere = !m.home.ownerId || m.home.ownerId !== other.away.ownerId;
      if (swapOkThere && swapOkHere) {
        const tmp = other.away;
        other.away = m.away;
        m.away = tmp;
        break;
      }
    }
  }
}

/** Eliminatoria simple con sembrado clásico y byes hacia la potencia de 2 superior. */
export function generateSingleElimination(entrants: Entrant[]): Pairing[] {
  if (entrants.length < 2) throw new Error("eliminatoria: hacen falta al menos 2 participantes");
  const bySeed = [...entrants].sort((a, b) => a.seed - b.seed);
  const size = 2 ** Math.ceil(Math.log2(bySeed.length));
  const positions = seedPositions(size);
  const roundsTotal = Math.log2(size);

  const r1: { home: Entrant | null; away: Entrant | null }[] = [];
  for (let m = 0; m < size / 2; m++) {
    const homeSeed = positions[m * 2];
    const awaySeed = positions[m * 2 + 1];
    r1.push({ home: bySeed[homeSeed - 1] ?? null, away: bySeed[awaySeed - 1] ?? null });
  }
  avoidSameOwnerRound1(r1);

  const pairings: Pairing[] = [];
  for (let m = 0; m < r1.length; m++) {
    const { home, away } = r1[m];
    pairings.push({
      slot: `W1M${m + 1}`,
      round: 1,
      bracket: "winners",
      home: home?.id ?? away?.id ?? null,
      away: home && away ? away.id : null,
      bye: !(home && away),
      final: roundsTotal === 1,
    });
  }
  for (let r = 2; r <= roundsTotal; r++) {
    const matches = size / 2 ** r;
    for (let m = 0; m < matches; m++) {
      pairings.push({
        slot: `W${r}M${m + 1}`,
        round: r,
        bracket: "winners",
        home: null,
        away: null,
        homeSource: { slot: `W${r - 1}M${m * 2 + 1}`, take: "winner" },
        awaySource: { slot: `W${r - 1}M${m * 2 + 2}`, take: "winner" },
        final: r === roundsTotal,
      });
    }
  }
  return pairings;
}

/**
 * Doble eliminación: bracket de ganadores (W) + bracket de perdedores (L) +
 * gran final. Nadie queda fuera con UNA sola derrota: cada perdedor de W cae
 * a un slot concreto de L (propiedad verificada con fast-check). El bracket L
 * alterna rondas de caída (ganadores de L contra recién caídos de W) y rondas
 * internas (ganadores de L entre sí), estructura estándar.
 */
export function generateDoubleElimination(entrants: Entrant[]): Pairing[] {
  const winners = generateSingleElimination(entrants).map((p) => ({ ...p, final: false }));
  const size = 2 ** Math.ceil(Math.log2(entrants.length));
  const k = Math.log2(size);
  if (k < 2) {
    // Con 2 participantes no hay bracket de perdedores: revancha directa
    // (y bracket reset si el que venía invicto pierde la revancha).
    const [w1] = winners;
    return [
      w1,
      {
        slot: "GF",
        round: 2,
        bracket: "grand_final",
        home: null,
        away: null,
        homeSource: { slot: w1.slot, take: "winner" },
        awaySource: { slot: w1.slot, take: "loser" },
      },
      {
        slot: "GF2",
        round: 3,
        bracket: "grand_final",
        home: null,
        away: null,
        homeSource: { slot: "GF", take: "winner" },
        awaySource: { slot: "GF", take: "loser" },
        conditionalOn: w1.slot,
        final: true,
      },
    ];
  }

  const pairings: Pairing[] = [...winners];
  let lbRound = 1;
  // L1: los perdedores de W1 se emparejan entre sí.
  let prev: string[] = [];
  const w1Count = size / 2;
  for (let m = 0; m < w1Count / 2; m++) {
    const slot = `L1M${m + 1}`;
    pairings.push({
      slot,
      round: 1,
      bracket: "losers",
      home: null,
      away: null,
      homeSource: { slot: `W1M${m * 2 + 1}`, take: "loser" },
      awaySource: { slot: `W1M${m * 2 + 2}`, take: "loser" },
    });
    prev.push(slot);
  }
  // Rondas de caída e internas alternadas.
  for (let wr = 2; wr <= k; wr++) {
    lbRound++;
    const droppers = size / 2 ** wr; // perdedores de W en la ronda wr
    const drop: string[] = [];
    for (let m = 0; m < droppers; m++) {
      const slot = `L${lbRound}M${m + 1}`;
      pairings.push({
        slot,
        round: lbRound,
        bracket: "losers",
        home: null,
        away: null,
        homeSource: { slot: prev[m], take: "winner" },
        awaySource: { slot: `W${wr}M${m + 1}`, take: "loser" },
      });
      drop.push(slot);
    }
    prev = drop;
    if (wr < k) {
      lbRound++;
      const internal: string[] = [];
      for (let m = 0; m < prev.length / 2; m++) {
        const slot = `L${lbRound}M${m + 1}`;
        pairings.push({
          slot,
          round: lbRound,
          bracket: "losers",
          home: null,
          away: null,
          homeSource: { slot: prev[m * 2], take: "winner" },
          awaySource: { slot: prev[m * 2 + 1], take: "winner" },
        });
        internal.push(slot);
      }
      prev = internal;
    }
  }
  // Gran final: ganador de W contra superviviente de L, con bracket reset
  // (GF2) si el invicto pierde la GF: nadie queda fuera con UNA sola derrota.
  pairings.push({
    slot: "GF",
    round: k + lbRound + 1,
    bracket: "grand_final",
    home: null,
    away: null,
    homeSource: { slot: `W${k}M1`, take: "winner" },
    awaySource: { slot: prev[0], take: "winner" },
  });
  pairings.push({
    slot: "GF2",
    round: k + lbRound + 2,
    bracket: "grand_final",
    home: null,
    away: null,
    homeSource: { slot: "GF", take: "winner" },
    awaySource: { slot: "GF", take: "loser" },
    conditionalOn: `W${k}M1`,
    final: true,
  });
  return pairings;
}

// -------------------------------------------------------------------- suizo

export interface SwissStanding {
  id: string;
  points: number;
  /** Para desempates; el generador ordena por puntos y luego seed. */
  seed: number;
  hadBye?: boolean;
}

export function recommendedSwissRounds(n: number): number {
  return Math.max(1, Math.ceil(Math.log2(Math.max(2, n))));
}

/**
 * Una ronda suiza: empareja por puntuación (adyacentes tras ordenar por
 * puntos, luego seed) EVITANDO repetir rival mientras sea evitable
 * (backtracking completo: si existe un emparejamiento sin repeticiones, lo
 * encuentra; solo si es inevitable permite repetir). Con n impar, bye para el
 * peor clasificado que aún no descansó.
 */
export function generateSwissRound(standings: SwissStanding[], played: ReadonlySet<string>, round: number): Pairing[] {
  const ordered = [...standings].sort((a, b) => b.points - a.points || a.seed - b.seed);
  let byeId: string | null = null;
  let field = ordered;
  if (ordered.length % 2 === 1) {
    const candidate = [...ordered].reverse().find((s) => !s.hadBye) ?? ordered[ordered.length - 1];
    byeId = candidate.id;
    field = ordered.filter((s) => s.id !== byeId);
  }

  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const result: [string, string][] = [];

  function backtrack(pool: SwissStanding[], allowRepeats: boolean): boolean {
    if (pool.length === 0) return true;
    const [first, ...rest] = pool;
    for (let i = 0; i < rest.length; i++) {
      const rival = rest[i];
      if (!allowRepeats && played.has(pairKey(first.id, rival.id))) continue;
      result.push([first.id, rival.id]);
      if (
        backtrack(
          rest.filter((_, j) => j !== i),
          allowRepeats,
        )
      )
        return true;
      result.pop();
    }
    return false;
  }

  if (!backtrack(field, false)) {
    result.length = 0;
    if (!backtrack(field, true)) throw new Error("suizo: imposible emparejar la ronda");
  }

  const pairings: Pairing[] = result.map(([a, b], i) => ({
    slot: `S${round}M${i + 1}`,
    round,
    bracket: "main" as const,
    // Alternancia de lados por mesa y ronda (T9.4).
    home: (round + i) % 2 === 0 ? b : a,
    away: (round + i) % 2 === 0 ? a : b,
  }));
  if (byeId) {
    pairings.push({ slot: `S${round}BYE`, round, bracket: "main", home: byeId, away: null, bye: true });
  }
  return pairings;
}

// ------------------------------------------------------------------- equipos

export interface TeamEntry {
  teamId: string;
  /** Plantilla: varios bots por equipo (formato por equipos del cap. 19). */
  roster: string[];
}

/**
 * Torneo por equipos: liguilla round robin entre equipos; cada emparejamiento
 * es una serie por equipos (modo team_deathmatch) con las plantillas completas
 * de ambos. home/away son teamIds; el scheduler expande las plantillas a
 * participantes de batalla.
 */
export function generateTeams(teams: TeamEntry[]): Pairing[] {
  const entrants: Entrant[] = teams.map((t, i) => ({ id: t.teamId, seed: i + 1 }));
  return generateRoundRobin(entrants, { slotPrefix: "T" });
}

// -------------------------------------------------------------- utilidades

export type TournamentFormat =
  "league" | "round_robin" | "single_elimination" | "double_elimination" | "swiss" | "teams";

/**
 * Calendario inicial de un formato individual. El suizo solo genera su
 * PRIMERA ronda (las siguientes dependen de resultados: las materializa
 * process_result); las eliminatorias generan la estructura completa con
 * slots dependientes. El formato de equipos usa generateTeams (plantillas).
 */
export function generateInitialSchedule(format: Exclude<TournamentFormat, "teams">, entrants: Entrant[]): Pairing[] {
  switch (format) {
    case "league":
      return generateLeague(entrants);
    case "round_robin":
      return generateRoundRobin(entrants);
    case "single_elimination":
      return generateSingleElimination(entrants);
    case "double_elimination":
      return generateDoubleElimination(entrants);
    case "swiss":
      return generateSwissRound(
        entrants.map((e) => ({ id: e.id, points: 0, seed: e.seed })),
        new Set(),
        1,
      );
  }
}
