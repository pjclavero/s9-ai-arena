/** T7.4 · App del panel: navegación por hash, sesión y ocultación por rol (la API autoriza). */
import { useEffect, useState } from "react";
import { api, getToken, type Me } from "./api.js";
import type { ModuleDefinition } from "../../../packages/module-catalog/types.js";
import { LoginPage } from "./pages/LoginPage.js";
import { BotsPage } from "./pages/BotsPage.js";
import { TeamsPage } from "./pages/TeamsPage.js";
import { AdminPage, isAdmin } from "./pages/AdminPage.js";
import { ViewerPage } from "./pages/ViewerPage.js";
import { ReplayPage } from "./pages/ReplayPage.js";
import { parseShareLink } from "./viewer/replay-player.js";
import { matchBroadcastRoute } from "./broadcast/config.js";
import { BroadcastPage } from "./pages/BroadcastPage.js";

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

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [route, setRoute] = useState(window.location.hash || "#/bots");
  const [catalog, setCatalog] = useState<ModuleDefinition[]>([]);
  const [catalogVersion, setCatalogVersion] = useState("mvp@1");

  useEffect(() => {
    const onHash = () => setRoute(window.location.hash || "#/bots");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (!me) return;
    api<{ catalogVersion: string }[]>("GET", "/catalog/versions")
      .then(async (versions) => {
        if (versions.length > 0) {
          const v = versions[versions.length - 1].catalogVersion;
          setCatalogVersion(v);
          setCatalog(await api<ModuleDefinition[]>("GET", `/catalog/${encodeURIComponent(v)}/modules`));
        }
      })
      .catch(() => {});
  }, [me]);

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
        {publicView.kind === "viewer" ? (
          <ViewerPage battleId={publicView.battleId} />
        ) : (
          <ReplayPage battleId={publicView.battleId} initialTick={publicView.t} />
        )}
      </main>
    );
  }

  if (!me || !getToken()) {
    return (
      <main>
        <h1>S9 AI Arena</h1>
        <LoginPage onLogin={setMe} />
      </main>
    );
  }

  return (
    <>
      <nav>
        <strong>S9 AI Arena</strong>
        <a href="#/bots">Mis bots</a>
        <a href="#/teams">Equipos</a>
        {/* La interfaz solo OCULTA; la autorización la hace la API (cap. 16) */}
        {isAdmin(me) && (
          <a href="#/admin" data-testid="admin-link">
            Administración
          </a>
        )}
        <span style={{ marginLeft: "auto" }}>
          {me.displayName} ({me.roles.join(", ")})
        </span>
      </nav>
      <main>
        {route.startsWith("#/teams") ? (
          <TeamsPage me={me} />
        ) : route.startsWith("#/admin") ? (
          <AdminPage me={me} />
        ) : catalog.length > 0 ? (
          <BotsPage me={me} catalog={catalog} catalogVersion={catalogVersion} budgetCredits={BUDGET_DEFAULT} />
        ) : (
          <p>Cargando catálogo…</p>
        )}
      </main>
    </>
  );
}
