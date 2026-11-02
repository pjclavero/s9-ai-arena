/**
 * N6 (entrega A) · Página pública #/ranking: pinta GET /standings?mode=<modo>
 * (contrato getStandings, security: [], x-min-role: visitor — sin cuenta).
 * Sigue el patrón de recurso de R3.7 (ERR-VIS-10) usado por BracketPage y
 * LivePage: un fallo de carga se ANUNCIA (role="alert") con reintento, nunca
 * como lista vacía; una clasificación vacía dice por qué. SIN botones de
 * acción/mutación: página de SOLO LECTURA.
 *
 * R16: EmptyState adopta la primitiva de ui/primitives.tsx. El data-testid se
 * preserva en el elemento raíz del componente para que los tests existentes
 * sigan encontrándolo.
 */
import { useState } from "react";
import { api } from "../api.js";
import { useResource, ResourceView } from "../resource.js";
import { EmptyState } from "../ui/primitives.js";
import { MODE_NAME } from "../battle-result.js";
import { ModeHelpTip } from "../help/sections/rules.js";
import { RANKING_EMPTY_LINES, RatingTip, VdeTip } from "../help/sections/tournaments.js";

export interface Standing {
  rank: number;
  /** UX-F (DEF-R3) · null = bot privado que no puedes identificar (botName «Bot privado»). */
  botId: string | null;
  botName: string;
  rating: number;
  wins: number;
  losses: number;
  draws: number;
}

// UX-R · las etiquetas viven en battle-result.ts (MODE_NAME) para que crear
// batalla y torneos digan lo mismo que el ranking.
const MODES = Object.entries(MODE_NAME).map(([value, label]) => ({ value, label }));

export function RankingPage() {
  const [mode, setMode] = useState<string>("deathmatch");
  const [res, reload] = useResource<Standing[]>(
    () => api<Standing[]>("GET", `/standings?mode=${encodeURIComponent(mode)}`),
    [mode],
  );

  return (
    <section>
      <h2>Clasificación</h2>
      <p>
        <label>
          Modo:{" "}
          <select data-testid="ranking-mode" value={mode} onChange={(e) => setMode(e.target.value)}>
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <ModeHelpTip mode={mode} />
      </p>
      <ResourceView resource={res} label="la clasificación" onRetry={reload}>
        {(standings) =>
          standings.length === 0 ? (
            <EmptyState
              message={RANKING_EMPTY_LINES[0]}
              data-testid="ranking-empty"
              action={RANKING_EMPTY_LINES.slice(1).map((l) => (
                <p key={l}>{l}</p>
              ))}
            />
          ) : (
            <table className="stack-table" data-testid="ranking-table">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Bot</th>
                  <th scope="col">
                    Rating
                    <RatingTip testId="ranking-help-rating" />
                  </th>
                  <th scope="col">
                    V-D-E
                    <VdeTip testId="ranking-help-vde" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {standings.map((s) => (
                  <tr key={s.botId ?? `privado-${s.rank}`} data-testid="ranking-row">
                    <td data-label="#">{s.rank}</td>
                    <td data-label="Bot">{s.botName}</td>
                    {/* data-label a mano: el encabezado lleva el ⓘ (y su panel) dentro. */}
                    <td data-label="Rating">{s.rating}</td>
                    <td data-label="V-D-E">
                      {s.wins}-{s.losses}-{s.draws}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </ResourceView>
    </section>
  );
}
