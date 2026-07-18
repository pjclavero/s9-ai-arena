/**
 * T11.1 · Vista /broadcast (cap. 21): composición 1920×1080 pensada para
 * captura por Chromium headless, SIN interacción — cero botones, cero cursor.
 *
 * No duplica el render: monta el MISMO visor de E8 (PhaserViewer, importado
 * perezosamente) y el MISMO SpectatorClient (reconexión + un snapshot por
 * detrás + interpolación), y le añade el "chrome" de emisión: marcador,
 * participantes con loadout resumido (estado de módulos por slot, del snapshot
 * público), ronda/progreso del torneo, ticker de eventos y branding por
 * parámetros. Las pantallas de espera/entre batallas las alimenta el
 * BroadcastDirector con el estado del torneo de E9 vía API pública.
 *
 * Regla de oro (cap. 21): esta vista consume el canal de espectador como un
 * cliente más; jamás toca motor ni tick.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { BroadcastConfig } from "../broadcast/config.js";
import { BroadcastDirector, createPublicApi, type BattleSummary, type BroadcastScreen } from "../broadcast/director.js";
import { SpectatorClient } from "../viewer/spectator-client.js";
import { LiveFeed } from "../viewer/live-feed.js";
import type { ViewerScene } from "../viewer/PhaserViewer.js";
import type { FeedItem, VehicleOverlay } from "../viewer/overlay.js";

const STAGE = { width: 1920, height: 1080 };
const TICKER_ITEMS = 6;

export function BroadcastPage({ config }: { config: BroadcastConfig }) {
  const [screen, setScreen] = useState<BroadcastScreen | null>(null);

  useEffect(() => {
    if (!config.target) return;
    const api = createPublicApi();
    const director = new BroadcastDirector({
      target: config.target,
      fetchJson: api.get,
      onScreen: setScreen,
      pollIntervalMs: config.pollIntervalMs,
    });
    director.start();
    return () => director.stop();
  }, [config]);

  const b = config.branding;
  const stageStyle: CSSProperties = {
    width: STAGE.width,
    height: STAGE.height,
    background: b.primaryColor,
    color: "#f5f5f5",
    cursor: "none", // DoD: sin cursores ni controles visibles
    userSelect: "none",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    fontFamily: "system-ui, sans-serif",
    position: "relative",
  };

  return (
    <div data-testid="broadcast-stage" style={stageStyle}>
      <BroadcastHeader config={config} screen={screen} />
      {!config.target ? (
        <CenterCard accent={b.accentColor} title={b.eventName} subtitle="Configura ?battle=<id> o ?tournament=<id>" />
      ) : screen === null || screen.kind === "waiting" ? (
        <WaitingScreen config={config} next={screen?.kind === "waiting" ? screen.nextBattle : null} />
      ) : screen.kind === "intermission" ? (
        <IntermissionScreen config={config} last={screen.lastBattle} next={screen.nextBattle} />
      ) : screen.kind === "finished" ? (
        <FinishedScreen config={config} last={screen.lastBattle} />
      ) : (
        <LiveScreen config={config} battle={screen.battle} />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────── cabecera con branding y ronda

function BroadcastHeader({ config, screen }: { config: BroadcastConfig; screen: BroadcastScreen | null }) {
  const b = config.branding;
  const progress = screen?.progress;
  return (
    <header
      data-testid="broadcast-header"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 24,
        padding: "12px 32px",
        borderBottom: `4px solid ${b.accentColor}`,
        minHeight: 72,
      }}
    >
      {b.logoUrl && <img data-testid="broadcast-logo" src={b.logoUrl} alt="" style={{ height: 48 }} />}
      <strong data-testid="broadcast-event" style={{ fontSize: 32, color: b.accentColor }}>
        {b.eventName}
      </strong>
      {progress && progress.total > 0 && (
        <span data-testid="broadcast-round" style={{ marginLeft: "auto", fontSize: 24 }}>
          Batalla {Math.min(progress.played + 1, progress.total)} / {progress.total}
        </span>
      )}
    </header>
  );
}

function CenterCard({ accent, title, subtitle }: { accent: string; title: string; subtitle: string }) {
  return (
    <section
      style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}
    >
      <h1 style={{ fontSize: 64, color: accent, margin: 0 }}>{title}</h1>
      <p style={{ fontSize: 32, opacity: 0.85 }}>{subtitle}</p>
    </section>
  );
}

function participantsLine(battle: BattleSummary | null): string {
  if (!battle) return "";
  return battle.participants.map((p) => `${shortId(p.botId)} v${p.version} (${p.team})`).join("  ·  ");
}

function scoreLine(battle: BattleSummary | null): string {
  const score = battle?.result?.score;
  if (!score) return "";
  return Object.entries(score)
    .map(([team, pts]) => `${team} ${pts}`)
    .join("  —  ");
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

// ─────────────────────────────────────────── pantallas de espera/entre batallas

function WaitingScreen({ config, next }: { config: BroadcastConfig; next: BattleSummary | null }) {
  return (
    <section
      data-testid="broadcast-waiting"
      style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}
    >
      <h1 style={{ fontSize: 64, color: config.branding.accentColor, margin: 0 }}>{config.branding.eventName}</h1>
      <p style={{ fontSize: 36 }}>{next ? "La batalla empieza en breve" : "Esperando el inicio del torneo…"}</p>
      {next && (
        <p data-testid="broadcast-next" style={{ fontSize: 28, opacity: 0.9 }}>
          Próxima batalla: {participantsLine(next)} · {next.mode}
        </p>
      )}
    </section>
  );
}

function IntermissionScreen({
  config,
  last,
  next,
}: {
  config: BroadcastConfig;
  last: BattleSummary;
  next: BattleSummary | null;
}) {
  return (
    <section
      data-testid="broadcast-intermission"
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
      }}
    >
      <h2 style={{ fontSize: 44, margin: 0 }}>Resultado</h2>
      <p data-testid="broadcast-last-score" style={{ fontSize: 40, color: config.branding.accentColor }}>
        {scoreLine(last) || "batalla terminada"}
      </p>
      <p style={{ fontSize: 26, opacity: 0.9 }}>{participantsLine(last)}</p>
      {next && (
        <p data-testid="broadcast-next" style={{ fontSize: 30 }}>
          A continuación: {participantsLine(next)} · {next.mode}
        </p>
      )}
    </section>
  );
}

function FinishedScreen({ config, last }: { config: BroadcastConfig; last: BattleSummary | null }) {
  return (
    <section
      data-testid="broadcast-finished"
      style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}
    >
      <h1 style={{ fontSize: 56, color: config.branding.accentColor, margin: 0 }}>{config.branding.eventName}</h1>
      <p style={{ fontSize: 36 }}>Torneo terminado. ¡Gracias por vernos!</p>
      {last && (
        <p data-testid="broadcast-last-score" style={{ fontSize: 30, opacity: 0.9 }}>
          Última batalla: {scoreLine(last)} · {participantsLine(last)}
        </p>
      )}
    </section>
  );
}

// ───────────────────────────────────────────────── batalla en directo (E8 real)

function LiveScreen({ config, battle }: { config: BroadcastConfig; battle: BattleSummary }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ViewerScene | null>(null);
  const [live, setLive] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!hostRef.current) return;
    let game: { destroy: (removeCanvas: boolean) => void } | null = null;
    let client: SpectatorClient | null = null;
    let alive = true;
    const api = createPublicApi();

    // El MISMO visor de E8 (chunk perezoso): aquí solo se cablea, no se re-renderiza.
    void import("../viewer/PhaserViewer.js").then(({ createViewerGame, ViewerScene }) => {
      if (!alive || !hostRef.current) return;
      // FPS objetivo por vista (R3.2): la emisión se captura a 30 fps (streamer);
      // renderizar a más solo quema CPU del contenedor de Chromium.
      game = createViewerGame(hostRef.current, { targetFps: 30 });
      const scene = (game as any).scene.getScene("viewer") as InstanceType<typeof ViewerScene>;
      scene.cameraMode = { kind: "global" }; // encuadre fijo de emisión, sin manos
      sceneRef.current = scene;
      // Mismo reloj de reproducción con delay-buffer que el visor (R3.2).
      const feed = new LiveFeed(scene);

      client = new SpectatorClient({
        // Ticket ANÓNIMO: la vista broadcast jamás lleva sesión (cero datos privados).
        getTicket: () => api.post(`/battles/${battle.id}/spectate-ticket`),
      });
      const c = client;
      client.on("init", (msg) => {
        setLive(true);
        if (msg.meta?.world) scene.setWorld(msg.meta.world);
        feed.onInit(msg);
      });
      client.on("snapshot", (s) => {
        feed.onSnapshot(s, c.state.serverTimeMs ?? undefined);
        setTick(s.tick);
      });
      client.on("event", (e) => feed.onEvent(e));
      client.on("disconnect", () => setLive(false));
      client.on("reconnected", () => setLive(true));
      void client.connect();
    });

    return () => {
      alive = false;
      client?.stop();
      game?.destroy(true);
      sceneRef.current = null;
    };
  }, [battle.id]);

  const overlay = sceneRef.current?.overlay;
  const accent = config.branding.accentColor;
  return (
    <section data-testid="broadcast-live" style={{ flex: 1, position: "relative", minHeight: 0 }}>
      {/* Visor E8 a pantalla completa (el canvas llena el hueco). */}
      <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />

      {/* Marcador superpuesto */}
      <div
        data-testid="broadcast-score"
        style={{
          position: "absolute",
          top: 16,
          left: "50%",
          transform: "translateX(-50%)",
          padding: "8px 24px",
          background: "rgba(0,0,0,0.65)",
          borderRadius: 8,
          fontSize: 34,
          color: accent,
        }}
      >
        {overlay && Object.keys(overlay.score).length > 0
          ? Object.entries(overlay.score)
              .map(([t, n]) => `${t} ${n}`)
              .join("   ")
          : live
            ? "0 — 0"
            : "conectando…"}
      </div>

      {/* Participantes con loadout resumido (estado de módulos del snapshot público) */}
      <aside
        data-testid="broadcast-participants"
        style={{
          position: "absolute",
          top: 16,
          right: 16,
          width: 360,
          background: "rgba(0,0,0,0.55)",
          borderRadius: 8,
          padding: 12,
          fontSize: 18,
        }}
      >
        {(overlay ? [...overlay.vehicles.values()] : []).map((v) => (
          <ParticipantRow key={v.id} v={v} accent={accent} />
        ))}
        {!overlay &&
          battle.participants.map((p) => (
            <div key={p.botId}>
              {shortId(p.botId)} v{p.version} · {p.team}
            </div>
          ))}
      </aside>

      {/* Ticker de eventos */}
      <footer
        data-testid="broadcast-ticker"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(0,0,0,0.7)",
          padding: "10px 24px",
          fontSize: 22,
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
      >
        {(overlay?.feed ?? []).slice(-TICKER_ITEMS).map((f: FeedItem, i: number) => (
          <span key={`${f.tick}-${i}`} style={{ marginRight: 48 }}>
            <span style={{ color: accent }}>[{f.tick}]</span> {f.text}
          </span>
        ))}
        <span style={{ opacity: 0.6 }}>tick {tick}</span>
      </footer>
    </section>
  );
}

function ParticipantRow({ v, accent }: { v: VehicleOverlay; accent: string }) {
  const hp = v.hullHpMax > 0 ? Math.round((100 * v.hullHp) / v.hullHpMax) : 0;
  // Loadout resumido: slot→estado del módulo, tal y como viaja en el snapshot público.
  const modules = Object.entries(v.modules)
    .map(([slot, state]) => (state === "operational" ? slot : `${slot}(${state[0]})`))
    .join(" ");
  return (
    <div style={{ opacity: v.alive ? 1 : 0.45, marginBottom: 6 }}>
      <strong style={{ color: accent }}>{v.id}</strong> · {v.team} · {v.alive ? `${hp}%` : "KO"}
      {v.carryingFlag ? " · 🚩" : ""}
      <div style={{ fontSize: 14, opacity: 0.85 }}>{modules}</div>
    </div>
  );
}
