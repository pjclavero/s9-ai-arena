/**
 * EQ3 · Centro de Ayuda integrado: #/help (alias #/ayuda y #/docs), PÚBLICO.
 *
 * Funciona sin GitHub y sin Internet: todo el contenido viaja con la web (texto
 * de help/content.ts y help/sections/*, y las fuentes de verdad embebidas en build
 * por help/sources.ts). La única consulta de red es opcional y al MISMO origen
 * (GET /rulesets, para enseñar los rulesets de esta instalación); si falla, la
 * ayuda se lee igual. GitHub sólo aparece como enlace opcional al código fuente.
 *
 * Rutas: #/help/<grupo>/<hoja> (help/tree.ts). La portada es «Primeros pasos», con
 * el recorrido, el glosario y los data-testid históricos (help-page, help-journey,
 * help-glossary, help-docs) que usan los E2E de onboarding.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { DOC_LINKS, GLOSSARY, HOW_IT_PLAYS, JOURNEY, WHAT_IS_S9 } from "../help/content.js";
import { HELP_TREE, helpHref, parseHelpHash, searchHelp, type HelpLocation } from "../help/tree.js";
import { ensureHelpStyles } from "../help/help-styles.js";
import {
  BotConcepts,
  Commands,
  Events,
  Examples,
  Observations,
  Radio,
  SdkJavascript,
  SdkPython,
  Sensors,
} from "../help/sections/bots.js";
import { EquipmentCategory, LoadoutBasics } from "../help/sections/equipment.js";
import {
  Battle1v1,
  BattleNew,
  BattleRespawns,
  BattleScoring,
  BattleTeams,
  BattleTiebreaks,
  ModeCaptureTheFlag,
  ModeDeathmatch,
  ModeElimination,
  ModeLimitedRespawn,
  ModeOthers,
  ModeTeamDeathmatch,
  ModeZoneControl,
  RulesReference,
} from "../help/sections/rules.js";
import { RankingHelp, TournamentsHelp } from "../help/sections/tournaments.js";
import {
  MapBases,
  MapCrates,
  MapEditorHelp,
  MapFlags,
  MapSpawns,
  MapValidation,
  MapWalls,
  MapZones,
} from "../help/sections/maps.js";
import { CatalogReference, ProtocolReference, VersionsReference } from "../help/sections/reference.js";
import { StreamingHelp } from "../help/sections/streaming.js";

function GettingStarted(props: { loggedIn: boolean }) {
  return (
    <>
      <section aria-labelledby="help-what">
        <h4 id="help-what">Qué es S9</h4>
        <p>{WHAT_IS_S9}</p>
        <p>{HOW_IT_PLAYS}</p>
      </section>

      <section aria-labelledby="help-journey-title">
        <h4 id="help-journey-title">Recorrido paso a paso: de la cuenta a la primera batalla</h4>
        <ol data-testid="help-journey">
          {JOURNEY.map((s) => (
            <li key={s.id}>
              <strong>{s.title}.</strong> {s.how}{" "}
              {/* Sin sesión los enlaces del panel llevan al acceso: se dice en vez de sorprender. */}
              {s.id === "account" ? (
                !props.loggedIn && <a href={s.href}>{s.linkLabel}</a>
              ) : (
                <a href={s.href}>
                  {s.linkLabel}
                  {props.loggedIn ? "" : " (requiere iniciar sesión)"}
                </a>
              )}
            </li>
          ))}
        </ol>
        <p>
          ¿Algo falla? Cada pantalla dice qué ha pasado (permiso, inexistente, servidor no disponible, sin respuesta) y
          ofrece «Reintentar». Si una versión queda <code>rejected</code>, el motivo aparece junto a la versión.
        </p>
      </section>

      <section aria-labelledby="help-glossary-title">
        <h4 id="help-glossary-title">Glosario</h4>
        <dl data-testid="help-glossary">
          {GLOSSARY.map((g) => (
            <div key={g.id} id={`glosario-${g.id}`}>
              <dt>
                <strong>{g.term}</strong>
              </dt>
              <dd>{g.definition}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="help-docs-title">
        <h4 id="help-docs-title">Código fuente (opcional, externo)</h4>
        <p>
          Todo lo necesario para usar S9 está en esta ayuda y funciona sin conexión. Si quieres ver el código fuente del
          proyecto o abrir una incidencia, el repositorio público está en GitHub (se abre en otra pestaña y necesita
          Internet):
        </p>
        <ul data-testid="help-docs">
          {DOC_LINKS.map((d) => (
            <li key={d.href}>
              <a href={d.href} target="_blank" rel="noopener noreferrer">
                {d.label}
              </a>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

/** Contenido de cada hoja. Clave `grupo/hoja`; toda hoja de HELP_TREE tiene entrada (lo exige el test). */
export const HELP_CONTENT: Record<string, (p: { loggedIn: boolean }) => ReactNode> = {
  "inicio/primeros-pasos": (p) => <GettingStarted loggedIn={p.loggedIn} />,
  "bots/conceptos": () => <BotConcepts />,
  "bots/sdk-python": () => <SdkPython />,
  "bots/sdk-javascript": () => <SdkJavascript />,
  "bots/observaciones": () => <Observations />,
  "bots/comandos": () => <Commands />,
  "bots/eventos": () => <Events />,
  "bots/sensores": () => <Sensors />,
  "bots/radio": () => <Radio />,
  "bots/ejemplos": () => <Examples />,
  "equipamiento/loadout": () => <LoadoutBasics />,
  "equipamiento/chassis": () => <EquipmentCategory categories={["chassis"]} />,
  "equipamiento/movement": () => <EquipmentCategory categories={["movement"]} />,
  "equipamiento/power": () => <EquipmentCategory categories={["power"]} />,
  "equipamiento/sensor": () => <EquipmentCategory categories={["sensor"]} />,
  "equipamiento/weapon": () => <EquipmentCategory categories={["weapon"]} />,
  "equipamiento/ammo": () => <EquipmentCategory categories={["ammo"]} />,
  "equipamiento/armor": () => <EquipmentCategory categories={["armor"]} />,
  "equipamiento/radio": () => <EquipmentCategory categories={["radio"]} />,
  "equipamiento/otros": () => <EquipmentCategory categories={["mine", "utility"]} />,
  "batallas/nueva": () => <BattleNew />,
  "batallas/1v1": () => <Battle1v1 />,
  "batallas/equipos": () => <BattleTeams />,
  "batallas/respawns": () => <BattleRespawns />,
  "batallas/puntuacion": () => <BattleScoring />,
  "batallas/desempates": () => <BattleTiebreaks />,
  "modos/deathmatch": () => <ModeDeathmatch />,
  "modos/team_deathmatch": () => <ModeTeamDeathmatch />,
  "modos/eliminacion": () => <ModeElimination />,
  "modos/respawn-limitado": () => <ModeLimitedRespawn />,
  "modos/capture_the_flag": () => <ModeCaptureTheFlag />,
  "modos/zone_control": () => <ModeZoneControl />,
  "modos/otros": () => <ModeOthers />,
  "torneos/torneos": () => <TournamentsHelp />,
  "torneos/ranking": () => <RankingHelp />,
  "administracion/streaming": () => <StreamingHelp />,
  "mapas/editor": () => <MapEditorHelp />,
  "mapas/spawns": () => <MapSpawns />,
  "mapas/bases": () => <MapBases />,
  "mapas/banderas": () => <MapFlags />,
  "mapas/zonas": () => <MapZones />,
  "mapas/muros": () => <MapWalls />,
  "mapas/cajas": () => <MapCrates />,
  "mapas/validacion": () => <MapValidation />,
  "referencia/reglas": () => <RulesReference />,
  "referencia/catalogo": () => <CatalogReference />,
  "referencia/protocolo": () => <ProtocolReference />,
  "referencia/versiones": () => <VersionsReference />,
};

function useHash(): string {
  const [hash, setHash] = useState(() => (typeof window === "undefined" ? "" : window.location.hash));
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

function HelpIndex(props: { loc: HelpLocation }) {
  const [open, setOpen] = useState(false);
  return (
    <nav
      className="help-index"
      aria-label="Índice de la ayuda"
      data-open={open ? "true" : "false"}
      data-testid="help-index"
    >
      <button
        type="button"
        className="help-index-toggle"
        aria-expanded={open}
        aria-controls="help-index-list"
        onClick={() => setOpen((o) => !o)}
      >
        Índice de la ayuda
      </button>
      <ul className="help-index-list" id="help-index-list">
        {HELP_TREE.map((g) => (
          <li key={g.id}>
            {g.leaves.length === 1 ? (
              <a
                href={helpHref(g.id, g.leaves[0].id)}
                aria-current={props.loc.group.id === g.id ? "page" : undefined}
                onClick={() => setOpen(false)}
              >
                {g.title}
              </a>
            ) : (
              <>
                <span className="help-group-title" id={`help-g-${g.id}`}>
                  {g.title}
                </span>
                <ul aria-labelledby={`help-g-${g.id}`}>
                  {g.leaves.map((l) => (
                    <li key={l.id}>
                      <a
                        href={helpHref(g.id, l.id)}
                        aria-current={props.loc.group.id === g.id && props.loc.leaf.id === l.id ? "page" : undefined}
                        onClick={() => setOpen(false)}
                        data-testid={`help-nav-${g.id}-${l.id}`}
                      >
                        {l.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

function HelpSearch() {
  const [q, setQ] = useState("");
  const results = searchHelp(q);
  return (
    <div className="help-search" role="search">
      <label htmlFor="help-search-input">Buscar en la ayuda</label>
      <input
        id="help-search-input"
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        data-testid="help-search"
        autoComplete="off"
      />
      {q.trim() && (
        <div style={{ flexBasis: "100%" }}>
          <p role="status" aria-live="polite" data-testid="help-search-count">
            {results.length === 0
              ? "Sin resultados."
              : results.length === 1
                ? "1 resultado."
                : `${results.length} resultados.`}
          </p>
          {results.length > 0 && (
            <ul data-testid="help-search-results">
              {results.map((r) => (
                <li key={`${r.group.id}/${r.leaf.id}`}>
                  <a href={helpHref(r.group.id, r.leaf.id)} onClick={() => setQ("")}>
                    {r.group.title} › {r.leaf.title}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function HelpPage(props: { loggedIn: boolean }) {
  const hash = useHash();
  const loc = parseHelpHash(hash);
  const key = `${loc.group.id}/${loc.leaf.id}`;
  const render = HELP_CONTENT[key];
  const titleRef = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);

  useEffect(ensureHelpStyles, []);

  // Al cambiar de hoja DESDE la ayuda (el foco ya está en el contenido, así que
  // route-focus no lo mueve), el foco va al título de la hoja nueva: el lector de
  // pantalla anuncia dónde se está.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    titleRef.current?.focus();
  }, [key]);

  return (
    <div data-testid="help-page" data-help-section={key}>
      <h2>Centro de Ayuda de S9 AI Arena</h2>
      <HelpSearch />
      <div className="help-layout">
        <HelpIndex loc={loc} />
        <article className="help-article card" aria-labelledby="help-leaf-title" data-testid="help-article">
          <p className="help-breadcrumb" data-testid="help-breadcrumb">
            <a href="#/help">Ayuda</a>
            {loc.group.id !== "inicio" && (
              <>
                {" › "}
                {loc.group.title}
              </>
            )}
          </p>
          {loc.notFound && (
            <p className="warn" role="alert" data-testid="help-not-found">
              Esa sección de la ayuda no existe; te mostramos la más cercana.
            </p>
          )}
          <h3 id="help-leaf-title" tabIndex={-1} ref={titleRef}>
            {loc.leaf.title}
          </h3>
          {render ? render({ loggedIn: props.loggedIn }) : null}
        </article>
      </div>
    </div>
  );
}
