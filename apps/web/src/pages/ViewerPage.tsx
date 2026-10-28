/**
 * T8.2 · Página del visor en directo. Pública: un visitante anónimo ve la batalla
 * sin cuenta (DoD T7.5/T8.2). Monta Phaser (render) y SpectatorClient (transporte),
 * ambos ya probados por separado; aquí solo se cablean.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { describeApiError } from "../errors.js";
import { SpectatorClient, type SpectateTicket } from "../viewer/spectator-client.js";
import { LiveFeed } from "../viewer/live-feed.js";
import {
  participantsTitle,
  rosterFromMeta,
  rosterTeams,
  sideText,
  sortTeams,
  vehicleLabel,
  type ViewerRoster,
} from "../viewer/art-direction.js";
import { RosterList } from "../viewer/RosterList.js";
import { buildHudModel } from "../viewer/hud-model.js";
import { HudOverlay } from "../viewer/HudOverlay.js";
import type { ViewerScene } from "../viewer/PhaserViewer.js";
import type { CameraMode } from "../viewer/camera.js";

/**
 * FC-D (D4) · Estado del visor, en `data-state` para la UI y el E2E:
 * init (Phaser arrancando) → connecting (ticket + socket) → live → finished, o
 * reconnecting / rejected (rechazo definitivo con motivo) / offline (agotó reintentos) / error.
 */
export type ViewerState =
  "init" | "connecting" | "live" | "reconnecting" | "finished" | "rejected" | "offline" | "error";

/** Texto para el usuario de cada rechazo definitivo del canal de espectador. */
export function describeSpectateRejection(r: {
  kind: string;
  status?: number;
  code?: number;
  reason?: string;
  error?: unknown;
}): {
  text: string;
  showReplay: boolean;
} {
  if (r.kind === "ticket") {
    const d = describeApiError(r.error);
    if (r.status === 404)
      return { text: "Esta batalla no existe o no se puede ver en directo sin cuenta.", showReplay: true };
    return { text: `No se pudo obtener el pase de espectador: ${d.title} — ${d.detail}`, showReplay: false };
  }
  switch (r.code) {
    case 4404:
      return { text: "La batalla no está en directo (ya terminó o aún no ha empezado).", showReplay: true };
    case 4401:
      return {
        text: "El servidor de directo rechazó el pase de espectador (ticket inválido o caducado).",
        showReplay: false,
      };
    case 4403:
      return { text: `El servidor de directo denegó el acceso (${r.reason || "acceso denegado"}).`, showReplay: true };
    default:
      return {
        text: `El servidor de directo cerró la conexión (${r.code ?? "?"} ${r.reason ?? ""}).`,
        showReplay: false,
      };
  }
}

export function ViewerPage({ battleId }: { battleId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ViewerScene | null>(null);
  const [status, setStatus] = useState("inicializando visor…");
  const [state, setState] = useState<ViewerState>("init");
  const [rejectCode, setRejectCode] = useState<string | undefined>(undefined);
  const [showReplay, setShowReplay] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [allowFog, setAllowFog] = useState(false);
  const [fogOn, setFogOn] = useState(false);
  // 4v4 · sin bando por defecto: se toma de la nómina en cuanto llega (antes "red" fijo).
  const [fogTeam, setFogTeam] = useState("");
  /** Nómina pública (vehículo → bot): de ella salen bandos, cámaras y nombres. */
  const [roster, setRoster] = useState<ViewerRoster>(() => new Map());
  const [debugAvailable, setDebugAvailable] = useState(false);
  const [debugOn, setDebugOn] = useState(false);
  const [camera, setCamera] = useState<CameraMode>({ kind: "global" });
  const [overlayTick, setOverlayTick] = useState(0);
  // UX-R · «Batalla Alfa vs Beta» en cuanto la cabecera trae la nómina.
  const [title, setTitle] = useState<string | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    let game: { destroy: (removeCanvas: boolean) => void } | null = null;
    let client: SpectatorClient | null = null;
    let alive = true;

    // Phaser se importa dinámicamente: el resto del panel no carga el motor de render.
    setState("init");
    setStatus("inicializando visor…");
    setRejectCode(undefined);
    setShowReplay(false);
    setTitle(null);
    setRoster(new Map());
    // UX-F (DEF-R11) · el pase se pide YA, en paralelo con la carga de Phaser. Antes
    // se pedía cuando Phaser había arrancado (~5 s en un navegador sin GPU), y una
    // batalla que no existe tardaba eso en decirse. El primer connect() usa esta
    // misma petición (no se pide dos veces); los reintentos piden uno nuevo.
    const ticketPath = `/battles/${battleId}/spectate-ticket`;
    let firstTicket: Promise<SpectateTicket> | null = api<SpectateTicket>("POST", ticketPath);
    let rejectedEarly = false;
    firstTicket.catch((e: unknown) => {
      const st = (e as { status?: unknown } | null)?.status;
      if (!alive || typeof st !== "number" || st < 400 || st >= 500 || st === 429) return;
      rejectedEarly = true;
      const d = describeSpectateRejection({ kind: "ticket", status: st, error: e });
      setState("rejected");
      setRejectCode(String(st));
      setShowReplay(d.showReplay);
      setStatus(d.text);
    });
    const fail = (prefix: string, e: unknown) => {
      if (!alive) return;
      const d = describeApiError(e);
      setState("error");
      setStatus(`${prefix}: ${d.title} — ${d.detail}`);
    };

    void import("../viewer/PhaserViewer.js")
      .then(async ({ createViewerGame, waitForViewerScene }) => {
        if (!alive || !hostRef.current) return;
        game = createViewerGame(hostRef.current, { targetFps: 60 });
        // FC-D (D3, TD-009): la escena no existe hasta el READY de Phaser. Antes se
        // pedía aquí con getScene → null → TypeError y el visor se quedaba en
        // «conectando…» sin pedir siquiera el ticket.
        let scene: ViewerScene;
        try {
          scene = await waitForViewerScene(game as any);
        } catch (e) {
          fail("el visor no pudo arrancar", e);
          return;
        }
        if (!alive || rejectedEarly) return; // ya se dijo por qué no hay directo
        sceneRef.current = scene;
        setState("connecting");
        setStatus("conectando…");
        // R3.2: LiveFeed fecha los snapshots por su tick (eje de partida) y fija el
        // reloj de reproducción con delay-buffer de ~2 intervalos (DelayClock).
        const feed = new LiveFeed(scene);

        client = new SpectatorClient({
          getTicket: () => {
            const t = firstTicket ?? api<SpectateTicket>("POST", ticketPath);
            firstTicket = null;
            return t;
          },
        });
        const c = client;
        client.on("init", (msg) => {
          setState(msg.finished ? "finished" : "live");
          setStatus(msg.finished ? "batalla terminada" : "en directo");
          setAllowFog(msg.spectator?.allowFogView === true);
          setDebugAvailable(msg.spectator?.debug === true);
          if (msg.meta?.world) scene.setWorld(msg.meta.world);
          // R3.4: nómina pública (nombre + chasis + equipo por vehículo) desde la
          // cabecera init; el visor pinta sprite por chasis y NOMBRE, no el UUID.
          if (msg.meta?.roster) {
            const r = rosterFromMeta(msg.meta.roster);
            scene.setRoster(r);
            setRoster(r);
            const teams = rosterTeams(r);
            setFogTeam((prev) => (prev && teams.includes(prev) ? prev : (teams[0] ?? "")));
          }
          setTitle(participantsTitle(msg.meta?.roster));
          // R3.6: si nos conectamos a una batalla YA terminada, arrastramos el
          // resultado para anunciar el fin sobre el canvas y en el HUD.
          if (msg.finished && msg.result) scene.applyResult(msg.result);
          feed.onInit(msg);
        });
        client.on("snapshot", (s) => {
          feed.onSnapshot(s, c.state.serverTimeMs ?? undefined);
          setOverlayTick(s.tick);
        });
        client.on("event", (e) => feed.onEvent(e));
        client.on("debug", (d) => {
          scene.debugLayers = d.layers;
        });
        client.on("disconnect", () => {
          setState("reconnecting");
          setStatus("reconectando…");
        });
        client.on("reconnected", () => {
          setState("live");
          setStatus("en directo (reconectado)");
        });
        client.on("rejected", (r) => {
          const d = describeSpectateRejection(r);
          setState("rejected");
          setRejectCode(String(r.code ?? r.status ?? ""));
          setShowReplay(d.showReplay);
          setStatus(d.text);
        });
        client.on("result", (result) => {
          setState("finished");
          setStatus("batalla terminada");
          // R3.6: el fin de partida entra al overlay → rótulo sobre el canvas + HUD.
          scene.applyResult(result);
        });
        client.on("gave_up", () => {
          setState("offline");
          setStatus("sin conexión con el servidor de directo tras varios intentos");
        });
        void client.connect();
      })
      .catch((e: unknown) => fail("no se pudo cargar el visor", e));

    return () => {
      alive = false;
      client?.stop();
      game?.destroy(true);
    };
  }, [battleId, attempt]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.cameraMode = camera;
    scene.fog = { allowFogView: allowFog, enabled: fogOn && fogTeam !== "", team: fogTeam };
    scene.showDebug = debugOn && debugAvailable;
  }, [camera, allowFog, fogOn, fogTeam, debugOn, debugAvailable, overlayTick]);

  // UX-R · Sin batalla que ver (rechazo, error, sin conexión) no se pinta el HUD
  // ni los controles de cámara: un «0 — 0 · Preparados» contradice la alerta.
  const failed = state === "rejected" || state === "error" || state === "offline";
  const overlay = failed ? undefined : sceneRef.current?.overlay;
  // 4v4 · bandos de la NÓMINA (y, si aún no la hay, de los vehículos del snapshot):
  // nunca red/blue fijos. Con 8 vehículos, 2 bandos de 4.
  const fromRoster = rosterTeams(roster);
  const sides =
    fromRoster.length > 0
      ? fromRoster
      : sortTeams([...(overlay?.vehicles.values() ?? [])].map((v) => v.team).filter(Boolean));
  return (
    <section>
      <h2 data-testid="viewer-title" style={{ overflowWrap: "anywhere" }}>
        {title ? `Batalla: ${title}` : `Batalla ${battleId}`}
      </h2>
      <p
        data-testid="viewer-status"
        data-state={state}
        data-reject-code={rejectCode}
        role={failed ? "alert" : "status"}
        className={failed ? "error" : undefined}
      >
        {status}
      </p>
      {(showReplay || state === "finished") && (
        <p>
          <a href={`#/replay/${encodeURIComponent(battleId)}?t=0`} data-testid="viewer-replay-link">
            Ver el replay de esta batalla
          </a>
        </p>
      )}
      {(state === "offline" || state === "error") && (
        <button type="button" onClick={() => setAttempt((n) => n + 1)}>
          Reintentar
        </button>
      )}
      <div hidden={failed} data-testid="viewer-controls">
        <button onClick={() => setCamera({ kind: "global" })}>Vista global</button>
        {sides.map((t) => (
          <button key={t} data-testid="camera-side" onClick={() => setCamera({ kind: "team", team: t })}>
            Bando {sideText(t)}
          </button>
        ))}
        {overlay &&
          [...overlay.vehicles.keys()].map((id) => (
            <button key={id} onClick={() => setCamera({ kind: "follow", vehicleId: id })}>
              Seguir {vehicleLabel(roster, id)}
            </button>
          ))}
        {allowFog && sides.length > 0 && (
          <label>
            <input type="checkbox" checked={fogOn} onChange={(e) => setFogOn(e.target.checked)} />
            Niebla de guerra (
            <select
              aria-label="bando de la niebla"
              value={fogTeam || sides[0]}
              onChange={(e) => setFogTeam(e.target.value)}
            >
              {sides.map((t) => (
                <option key={t} value={t}>
                  {sideText(t)}
                </option>
              ))}
            </select>
            )
          </label>
        )}
        {debugAvailable && (
          <label>
            <input type="checkbox" checked={debugOn} onChange={(e) => setDebugOn(e.target.checked)} />
            Capas de depuración
          </label>
        )}
      </div>
      <p hidden={failed} style={{ opacity: 0.7, fontSize: 13 }}>
        Rueda: zoom · arrastre: mover cámara · 1–8: seguir bots · G: vista global
      </p>
      {!failed && <RosterList roster={roster} testId="viewer-roster" />}
      {/* R3.6 · El HUD (marcador, reloj/fase, objetivo, panel de equipos con vida y
          módulos, kill feed, banderas y zonas) se superpone al canvas. El minimapa
          y el rótulo de fin de partida los dibuja Phaser dentro del canvas. */}
      {/* UX-R · El contenedor no deja que el canvas desborde la página en móvil
          (como el del replay): el canvas sigue su ancho por ResizeObserver. */}
      <div
        data-testid="viewer-canvas-host"
        hidden={failed}
        style={{ position: "relative", width: "100%", maxWidth: "100%", height: 640, overflow: "hidden" }}
      >
        <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />
        {overlay && <HudOverlay model={buildHudModel(overlay, { roster: sceneRef.current?.rosterView })} />}
      </div>
      {overlay && (
        <aside>
          <p data-testid="score">
            {Object.entries(overlay.score)
              .map(([t, n]) => `${t}: ${n}`)
              .join(" · ")}
          </p>
          <ul data-testid="feed">
            {overlay.feed.slice(-8).map((f, i) => (
              <li key={i}>
                [{f.tick}] {f.text}
              </li>
            ))}
          </ul>
        </aside>
      )}
    </section>
  );
}
