/**
 * EQ3 · Ayuda de TORNEOS y RANKING. Verificado contra el código (main a1a6c4e):
 *  - Elo con rating inicial 1000 y K=24 por defecto, configurable por torneo
 *    (apps/tournament-worker/src/ratings.ts: INITIAL_RATING, DEFAULT_K);
 *  - sólo puntúan batallas `official`: las crea el planificador de torneos
 *    (scheduler.ts, official: true); «Nueva batalla» las crea con official: false
 *    (apps/api/src/routes/battles.ts);
 *  - rating por bot, temporada y MODO (ratings.mode): un ranking por modo;
 *  - V-D-E (columna de /standings) sale de leagueTable (results.ts): cuenta
 *    ENFRENTAMIENTOS del torneo (no batallas), un bye cuenta como victoria y un
 *    enfrentamiento sin ganador es empate; la posición (#) es la de esa tabla
 *    (3 puntos por victoria, 1 por empate), no el rating. «Descalificación =
 *    derrota» es del Elo (ratings.ts outcomeScore), no de V-D-E (EQ6, #210).
 */
import { MODE_NAME, TOURNAMENT_FORMAT_NAME } from "../../battle-result.js";
import { InfoTip } from "../InfoTip.js";
import { helpHref } from "../tree.js";

/** Texto del estado vacío del ranking (encargo EQ3). Lo usa RankingPage cuando EQ4 lo integre. */
export const RANKING_EMPTY_LINES = [
  "Todavía no hay clasificación oficial para este modo.",
  "La clasificación sólo incluye batallas oficiales de torneo.",
  "Las batallas creadas mediante «Nueva batalla» no modifican el rating.",
] as const;

/** Valores del rating, copiados de ratings.ts (no importable en el navegador); el test los compara. */
export const RATING_FACTS = { initial: 1000, defaultK: 24 } as const;

/**
 * EQ4 · ⓘ de las columnas del ranking: UNA sola fuente para la Ayuda y para
 * RankingPage (antes cada uno tenía su texto). `testId` permite distinguirlos.
 */
export function RatingTip(props: { testId?: string }) {
  return (
    <InfoTip topic="Rating" testId={props.testId ?? "tip-rating"}>
      Todos los bots empiezan con {RATING_FACTS.initial}. Se calcula por cada batalla oficial: ganar a un rival con más
      rating sube más que ganar a uno con menos, y perder resta lo mismo que gana el rival. Para el rating, una
      descalificación cuenta como derrota.
    </InfoTip>
  );
}

export function VdeTip(props: { testId?: string }) {
  return (
    <InfoTip topic="V-D-E" testId={props.testId ?? "tip-vde"}>
      Victorias - Derrotas - Empates en los enfrentamientos de los torneos de la temporada en este modo (un
      enfrentamiento puede tener varias batallas). Pasar una ronda sin rival (bye) cuenta como victoria; un
      enfrentamiento sin ganador, como empate.
    </InfoTip>
  );
}

export function RankingEmptyState() {
  return (
    <div role="status" data-testid="ranking-empty-help">
      {RANKING_EMPTY_LINES.map((l) => (
        <p key={l}>{l}</p>
      ))}
    </div>
  );
}

export function TournamentsHelp() {
  return (
    <div data-testid="help-tournaments">
      <p>
        Un torneo enfrenta a los bots inscritos según un formato. Sus batallas son <strong>oficiales</strong>: son las
        únicas que cambian el rating.
      </p>
      <h4>Formatos</h4>
      <ul data-testid="help-tournament-formats">
        {Object.entries(TOURNAMENT_FORMAT_NAME).map(([id, name]) => (
          <li key={id}>
            {name} <code>{id}</code>
          </li>
        ))}
      </ul>
      <h4>Cómo funciona</h4>
      <ol>
        <li>
          Un organizador (rol «organizer») crea el torneo con su formato y su modo; nace con inscripciones abiertas.
        </li>
        <li>El dueño de cada bot lo inscribe con una de sus versiones publicadas y elegibles (con su loadout).</li>
        <li>
          Al cerrar las inscripciones, las versiones inscritas quedan <strong>congeladas</strong>, se genera el
          calendario y la plataforma juega las batallas sola.
        </li>
        <li>Cada batalla terminada actualiza el rating de sus bots en el ranking de ese modo.</li>
      </ol>
      <p>
        Ver <a href={helpHref("torneos", "ranking")}>Ranking</a>.
      </p>
    </div>
  );
}

export function RankingHelp() {
  return (
    <div data-testid="help-ranking">
      <ul data-testid="help-ranking-facts">
        <li>
          El <strong>rating</strong> es un Elo <RatingTip /> con valor inicial <strong>{RATING_FACTS.initial}</strong>{" "}
          (factor K {RATING_FACTS.defaultK} por defecto; un torneo puede fijar el suyo). Para el rating, una
          descalificación cuenta como derrota.
        </li>
        <li>
          <strong>Sólo las batallas oficiales de torneo</strong> afectan al rating. Las batallas creadas con «Nueva
          batalla» son de práctica y no lo cambian.
        </li>
        <li>
          <strong>V-D-E</strong> <VdeTip /> significa Victorias - Derrotas - Empates, contados por enfrentamientos (no
          por batallas) y sumados en todos los torneos de la temporada en ese modo. La posición (#) es la de esa suma (3
          puntos por victoria y 1 por empate), no el rating. Un enfrentamiento detenido por límite técnico no cuenta.
        </li>
        <li>
          <strong>Cada modo tiene su ranking independiente</strong> ({Object.values(MODE_NAME).join(", ")}): un bot
          tiene un rating distinto en cada modo, y por temporada.
        </li>
        <li>
          En batallas por equipos el rating se reparte por parejas de rivales: la suma de lo que se gana y se pierde es
          cero.
        </li>
      </ul>
      <h4>Cuando todavía no hay datos</h4>
      <p>El ranking de un modo sin batallas oficiales dice:</p>
      <blockquote>
        <RankingEmptyState />
      </blockquote>
    </div>
  );
}
