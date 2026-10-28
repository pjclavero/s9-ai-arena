/**
 * UX-D · Detalle de UNA batalla (#/battles/<id>). Antes esa ruta daba 404 y el
 * resultado sólo se veía como una fila de la lista con UUIDs.
 *
 *  - D1 · resultado: ganador con NOMBRES de bot, marcador, duración (ticks y
 *    tiempo), participantes con su versión EXACTA, mapa, modo y versiones del
 *    motor (de la auditoría).
 *  - D3 · estadísticas por bot: disparos, aciertos, precisión, daño, bajas,
 *    supervivencia, timeouts, objetivos y uso de módulos (con QUÉ mide cada uno).
 *    Justo tras terminar el job aún no ha escrito (TD-065): «calculando» y se
 *    vuelve a preguntar, nunca una tabla vacía.
 *  - UX-06 · diagnóstico de TUS bots (la API sólo lo entrega a su dueño y al
 *    staff): si arrancó, HELLO, decisiones, timeouts, descalificación, COMMAND
 *    inválidos y por qué, rechazos por motivo, salida del contenedor y CPU.
 *
 * Una batalla en curso o en cola se refresca sola. Un id ajeno o inexistente es
 * el mismo 404 de la API («no existe o no tienes acceso»).
 */
import { useEffect } from "react";
import { api } from "../api.js";
import { useResource, ResourceView } from "../resource.js";
import {
  MODE_TEXT,
  OUTCOME_TEXT,
  USES_KIND_TEXT,
  botLabel,
  botVersionLabel,
  dqReasonText,
  rejectionText,
  summarizeBattle,
  ticksToClock,
  winnerText,
  teamText,
  sideResults,
  sidesTitle,
  groupBySide,
  type BattleLike,
  type ParticipantLike,
} from "../battle-result.js";
import { LiveStatus, StatusBadge } from "../ui/primitives.js";

interface DetailParticipant extends ParticipantLike {
  cpuMs?: number | null;
  diagnosticsVisible?: boolean;
}

interface BattleDetail extends BattleLike {
  mode: string;
  rulesetId?: string;
  mapId: string;
  mapName?: string;
  mapVersion: number;
  tournamentId?: string;
  official?: boolean;
  createdAt?: string;
  participants: DetailParticipant[];
}

interface ModuleStatsView {
  moduleId: string | null;
  usesKind?: string;
  uses: number;
  /** UX-F (DEF-R12) · sólo para el dueño y el staff (diagnóstico). */
  rejections?: number;
  damageDealt: number;
  finalState: string;
}

interface BotStatsView {
  botName?: string;
  version?: number;
  team: string;
  damageDealt: number;
  damageTaken: number;
  shotsFired: number;
  shotsHit: number;
  accuracy: number | null;
  kills: number;
  died: boolean;
  survivedTicks: number;
  flagCaptures: number;
  flagsTaken: number;
  minesDeployed: number;
  minesTriggered: number;
  /** UX-F (DEF-R12) · sólo para el dueño y el staff (diagnóstico). */
  decisionTimeouts?: number;
  distanceM?: number;
  disqualified: boolean;
  perModule: Record<string, ModuleStatsView>;
}

interface DiagnosticsView {
  botId: string;
  botName?: string;
  version: number;
  measured: boolean;
  startup: { ok: boolean; reason?: string; warning?: string } | null;
  hello: { ok: boolean; tick: number | null; reconnects: number | null } | null;
  decisions: number | null;
  decisionTimeouts: number | null;
  maxConsecutiveTimeouts: number | null;
  disqualified: boolean;
  disqualifiedReason: string | null;
  commands: {
    received: number | null;
    invalid: number | null;
    firstInvalidReason: string | null;
    invalidJson: number | null;
    late: number | null;
    wrongTick: number | null;
    extra: number | null;
  } | null;
  rejectionsByReason: Record<string, number> | null;
  disconnectedAtTick: number | null;
  container: { exitCode: number | null; oomKilled: boolean; exitedDuringBattle: boolean } | null;
  cpuMs: number | null;
}

interface StatsResponse {
  status: "ready" | "pending" | "unavailable";
  perBot: Record<string, BotStatsView>;
  diagnostics: Record<string, DiagnosticsView>;
}

interface AuditView {
  versions?: Record<string, string>;
  map?: { checksum?: string };
}

const STATUS_TEXT: Record<string, string> = {
  scheduled: "en cola",
  running: "en curso",
  finished: "terminada",
  failed: "fallida",
};

const VERSION_KEYS: [string, string][] = [
  ["engine", "motor"],
  ["physics", "física"],
  ["rules", "reglas"],
  ["catalog", "catálogo"],
  ["protocol", "protocolo"],
];

const REFRESH_MS = 5000;

const pct = (x: number | null | undefined) => (typeof x === "number" ? `${Math.round(x * 100)} %` : "—");
const n0 = (x: number | null | undefined) => (typeof x === "number" ? String(Math.round(x)) : "no medido");

export function BattleDetailPage(props: { id: string }) {
  const id = encodeURIComponent(props.id);
  const [battle, reloadBattle] = useResource(() => api<BattleDetail>("GET", `/battles/${id}`), [id]);
  const [stats, reloadStats] = useResource(() => api<StatsResponse>("GET", `/battles/${id}/stats`), [id]);
  const [audit] = useResource(() => api<AuditView>("GET", `/battles/${id}/audit`).catch(() => null), [id]);

  // En cola / en curso / estadísticas pendientes: se vuelve a preguntar SIN
  // desmontar nada (revalidación silenciosa). Se para sola al quedar firme.
  const live = battle.status === "ready" && (battle.data.status === "scheduled" || battle.data.status === "running");
  const statsPending = stats.status === "ready" && stats.data.status === "pending";
  useEffect(() => {
    if (!live && !statsPending) return;
    const t = setInterval(() => {
      if (live) reloadBattle({ silent: true });
      reloadStats({ silent: true });
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [live, statsPending, reloadBattle, reloadStats]);

  return (
    <div className="card" data-testid="battle-detail">
      <p>
        <a href="#/battles">← Batallas</a>
      </p>
      <ResourceView resource={battle} label="la batalla" onRetry={reloadBattle}>
        {(b) => (
          <>
            <BattleHeader b={b} audit={audit.status === "ready" ? audit.data : null} />
            <h3>Estadísticas</h3>
            <ResourceView resource={stats} label="las estadísticas" onRetry={reloadStats}>
              {(s) => <StatsSection b={b} s={s} />}
            </ResourceView>
            {stats.status === "ready" && Object.keys(stats.data.diagnostics ?? {}).length > 0 && (
              <DiagnosticsSection b={b} diagnostics={stats.data.diagnostics} />
            )}
          </>
        )}
      </ResourceView>
    </div>
  );
}

function BattleHeader({ b, audit }: { b: BattleDetail; audit: AuditView | null }) {
  const v = summarizeBattle(b);
  const r = (b.result && typeof b.result === "object" ? b.result : {}) as { ticks?: number };
  const ticks = Number(r.ticks);
  return (
    <>
      <h2 data-testid="battle-title">
        {sidesTitle<DetailParticipant>(b.participants, botLabel) || "Batalla"} <small>· {STATUS_TEXT[b.status] ?? b.status}</small>
      </h2>
      {b.status === "finished" && (
        <p data-testid="battle-winner">
          <strong>{winnerText(b) ?? "sin resultado"}</strong>
          {v.score && <> · marcador {v.score}</>}
          {v.endReason && <> · {v.endReason}</>}
          {v.agentsNote && <StatusBadge variant="warn"> · {v.agentsNote}</StatusBadge>}
        </p>
      )}
      {b.status === "failed" && (
        <p className="error" data-testid="battle-failed">
          La batalla no se pudo jugar ({v.failure ?? "fallo"}). No cuenta para nadie; si fue de infraestructura, la
          plataforma ya la reintentó antes de darla por fallida.
        </p>
      )}
      {(b.status === "scheduled" || b.status === "running") && (
        // UX-R · LiveStatus: el paso de «en cola» a «en curso» se anuncia (aria-live) y
        // aria-busy dice que el resultado aún no está.
        <LiveStatus busy data-testid="battle-live-note">
          {b.status === "scheduled"
            ? "En cola: la ejecutará el servicio de batallas en cuanto haya hueco. Esta página se actualiza sola."
            : "En curso. Esta página se actualiza sola; el resultado aparecerá al terminar."}{" "}
          {b.status === "running" && <a href={`#/viewer/${encodeURIComponent(b.id)}`}>Ver en directo</a>}
        </LiveStatus>
      )}
      <dl data-testid="battle-facts">
        <dt>Modo</dt>
        <dd>{MODE_TEXT[b.mode] ?? b.mode}</dd>
        <dt>Mapa</dt>
        <dd>
          {b.mapName ?? b.mapId} (versión {b.mapVersion})
        </dd>
        <dt>Duración</dt>
        <dd data-testid="battle-duration">
          {Number.isFinite(ticks) && ticks > 0
            ? `${ticksToClock(ticks)} de partida (${ticks} ticks a 30/s)`
            : (v.duration ?? "—")}
        </dd>
        {b.official !== undefined && (
          <>
            <dt>Tipo</dt>
            <dd>{b.official ? "oficial (cuenta para el rating)" : "práctica (no cuenta para el rating)"}</dd>
          </>
        )}
        {b.tournamentId && (
          <>
            <dt>Torneo</dt>
            <dd>
              <a href={`#/tournaments/${encodeURIComponent(b.tournamentId)}`}>ver torneo</a>
            </dd>
          </>
        )}
        {audit?.versions && (
          <>
            <dt>Versiones</dt>
            <dd data-testid="battle-versions">
              {VERSION_KEYS.filter(([k]) => audit.versions![k])
                .map(([k, label]) => `${label} ${audit.versions![k]}`)
                .join(" · ") || "—"}
            </dd>
          </>
        )}
      </dl>
      <SidesTable b={b} />
      <table data-testid="battle-participants">
        <thead>
          <tr>
            <th>Bot</th>
            <th>Versión</th>
            {/* UX-R · el lado del campo es el BANDO (como en «Nueva batalla»), no un equipo de «Equipos». */}
            <th>Bando</th>
            <th>Resultado</th>
          </tr>
        </thead>
        <tbody>
          {b.participants.map((p) => (
            <tr key={p.botId} data-testid="participant-row">
              <td>
                {/* Sólo tus bots tienen página de detalle para ti. */}
                {p.diagnosticsVisible ? (
                  <a href={`#/bots/${encodeURIComponent(p.botId)}`}>{botLabel(p)}</a>
                ) : (
                  botLabel(p)
                )}
              </td>
              <td>v{p.version}</td>
              <td>{teamText(p.team)}</td>
              <td>{p.outcome ? (OUTCOME_TEXT[p.outcome] ?? p.outcome) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        {v.hasReplay ? (
          <a href={`#/replay/${encodeURIComponent(b.id)}?t=0`} data-testid="battle-replay-link">
            Ver replay
          </a>
        ) : b.status === "finished" ? (
          <span>Sin replay: la batalla terminó sin jugarse (incomparecencia o fallo de arranque de un bot).</span>
        ) : null}
      </p>
    </>
  );
}

const SIDE_OUTCOME_CLASS: Record<string, string> = { gana: "ok", pierde: "warn", empate: "" };

/**
 * 4v4 · Resultado POR BANDO (lo que ya trae la batalla: participantes y `result`).
 * Recuerda que el bando es el lado del campo, no el equipo de la sección Equipos.
 */
function SidesTable({ b }: { b: BattleDetail }) {
  const sides = sideResults(b);
  if (sides.length < 2) return null;
  return (
    <table data-testid="battle-sides">
      <caption>Resultado por bando (el bando es el lado del campo, no el equipo de la sección Equipos)</caption>
      <thead>
        <tr>
          <th>Bando</th>
          <th>Bots</th>
          <th>Puntos</th>
          <th>Resultado</th>
        </tr>
      </thead>
      <tbody>
        {sides.map((sd) => (
          <tr key={sd.team} data-testid="side-row" data-team={sd.team}>
            <td>{sd.label}</td>
            <td>
              {sd.bots.length} · {sd.bots.join(", ")}
            </td>
            <td>{sd.score ?? "—"}</td>
            <td className={sd.outcome ? SIDE_OUTCOME_CLASS[sd.outcome] : undefined}>{sd.outcome ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StatsSection({ b, s }: { b: BattleDetail; s: StatsResponse }) {
  if (s.status === "pending") {
    return (
      <p role="status" data-testid="stats-pending">
        {b.status === "finished"
          ? "Calculando estadísticas a partir del replay… se mostrarán aquí en unos segundos."
          : "Las estadísticas se calculan al terminar la batalla."}
      </p>
    );
  }
  if (s.status === "unavailable") {
    return (
      <p data-testid="stats-unavailable">
        Esta batalla no tiene estadísticas: no llegó a jugarse (sin replay del que calcularlas).
      </p>
    );
  }
  const rows = b.participants.filter((p) => s.perBot[p.botId]);
  return (
    <>
      <table data-testid="battle-stats">
        <thead>
          <tr>
            <th>Bot</th>
            <th>Disparos</th>
            <th>Aciertos</th>
            <th>Precisión</th>
            <th>Daño hecho</th>
            <th>Daño recibido</th>
            <th>Bajas</th>
            <th>Supervivencia</th>
            <th>Recorrido</th>
            <th>Turnos sin responder</th>
            <th>Objetivos</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const st = s.perBot[p.botId];
            const objectives = [
              st.flagsTaken ? `${st.flagsTaken} banderas tomadas` : null,
              st.flagCaptures ? `${st.flagCaptures} capturas` : null,
              st.minesDeployed ? `${st.minesDeployed} minas (${st.minesTriggered} detonadas)` : null,
            ].filter(Boolean);
            return (
              <tr key={p.botId} data-testid="stats-row">
                <td>{botVersionLabel(p)}</td>
                <td>{st.shotsFired}</td>
                <td>{st.shotsHit}</td>
                <td>{pct(st.accuracy)}</td>
                <td>{Math.round(st.damageDealt)}</td>
                <td>{Math.round(st.damageTaken)}</td>
                <td>{st.kills}</td>
                <td>{st.died ? `destruido a los ${ticksToClock(st.survivedTicks)}` : "sobrevivió"}</td>
                <td>{typeof st.distanceM === "number" ? `${Math.round(st.distanceM)} m` : "—"}</td>
                <td>{typeof st.decisionTimeouts === "number" ? st.decisionTimeouts : "—"}</td>
                <td>{objectives.length > 0 ? objectives.join(" · ") : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {groupBySide(rows).some((g) => g.items.length > 1) && (
        // 4v4 · totales por bando, sumados de las filas por bot de arriba (mismo dato).
        <table data-testid="battle-stats-sides">
          <thead>
            <tr>
              <th>Bando</th>
              <th>Bajas</th>
              <th>Daño hecho</th>
              <th>Daño recibido</th>
              <th>Supervivientes</th>
            </tr>
          </thead>
          <tbody>
            {groupBySide(rows).map((g) => {
              const st = g.items.map((p) => s.perBot[p.botId]);
              const sum = (f: (x: BotStatsView) => number) => st.reduce((acc, x) => acc + (f(x) || 0), 0);
              return (
                <tr key={g.team ?? "_"} data-testid="stats-side-row" data-team={g.team ?? ""}>
                  <td>{teamText(g.team)}</td>
                  <td>{sum((x) => x.kills)}</td>
                  <td>{Math.round(sum((x) => x.damageDealt))}</td>
                  <td>{Math.round(sum((x) => x.damageTaken))}</td>
                  <td>
                    {st.filter((x) => !x.died).length} / {st.length}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {rows.map((p) => (
        <details key={p.botId} data-testid="module-usage">
          <summary>Uso de módulos de {botVersionLabel(p)}</summary>
          <table>
            <thead>
              <tr>
                <th>Hueco</th>
                <th>Módulo</th>
                <th>Uso</th>
                <th>Rechazos</th>
                <th>Daño</th>
                <th>Estado final</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(s.perBot[p.botId].perModule ?? {}).map(([slot, m]) => (
                <tr key={slot}>
                  <td>{slot}</td>
                  <td>{m.moduleId ?? "—"}</td>
                  <td>
                    {m.usesKind === "passive"
                      ? USES_KIND_TEXT.passive
                      : m.usesKind
                        ? `${m.uses} ${USES_KIND_TEXT[m.usesKind] ?? ""}`
                        : String(m.uses)}
                  </td>
                  <td>{typeof m.rejections === "number" ? m.rejections : "—"}</td>
                  <td>{m.damageDealt > 0 ? Math.round(m.damageDealt) : "—"}</td>
                  <td>{m.finalState === "operational" ? "operativo" : m.finalState}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ))}
    </>
  );
}

function DiagnosticsSection({ b, diagnostics }: { b: BattleDetail; diagnostics: Record<string, DiagnosticsView> }) {
  const mine = b.participants.filter((p) => diagnostics[p.botId]);
  return (
    <section data-testid="battle-diagnostics">
      <h3>Diagnóstico de tus bots</h3>
      <p>
        <small>Sólo lo ves tú (y los moderadores): no se muestra a los rivales.</small>
      </p>
      {mine.map((p) => (
        <BotDiagnostics key={p.botId} d={diagnostics[p.botId]} label={botVersionLabel(p)} />
      ))}
    </section>
  );
}

function BotDiagnostics({ d, label }: { d: DiagnosticsView; label: string }) {
  const problems: string[] = [];
  if (d.startup && !d.startup.ok) problems.push(`No arrancó: ${dqReasonText(d.startup.reason)}.`);
  // UX-F (DEF-R4) · versión publicada antes de exigir el hook: jugó, pero quieta.
  if (d.startup?.warning === "hook_missing")
    problems.push(
      `Tu versión publicada v${d.version} no implementa on_observation (Python) / onObservation (JavaScript): ` +
        "tu código no decide nada y el bot jugó quieto. Implementa el hook y publica una versión nueva.",
    );
  if (d.hello && !d.hello.ok) problems.push("Nunca completó el HELLO del protocolo.");
  if (d.disqualified) problems.push(`Descalificado: ${dqReasonText(d.disqualifiedReason)}.`);
  if (d.commands?.invalid)
    problems.push(
      `${d.commands.invalid} COMMAND con forma inválida descartados${
        d.commands.firstInvalidReason ? ` (primero: ${d.commands.firstInvalidReason})` : ""
      }. Revisa el esquema de COMMAND.`,
    );
  if (d.container?.exitedDuringBattle)
    problems.push(
      `El proceso del bot terminó antes del final${
        d.container.oomKilled
          ? " por falta de memoria"
          : d.container.exitCode !== null
            ? ` (código de salida ${d.container.exitCode})`
            : ""
      }${d.disconnectedAtTick !== null ? `, a los ${ticksToClock(d.disconnectedAtTick)}` : ""}.`,
    );
  else if (d.disconnectedAtTick !== null)
    problems.push(`Se desconectó a los ${ticksToClock(d.disconnectedAtTick)} de partida.`);

  const rejections = Object.entries(d.rejectionsByReason ?? {}).filter(([, n]) => n > 0);
  return (
    <div data-testid="bot-diagnostics" data-bot-id={d.botId}>
      <h4>{label}</h4>
      {problems.length > 0 ? (
        <ul data-testid="diagnostics-problems">
          {problems.map((x) => (
            <li key={x} className="warn">
              {x}
            </li>
          ))}
        </ul>
      ) : (
        <p className="ok">Sin problemas detectados.</p>
      )}
      <dl>
        <dt>Arranque</dt>
        <dd>
          {d.startup
            ? d.startup.ok
              ? d.startup.warning === "hook_missing"
                ? "arrancó, pero sin hook: no decide nada"
                : "correcto"
              : dqReasonText(d.startup.reason)
            : "no medido"}
        </dd>
        <dt>HELLO</dt>
        <dd>
          {d.hello
            ? d.hello.ok
              ? `correcto${d.hello.reconnects ? ` (${d.hello.reconnects} reconexiones)` : ""}`
              : "no completado"
            : "no medido"}
        </dd>
        <dt>Decisiones aplicadas</dt>
        <dd>{n0(d.decisions)}</dd>
        <dt>Turnos sin responder a tiempo</dt>
        <dd>
          {n0(d.decisionTimeouts)}
          {d.maxConsecutiveTimeouts !== null && <> (se descalifica con {d.maxConsecutiveTimeouts} seguidos)</>}
        </dd>
        {d.commands && (
          <>
            <dt>COMMAND recibidos</dt>
            <dd>
              {n0(d.commands.received)} · tardíos {n0(d.commands.late)} · para otro ciclo {n0(d.commands.wrongTick)} ·
              duplicados {n0(d.commands.extra)} · mensajes no JSON {n0(d.commands.invalidJson)}
            </dd>
          </>
        )}
        <dt>Acciones rechazadas por el motor</dt>
        <dd data-testid="diagnostics-rejections">
          {rejections.length === 0
            ? d.rejectionsByReason
              ? "ninguna"
              : "no medido"
            : rejections.map(([reason, n]) => `${rejectionText(reason)}: ${n}`).join(" · ")}
        </dd>
        <dt>CPU</dt>
        <dd>{typeof d.cpuMs === "number" ? `${Math.round(d.cpuMs)} ms` : "no medida"}</dd>
      </dl>
      {!d.measured && (
        <p>
          <small>
            El ejecutor no registró arranque ni protocolo de esta batalla (anterior a esta versión de la plataforma).
          </small>
        </p>
      )}
    </div>
  );
}
