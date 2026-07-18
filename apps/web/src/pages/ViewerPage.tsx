/**
 * T8.2 · Página del visor en directo. Pública: un visitante anónimo ve la batalla
 * sin cuenta (DoD T7.5/T8.2). Monta Phaser (render) y SpectatorClient (transporte),
 * ambos ya probados por separado; aquí solo se cablean.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { SpectatorClient } from "../viewer/spectator-client.js";
import { LiveFeed } from "../viewer/live-feed.js";
import { rosterFromMeta } from "../viewer/art-direction.js";
import type { ViewerScene } from "../viewer/PhaserViewer.js";
import type { CameraMode } from "../viewer/camera.js";

export function ViewerPage({ battleId }: { battleId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ViewerScene | null>(null);
  const [status, setStatus] = useState("conectando…");
  const [allowFog, setAllowFog] = useState(false);
  const [fogOn, setFogOn] = useState(false);
  const [fogTeam, setFogTeam] = useState("red");
  const [debugAvailable, setDebugAvailable] = useState(false);
  const [debugOn, setDebugOn] = useState(false);
  const [camera, setCamera] = useState<CameraMode>({ kind: "global" });
  const [overlayTick, setOverlayTick] = useState(0);

  useEffect(() => {
    if (!hostRef.current) return;
    let game: { destroy: (removeCanvas: boolean) => void } | null = null;
    let client: SpectatorClient | null = null;
    let alive = true;

    // Phaser se importa dinámicamente: el resto del panel no carga el motor de render.
    void import("../viewer/PhaserViewer.js").then(({ createViewerGame, ViewerScene }) => {
      if (!alive || !hostRef.current) return;
      game = createViewerGame(hostRef.current, { targetFps: 60 });
      const scene = (game as any).scene.getScene("viewer") as InstanceType<typeof ViewerScene>;
      sceneRef.current = scene;
      // R3.2: LiveFeed fecha los snapshots por su tick (eje de partida) y fija el
      // reloj de reproducción con delay-buffer de ~2 intervalos (DelayClock).
      const feed = new LiveFeed(scene);

      client = new SpectatorClient({
        getTicket: () => api("POST", `/battles/${battleId}/spectate-ticket`),
      });
      const c = client;
      client.on("init", (msg) => {
        setStatus("en directo");
        setAllowFog(msg.spectator?.allowFogView === true);
        setDebugAvailable(msg.spectator?.debug === true);
        if (msg.meta?.world) scene.setWorld(msg.meta.world);
        // R3.4: nómina pública (nombre + chasis + equipo por vehículo) desde la
        // cabecera init; el visor pinta sprite por chasis y NOMBRE, no el UUID.
        if (msg.meta?.roster) scene.setRoster(rosterFromMeta(msg.meta.roster));
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
      client.on("disconnect", () => setStatus("reconectando…"));
      client.on("reconnected", () => setStatus("en directo (reconectado)"));
      client.on("result", () => setStatus("batalla terminada"));
      client.on("gave_up", () => setStatus("sin conexión"));
      void client.connect();
    });

    return () => {
      alive = false;
      client?.stop();
      game?.destroy(true);
    };
  }, [battleId]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.cameraMode = camera;
    scene.fog = { allowFogView: allowFog, enabled: fogOn, team: fogTeam };
    scene.showDebug = debugOn && debugAvailable;
  }, [camera, allowFog, fogOn, fogTeam, debugOn, debugAvailable, overlayTick]);

  const overlay = sceneRef.current?.overlay;
  return (
    <section>
      <h2>Batalla {battleId}</h2>
      <p data-testid="viewer-status">{status}</p>
      <div>
        <button onClick={() => setCamera({ kind: "global" })}>Vista global</button>
        <button onClick={() => setCamera({ kind: "team", team: "red" })}>Equipo rojo</button>
        <button onClick={() => setCamera({ kind: "team", team: "blue" })}>Equipo azul</button>
        {overlay &&
          [...overlay.vehicles.keys()].map((id) => (
            <button key={id} onClick={() => setCamera({ kind: "follow", vehicleId: id })}>
              Seguir {id}
            </button>
          ))}
        {allowFog && (
          <label>
            <input type="checkbox" checked={fogOn} onChange={(e) => setFogOn(e.target.checked)} />
            Niebla de guerra (
            <select value={fogTeam} onChange={(e) => setFogTeam(e.target.value)}>
              <option value="red">rojo</option>
              <option value="blue">azul</option>
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
      <p style={{ opacity: 0.7, fontSize: 13 }}>
        Rueda: zoom · arrastre: mover cámara · 1–4: seguir bots · G: vista global
      </p>
      <div ref={hostRef} style={{ width: "100%", height: 640 }} />
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
