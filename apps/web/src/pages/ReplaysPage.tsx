/**
 * R7-A · Listado de los replays que el usuario puede ver.
 *
 * PRC (TD-004) · Consume `GET /api/v1/replays` (listReplays): SÓLO los replays que el
 * usuario puede ver (staff, dueño o equipo de un bot participante, o públicos si
 * S9_PUBLIC_REPLAYS_ENABLED). Antes leía `GET /replays/` del replay-service a
 * través del gateway: el inventario de TODOS los ficheros, también para anónimos.
 * Enlaza al reproductor (`#/replay/:battleId`). No expone secretos ni rutas internas.
 *
 * TD-014 sigue cerrada: la ruta es de la API (`/api/v1/replays`), sin barra final
 * ni redirección; el gateway ya no tiene `location /replays/` que redirigir.
 *
 * FC-D (D1/D2) · Estados con los componentes comunes: carga, error clasificado
 * (502 del gateway, timeout, red) con «Reintentar», vacío con siguiente paso.
 */
import { api } from "../api.js";
import { useResource, ResourceView } from "../resource.js";
import { EmptyState } from "../ui/primitives.js";
import { teamText } from "../battle-result.js";

interface ReplaySummary {
  battleId: string;
  ticks: number;
  winner: string;
  official: boolean;
  createdAt: string;
  sizeBytes: number;
}

/** Ruta del listado en la API (relativa a /api/v1, la antepone `api()`). */
export const REPLAYS_LIST_PATH = "/replays";

/** Duración aproximada de un replay a 30 ticks/s (motor E2). */
export function formatTicksAsDuration(ticks: number): string {
  const s = Math.round(ticks / 30);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function ReplaysPage() {
  const [list, reload] = useResource(async () => {
    const body = await api<{ items?: ReplaySummary[] }>("GET", REPLAYS_LIST_PATH);
    if (!body || !Array.isArray(body.items)) throw new Error("respuesta de la API de replays sin `items`");
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
            <table className="stack-table">
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
                    <td>{r.winner === "draw" ? "empate" : r.winner ? `gana ${teamText(r.winner)}` : "—"}</td>
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
