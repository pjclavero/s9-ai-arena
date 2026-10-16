/**
 * R7-A · Listado global de replays gestionados por el replay-service.
 *
 * Consume `GET /replays/` (servido por el replay-service tras el gateway). Muestra todos
 * los replays (no solo abrir uno conocido) y enlaza al reproductor (`#/replay/:battleId`).
 * No expone secretos ni rutas internas.
 *
 * FC-D (D6, TD-014) · La ruta lleva BARRA FINAL: `fetch("/replays")` (sin barra) caía en
 * la redirección 301 de nginx hacia `location /replays/`, y detrás del proxy TLS esa
 * redirección era ABSOLUTA a `http://` → el navegador la bloqueaba como contenido
 * mixto. Además el gateway ya no redirige (`absolute_redirect off` + `location =
 * /replays`), así que ni un cliente antiguo recibe un `http://`.
 *
 * FC-D (D1/D2) · Estados con los componentes comunes: carga, error clasificado
 * (502 del gateway, timeout, red) con «Reintentar», vacío con siguiente paso.
 */
import { fetchJson } from "../api.js";
import { useResource, ResourceView } from "../resource.js";
import { EmptyState } from "../ui/primitives.js";

interface ReplaySummary {
  battleId: string;
  ticks: number;
  winner: string;
  official: boolean;
  createdAt: string;
  sizeBytes: number;
}

/** Ruta del listado tras el gateway. CON barra final (ver cabecera). */
export const REPLAYS_LIST_URL = "/replays/";

/** Duración aproximada de un replay a 30 ticks/s (motor E2). */
export function formatTicksAsDuration(ticks: number): string {
  const s = Math.round(ticks / 30);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function ReplaysPage() {
  const [list, reload] = useResource(async () => {
    const body = await fetchJson<{ items?: ReplaySummary[] }>(REPLAYS_LIST_URL);
    if (!body || !Array.isArray(body.items)) throw new Error("respuesta del servicio de replays sin `items`");
    return body.items;
  }, []);

  return (
    <section>
      <h2>Replays</h2>
      <ResourceView resource={list} label="los replays" onRetry={reload}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState
              data-testid="replays-empty"
              message="No hay replays todavía. Se crean al terminar una batalla."
              action={<a href="#/battles">Ir a Batallas</a>}
            />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Batalla</th>
                  <th>Resultado</th>
                  <th>Duración</th>
                  <th>Oficial</th>
                  <th>Fecha</th>
                  <th>Ver</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.battleId} data-testid="replay-row" data-battle-id={r.battleId}>
                    <td>
                      <code title={r.battleId}>{r.battleId.slice(0, 8)}</code>
                    </td>
                    <td>{r.winner ? `gana ${r.winner}` : "—"}</td>
                    <td>
                      {formatTicksAsDuration(r.ticks)} ({r.ticks} ticks)
                    </td>
                    <td>{r.official ? "sí" : "no"}</td>
                    <td>{new Date(r.createdAt).toLocaleString()}</td>
                    <td>
                      <a href={`#/replay/${encodeURIComponent(r.battleId)}?t=0`} data-testid="replay-open">
                        Ver replay
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </ResourceView>
    </section>
  );
}
