/**
 * T8.3 · Página del reproductor de replays. Pública (sin cuenta). Mismos modos de
 * cámara y overlay que el directo: reutiliza ViewerScene; solo cambia la FUENTE
 * (ReplayPlayer contra el replay-service en vez de SpectatorClient contra el gateway).
 */
import { useEffect, useRef, useState } from "react";
import { ReplayPlayer, buildShareLink, httpReplaySource } from "../viewer/replay-player.js";
import { ReplayFeed } from "../viewer/replay-feed.js";
import { ReplayTickPublisher } from "../viewer/ui-throttle.js";
import type { ViewerScene } from "../viewer/PhaserViewer.js";
import type { CameraMode } from "../viewer/camera.js";

/** Prefetch del trozo N+1 fuera del RAF, a 2 Hz: la red nunca está en el frame. */
const PREFETCH_INTERVAL_MS = 500;

const SPEEDS = [0.5, 1, 2, 4, 8];

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
  const [tick, setTick] = useState(0);
  const [totalTicks, setTotalTicks] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [camera, setCamera] = useState<CameraMode>({ kind: "global" });
  const [shareCopied, setShareCopied] = useState(false);

  useEffect(() => {
    if (!hostRef.current) return;
    let game: { destroy: (removeCanvas: boolean) => void } | null = null;
    let raf = 0;
    let prefetchTimer: ReturnType<typeof setInterval> | null = null;
    let alive = true;

    void import("../viewer/PhaserViewer.js").then(async ({ createViewerGame, ViewerScene }) => {
      if (!alive || !hostRef.current) return;
      game = createViewerGame(hostRef.current, { targetFps: 60 });
      const scene = (game as any).scene.getScene("viewer") as InstanceType<typeof ViewerScene>;
      sceneRef.current = scene;

      // El gateway (E10) enruta /replay-service/* al servicio interno.
      const player = new ReplayPlayer(httpReplaySource("/replay-service", battleId));
      playerRef.current = player;
      try {
        await player.init(initialTick);
      } catch (e) {
        setStatus(`replay no disponible: ${(e as Error).message}`);
        return;
      }
      setTotalTicks(player.index!.ticks);
      setStatus("listo");
      // R3.1 (ERR-VIS-01): la ReplayFeed fecha los snapshots en tiempo de PARTIDA
      // (derivado del playhead) y usa pushSnapshot por snapshot nuevo + resetTo
      // solo tras seek — misma ruta de interpolación que el directo, sin saltos.
      const feed = new ReplayFeed(player, scene);
      feedRef.current = feed;
      player.play();
      setPlaying(true);

      // R3.3 (ERR-VIS-11): el tick se guarda en un ref en CADA frame (para el
      // slider en pausa) pero sólo se publica al estado de React a ~4 Hz — antes
      // React re-renderizaba la página entera a 60 fps sólo para mover un número.
      const publisher = new ReplayTickPublisher((t) => setTick(t));

      let last = performance.now();
      const loop = async () => {
        if (!alive) return;
        const now = performance.now();
        const { finished } = await feed.frame(now - last);
        last = now;
        tickRef.current = player.currentTick;
        publisher.onFrame(now, player.currentTick, finished);
        if (finished) {
          setPlaying(false);
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
    });

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      if (prefetchTimer) clearInterval(prefetchTimer);
      seekAbortRef.current?.abort();
      game?.destroy(true);
    };
  }, [battleId, initialTick]);

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
      <h2>Replay {battleId}</h2>
      <p data-testid="replay-status">{status}</p>
      <div>
        <button
          onClick={() => {
            if (!player) return;
            if (player.playing) {
              player.pause();
              setPlaying(false);
            } else {
              player.play();
              setPlaying(true);
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
        <button onClick={() => setCamera({ kind: "team", team: "red" })}>Equipo rojo</button>
        <button onClick={() => setCamera({ kind: "team", team: "blue" })}>Equipo azul</button>
      </div>
      <input
        type="range"
        min={0}
        max={totalTicks}
        value={tick}
        data-testid="timeline"
        // Arrastrar sólo mueve el pulgar (barato): el tick pintado sigue al slider
        // sin pedir datos. El SEEK real se hace al SOLTAR (R3.3), no en cada píxel.
        onChange={(e) => setTick(Number(e.target.value))}
        onPointerUp={(e) => seekTo(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => seekTo(Number((e.target as HTMLInputElement).value))}
        style={{ width: "100%" }}
      />
      <p>
        tick {tick} / {totalTicks} · {speed}×
      </p>
      <div ref={hostRef} style={{ width: "100%", height: 640 }} />
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
