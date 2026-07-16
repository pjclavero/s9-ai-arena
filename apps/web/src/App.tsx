/** T7.4 · App del panel: navegación por hash, sesión y ocultación por rol (la API autoriza). */
import { useEffect, useState } from "react";
import { api, getToken, type Me } from "./api.js";
import type { ModuleDefinition } from "../../../packages/module-catalog/types.js";
import { LoginPage } from "./pages/LoginPage.js";
import { BotsPage } from "./pages/BotsPage.js";
import { TeamsPage } from "./pages/TeamsPage.js";
import { AdminPage, isAdmin } from "./pages/AdminPage.js";

const BUDGET_DEFAULT = 1000; // BUDGET_CREDITS_MVP; el ruleset de cada torneo puede cambiarlo (D7)

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
