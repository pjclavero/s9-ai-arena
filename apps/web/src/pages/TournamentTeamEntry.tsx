/**
 * #287 · «Inscribir equipo» en un torneo `teams` con reglas NvN: elegir equipo → ver el
 * roster con la versión de cada bot → validar todos → UNA petición atómica
 * (POST /tournaments/{id}/team-entries). La regla de qué se puede inscribir es la de
 * `teamRosterPlan` (tournament-entry.ts), espejo de la API; la API es la autoridad.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api } from "../api.js";
import {
  FROZEN_LABEL,
  entryVersionLabel,
  teamRosterPlan,
  tournamentEntryChoices,
  type EntryVersion,
  type RosterVersions,
  type TeamRosterBot,
} from "../tournament-entry.js";

interface TeamItem {
  id: string;
  name: string;
  isMember?: boolean;
  bots?: TeamRosterBot[];
}

export function TournamentTeamEntry(props: {
  tournamentId: string;
  teamSize: number;
  onEntered: () => void;
  onMessage: (m: { kind: "ok" | "error"; text: string } | null) => void;
}) {
  const [teams, setTeams] = useState<TeamItem[] | "loading" | "error">("loading");
  const [teamId, setTeamId] = useState("");
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [versions, setVersions] = useState<Map<string, RosterVersions>>(new Map());
  const [chosen, setChosen] = useState<Map<string, number>>(new Map());
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let alive = true;
    api<{ items: TeamItem[] }>("GET", "/teams?limit=100").then(
      (page) => alive && setTeams((page?.items ?? []).filter((t) => t.isMember)),
      () => alive && setTeams("error"),
    );
    return () => {
      alive = false;
    };
  }, []);

  const team = Array.isArray(teams) ? teams.find((t) => t.id === teamId) : undefined;
  const bots = useMemo(() => team?.bots ?? [], [team]);

  // Al elegir equipo: se proponen los primeros N bots PROPIOS y se cargan sus versiones.
  useEffect(() => {
    setChosen(new Map());
    setIncluded(
      new Set(
        bots
          .filter((b) => b.mine)
          .slice(0, props.teamSize)
          .map((b) => b.id),
      ),
    );
    const mine = bots.filter((b) => b.mine);
    setVersions(new Map(mine.map((b) => [b.id, "loading" as const])));
    let alive = true;
    for (const b of mine) {
      api<EntryVersion[]>("GET", `/bots/${encodeURIComponent(b.id)}/versions`).then(
        (items) => {
          if (!alive) return;
          setVersions((m) => new Map(m).set(b.id, Array.isArray(items) ? items : "error"));
        },
        () => alive && setVersions((m) => new Map(m).set(b.id, "error")),
      );
    }
    return () => {
      alive = false;
    };
  }, [bots, props.teamSize]);

  const plan = teamRosterPlan({ teamSize: props.teamSize, bots, included, versions, chosen });

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    props.onMessage(null);
    if (!team || !plan.canSubmit) return;
    setSending(true);
    try {
      await api("POST", `/tournaments/${encodeURIComponent(props.tournamentId)}/team-entries`, {
        teamId: team.id,
        members: plan.members,
      });
      props.onMessage({ kind: "ok", text: `Equipo ${team.name} inscrito (${plan.members.length} bots)` });
      props.onEntered();
    } catch (err) {
      props.onMessage({ kind: "error", text: (err as Error).message || "no se pudo inscribir el equipo" });
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} data-testid="team-entry-form">
      <p>
        Tamaño: {props.teamSize} vs {props.teamSize}. Se inscribe el equipo completo: o entran todos sus bots o ninguno.
      </p>
      <label>
        Inscribir equipo{" "}
        <select aria-label="equipo a inscribir" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
          <option value="">— elige un equipo —</option>
          {Array.isArray(teams) &&
            teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
        </select>
      </label>
      {teams === "error" && <p className="error">No se pudieron cargar tus equipos.</p>}
      {Array.isArray(teams) && teams.length === 0 && (
        <p className="muted" data-testid="team-entry-no-teams">
          No eres miembro de ningún equipo.
        </p>
      )}
      {team && (
        <ul data-testid="team-roster">
          {plan.rows.map((r) => {
            const vs = versions.get(r.botId);
            const choices = Array.isArray(vs) ? tournamentEntryChoices(vs) : null;
            return (
              <li key={r.botId} data-testid={`roster-${r.botId}`} data-ok={r.included && !r.problem ? "1" : "0"}>
                <label>
                  <input
                    type="checkbox"
                    aria-label={`incluir ${r.name}`}
                    checked={r.included}
                    onChange={(e) =>
                      setIncluded((s) => {
                        const n = new Set(s);
                        if (e.target.checked) n.add(r.botId);
                        else n.delete(r.botId);
                        return n;
                      })
                    }
                  />{" "}
                  {r.included && !r.problem ? "✓ " : ""}
                  {r.name}
                </label>{" "}
                {choices && choices.selectable.length > 0 && (
                  <select
                    aria-label={`versión de ${r.name}`}
                    value={String(r.version ?? choices.defaultVersion ?? "")}
                    onChange={(e) => setChosen((m) => new Map(m).set(r.botId, Number(e.target.value)))}
                  >
                    {choices.selectable.map((v) => (
                      <option key={v.version} value={String(v.version)}>
                        {entryVersionLabel(v)}
                      </option>
                    ))}
                  </select>
                )}
                {r.included && r.frozen && <small className="muted"> {FROZEN_LABEL}</small>}
                {r.included && r.problem && (
                  <small className="error" data-testid={`roster-problem-${r.botId}`}>
                    {" "}
                    {r.problem}
                  </small>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {team && plan.reason && (
        <p className="warn" data-testid="team-entry-reason">
          {plan.reason}
        </p>
      )}
      <button type="submit" disabled={!team || !plan.canSubmit || sending}>
        Inscribir equipo
      </button>
    </form>
  );
}
