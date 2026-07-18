/**
 * T7.4 · App del panel: navegación por hash, sesión y ocultación por rol (la API autoriza).
 *
 * R3.7 (ERR-VIS-02/03/04/10):
 *  - la sesión sobrevive a un F5: bootstrapSession() la recupera desde la
 *    cookie httpOnly (nada en localStorage) y el interceptor único de 401 de
 *    api.ts redirige aquí (onSessionExpired) con mensaje accesible;
 *  - rutas nuevas #/tournaments, #/tournaments/<id> y #/battles (con filtro por
 *    bot): torneos y batallas por ENLACES, sin teclear UUIDs;
 *  - error boundary global + por pantalla (un fallo de render no deja la app
 *    en blanco) y el catálogo es un recurso con carga/error/reintento.
 */
import { useEffect, useState } from "react";
import { api, bootstrapSession, logout, onSessionExpired, getToken, type Me } from "./api.js";
import type { ModuleDefinition } from "../../../packages/module-catalog/types.js";
import { LoginPage } from "./pages/LoginPage.js";
import { BotsPage } from "./pages/BotsPage.js";
import { TeamsPage } from "./pages/TeamsPage.js";
import { AdminPage, isAdmin } from "./pages/AdminPage.js";
import { ViewerPage } from "./pages/ViewerPage.js";
import { ReplayPage } from "./pages/ReplayPage.js";
import { TournamentsPage } from "./pages/TournamentsPage.js";
import { TournamentDetailPage } from "./pages/TournamentDetailPage.js";
import { BattlesPage } from "./pages/BattlesPage.js";
import { MapsPage } from "./pages/MapsPage.js";
import { parseShareLink } from "./viewer/replay-player.js";
import { matchBroadcastRoute } from "./broadcast/config.js";
import { BroadcastPage } from "./pages/BroadcastPage.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { useResource, ResourceView } from "./resource.js";

const BUDGET_DEFAULT = 1000; // BUDGET_CREDITS_MVP; el ruleset de cada torneo puede cambiarlo (D7)

/**
 * E8 · Rutas públicas: #/viewer/<battleId> (directo) y #/replay/<battleId>?t=<tick>
 * (enlace compartible con tick inicial, DoD T8.3).
 */
export function matchPublicRoute(
  route: string,
): { kind: "viewer"; battleId: string } | { kind: "replay"; battleId: string; t: number } | null {
  const viewer = /^#\/viewer\/([^/?]+)/.exec(route);
  if (viewer) return { kind: "viewer", battleId: decodeURIComponent(viewer[1]) };
  const replay = parseShareLink(route); // el MISMO parser que genera los enlaces (T8.3)
  if (replay) return { kind: "replay", battleId: replay.battleId, t: replay.t };
  return null;
}

/** R3.7 · Rutas del panel autenticado (además de #/bots, #/teams y #/admin). */
export function matchPanelRoute(
  route: string,
): { kind: "tournament"; id: string } | { kind: "battles"; botFilter?: string } | null {
  const detail = /^#\/tournaments\/([^/?]+)/.exec(route);
  if (detail) return { kind: "tournament", id: decodeURIComponent(detail[1]) };
  const battles = /^#\/battles(?:\?bot=([^&]+))?/.exec(route);
  if (battles) return { kind: "battles", botFilter: battles[1] ? decodeURIComponent(battles[1]) : undefined };
  return null;
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [booting, setBooting] = useState(true);
  const [notice, setNotice] = useState("");
  const [route, setRoute] = useState(window.location.hash || "#/bots");

  useEffect(() => {
    const onHash = () => setRoute(window.location.hash || "#/bots");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // R3.7 · Interceptor único de 401 (api.ts): si el refresh falla, se limpia la
  // sesión y se vuelve al login con un mensaje anunciado (role="alert").
  useEffect(() => {
    onSessionExpired((reason) => {
      setMe(null);
      setNotice(reason);
    });
    return () => onSessionExpired(null);
  }, []);

  // R3.7 · F5 mantiene la sesión: refresh desde la cookie httpOnly al arrancar.
  useEffect(() => {
    let alive = true;
    bootstrapSession()
      .then((who) => {
        if (alive && who) setMe(who);
      })
      .finally(() => {
        if (alive) setBooting(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // R3.7 (ERR-VIS-10) · El catálogo es un RECURSO: si su carga falla, la página
  // de bots lo dice y ofrece reintentar (antes se quedaba en "Cargando…" eterno).
  const [catalogRes, reloadCatalog] = useResource<{ version: string; modules: ModuleDefinition[] }>(async () => {
    if (!me) return { version: "mvp@1", modules: [] };
    const versions = await api<{ catalogVersion: string }[]>("GET", "/catalog/versions");
    if (versions.length === 0) return { version: "mvp@1", modules: [] };
    const v = versions[versions.length - 1].catalogVersion;
    return { version: v, modules: await api<ModuleDefinition[]>("GET", `/catalog/${encodeURIComponent(v)}/modules`) };
  }, [me?.id]);

  // E11/T11.1: la vista /broadcast (composición 1080p para captura, cap. 21) es
  // pública, sin panel ni login, y se autoconfigura por query (?battle|?tournament).
  const broadcast = matchBroadcastRoute(window.location.pathname, window.location.search, route);
  if (broadcast) return <BroadcastPage config={broadcast} />;

  // E8: el visor y los replays son PÚBLICOS (DoD T7.5: un visitante anónimo ve la
  // batalla en directo y el replay sin cuenta). No pasan por el login del panel.
  const publicView = matchPublicRoute(route);
  if (publicView) {
    return (
      <main>
        <h1>S9 AI Arena</h1>
        <ErrorBoundary label="el visor">
          {publicView.kind === "viewer" ? (
            <ViewerPage battleId={publicView.battleId} />
          ) : (
            <ReplayPage battleId={publicView.battleId} initialTick={publicView.t} />
          )}
        </ErrorBoundary>
      </main>
    );
  }

  if (booting) {
    return (
      <main>
        <h1>S9 AI Arena</h1>
        <p role="status" aria-live="polite">
          Recuperando sesión…
        </p>
      </main>
    );
  }

  if (!me || !getToken()) {
    return (
      <main>
        <h1>S9 AI Arena</h1>
        <ErrorBoundary label="el acceso">
          <LoginPage
            notice={notice}
            onLogin={(who) => {
              setNotice("");
              setMe(who);
            }}
          />
        </ErrorBoundary>
      </main>
    );
  }

  const panelRoute = matchPanelRoute(route);

  return (
    <ErrorBoundary label="el panel">
      <nav aria-label="principal">
        <strong>S9 AI Arena</strong>
        <a href="#/bots">Mis bots</a>
        <a href="#/teams">Equipos</a>
        <a href="#/tournaments">Torneos</a>
        <a href="#/battles">Batallas</a>
        <a href="#/maps">Mapas</a>
        {/* La interfaz solo OCULTA; la autorización la hace la API (cap. 16) */}
        {isAdmin(me) && (
          <a href="#/admin" data-testid="admin-link">
            Administración
          </a>
        )}
        <span style={{ marginLeft: "auto" }}>
          {me.displayName} ({me.roles.join(", ")})
        </span>
        <button
          type="button"
          data-testid="logout"
          onClick={() => {
            void logout().then(() => {
              setNotice("Sesión cerrada.");
              setMe(null);
            });
          }}
        >
          Salir
        </button>
      </nav>
      <main>
        <ErrorBoundary label="esta pantalla">
          {panelRoute?.kind === "tournament" ? (
            <TournamentDetailPage id={panelRoute.id} me={me} />
          ) : panelRoute?.kind === "battles" ? (
            <BattlesPage botFilter={panelRoute.botFilter} />
          ) : route.startsWith("#/tournaments") ? (
            <TournamentsPage me={me} />
          ) : route.startsWith("#/teams") ? (
            <TeamsPage me={me} />
          ) : route.startsWith("#/maps") ? (
            <MapsPage me={me} />
          ) : route.startsWith("#/admin") ? (
            <AdminPage me={me} />
          ) : (
            <ResourceView resource={catalogRes} label="el catálogo" onRetry={reloadCatalog}>
              {(cat) => (
                <BotsPage me={me} catalog={cat.modules} catalogVersion={cat.version} budgetCredits={BUDGET_DEFAULT} />
              )}
            </ResourceView>
          )}
        </ErrorBoundary>
      </main>
    </ErrorBoundary>
  );
}
