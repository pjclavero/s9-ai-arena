/**
 * R11 · Página pública #/live: lista las batallas en directo publicadas por
 * GET /public/battles/live, sin cuenta. Sigue el patrón R3.7 (ERR-VIS-10) de
 * carga/error por recurso: un fallo se ANUNCIA (role="alert") con reintento,
 * nunca se pinta como lista vacía.
 *
 * EQ4 · No se confunde «no hay batallas» con «no tienes permiso»:
 *  - VISITANTE sin cuenta y emisión pública apagada (enabled:false): «La emisión
 *    pública para visitantes está desactivada.» (es una decisión de
 *    configuración, no un fallo);
 *  - USUARIO con sesión: además de las públicas, las batallas EN CURSO que su
 *    cuenta puede ver (GET /battles?status=running; la API aplica la política de
 *    battle-access.ts). Si no hay ninguna: «No hay ninguna batalla en directo en
 *    este momento. Cuando una batalla esté en curso aparecerá aquí.» El apagado
 *    de la emisión pública es, para él, sólo una nota secundaria.
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

interface OwnBattle {
  id: string;
  mode?: string;
  mapId?: string;
  mapName?: string;
}

interface LiveView {
  publicEnabled: boolean;
  battles: { id: string; mode: string; mapName: string }[];
}

export const LIVE_EMPTY_TEXT =
  "No hay ninguna batalla en directo en este momento. Cuando una batalla esté en curso aparecerá aquí.";
export const LIVE_PUBLIC_OFF_TEXT = "La emisión pública para visitantes está desactivada.";

export function LivePage(props: { loggedIn?: boolean } = {}) {
  const loggedIn = props.loggedIn === true;
  const [res, reload] = useResource<LiveView>(async () => {
    const [pub, own] = await Promise.all([
      api<PublicLiveBattles>("GET", "/public/battles/live"),
      loggedIn ? api<{ items: OwnBattle[] }>("GET", "/battles?status=running") : Promise.resolve({ items: [] }),
    ]);
    const seen = new Set<string>();
    const battles: LiveView["battles"] = [];
    for (const b of [...(pub.enabled ? pub.battles : []), ...(own.items ?? [])]) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      battles.push({ id: b.id, mode: b.mode ?? "", mapName: b.mapName ?? b.mapId ?? "mapa" });
    }
    return { publicEnabled: pub.enabled, battles };
  }, [loggedIn]);

  return (
    <section>
      <h2>En directo</h2>
      <ResourceView resource={res} label="las batallas en directo" onRetry={reload}>
        {(data) =>
          !data.publicEnabled && !loggedIn ? (
            <div data-testid="live-disabled">
              <p>
                <strong>{LIVE_PUBLIC_OFF_TEXT}</strong>
              </p>
              <p>
                No es un fallo: quien administra la plataforma ha decidido no emitir batallas a visitantes sin cuenta.
                Tus propias batallas sí se pueden seguir en directo: entra con tu cuenta y ábrelas desde{" "}
                <a href="#/battles">Batallas</a>.
              </p>
            </div>
          ) : (
            <>
              {data.battles.length === 0 ? (
                <p data-testid="live-empty">{LIVE_EMPTY_TEXT}</p>
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
              )}
              {loggedIn && !data.publicEnabled && (
                <p className="muted" data-testid="live-public-off-note">
                  <small>
                    {LIVE_PUBLIC_OFF_TEXT} Aquí ves las batallas en curso que tu cuenta puede ver.
                  </small>
                </p>
              )}
            </>
          )
        }
      </ResourceView>
    </section>
  );
}
