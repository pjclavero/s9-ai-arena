/**
 * T8.3 · Página del reproductor de replays. Ruta pública, pero el replay sólo se
 * carga si la API lo autoriza (PRC TD-004: participante, equipo, staff o replay
 * público por S9_PUBLIC_REPLAYS_ENABLED). Mismos modos de
 * cámara y overlay que el directo: reutiliza ViewerScene; solo cambia la FUENTE
 * (ReplayPlayer contra el replay-service en vez de SpectatorClient contra el gateway).
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { describeApiError } from "../errors.js";
import { ReplayPlayer, buildShareLink, httpReplaySource } from "../viewer/replay-player.js";
import { ReplayFeed } from "../viewer/replay-feed.js";
import {
  participantsTitle,
  rosterFromMeta,
  rosterTeams,
  sideText,
  type ViewerRoster,
} from "../viewer/art-direction.js";
import { RosterList } from "../viewer/RosterList.js";
import { ReplayTickPublisher } from "../viewer/ui-throttle.js";
import type { ViewerScene } from "../viewer/PhaserViewer.js";
import type { CameraMode } from "../viewer/camera.js";
import { buildHudModel } from "../viewer/hud-model.js";
import { HudOverlay } from "../viewer/HudOverlay.js";
import { MinimapPanel } from "../viewer/MinimapPanel.js";
import {
  BotSelector,
  CameraBar,
  TagPrefsControl,
  TheaterGrid,
  TheaterStyles,
  useViewStatus,
  useWideMain,
} from "../viewer/theater.js";
import { DEFAULT_TAG_PREFS, type TagPrefs } from "../viewer/vehicle-tags.js";

/** Prefetch del trozo N+1 fuera del RAF, a 2 Hz: la red nunca está en el frame. */
const PREFETCH_INTERVAL_MS = 500;

/**
 * PRC (TD-004) · Base que se antepone a las rutas de `httpReplaySource()`
 * (`/replays/<id>/index`, `/replays/<id>/segment`). Queda VACÍA porque el fetch
 * es `api()` (apps/web/src/api.ts), que ya antepone `/api/v1`: el navegador pide
 * `/api/v1/replays/<id>/index`, el gateway quita `/api/v1` y la API resuelve
 * `getReplayIndex`/`getReplaySegment` aplicando la política de acceso.
 *
 * Antes (B6) la base apuntaba al replay-service a través de `location /replays/`
 * del gateway, SIN autenticación: cualquiera bajaba replays privados. Ese
 * `location` ahora responde 404. La cadena cliente → gateway → contrato de la API
 * la ejecuta `apps/web/tests/replay-page-gateway-path.test.ts`.
 */
export const REPLAY_API_BASE = "";

const SPEEDS = [0.5, 1, 2, 4, 8];

/**
 * FC-D · Estado del reproductor, expuesto en `data-state` para la UI y el E2E de
 * navegador: loading → init (Phaser arrancando) → playing/paused → finished, o
 * error (con `data-error-kind`).
 */
export type ReplayState = "loading" | "init" | "playing" | "paused" | "finished" | "error";

/**
 * PRC (TD-004) · Fetch AUTENTICADO del replay: `api()` adjunta el Bearer de la
 * sesión (y refresca si caducó), con el MISMO plazo y clasificación de errores
 * que el resto del panel. Sin sesión, la API sólo sirve replays públicos; el
 * resto responde 404, igual que un replay inexistente.
 */
export const replayApiFetch = async (url: string) => {
  const data = await api<unknown>("GET", url);
  return { ok: true, status: 200, json: async () => data };
};

export function ReplayPage({ battleId, initialTick = 0 }: { battleId: string; initialTick?: number }) {
  useWideMain();
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ViewerScene | null>(null);
  /** UX-VIEW · la escena en estado de React (para suscribirse a su cámara). */
  const [scene, setScene] = useState<ViewerScene | null>(null);
  /** Modo elegido antes de que exista la escena: se aplica UNA vez al crearla. */
  const pendingCamera = useRef<CameraMode | null>(null);
  const [tagPrefs, setTagPrefs] = useState<TagPrefs>(DEFAULT_TAG_PREFS);
  const playerRef = useRef<ReplayPlayer | null>(null);
  const feedRef = useRef<ReplayFeed | null>(null);
  /** Tick de CADA frame (60 fps) sin re-render de React; el slider en pausa lo consulta. */
  const tickRef = useRef(0);
  /** AbortController del seek en curso: un nuevo seek aborta el anterior (R3.3). */
  const seekAbortRef = useRef<AbortController | null>(null);
  const [status, setStatus] = useState("cargando…");
  const [state, setState] = useState<ReplayState>("loading");
  const [errorKind, setErrorKind] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [tick, setTick] = useState(0);
  const [totalTicks, setTotalTicks] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  // UX-R · «Replay Alfa vs Beta» con la nómina del índice, si la trae.
  const [title, setTitle] = useState<string | null>(null);
  /** 4v4 · nómina del índice: de ella salen los botones de cámara por bando. */
  const [roster, setRoster] = useState<ViewerRoster>(() => new Map());
  const viewStatus = useViewStatus(scene);

  useEffect(() => {
    if (!hostRef.current) return;
    let game: { destroy: (removeCanvas: boolean) => void } | null = null;
    let raf = 0;
    let prefetchTimer: ReturnType<typeof setInterval> | null = null;
    let alive = true;

    const fail = (prefix: string, e: unknown) => {
      if (!alive) return;
      const d = describeApiError(e);
      setErrorKind(d.kind);
      setState("error");
      setStatus(`${prefix}: ${d.title} — ${d.detail}`);
    };

    setState("loading");
    setErrorKind(undefined);
    setTitle(null);
    setRoster(new Map());
    setStatus("cargando…");
    void import("../viewer/PhaserViewer.js")
      .then(async ({ createViewerGame, waitForViewerScene }) => {
        if (!alive || !hostRef.current) return;
        // Primero el índice: si el replay no existe no se arranca el motor de render.
        // PRC (TD-004): por la API autorizada (ver REPLAY_API_BASE más arriba).
        const player = new ReplayPlayer(httpReplaySource(REPLAY_API_BASE, battleId, replayApiFetch));
        playerRef.current = player;
        try {
          await player.init(initialTick);
        } catch (e) {
          fail("replay no disponible", e);
          return;
        }
        if (!alive || !hostRef.current) return;
        setTotalTicks(player.index!.ticks);
        setTitle(participantsTitle(player.index?.roster));
        setRoster(rosterFromMeta(player.index?.roster));
        setState("init");
        setStatus("inicializando visor…");
        game = createViewerGame(hostRef.current, { targetFps: 60, interactive: true });
        // FC-D (D3, TD-009): la escena NO existe hasta el READY de Phaser; se espera
        // a esa señal (y al create de la escena), nunca a un sleep.
        let scene: ViewerScene;
        try {
          scene = await waitForViewerScene(game as any);
        } catch (e) {
          fail("el visor no pudo arrancar", e);
          return;
        }
        if (!alive) return;
        sceneRef.current = scene;
        if (pendingCamera.current) scene.cameraMode = pendingCamera.current;
        setScene(scene);

        // R3.4: si el índice del replay trae nómina, sprite por chasis y NOMBRE.
        if (player.index?.roster) scene.setRoster(rosterFromMeta(player.index.roster));
        // UX-D (C-G9): muros, destructibles y bases del mapa con el que se jugó.
        if (player.index?.world && player.index.world.widthM > 0) scene.setWorld(player.index.world);
        setStatus("listo");
        // R3.1 (ERR-VIS-01): la ReplayFeed fecha los snapshots en tiempo de PARTIDA
        // (derivado del playhead) y usa pushSnapshot por snapshot nuevo + resetTo
        // solo tras seek — misma ruta de interpolación que el directo, sin saltos.
        const feed = new ReplayFeed(player, scene);
        feedRef.current = feed;
        player.play();
        setPlaying(true);
        setState("playing");
        setStatus("reproduciendo");

        // R3.3 (ERR-VIS-11): el tick se guarda en un ref en CADA frame (para el
        // slider en pausa) pero sólo se publica al estado de React a ~4 Hz — antes
        // React re-renderizaba la página entera a 60 fps sólo para mover un número.
        const publisher = new ReplayTickPublisher((t) => setTick(t));

        let last = performance.now();
        const loop = async () => {
          if (!alive) return;
          const now = performance.now();
          let finished: boolean;
          try {
            ({ finished } = await feed.frame(now - last));
          } catch (e) {
            // Un segmento que no llega (red, 5xx) se DICE; antes el bucle moría en silencio.
            fail("error al cargar el replay", e);
            return;
          }
          last = now;
          tickRef.current = player.currentTick;
          publisher.onFrame(now, player.currentTick, finished);
          if (finished && player.playing) {
            player.pause();
            setPlaying(false);
            setState("finished");
            setStatus("fin del replay");
          }
          raf = requestAnimationFrame(() => void loop());
        };
        raf = requestAnimationFrame(() => void loop());

        // Prefetch del trozo N+1 FUERA del bucle de RAF: la descarga nunca compite
        // con el render del frame (R3.3).
        prefetchTimer = setInterval(() => {
          if (alive) void player.prefetch();
        }, PREFETCH_INTERVAL_MS);
      })
      .catch((e: unknown) => fail("no se pudo cargar el visor", e));

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      if (prefetchTimer) clearInterval(prefetchTimer);
      seekAbortRef.current?.abort();
      game?.destroy(true);
      sceneRef.current = null;
      setScene(null);
    };
  }, [battleId, initialTick, attempt]);

  // UX-VIEW · Antes un efecto hacía `scene.cameraMode = camera` en CADA tick y pisaba
  // el zoom y el pan manuales. El modo sólo cambia ante una acción del usuario
  // (setCamera, más abajo); las etiquetas sí se aplican al cambiar.
  useEffect(() => {
    const s = sceneRef.current;
    if (s) s.tagPrefs = tagPrefs;
  }, [tagPrefs, scene]);

  const player = playerRef.current;

  /**
   * Seek al soltar el slider (R3.3): un nuevo seek ABORTA el anterior con
   * AbortController, así arrastrar rápido no encola descargas obsoletas. El
   * AbortError del seek cancelado se ignora (era el comportamiento buscado).
   */
  const seekTo = (t: number): void => {
    const feed = feedRef.current;
    if (!feed || !player) return;
    seekAbortRef.current?.abort();
    const ctrl = new AbortController();
    seekAbortRef.current = ctrl;
    void feed
      .seek(t, ctrl.signal)
      .then(() => {
        if (!ctrl.signal.aborted) setTick(player.currentTick);
      })
      .catch((e) => {
        if ((e as Error)?.name !== "AbortError") throw e;
      });
  };

  /** Cambio de cámara por una acción del usuario: va directo a la escena (fuente de verdad). */
  const setCamera = (mode: CameraMode) => {
    pendingCamera.current = mode;
    const s = sceneRef.current;
    if (s) s.cameraMode = mode;
  };
  const call = (fn: (s: ViewerScene) => void) => () => {
    const s = sceneRef.current;
    if (s) fn(s);
  };
  const mode = viewStatus?.mode;
  const overlay = sceneRef.current?.overlay;
  const vehicles = overlay?.vehicles instanceof Map ? overlay.vehicles : undefined;
  const failed = state === "error";

  return (
    <section className="s9v" style={{ ["--s9v-reserve" as string]: "250px" }}>
      <TheaterStyles />
      <div className="s9v-head">
        <h2 data-testid="replay-title" style={{ overflowWrap: "anywhere" }}>
          {title ? `Replay: ${title}` : `Replay ${battleId}`}
        </h2>
        <p>
          <a href="#/replays">← Todos los replays</a>
        </p>
        <p
          data-testid="replay-status"
          data-state={state}
          data-error-kind={errorKind}
          role={state === "error" ? "alert" : "status"}
          className={state === "error" ? "error" : undefined}
        >
          {status}
        </p>
        {state === "error" && errorKind !== "notFound" && (
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Reintentar
          </button>
        )}
      </div>
      <div className="s9v-bar s9v-transport" data-testid="replay-controls">
        <span className="s9v-group" role="group" aria-label="Reproducción">
          <button
            disabled={state === "loading" || state === "init" || state === "error"}
            onClick={() => {
              if (!player) return;
              if (player.playing) {
                player.pause();
                // El tick se publica a ~4 Hz (R3.3): sin esto, «en pausa» mostraría
                // hasta 250 ms de tick viejo y luego saltaría al real. `advance()` sólo
                // mueve el playhead si está reproduciendo, así que éste es el definitivo.
                tickRef.current = player.currentTick;
                setTick(player.currentTick);
                setPlaying(false);
                setState("paused");
              } else {
                // Al final del replay, «Reproducir» vuelve a empezar desde el tick 0.
                if (player.finished) seekTo(0);
                player.play();
                setPlaying(true);
                setState("playing");
                setStatus("reproduciendo");
              }
            }}
          >
            {playing ? "Pausa" : "Reproducir"}
          </button>
          {SPEEDS.map((s) => (
            <button
              key={s}
              disabled={speed === s}
              aria-pressed={speed === s}
              onClick={() => {
                player?.setSpeed(s);
                setSpeed(s);
              }}
            >
              {s}×
            </button>
          ))}
          <button
            onClick={() => {
              const link = `${window.location.origin}${window.location.pathname}${buildShareLink(battleId, tick)}`;
              void navigator.clipboard?.writeText(link).then(() => {
                setShareCopied(true);
                setTimeout(() => setShareCopied(false), 1500);
              });
            }}
          >
            {shareCopied ? "¡Copiado!" : "Compartir este instante"}
          </button>
        </span>
        <input
          type="range"
          min={0}
          max={totalTicks}
          value={tick}
          data-testid="timeline"
          aria-label="Línea de tiempo del replay"
          aria-valuetext={`tick ${tick} de ${totalTicks}`}
          // Arrastrar sólo mueve el pulgar (barato): el tick pintado sigue al slider
          // sin pedir datos. El SEEK real se hace al SOLTAR (R3.3), no en cada píxel.
          onChange={(e) => setTick(Number(e.target.value))}
          onPointerUp={(e) => seekTo(Number((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => seekTo(Number((e.target as HTMLInputElement).value))}
          style={{ width: "100%" }}
        />
        <p data-testid="replay-tick" data-tick={tick} data-total={totalTicks} style={{ margin: 0 }}>
          tick {tick} / {totalTicks} · {speed}×
        </p>
      </div>
      <div className="s9v-bar" data-testid="replay-camera" hidden={failed}>
        <span className="s9v-group" role="group" aria-label="Encuadre">
          <button aria-pressed={mode?.kind === "global"} onClick={() => setCamera({ kind: "global" })}>
            Vista global
          </button>
          {rosterTeams(roster).map((t) => (
            <button
              key={t}
              data-testid="camera-side"
              aria-pressed={mode?.kind === "team" && mode.team === t}
              onClick={() => setCamera({ kind: "team", team: t })}
            >
              Bando {sideText(t)}
            </button>
          ))}
        </span>
        <CameraBar
          status={viewStatus}
          roster={roster}
          disabled={!scene}
          onZoomIn={call((s) => s.zoomIn())}
          onZoomOut={call((s) => s.zoomOut())}
          onFit={call((s) => s.fitMap())}
          onNative={call((s) => s.zoomNative())}
          onCenterSelected={call((s) => s.centerSelected())}
        />
      </div>
      <TheaterGrid
        stage={
          <>
            <div style={{ position: "relative", width: "100%", maxWidth: "100%", overflow: "hidden" }}>
              <div
                ref={hostRef}
                data-testid="replay-canvas-host"
                className="s9v-stage"
                tabIndex={0}
                role="application"
                aria-roledescription="escenario del replay"
                aria-label="Escenario del replay"
                aria-describedby="replay-help"
                data-camera-mode={mode?.kind ?? "global"}
                data-zoom-percent={viewStatus?.zoomPercent ?? 0}
                style={{ width: "100%", maxWidth: "100%", overflow: "hidden" }}
              />
              {/* UX-VIEW · el replay también lleva el HUD compacto (marcador, reloj y kill feed). */}
              {overlay && vehicles && (
                <HudOverlay compact model={buildHudModel(overlay, { roster: sceneRef.current?.rosterView })} />
              )}
            </div>
            <p id="replay-help" className="s9v-help">
              Rueda o pellizco: zoom · arrastrar: mover cámara · toque: seleccionar · 1–8: seguir bots · G: vista global
              · +/−: zoom · F: encajar · C: centrar seleccionado (con el foco en el escenario)
            </p>
          </>
        }
        side={
          <>
            <MinimapPanel
              getState={() => sceneRef.current?.minimapState?.() ?? null}
              onCenter={(x, y) => sceneRef.current?.centerOnWorld?.(x, y)}
              defaultOpen={typeof window === "undefined" || window.innerWidth > 720}
            />
            {vehicles && vehicles.size > 0 && (
              <section className="s9v-card" aria-label="Bots">
                <BotSelector
                  roster={roster}
                  vehicleIds={[...vehicles.keys()]}
                  vehicles={vehicles}
                  status={viewStatus}
                  onFollow={(id) => setCamera({ kind: "follow", vehicleId: id })}
                />
              </section>
            )}
            <section className="s9v-card" aria-label="Participantes">
              <RosterList roster={roster} testId="replay-roster" />
              <TagPrefsControl prefs={tagPrefs} onChange={setTagPrefs} />
            </section>
            {sceneRef.current && (
              <section className="s9v-card" aria-label="Marcador y eventos">
                <p data-testid="score">
                  {Object.entries(sceneRef.current.overlay?.score ?? {})
                    .map(([t, n]) => `${t}: ${n}`)
                    .join(" · ")}
                </p>
                {Array.isArray(overlay?.feed) && overlay.feed.length > 0 && (
                  <ul data-testid="feed">
                    {overlay.feed.slice(-8).map((f, i) => (
                      <li key={i}>
                        [{f.tick}] {f.text}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </>
        }
      />
    </section>
  );
}
