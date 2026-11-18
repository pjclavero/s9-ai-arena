/**
 * R3.7 (ERR-VIS-02) · Seguir un torneo: detalle, inscripción, cola, batallas en
 * curso (enlace al directo), cuadro visual por rondas e historial (enlace al
 * replay) — todo por enlaces, sin teclear UUIDs. El feed de batallas se
 * refresca en silencio cada 5 s y los cambios se anuncian (aria-live).
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type Me } from "../api.js";
import { BroadcastButton } from "../broadcast/BroadcastButton.js";
import { useResource, ResourceView, type Resource } from "../resource.js";
import type { Tournament } from "./TournamentsPage.js";
import {
  TOURNAMENT_FORMAT_NAME,
  TOURNAMENT_STATE_NAME,
  botVersionLabel,
  labelOf,
  modeName,
  type ParticipantLike,
} from "../battle-result.js";
import {
  FROZEN_LABEL,
  entryVersionLabel,
  tournamentEntryChoices,
  type EntryChoices,
  type EntryVersion,
} from "../tournament-entry.js";
import { TournamentTeamEntry } from "./TournamentTeamEntry.js";

export interface TournamentBattle {
  id: string;
  status: string;
  round: number;
  mode: string;
  participants: ParticipantLike[];
  result?: unknown;
}

interface OwnBot {
  id: string;
  name: string;
  visibility?: string;
  latestPublishedVersion?: number;
}

/** VISIBILIDAD (§26) · texto ÚNICO para inscribir un bot no público: nunca «hazlo público». */
export function entryPrivacyNote(visibility: string | undefined, broadcast: boolean | undefined): string | null {
  if (visibility === "public" || visibility === undefined) return null;
  const quien = visibility === "team" ? "Este bot es de equipo." : "Este bot es privado.";
  return broadcast
    ? `${quien} Durante las batallas públicas se mostrarán únicamente sus datos de competición; su código seguirá privado.`
    : `${quien} Puede participar igual; sus batallas sólo las verán sus participantes, su equipo y la organización.`;
}

const POLL_MS = 5000;

/** #287 · Tamaño de equipo de un torneo `teams` con reglas NvN (`null`: inscripción bot a bot). */
export function teamSizeOfTournament(t: Tournament): number | null {
  if (t.format !== "teams") return null;
  const n = t.rules?.params?.teamSize;
  return typeof n === "number" && n >= 1 ? n : null;
}

/** #288 · Estados con cancelación (los de la API: sin calendario ni batallas). */
export const CANCELLABLE_STATES = ["draft", "open"];

/** #288 · Por qué un torneo no se puede cancelar en su estado (null = sí se puede). */
export function cancelBlockedReason(state: string): string | null {
  if (CANCELLABLE_STATES.includes(state)) return null;
  if (state === "cancelled") return "Este torneo está cancelado.";
  if (state === "finished") return "Este torneo ya ha terminado: no se puede cancelar.";
  return "Ya no se puede cancelar: las inscripciones están cerradas y el calendario generado o en juego.";
}

/** #288 · Texto de la confirmación: qué pasa al cancelar y qué no. */
export const CANCEL_CONFIRM_TEXT =
  "¿Cancelar el torneo? No se generará calendario ni se jugará ninguna batalla y no se podrá reabrir. " +
  "No se borra nada: las inscripciones y el historial se conservan.";

/** UX-D · por NOMBRE de bot y versión exacta (antes: UUID recortado). */
function battleLabel(b: TournamentBattle): string {
  const names = b.participants.map(botVersionLabel);
  return names.length > 0 ? names.join(" vs ") : "batalla sin participantes";
}

export function BattleLink({ battle }: { battle: TournamentBattle }) {
  if (battle.status === "running") {
    return <a href={`#/viewer/${encodeURIComponent(battle.id)}`}>Ver en directo</a>;
  }
  if (battle.status === "finished") {
    return <a href={`#/replay/${encodeURIComponent(battle.id)}?t=0`}>Ver replay</a>;
  }
  // FC-D: una batalla fallida no está «en cola» (antes se pintaba igual).
  if (battle.status === "failed") return <span className="error">fallida</span>;
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
        if (!silent) setBattles({ status: "error", message: (e as Error).message ?? "error desconocido", error: e });
      }
    },
    [props.id],
  );
  useEffect(() => {
    void loadBattles(false);
    const timer = setInterval(() => void loadBattles(true), POLL_MS);
    return () => clearInterval(timer);
  }, [loadBattles]);

  // Inscripción de un bot propio (versión publicada o congelada y elegible); la API valida y autoriza.
  const [ownBots] = useResource(
    () => api<{ items: OwnBot[] }>("GET", `/bots?ownerId=${encodeURIComponent(props.me.id)}`),
    [props.me.id],
  );
  const [entryBot, setEntryBot] = useState("");
  const [entryMsg, setEntryMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  // FROZEN-REUSE (B8) · versiones del bot elegido: una `frozen` de un torneo anterior se
  // ofrece («Frozen / Inmutable») si es elegible. Si no cargan, se cae a la última
  // publicada del listado (comportamiento anterior) y decide la API.
  const [entryVersions, setEntryVersions] = useState<
    | { botId: string; status: "loading" }
    | { botId: string; status: "error" }
    | { botId: string; status: "ready"; choices: EntryChoices; items: EntryVersion[] }
    | null
  >(null);
  const [entryVersion, setEntryVersion] = useState("");
  useEffect(() => {
    setEntryVersion("");
    if (!entryBot) {
      setEntryVersions(null);
      return;
    }
    let alive = true;
    setEntryVersions({ botId: entryBot, status: "loading" });
    api<EntryVersion[]>("GET", `/bots/${encodeURIComponent(entryBot)}/versions`).then(
      (items) => {
        if (!alive) return;
        if (!Array.isArray(items)) {
          setEntryVersions({ botId: entryBot, status: "error" });
          return;
        }
        const choices = tournamentEntryChoices(items);
        setEntryVersions({ botId: entryBot, status: "ready", choices, items });
        setEntryVersion(choices.defaultVersion != null ? String(choices.defaultVersion) : "");
      },
      () => {
        if (alive) setEntryVersions({ botId: entryBot, status: "error" });
      },
    );
    return () => {
      alive = false;
    };
  }, [entryBot]);
  const readyVersions = entryVersions?.status === "ready" && entryVersions.botId === entryBot ? entryVersions : null;
  const chosenVersion = readyVersions?.items.find((v) => String(v.version) === entryVersion);

  async function onEnter(e: FormEvent) {
    e.preventDefault();
    setEntryMsg(null);
    const bot = ownBots.status === "ready" ? ownBots.data.items.find((b) => b.id === entryBot) : undefined;
    if (!bot) {
      setEntryMsg({ kind: "error", text: "Elige un bot" });
      return;
    }
    let version: number | undefined;
    if (readyVersions) {
      version = entryVersion ? Number(entryVersion) : undefined;
      if (version == null) {
        setEntryMsg({ kind: "error", text: "Ese bot no tiene ninguna versión publicada o congelada que sea elegible" });
        return;
      }
    } else {
      version = bot.latestPublishedVersion;
      if (!version) {
        setEntryMsg({ kind: "error", text: "Ese bot no tiene ninguna versión publicada" });
        return;
      }
    }
    const frozen = readyVersions?.items.find((v) => v.version === version)?.state === "frozen";
    try {
      await api("POST", `/tournaments/${encodeURIComponent(props.id)}/entries`, {
        botId: bot.id,
        version,
      });
      setEntryMsg({ kind: "ok", text: `${bot.name} inscrito (v${version})${frozen ? ` · ${FROZEN_LABEL}` : ""}` });
      reloadDetail();
    } catch (err) {
      setEntryMsg({ kind: "error", text: (err as Error).message || "no se pudo inscribir" });
    }
  }

  async function onCancelTournament() {
    if (!window.confirm(CANCEL_CONFIRM_TEXT)) return;
    setEntryMsg(null);
    try {
      await api("POST", `/tournaments/${encodeURIComponent(props.id)}/actions/cancel`, {});
      setEntryMsg({ kind: "ok", text: "Torneo cancelado: no se jugará ninguna batalla" });
      reloadDetail();
    } catch (err) {
      setEntryMsg({ kind: "error", text: (err as Error).message || "no se pudo cancelar el torneo" });
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
        {" · "}
        <a href={`#/tournaments/${encodeURIComponent(props.id)}/bracket`}>Ver cuadro</a>
      </p>
      <div className="card">
        <ResourceView resource={detail} label="el torneo" onRetry={reloadDetail}>
          {(t) => (
            <>
              <h2>{t.name}</h2>
              {/* EQ5b · sólo admin; abre Streaming con el destino, no emite. */}
              <BroadcastButton me={props.me} kind="tournament" id={props.id} />
              <p>
                {labelOf(TOURNAMENT_FORMAT_NAME, t.format)} · {modeName(t.mode)} · estado{" "}
                <strong data-testid="tournament-state" data-state={t.state}>
                  {labelOf(TOURNAMENT_STATE_NAME, t.state)}
                </strong>{" "}
                · {t.entryCount ?? 0} inscritos
                {t.broadcast && (
                  <>
                    {" "}
                    · <strong data-testid="tournament-broadcast-badge">retransmisión pública</strong>
                  </>
                )}
              </p>
              {/* #287 · torneo por equipos con tamaño: la unidad de inscripción es el EQUIPO. */}
              {t.state === "open" && teamSizeOfTournament(t) !== null && (
                <>
                  <TournamentTeamEntry
                    tournamentId={props.id}
                    teamSize={teamSizeOfTournament(t)!}
                    onEntered={reloadDetail}
                    onMessage={setEntryMsg}
                  />
                  <button type="button" onClick={onCloseEntries}>
                    Cerrar inscripciones
                  </button>
                </>
              )}
              {t.state === "open" && teamSizeOfTournament(t) === null && (
                <form onSubmit={onEnter}>
                  <label>
                    Inscribir bot{" "}
                    <select aria-label="bot a inscribir" value={entryBot} onChange={(e) => setEntryBot(e.target.value)}>
                      <option value="">— elige un bot —</option>
                      {ownBots.status === "ready" &&
                        ownBots.data.items.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                            {b.latestPublishedVersion ? ` (v${b.latestPublishedVersion})` : ""}
                          </option>
                        ))}
                    </select>
                  </label>{" "}
                  {readyVersions && (
                    <label>
                      Versión{" "}
                      <select
                        aria-label="versión a inscribir"
                        value={entryVersion}
                        onChange={(e) => setEntryVersion(e.target.value)}
                      >
                        {readyVersions.choices.selectable.length === 0 && (
                          <option value="">— ninguna versión inscribible —</option>
                        )}
                        {readyVersions.choices.selectable.map((v) => (
                          <option key={v.version} value={String(v.version)}>
                            {entryVersionLabel(v)}
                          </option>
                        ))}
                        {readyVersions.choices.blocked.map((b) => (
                          <option key={`blocked-${b.version.version}`} value={`blocked-${b.version.version}`} disabled>
                            {entryVersionLabel(b.version)} · No elegible — {b.reason}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}{" "}
                  {entryVersions?.status === "error" && entryVersions.botId === entryBot && (
                    <small className="muted" data-testid="entry-versions-unavailable">
                      No se pudieron cargar sus versiones: se usará la última publicada y la plataforma comprobará si es
                      elegible.
                    </small>
                  )}
                  {chosenVersion?.state === "frozen" && (
                    <p className="note" data-testid="entry-frozen-note">
                      {FROZEN_LABEL}: esta versión ya compitió en otro torneo. Se inscribe tal cual (mismo código y
                      loadout); no se crea ninguna versión nueva ni cambia su estado.
                    </p>
                  )}
                  <button type="submit">Inscribir</button>{" "}
                  {(() => {
                    const chosen =
                      ownBots.status === "ready" ? ownBots.data.items.find((b) => b.id === entryBot) : undefined;
                    const note = chosen ? entryPrivacyNote(chosen.visibility, t.broadcast) : null;
                    return note ? (
                      <p className="note" data-testid="entry-privacy-note">
                        {note}
                      </p>
                    ) : null;
                  })()}
                  {/* #291 · sólo quien creó el torneo o el staff (la API también lo exige). */}
                  {t.viewerCanManage && (
                    <button type="button" onClick={onCloseEntries} data-testid="close-entries">
                      Cerrar inscripciones
                    </button>
                  )}
                </form>
              )}
              {t.viewerCanManage &&
                (cancelBlockedReason(t.state) === null ? (
                  <p>
                    <button type="button" onClick={() => void onCancelTournament()} data-testid="cancel-tournament">
                      Cancelar torneo
                    </button>
                  </p>
                ) : (
                  t.state !== "cancelled" && (
                    <p className="muted" data-testid="cancel-tournament-blocked">
                      {cancelBlockedReason(t.state)}
                    </p>
                  )
                ))}
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
