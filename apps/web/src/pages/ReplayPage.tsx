/**
 * T8.3 · Página del reproductor de replays. Pública (sin cuenta). Mismos modos de
 * cámara y overlay que el directo: reutiliza ViewerScene; solo cambia la FUENTE
 * (ReplayPlayer contra el replay-service en vez de SpectatorClient contra el gateway).
 */
import { useEffect, useRef, useState } from "react";
import { ReplayPlayer, buildShareLink, httpReplaySource } from "../viewer/replay-player.js";
import { ReplayFeed } from "../viewer/replay-feed.js";
import type { ViewerScene } from "../viewer/PhaserViewer.js";
import type { CameraMode } from "../viewer/camera.js";

const SPEEDS = [0.5, 1, 2, 4, 8];

export function ReplayPage({ battleId, initialTick = 0 }: { battleId: string; initialTick?: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ViewerScene | null>(null);
  const playerRef = useRef<ReplayPlayer | null>(null);
  const feedRef = useRef<ReplayFeed | null>(null);
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
    let alive = true;

    void import("../viewer/PhaserViewer.js").then(async ({ createViewerGame, ViewerScene }) => {
      if (!alive || !hostRef.current) return;
      game = createViewerGame(hostRef.current);
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

      let last = performance.now();
      const loop = async () => {
        if (!alive) return;
        const now = performance.now();
        const { finished } = await feed.frame(now - last);
        last = now;
        setTick(player.currentTick);
        if (finished) {
          setPlaying(false);
          setStatus("fin del replay");
        }
        raf = requestAnimationFrame(() => void loop());
      };
      raf = requestAnimationFrame(() => void loop());
    });

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      game?.destroy(true);
    };
  }, [battleId, initialTick]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (scene) scene.cameraMode = camera;
  }, [camera, tick]);

  const player = playerRef.current;
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
        onChange={(e) => {
          const t = Number(e.target.value);
          // El seek pasa por la ReplayFeed: reposiciona la escena con resetTo
          // (sin arrastrar interpolación del tramo anterior), incluso en pausa.
          void feedRef.current?.seek(t).then(() => setTick(player!.currentTick));
        }}
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
