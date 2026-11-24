/**
 * R3.7 (ERR-VIS-02) · Torneos en el panel: listado, creación (la API autoriza,
 * la UI solo envía) y enlace al detalle para seguirlos sin teclear UUIDs.
 * Formularios con onSubmit (Enter funciona) y errores anunciados (role="alert").
 */
import { useState, type FormEvent } from "react";
import { api, type Me } from "../api.js";
import { useResource, ResourceView } from "../resource.js";
import { TOURNAMENT_FORMAT_NAME, TOURNAMENT_STATE_NAME, labelOf, modeName } from "../battle-result.js";

export interface Tournament {
  id: string;
  name: string;
  format: string;
  mode: string;
  state: string;
  entryCount?: number;
  /** VISIBILIDAD · el torneo autoriza su retransmisión pública (fijado al crearlo). */
  broadcast?: boolean;
  /** V1 · INVITACIÓN · modalidad de inscripción; NO cambia la visibilidad (todo torneo se lista). */
  enrollment?: "open" | "invitation";
  /** ADR-022 · copia de reglas; #287 usa `params.teamSize` (torneos por equipos NvN). */
  rules?: { params?: { teamSize?: number } | null } | null;
  /** #291 · quien pregunta es quien lo creó o staff (lo calcula la API en el detalle). */
  viewerCanManage?: boolean;
}

// UX-R · los valores son los de la API; lo que se ENSEÑA son sus nombres.
const FORMATS = Object.keys(TOURNAMENT_FORMAT_NAME);
/** B3 (V1, D-OP-9) · Modos que se pueden elegir al CREAR un torneo: Captura la bandera y Control de zona
 *  quedan fuera (la API responde 400 `tournament_mode_not_allowed`). Espejo de TOURNAMENT_ALLOWED_MODES
 *  (apps/tournament-worker/src/tournament-modes.ts); un test de deriva los compara. Los torneos antiguos con
 *  esos modos se siguen LISTANDO con su nombre (modeName), sólo no se ofrecen para crear. */
export const TOURNAMENT_CREATE_MODES = ["deathmatch", "team_deathmatch"];
const MODES = TOURNAMENT_CREATE_MODES;
/** V1-T1 · Los torneos «Por equipos» sólo se pueden crear con reglas NvN (preset `team_deathmatch`):
 *  la API rechaza CTF en torneos y, sin preset, el torneo nace sin tamaño de equipo, no se monta
 *  «Inscribir equipo» y los equipos no se pueden seleccionar. */
export const TEAM_TOURNAMENT_MODE = "team_deathmatch";

export function TournamentsPage(_props: { me: Me }) {
  const [list, reload] = useResource(() => api<{ items: Tournament[] }>("GET", "/tournaments"), []);
  const [name, setName] = useState("");
  const [format, setFormat] = useState("single_elimination");
  const [mode, setMode] = useState("deathmatch");
  const [rulesetId, setRulesetId] = useState("mvp-default");
  const [broadcast, setBroadcast] = useState(false);
  // V1 · INVITACIÓN · modalidad de inscripción (por defecto, abierta como hasta ahora).
  const [enrollment, setEnrollment] = useState<"open" | "invitation">("open");
  // #287 · tamaño de equipo de un torneo por equipos de Team Deathmatch (preset `team_deathmatch`).
  const [teamSize, setTeamSize] = useState("4");
  const teamRules = format === "teams" && mode === TEAM_TOURNAMENT_MODE;
  const modeOptions = format === "teams" ? [TEAM_TOURNAMENT_MODE] : MODES;
  function onFormatChange(f: string) {
    setFormat(f);
    // «Por equipos» fija el modo de equipos; al salir de él se vuelve al modo por defecto.
    if (f === "teams") setMode(TEAM_TOURNAMENT_MODE);
    else if (mode === TEAM_TOURNAMENT_MODE && format === "teams") setMode("deathmatch");
  }
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  /**
   * #288 · Cancelar la creación: no envía NADA (ni POST ni estado a medias), limpia el
   * formulario y vuelve al listado.
   */
  function onCancelCreate() {
    setName("");
    setFormat("single_elimination");
    setMode("deathmatch");
    setRulesetId("mvp-default");
    setBroadcast(false);
    setEnrollment("open");
    setError("");
    window.location.hash = "#/tournaments";
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault(); // envío también con Enter (ERR-VIS-10 a11y)
    setError("");
    setCreating(true);
    try {
      const t = await api<Tournament>("POST", "/tournaments", {
        name,
        format,
        mode,
        rulesetId,
        broadcast,
        // V1 · INVITACIÓN · sólo si es por invitación: el alta de un torneo abierto no cambia (la API
        // aplica `open` por defecto).
        ...(enrollment === "invitation" ? { enrollment } : {}),
        ...(teamRules ? { rules: { preset: "team_deathmatch", teamSize: Number(teamSize) } } : {}),
      });
      setName("");
      reload();
      window.location.hash = `#/tournaments/${t.id}`;
    } catch (err) {
      setError((err as Error).message || "no se pudo crear el torneo");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <div className="card">
        <h2>Torneos</h2>
        <ResourceView resource={list} label="los torneos" onRetry={reload}>
          {(page) =>
            page.items.length === 0 ? (
              <p>No hay torneos todavía.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Nombre</th>
                    <th>Formato</th>
                    <th>Modo</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <a href={`#/tournaments/${t.id}`}>{t.name}</a>
                      </td>
                      <td>{labelOf(TOURNAMENT_FORMAT_NAME, t.format)}</td>
                      <td>{modeName(t.mode)}</td>
                      <td>
                        {labelOf(TOURNAMENT_STATE_NAME, t.state)}
                        {t.broadcast ? " · retransmisión pública" : ""}
                        {t.enrollment === "invitation" ? " · por invitación" : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          }
        </ResourceView>
      </div>

      <div className="card">
        <h3>Crear torneo</h3>
        {/* La UI no oculta el formulario por rol: la autorización real es de la API (cap. 16). */}
        <form onSubmit={onCreate}>
          <p>
            <label>
              Nombre{" "}
              <input aria-label="nombre del torneo" required value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          </p>
          <p>
            <label>
              Formato{" "}
              <select aria-label="formato" value={format} onChange={(e) => onFormatChange(e.target.value)}>
                {FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {labelOf(TOURNAMENT_FORMAT_NAME, f)}
                  </option>
                ))}
              </select>
            </label>{" "}
            <label>
              Modo{" "}
              <select aria-label="modo" value={mode} onChange={(e) => setMode(e.target.value)}>
                {modeOptions.map((m) => (
                  <option key={m} value={m}>
                    {modeName(m)}
                  </option>
                ))}
              </select>
            </label>{" "}
            <label>
              Ruleset <input aria-label="ruleset" value={rulesetId} onChange={(e) => setRulesetId(e.target.value)} />
            </label>
            {teamRules && (
              <>
                {" "}
                <label>
                  Tamaño{" "}
                  <select aria-label="tamaño de equipo" value={teamSize} onChange={(e) => setTeamSize(e.target.value)}>
                    {["2", "3", "4"].map((n) => (
                      <option key={n} value={n}>
                        {n} vs {n}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
          </p>
          <p>
            <label>
              <input
                type="checkbox"
                data-testid="tournament-broadcast"
                checked={broadcast}
                onChange={(e) => setBroadcast(e.target.checked)}
              />{" "}
              Retransmisión pública
            </label>{" "}
            <small>
              Sus batallas se podrán emitir y ver en público con el nombre, la versión, el equipo y el resultado de cada
              bot, también de los privados o de equipo. No cambia la visibilidad de ningún bot ni de su código. No se
              puede cambiar después de crear el torneo.
            </small>
          </p>
          <p>
            <label>
              Inscripción{" "}
              <select
                aria-label="modalidad de inscripción"
                data-testid="tournament-enrollment"
                value={enrollment}
                onChange={(e) => setEnrollment(e.target.value === "invitation" ? "invitation" : "open")}
              >
                <option value="open">Abierta</option>
                <option value="invitation">Por invitación</option>
              </select>
            </label>{" "}
            <small>
              El torneo aparece en el listado en los dos casos. «Por invitación»: sólo se inscribe quien tenga el enlace
              que generes en la ficha del torneo. Se puede cambiar mientras el torneo esté en borrador o abierto.
            </small>
          </p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" disabled={creating} data-testid="create-tournament">
            {creating ? "Creando…" : "Crear torneo"}
          </button>{" "}
          <button type="button" onClick={onCancelCreate} disabled={creating} data-testid="cancel-create-tournament">
            Cancelar
          </button>
        </form>
      </div>
    </div>
  );
}
