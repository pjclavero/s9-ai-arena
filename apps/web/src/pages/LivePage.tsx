/**
 * R11 · Página pública #/live: lista las batallas en directo publicadas por
 * GET /public/battles/live, sin cuenta. Sigue el patrón R3.7 (ERR-VIS-10) de
 * carga/error por recurso: un fallo se ANUNCIA (role="alert") con reintento,
 * nunca se pinta como lista vacía. Si la capability (S9_PUBLIC_SPECTATE_ENABLED)
 * está apagada, la API responde enabled:false y aquí se muestra un aviso claro
 * en vez de una lista vacía engañosa.
 *
 * UX-D · El aviso explica que es una DECISIÓN de configuración (no un fallo) y
 * dónde ver tus propias batallas; el modo sale en palabras, no como código.
 */
import { api } from "../api.js";
import { useResource, ResourceView } from "../resource.js";
import { MODE_TEXT } from "../battle-result.js";

interface PublicLiveBattle {
  id: string;
  status: string;
  mode: string;
  mapId: string;
  mapName: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

interface PublicLiveBattles {
  enabled: boolean;
  battles: PublicLiveBattle[];
}

export function LivePage() {
  const [res, reload] = useResource<PublicLiveBattles>(() => api<PublicLiveBattles>("GET", "/public/battles/live"), []);

  return (
    <section>
      <h2>En directo</h2>
      <ResourceView resource={res} label="las batallas en directo" onRetry={reload}>
        {(data) =>
          !data.enabled ? (
            <div data-testid="live-disabled">
              <p>La emisión pública está desactivada en este entorno.</p>
              <p>
                No es un fallo: quien administra la plataforma ha decidido no emitir batallas a visitantes sin cuenta.
                Tus propias batallas sí se pueden seguir en directo: entra con tu cuenta y ábrelas desde{" "}
                <a href="#/battles">Batallas</a>.
              </p>
            </div>
          ) : data.battles.length === 0 ? (
            <p data-testid="live-empty">
              No hay ninguna batalla pública en directo ahora mismo (las de bots privados sólo las ven sus dueños).
            </p>
          ) : (
            <ul data-testid="live-battles">
              {data.battles.map((b) => (
                <li key={b.id}>
                  <a href={`#/viewer/${encodeURIComponent(b.id)}`}>
                    {b.mapName} · {MODE_TEXT[b.mode] ?? b.mode}
                  </a>
                </li>
              ))}
            </ul>
          )
        }
      </ResourceView>
    </section>
  );
}
