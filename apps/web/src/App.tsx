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
import { describeApiError } from "./errors.js";
import type { ModuleDefinition } from "../../../packages/module-catalog/types.js";
import { LoginPage } from "./pages/LoginPage.js";
import { BotsPage } from "./pages/BotsPage.js";
import { TeamsPage } from "./pages/TeamsPage.js";
import { AdminPage, isAdmin } from "./pages/AdminPage.js";
import { ViewerPage } from "./pages/ViewerPage.js";
import { LivePage } from "./pages/LivePage.js";
import { RankingPage } from "./pages/RankingPage.js"; // N6 · #/ranking, solo lectura (GET /standings, público)
import { ReplayPage } from "./pages/ReplayPage.js";
import { TournamentsPage } from "./pages/TournamentsPage.js";
import { TournamentDetailPage } from "./pages/TournamentDetailPage.js";
import { BracketPage } from "./pages/BracketPage.js"; // R12 (slice 1, solo lectura): #/tournaments/:id/bracket
import { BattlesPage } from "./pages/BattlesPage.js";
// R9 · crear batalla de práctica desde la UI (usa POST /battles seguro; ver BattleNewPage).
import { BattleNewPage } from "./pages/BattleNewPage.js";
import { MapsPage } from "./pages/MapsPage.js";
import { MapEditorPage } from "./pages/MapEditorPage.js";
import { ReplaysPage } from "./pages/ReplaysPage.js"; // R7-A · listado global de replays
import { SystemPage } from "./pages/SystemPage.js";
import { AuditPage } from "./pages/AuditPage.js";
import { RolesPage } from "./pages/RolesPage.js";
import { parseShareLink } from "./viewer/replay-player.js";
import { matchBroadcastRoute } from "./broadcast/config.js";
import { BroadcastPage } from "./pages/BroadcastPage.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { useResource, ResourceView } from "./resource.js";
import { NotFoundPage } from "./pages/NotFoundPage.js";

const BUDGET_DEFAULT = 1000; // BUDGET_CREDITS_MVP; el ruleset de cada torneo puede cambiarlo (D7)

/**
 * E8 · Rutas públicas: #/viewer/<battleId> (directo) y #/replay/<battleId>?t=<tick>
 * (enlace compartible con tick inicial, DoD T8.3).
 */
export function matchPublicRoute(route: string):
  | (
      | {
          kind: "viewer";
          battleId: string;
        }
      | { kind: "replay"; battleId: string; t: number }
      | { kind: "live" }
      | { kind: "ranking" }
    )
  | null {
  const viewer = /^#\/viewer\/([^/?]+)/.exec(route);
  if (viewer) return { kind: "viewer", battleId: decodeURIComponent(viewer[1]) };
  const replay = parseShareLink(route); // el MISMO parser que genera los enlaces (T8.3)
  if (replay) return { kind: "replay", battleId: replay.battleId, t: replay.t };
  // R11 · #/live: listado público de batallas en directo (slice mínimo, sin cuenta).
  if (/^#\/live(?:[/?]|$)/.test(route)) return { kind: "live" };
  // N6 · #/ranking: clasificación pública (GET /standings, security: [], solo lectura).
  if (/^#\/ranking(?:[/?]|$)/.test(route)) return { kind: "ranking" };
  return null;
}

/** R3.7 · Rutas del panel autenticado (además de #/bots, #/teams y #/admin). */
export function matchPanelRoute(
  route: string,
):
  | { kind: "tournamentBracket"; id: string }
  | { kind: "tournament"; id: string }
  | { kind: "battles"; botFilter?: string }
  | { kind: "battle-new" }
  | null {
  // R12 (slice 1) · el cuadro va ANTES del detalle: si no, "/tournaments/<id>/bracket"
  // lo captura el patrón de detalle (que solo mira el primer segmento tras el id).
  const bracket = /^#\/tournaments\/([^/?]+)\/bracket(?:[/?]|$)/.exec(route);
  if (bracket) return { kind: "tournamentBracket", id: decodeURIComponent(bracket[1]) };
  const detail = /^#\/tournaments\/([^/?]+)/.exec(route);
  if (detail) return { kind: "tournament", id: decodeURIComponent(detail[1]) };
  if (/^#\/battles\/new/.test(route)) return { kind: "battle-new" }; // R9 (antes del match general de #/battles)
  // FC-D (D8): anclado — `#/battles/<basura>` es 404, no la lista.
  const battles = /^#\/battles\/?(?:\?(.*))?$/.exec(route);
  if (battles) {
    const bot = new URLSearchParams(battles[1] ?? "").get("bot");
    return { kind: "battles", botFilter: bot ? bot : undefined };
  }
  return null;
}

/**
 * FC-D (D8) · TABLA de rutas estáticas del panel, en orden de prioridad (la más
 * específica primero). Cada patrón se ancla al segmento completo: `#/teamsX` ya
 * no cae en Equipos ni un hash desconocido en «Mis bots» (antes no había 404).
 *
 * CÓMO REGISTRAR UNA RUTA NUEVA (A/C la piden en COORD.md; la registra D o REVIEW):
 *  1. añadir el nombre a `StaticPanelRoute` y una entrada aquí con su patrón;
 *  2. añadir el caso en `renderStaticPanel` (App) con el componente;
 *  3. si debe verse en la barra, un `<a>` en la `<nav>`;
 *  4. test en apps/web/tests/fc-d-navigation.test.tsx (ruta → componente).
 * Las rutas con parámetros siguen en `matchPanelRoute` / `matchPublicRoute`.
 */
export type StaticPanelRoute =
  "bots" | "teams" | "tournaments" | "replays" | "mapEditor" | "maps" | "system" | "audit" | "roles" | "admin";

export const STATIC_PANEL_ROUTES: ReadonlyArray<{ name: StaticPanelRoute; pattern: RegExp }> = [
  { name: "bots", pattern: /^(?:#?\/?|#\/bots(?:[/?].*)?)$/ },
  { name: "teams", pattern: /^#\/teams(?:[/?].*)?$/ },
  { name: "tournaments", pattern: /^#\/tournaments(?:\?.*)?$/ },
  { name: "replays", pattern: /^#\/replays\/?(?:\?.*)?$/ },
  { name: "mapEditor", pattern: /^#\/maps\/editor(?:[/?].*)?$/ },
  { name: "maps", pattern: /^#\/maps\/?(?:\?.*)?$/ },
  { name: "system", pattern: /^#\/system(?:[/?].*)?$/ },
  { name: "audit", pattern: /^#\/audit(?:[/?].*)?$/ },
  { name: "roles", pattern: /^#\/roles(?:[/?].*)?$/ },
  { name: "admin", pattern: /^#\/admin(?:[/?].*)?$/ },
];

/** Ruta estática del panel o `null` (⇒ página 404). */
export function matchStaticPanelRoute(route: string): StaticPanelRoute | null {
  for (const r of STATIC_PANEL_ROUTES) if (r.pattern.test(route)) return r.name;
  return null;
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [booting, setBooting] = useState(true);
  const [notice, setNotice] = useState("");
  /** FC-D (TD-022) · API caída al arrancar: NO es «sin sesión» (antes mandaba al login). */
  const [bootError, setBootError] = useState<unknown>(null);
  const [bootAttempt, setBootAttempt] = useState(0);
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
    setBooting(true);
    setBootError(null);
    bootstrapSession()
      .then((who) => {
        if (alive && who) setMe(who);
      })
      .catch((e: unknown) => {
        if (alive) setBootError(e);
      })
      .finally(() => {
        if (alive) setBooting(false);
      });
    return () => {
      alive = false;
    };
  }, [bootAttempt]);

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

  // E8: el visor y el reproductor son rutas PÚBLICAS (no pasan por el login del
  // panel). PRC (TD-004): el replay en sí sólo se sirve si la API lo autoriza
  // (participante/equipo/staff, o público por S9_PUBLIC_REPLAYS_ENABLED).
  const publicView = matchPublicRoute(route);
  if (publicView) {
    return (
      <main>
        <h1>S9 AI Arena</h1>
        <ErrorBoundary label="el visor">
          {publicView.kind === "viewer" ? (
            <ViewerPage battleId={publicView.battleId} />
          ) : publicView.kind === "live" ? (
            <LivePage />
          ) : publicView.kind === "ranking" ? (
            <RankingPage />
          ) : booting ? (
            // PRC (TD-004): el replay se pide CON la sesión (si la hay). Se espera al
            // refresh desde la cookie para no pedirlo anónimo y recibir un 404.
            <p role="status" aria-live="polite" data-testid="replay-status" data-state="loading">
              Recuperando sesión…
            </p>
          ) : (
            <ReplayPage key={me?.id ?? "anon"} battleId={publicView.battleId} initialTick={publicView.t} />
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

  if (bootError && !me) {
    const d = describeApiError(bootError);
    return (
      <main>
        <h1>S9 AI Arena</h1>
        <div className="card" role="alert" data-testid="boot-error" data-error-kind={d.kind}>
          <h2>No se puede contactar con la plataforma</h2>
          <p className="error">
            {d.title}: {d.detail}
          </p>
          <p>Tu sesión no se ha cerrado; vuelve a intentarlo cuando el servicio responda.</p>
          <button type="button" onClick={() => setBootAttempt((n) => n + 1)}>
            Reintentar
          </button>{" "}
          <button type="button" className="link" onClick={() => setBootError(null)}>
            Ir al inicio de sesión
          </button>
        </div>
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

  function renderStaticPanel(name: StaticPanelRoute | null) {
    switch (name) {
      case "tournaments":
        return <TournamentsPage me={me!} />;
      case "teams":
        return <TeamsPage me={me!} />;
      case "replays": // R7-A (con 's'; distinto de #/replay/<id> público)
        return <ReplaysPage />;
      case "mapEditor": // R10 (antes del match general de #/maps)
        return <MapEditorPage />;
      case "maps":
        return <MapsPage me={me!} />;
      case "system":
        return <SystemPage me={me!} />;
      case "audit":
        return <AuditPage me={me!} />;
      case "roles":
        return <RolesPage me={me!} />;
      case "admin":
        return <AdminPage me={me!} />;
      case "bots":
        return (
          <ResourceView resource={catalogRes} label="el catálogo" onRetry={reloadCatalog}>
            {(cat) => (
              <BotsPage me={me!} catalog={cat.modules} catalogVersion={cat.version} budgetCredits={BUDGET_DEFAULT} />
            )}
          </ResourceView>
        );
      default:
        return <NotFoundPage route={route} />;
    }
  }

  return (
    <ErrorBoundary label="el panel">
      <nav aria-label="principal">
        <strong>S9 AI Arena</strong>
        <a href="#/bots">Mis bots</a>
        <a href="#/teams">Equipos</a>
        <a href="#/tournaments">Torneos</a>
        <a href="#/battles">Batallas</a>
        <a href="#/replays">Replays</a>
        <a href="#/maps">Mapas</a>
        {/* R11 · #/live es pública (sin cuenta); el enlace aquí es solo un atajo del panel. */}
        <a href="#/live">En directo</a>
        {/* N6 · #/ranking es pública (sin cuenta); el enlace aquí es solo un atajo del panel. */}
        <a href="#/ranking">Ranking</a>
        {/* La interfaz solo OCULTA; la autorización la hace la API (cap. 16) */}
        {isAdmin(me) && (
          <>
            <a href="#/admin" data-testid="admin-link">
              Administración
            </a>
            <a href="#/system" data-testid="system-link">
              Sistema
            </a>
            <a href="#/audit" data-testid="audit-link">
              Auditoría
            </a>
            <a href="#/roles" data-testid="roles-link">
              Roles
            </a>
          </>
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
          {panelRoute?.kind === "tournamentBracket" ? (
            <BracketPage id={panelRoute.id} />
          ) : panelRoute?.kind === "tournament" ? (
            <TournamentDetailPage id={panelRoute.id} me={me} />
          ) : panelRoute?.kind === "battle-new" ? ( // R9
            <BattleNewPage me={me} />
          ) : panelRoute?.kind === "battles" ? (
            <BattlesPage botFilter={panelRoute.botFilter} />
          ) : (
            renderStaticPanel(matchStaticPanelRoute(route))
          )}
        </ErrorBoundary>
      </main>
    </ErrorBoundary>
  );
}
