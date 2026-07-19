/**
 * R7-A · Listado global de replays gestionados por el replay-service.
 *
 * Consume `GET /replays` (servido por el replay-service tras el gateway). Muestra todos
 * los replays (no solo abrir uno conocido) y enlaza al visor/reproductor existentes
 * (`#/viewer/:battleId`, `#/replay/:battleId`). No expone secretos ni rutas internas.
 */
import { useEffect, useState } from "react";

interface ReplaySummary {
  battleId: string;
  ticks: number;
  winner: string;
  official: boolean;
  createdAt: string;
  sizeBytes: number;
}

type State = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ok"; items: ReplaySummary[] };

export function ReplaysPage() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/replays");
        if (!res.ok) throw new Error(`replay-service respondió ${res.status}`);
        const body = (await res.json()) as { items: ReplaySummary[] };
        if (alive) setState({ kind: "ok", items: body.items ?? [] });
      } catch (e) {
        if (alive) setState({ kind: "error", message: (e as Error).message });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (state.kind === "loading") {
    return (
      <section>
        <h2>Replays</h2>
        <p role="status" aria-live="polite">
          Cargando replays…
        </p>
      </section>
    );
  }
  if (state.kind === "error") {
    return (
      <section>
        <h2>Replays</h2>
        <p role="alert" className="error">
          Servicio de replays no disponible: {state.message}
        </p>
      </section>
    );
  }
  if (state.items.length === 0) {
    return (
      <section>
        <h2>Replays</h2>
        <p>No hay replays todavía. Se crean al ejecutar batallas (arnés real o ejecución containerizada).</p>
      </section>
    );
  }

  return (
    <section>
      <h2>Replays</h2>
      <table>
        <thead>
          <tr>
            <th>Batalla</th>
            <th>Resultado</th>
            <th>Ticks</th>
            <th>Oficial</th>
            <th>Fecha</th>
            <th>Ver</th>
          </tr>
        </thead>
        <tbody>
          {state.items.map((r) => (
            <tr key={r.battleId} data-testid="replay-row">
              <td>
                <code>{r.battleId}</code>
              </td>
              <td>{r.winner}</td>
              <td>{r.ticks}</td>
              <td>{r.official ? "sí" : "no"}</td>
              <td>{new Date(r.createdAt).toLocaleString()}</td>
              <td>
                <a href={`#/viewer/${encodeURIComponent(r.battleId)}`}>visor</a>
                {" · "}
                <a href={`#/replay/${encodeURIComponent(r.battleId)}`}>reproductor</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
