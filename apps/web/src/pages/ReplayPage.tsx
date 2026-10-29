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
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ViewerScene | null>(null);
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
  const [camera, setCamera] = useState<CameraMode>({ kind: "global" });
  const [shareCopied, setShareCopied] = useState(false);
  // UX-R · «Replay Alfa vs Beta» con la nómina del índice, si la trae.
  const [title, setTitle] = useState<string | null>(null);
  /** 4v4 · nómina del índice: de ella salen los botones de cámara por bando. */
  const [roster, setRoster] = useState<ViewerRoster>(() => new Map());

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
        game = createViewerGame(hostRef.current, { targetFps: 60 });
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
    };
  }, [battleId, initialTick, attempt]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (scene) scene.cameraMode = camera;
  }, [camera, tick]);

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

  return (
    <section>
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
      <div>
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
        <button onClick={() => setCamera({ kind: "global" })}>Vista global</button>
        {rosterTeams(roster).map((t) => (
          <button key={t} data-testid="camera-side" onClick={() => setCamera({ kind: "team", team: t })}>
            Bando {sideText(t)}
          </button>
        ))}
      </div>
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
      <p data-testid="replay-tick" data-tick={tick} data-total={totalTicks}>
        tick {tick} / {totalTicks} · {speed}×
      </p>
      <RosterList roster={roster} testId="replay-roster" />
      <div
        ref={hostRef}
        data-testid="replay-canvas-host"
        style={{ width: "100%", maxWidth: "100%", height: 640, overflow: "hidden" }}
      />
      {sceneRef.current && (
        <aside>
          <p data-testid="score">
            {Object.entries(sceneRef.current.overlay.score)
              .map(([t, n]) => `${t}: ${n}`)
              .join(" · ")}
          </p>
        </aside>
      )}
    </section>
  );
}
