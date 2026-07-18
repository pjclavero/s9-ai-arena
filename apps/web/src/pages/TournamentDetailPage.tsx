/**
 * R3.7 (ERR-VIS-02) · Seguir un torneo: detalle, inscripción, cola, batallas en
 * curso (enlace al directo), cuadro visual por rondas e historial (enlace al
 * replay) — todo por enlaces, sin teclear UUIDs. El feed de batallas se
 * refresca en silencio cada 5 s y los cambios se anuncian (aria-live).
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type Me } from "../api.js";
import { useResource, ResourceView, type Resource } from "../resource.js";
import type { Tournament } from "./TournamentsPage.js";

export interface TournamentBattle {
  id: string;
  status: string;
  round: number;
  mode: string;
  participants: { botId: string; version: number; team?: string; outcome?: string }[];
  result?: unknown;
}

interface OwnBot {
  id: string;
  name: string;
  latestPublishedVersion?: number;
}

const POLL_MS = 5000;

function battleLabel(b: TournamentBattle): string {
  const names = b.participants.map((p) => `${p.botId.slice(0, 8)} v${p.version}`);
  return names.length > 0 ? names.join(" vs ") : b.id.slice(0, 8);
}

export function BattleLink({ battle }: { battle: TournamentBattle }) {
  if (battle.status === "running") {
    return <a href={`#/viewer/${encodeURIComponent(battle.id)}`}>Ver en directo</a>;
  }
  if (battle.status === "finished") {
    return <a href={`#/replay/${encodeURIComponent(battle.id)}?t=0`}>Ver replay</a>;
  }
  return <span>en cola</span>;
}

export function TournamentDetailPage(props: { id: string; me: Me }) {
  const [detail, reloadDetail] = useResource(
    () => api<Tournament>("GET", `/tournaments/${encodeURIComponent(props.id)}`),
    [props.id],
  );

  // Feed de batallas con refresco SILENCIOSO: la primera carga muestra estado,
  // los sondeos posteriores no vuelven a "Cargando…" ni borran datos si fallan.
  const [battles, setBattles] = useState<Resource<TournamentBattle[]>>({ status: "loading" });
  const loadBattles = useCallback(
    async (silent: boolean) => {
      if (!silent) setBattles({ status: "loading" });
      try {
        const page = await api<{ items: TournamentBattle[] }>(
          "GET",
          `/tournaments/${encodeURIComponent(props.id)}/battles`,
        );
        setBattles({ status: "ready", data: page.items });
      } catch (e) {
        if (!silent) setBattles({ status: "error", message: (e as Error).message ?? "error desconocido" });
      }
    },
    [props.id],
  );
  useEffect(() => {
    void loadBattles(false);
    const timer = setInterval(() => void loadBattles(true), POLL_MS);
    return () => clearInterval(timer);
  }, [loadBattles]);

  // Inscripción de un bot propio (versión publicada); la API valida y autoriza.
  const [ownBots] = useResource(
    () => api<{ items: OwnBot[] }>("GET", `/bots?ownerId=${encodeURIComponent(props.me.id)}`),
    [props.me.id],
  );
  const [entryBot, setEntryBot] = useState("");
  const [entryMsg, setEntryMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function onEnter(e: FormEvent) {
    e.preventDefault();
    setEntryMsg(null);
    const bot = ownBots.status === "ready" ? ownBots.data.items.find((b) => b.id === entryBot) : undefined;
    if (!bot) {
      setEntryMsg({ kind: "error", text: "Elige un bot" });
      return;
    }
    if (!bot.latestPublishedVersion) {
      setEntryMsg({ kind: "error", text: "Ese bot no tiene ninguna versión publicada" });
      return;
    }
    try {
      await api("POST", `/tournaments/${encodeURIComponent(props.id)}/entries`, {
        botId: bot.id,
        version: bot.latestPublishedVersion,
      });
      setEntryMsg({ kind: "ok", text: `${bot.name} inscrito (v${bot.latestPublishedVersion})` });
      reloadDetail();
    } catch (err) {
      setEntryMsg({ kind: "error", text: (err as Error).message || "no se pudo inscribir" });
    }
  }

  async function onCloseEntries() {
    setEntryMsg(null);
    try {
      await api("POST", `/tournaments/${encodeURIComponent(props.id)}/actions/close-entries`, {});
      setEntryMsg({ kind: "ok", text: "Inscripciones cerradas: versiones congeladas y semillas reveladas" });
      reloadDetail();
    } catch (err) {
      setEntryMsg({ kind: "error", text: (err as Error).message || "no se pudo cerrar inscripciones" });
    }
  }

  return (
    <div>
      <p>
        <a href="#/tournaments">← Todos los torneos</a>
      </p>
      <div className="card">
        <ResourceView resource={detail} label="el torneo" onRetry={reloadDetail}>
          {(t) => (
            <>
              <h2>{t.name}</h2>
              <p>
                {t.format} · {t.mode} · estado <strong data-testid="tournament-state">{t.state}</strong> ·{" "}
                {t.entryCount ?? 0} inscritos
              </p>
              {t.state === "open" && (
                <form onSubmit={onEnter}>
                  <label>
                    Inscribir bot{" "}
                    <select aria-label="bot a inscribir" value={entryBot} onChange={(e) => setEntryBot(e.target.value)}>
                      <option value="">— elige un bot —</option>
                      {ownBots.status === "ready" &&
                        ownBots.data.items.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                            {b.latestPublishedVersion ? ` (v${b.latestPublishedVersion})` : " (sin publicar)"}
                          </option>
                        ))}
                    </select>
                  </label>{" "}
                  <button type="submit">Inscribir</button>{" "}
                  <button type="button" onClick={onCloseEntries}>
                    Cerrar inscripciones
                  </button>
                </form>
              )}
              {entryMsg && (
                <p
                  className={entryMsg.kind === "ok" ? "ok" : "error"}
                  role={entryMsg.kind === "ok" ? "status" : "alert"}
                >
                  {entryMsg.text}
                </p>
              )}
            </>
          )}
        </ResourceView>
      </div>

      <div className="card">
        <h3>Batallas</h3>
        {battles.status === "loading" && (
          <p role="status" aria-live="polite">
            Cargando las batallas…
          </p>
        )}
        {battles.status === "error" && (
          <div role="alert">
            <p className="error">No se pudieron cargar las batallas: {battles.message}</p>
            <button type="button" onClick={() => void loadBattles(false)}>
              Reintentar
            </button>
          </div>
        )}
        {battles.status === "ready" && <BattlesBoard battles={battles.data} />}
      </div>
    </div>
  );
}

/** Cola + en curso + cuadro por rondas + historial, todo con enlaces. */
export function BattlesBoard({ battles }: { battles: TournamentBattle[] }) {
  const queued = battles.filter((b) => b.status === "scheduled" || b.status === "queued");
  const running = battles.filter((b) => b.status === "running");
  const finished = battles.filter((b) => b.status === "finished");
  const failed = battles.filter((b) => !["scheduled", "queued", "running", "finished"].includes(b.status));
  const rounds = [...new Set(battles.map((b) => b.round))].sort((a, b) => a - b);

  return (
    <div>
      {/* Los cambios de estado (nueva batalla en curso, resultado…) se anuncian. */}
      <div aria-live="polite" data-testid="battle-feed">
        <p>
          {running.length} en curso · {queued.length} en cola · {finished.length} terminadas
          {failed.length > 0 ? ` · ${failed.length} con incidencias` : ""}
        </p>
        {running.length > 0 && (
          <ul data-testid="running-battles">
            {running.map((b) => (
              <li key={b.id}>
                {battleLabel(b)} — <BattleLink battle={b} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {battles.length === 0 ? (
        <p>Aún no hay batallas: se generan al cerrar las inscripciones.</p>
      ) : (
        <>
          <h4>Cuadro</h4>
          <div className="bracket" data-testid="bracket">
            {rounds.map((round) => (
              <section key={round} className="round" aria-label={`Ronda ${round}`}>
                <h5>Ronda {round}</h5>
                <ul>
                  {battles
                    .filter((b) => b.round === round)
                    .map((b) => (
                      <li key={b.id}>
                        {battleLabel(b)}
                        <br />
                        <small>
                          {b.status} — <BattleLink battle={b} />
                        </small>
                      </li>
                    ))}
                </ul>
              </section>
            ))}
          </div>

          {finished.length > 0 && (
            <>
              <h4>Historial</h4>
              <ul data-testid="finished-battles">
                {finished.map((b) => (
                  <li key={b.id}>
                    {battleLabel(b)} — <BattleLink battle={b} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
