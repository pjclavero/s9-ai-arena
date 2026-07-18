/**
 * R3.6 · MEJ-gráficos — HUD del visor renderizado en HTML sobre el canvas.
 *
 * Presentacional y PURO respecto a los datos: recibe el HudModel ya derivado
 * (hud-model.ts, probado en Node) y lo pinta. El MISMO componente lo usan el
 * visor interactivo y /broadcast, de modo que el HUD es idéntico y legible en
 * ambos (DoD R3.6). No conoce Phaser ni la red: sólo dibuja el modelo.
 *
 * El indicador de fin de partida se dibuja además SOBRE EL CANVAS (PhaserViewer);
 * aquí se ofrece su gemelo HTML para el chrome de emisión.
 */
import type { CSSProperties } from "react";
import type { HudModel, HudBot, HudTeamPanel } from "./hud-model.js";

const panel: CSSProperties = {
  background: "rgba(0,0,0,0.6)",
  borderRadius: 8,
  padding: "8px 12px",
  color: "#f2f5f0",
  fontFamily: "system-ui, sans-serif",
  pointerEvents: "none",
};

export interface HudOverlayProps {
  model: HudModel;
  accent?: string;
  /** Escala tipográfica base (px). El broadcast la sube (1080p). */
  fontScale?: number;
}

export function HudOverlay({ model, accent = "#ffe066", fontScale = 14 }: HudOverlayProps) {
  return (
    <div data-testid="hud" style={{ position: "absolute", inset: 0, pointerEvents: "none", fontSize: fontScale }}>
      <TopBar model={model} accent={accent} />
      <TeamPanels model={model} accent={accent} />
      <KillFeed model={model} accent={accent} />
      <ObjectivesBar model={model} accent={accent} />
      {model.matchEnd && <MatchEndBanner model={model} accent={accent} />}
    </div>
  );
}

// ───────────────────────────── marcador + reloj + fase ───────────────────────

const PHASE_LABEL: Record<string, string> = { inicio: "Preparados", en_juego: "En juego", final: "Final" };

function TopBar({ model, accent }: { model: HudModel; accent: string }) {
  return (
    <div
      data-testid="hud-topbar"
      style={{
        ...panel,
        position: "absolute",
        top: 8,
        left: "50%",
        transform: "translateX(-50%)",
        textAlign: "center",
      }}
    >
      <div data-testid="hud-score" style={{ fontSize: "1.6em", fontWeight: 700 }}>
        {model.score.length > 0
          ? model.score.map((s, i) => (
              <span key={s.team} style={{ color: s.leading ? accent : undefined }}>
                {i > 0 && <span style={{ opacity: 0.5 }}> — </span>}
                {s.team} {s.points}
              </span>
            ))
          : "0 — 0"}
      </div>
      <div data-testid="hud-clock" style={{ fontSize: "0.9em", opacity: 0.85 }}>
        {model.clock.label} · {PHASE_LABEL[model.clock.phase] ?? model.clock.phase}
      </div>
    </div>
  );
}

// ─────────────────────────── objetivo + banderas + zonas ─────────────────────

function ObjectivesBar({ model, accent }: { model: HudModel; accent: string }) {
  return (
    <div data-testid="hud-objectives" style={{ ...panel, position: "absolute", top: 8, left: 8, maxWidth: "40%" }}>
      <div data-testid="hud-objective" style={{ color: accent, fontWeight: 600 }}>
        {model.objective.text}
      </div>
      {model.flags.length > 0 && (
        <div data-testid="hud-flags" style={{ fontSize: "0.85em" }}>
          {model.flags.map((f) => (
            <span key={f.team} style={{ marginRight: 10 }}>
              🚩 {f.team}: {flagLabel(f.state)}
            </span>
          ))}
        </div>
      )}
      {model.zones.length > 0 && (
        <div data-testid="hud-zones" style={{ fontSize: "0.85em" }}>
          {model.zones.map((z) => (
            <span key={z.id} style={{ marginRight: 10 }}>
              ◈ {z.id}: {z.team === "neutral" ? "neutral" : z.team} ({z.state})
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const FLAG_LABEL: Record<string, string> = {
  at_base: "en base",
  carried: "en juego",
  dropped: "caída",
  returning: "volviendo",
  captured: "capturada",
};
function flagLabel(state: string): string {
  return FLAG_LABEL[state] ?? state;
}

// ─────────────────────────── panel de bots por equipo ────────────────────────

function TeamPanels({ model, accent }: { model: HudModel; accent: string }) {
  return (
    <div
      data-testid="hud-teams"
      style={{ position: "absolute", top: 72, right: 8, display: "flex", flexDirection: "column", gap: 8, width: 260 }}
    >
      {model.teams.map((t) => (
        <TeamPanelView key={t.team} team={t} accent={accent} />
      ))}
    </div>
  );
}

function TeamPanelView({ team, accent }: { team: HudTeamPanel; accent: string }) {
  return (
    <div data-testid="hud-team" data-team={team.team} style={{ ...panel }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700 }}>
        <span style={{ color: accent }}>{team.team}</span>
        <span>
          {team.points} pts · {team.aliveCount} vivos
        </span>
      </div>
      {team.bots.map((b) => (
        <BotRow key={b.id} bot={b} />
      ))}
    </div>
  );
}

function BotRow({ bot }: { bot: HudBot }) {
  const barColor = bot.hpPercent > 50 ? "#5fd35f" : bot.hpPercent > 25 ? "#e0c040" : "#e05a5a";
  return (
    <div
      data-testid="hud-bot"
      data-bot={bot.id}
      style={{ opacity: bot.alive ? 1 : 0.45, marginTop: 4, fontSize: "0.85em" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span>
          {bot.name}
          {bot.carryingFlag ? " 🚩" : ""}
        </span>
        <span data-testid="hud-bot-hp">{bot.alive ? `${bot.hpPercent}%` : "KO"}</span>
      </div>
      {/* Barra de vida */}
      <div style={{ height: 5, background: "rgba(255,255,255,0.15)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${bot.hpPercent}%`, height: "100%", background: barColor }} />
      </div>
      {/* Módulos: iconos de estado (arma/blindaje/movilidad) + recuento fuera de combate */}
      <div style={{ fontSize: "0.85em", opacity: 0.85 }}>
        {bot.turretLocked ? "🔫✖ " : ""}
        {bot.armorBroken ? "🛡✖ " : ""}
        {bot.mobilityCrippled ? "⚙✖ " : ""}
        <span data-testid="hud-bot-modules">
          {bot.modulesTotal - bot.modulesDown}/{bot.modulesTotal} módulos
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────── kill feed ───────────────────────────────

function KillFeed({ model, accent }: { model: HudModel; accent: string }) {
  if (model.killFeed.length === 0) return null;
  return (
    <div
      data-testid="hud-killfeed"
      style={{ ...panel, position: "absolute", bottom: 8, right: 8, width: 260, fontSize: "0.85em" }}
    >
      {model.killFeed.map((k, i) => (
        <div key={`${k.tick}-${i}`}>
          <span style={{ color: accent }}>[{k.tick}]</span> {k.text}
        </div>
      ))}
    </div>
  );
}

// ─────────────────────── indicador de fin (gemelo HTML) ───────────────────────

function MatchEndBanner({ model, accent }: { model: HudModel; accent: string }) {
  const end = model.matchEnd!;
  return (
    <div
      data-testid="hud-matchend"
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        background: "rgba(0,0,0,0.8)",
        borderRadius: 12,
        padding: "20px 40px",
        textAlign: "center",
        color: "#f2f5f0",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div style={{ fontSize: "2em", fontWeight: 800, color: accent }}>{end.headline}</div>
      <div style={{ fontSize: "1.1em", marginTop: 6 }}>
        {Object.entries(end.score)
          .map(([t, n]) => `${t} ${n}`)
          .join("   ")}
      </div>
      {end.reason && <div style={{ fontSize: "0.85em", opacity: 0.7, marginTop: 4 }}>{end.reason}</div>}
    </div>
  );
}
