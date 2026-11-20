/**
 * #255 · Secciones «Batallas» y «Replays» del panel de un bot: las últimas del bot,
 * dentro del panel (antes eran dos enlaces que sacaban de la pantalla), con enlace a
 * la pantalla general YA filtrada para ver todas. Sólo lectura: la API sólo lista
 * lo que quien mira puede ver (G-08 / TD-004).
 */
import { api } from "../api.js";
import { useResource, ResourceView } from "../resource.js";
import { EmptyState } from "../ui/primitives.js";
import {
  botVersionLabel,
  modeName,
  sidesTitle,
  summarizeBattle,
  winnerText,
  type BattleLike,
  type ParticipantLike,
} from "../battle-result.js";
import { formatTicksAsDuration } from "./ReplaysPage.js";

interface Battle extends BattleLike {
  id: string;
  mode: string;
  participants: ParticipantLike[];
}

const STATUS_TEXT: Record<string, string> = {
  scheduled: "en cola",
  running: "en curso",
  finished: "terminada",
  failed: "fallida",
};

/** Cuántas se enseñan dentro del panel (el resto, en la pantalla general). */
export const BOT_ACTIVITY_LIMIT = 10;

export function BotBattlesSection(props: { botId: string; botName: string }) {
  const [list, reload] = useResource(() => api<{ items: Battle[] }>("GET", "/battles"), [props.botId]);
  const all = `#/battles?bot=${encodeURIComponent(props.botId)}`;
  return (
    <div data-testid="bot-battles">
      <p>
        <a href={all} data-testid="bot-battles-link">
          Ver todas las batallas de {props.botName}
        </a>{" "}
        · <a href="#/battles/new">+ Nueva batalla</a>
      </p>
      <ResourceView resource={list} label="las batallas" onRetry={reload}>
        {(page) => {
          // listBattles no filtra por participante: el filtro es de cliente (como #/battles?bot=).
          const items = (page.items ?? []).filter((b) => b.participants.some((p) => p.botId === props.botId));
          if (items.length === 0) return <EmptyState message="Este bot todavía no ha jugado ninguna batalla." />;
          return (
            <table className="stack-table">
              <thead>
                <tr>
                  <th>Batalla</th>
                  <th>Modo</th>
                  <th>Estado</th>
                  <th>Resultado</th>
                </tr>
              </thead>
              <tbody>
                {items.slice(0, BOT_ACTIVITY_LIMIT).map((b) => {
                  const v = summarizeBattle(b);
                  return (
                    <tr key={b.id} data-testid="bot-battle-row">
                      <td>
                        <a href={`#/battles/${encodeURIComponent(b.id)}`}>
                          {sidesTitle(b.participants, botVersionLabel, { withSide: true }) || "batalla"}
                        </a>
                      </td>
                      <td>{modeName(b.mode)}</td>
                      <td>{STATUS_TEXT[b.status] ?? b.status}</td>
                      <td>
                        {winnerText(b) ?? "—"}
                        {v.score ? <small> · {v.score}</small> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          );
        }}
      </ResourceView>
    </div>
  );
}

interface ReplaySummary {
  battleId: string;
  ticks: number;
  official: boolean;
  createdAt: string;
}

export function BotReplaysSection(props: { botId: string; botName: string }) {
  const [list, reload] = useResource(
    () =>
      api<{ items: ReplaySummary[] }>(
        "GET",
        `/replays?bot=${encodeURIComponent(props.botId)}&limit=${BOT_ACTIVITY_LIMIT}`,
      ),
    [props.botId],
  );
  const all = `#/replays?bot=${encodeURIComponent(props.botId)}`;
  return (
    <div data-testid="bot-replays">
      <p>
        <a href={all} data-testid="bot-replays-link">
          Ver todos los replays de {props.botName}
        </a>
      </p>
      <ResourceView resource={list} label="los replays" onRetry={reload}>
        {(page) => {
          const items = page.items ?? [];
          if (items.length === 0) return <EmptyState message="Este bot todavía no tiene replays." />;
          return (
            <table className="stack-table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Duración</th>
                  <th>Tipo</th>
                  <th>Ver</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.battleId} data-testid="bot-replay-row">
                    <td>{new Date(r.createdAt).toLocaleString()}</td>
                    <td>{formatTicksAsDuration(r.ticks)}</td>
                    <td>{r.official ? "oficial" : "práctica"}</td>
                    <td>
                      <a href={`#/replay/${encodeURIComponent(r.battleId)}?t=0`}>Ver replay</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          );
        }}
      </ResourceView>
    </div>
  );
}
