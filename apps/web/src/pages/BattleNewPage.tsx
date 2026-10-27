/**
 * R9 · Crear una batalla de práctica desde la UI (modo prepared/seguro).
 *
 * Usa el endpoint EXISTENTE y seguro `POST /battles` (createPracticeBattle, RBAC
 * x-min-role: user), que ENCOLA una batalla no oficial. La ejecuta el
 * tournament-worker (autoridad única, DEV-B): el código de cada bot en su
 * contenedor del sandbox. REVIEW (R4.6): ya no hay botón «Ejecutar batalla real»
 * (`POST /battles/{id}/run` sólo delega en la cola): crear = ejecutar.
 *
 * Solo permite mapas PUBLICADOS y VERSIONES DE BOT publicadas (published/frozen,
 * la misma regla que aplica la API con su 409 `bot_not_published`).
 *
 * FC-C (TD-003) · los modos y los rulesets salen de la API (GET /rulesets: ids REALES
 * de la tabla `rulesets`); aquí no hay ningún id de ruleset. Los mapas se filtran por
 * el modo elegido (supportedModes) y cada bando puede tomar sus bots de un equipo.
 *
 * UX-03 · Antes la página decía «Elige dos bots con versión publicada» y escondía los
 * bots sin publicar sin decir por qué. Ahora distingue BOT (el programa) de VERSIÓN
 * DE BOT (una entrega concreta de su código, que es lo que juega): por cada bot dice
 * qué versión publicada se usará, cuál es su última versión y en qué estado está, y
 * por qué no es elegible si no lo es. Se puede elegir una versión publicada concreta,
 * no sólo la última. Un bot cuya última versión está rechazada pero tiene una
 * publicada anterior SIGUE siendo elegible (la API la acepta).
 *
 * Bando ≠ equipo: el «rojo/azul» de una batalla es sólo el lado del campo (la
 * etiqueta `team` del participante); los equipos de la sección Equipos sólo sirven
 * aquí para FILTRAR la lista de bots. Dos bots del mismo equipo pueden enfrentarse.
 */
import { useEffect, useState } from "react";
import { api, type Me } from "../api.js";
import { ErrorState, FormError } from "../ui/primitives.js";
import { modeName } from "../battle-result.js";

export interface RulesetOption {
  id: string;
  name: string;
  mode: string | null;
  budgetCredits: number;
}
interface TeamOption {
  id: string;
  name: string;
  isMember?: boolean;
  bots?: { id: string; name: string }[];
}

interface MapVersion {
  mapId: string;
  name?: string;
  version: number;
  state: string;
  supportedModes?: string[];
}
export interface BotSummary {
  id: string;
  name: string;
  ownerId?: string;
  latestPublishedVersion?: number | null;
}
export interface BotVersionSummary {
  version: number;
  state: string;
}

/** Estados en los que una versión puede jugar (misma regla que createPracticeBattle). */
const PLAYABLE_STATES = ["published", "frozen"];

/** Nombre legible del estado de una versión de bot. */
export function versionStateLabel(state: string): string {
  switch (state) {
    case "draft":
      return "borrador (sin enviar)";
    case "validating":
    case "building":
      return "en validación";
    case "validated":
      return "validada (sin publicar)";
    case "rejected":
      return "rechazada";
    case "published":
      return "publicada";
    case "frozen":
      return "publicada (congelada)";
    default:
      return state;
  }
}

export interface BotEligibility {
  eligible: boolean;
  /** Versiones que pueden jugar, de la más reciente a la más antigua. */
  playable: number[];
  /** Versión que se usa si no se elige otra: la publicada más reciente. */
  defaultVersion?: number;
  latest?: BotVersionSummary;
  /** Una frase para el usuario: qué versión juega, o por qué no puede jugar y qué hacer. */
  summary: string;
  /** Sufijo corto para la opción del desplegable: «(v1)», «(v1) · última versión: v2 rechazada». */
  short?: string;
}

/**
 * ¿Puede este bot entrar en una batalla y con qué versión? `versions` es la lista de
 * GET /bots/{id}/versions; si no se pudo cargar (`null`) se usa lo que da el listado
 * (`latestPublishedVersion`) y se dice que no se conocen las demás.
 */
export function botEligibility(bot: BotSummary, versions: BotVersionSummary[] | null): BotEligibility {
  if (versions === null) {
    const v = bot.latestPublishedVersion;
    if (v == null) {
      return { eligible: false, playable: [], summary: "no elegible: ninguna versión publicada" };
    }
    return {
      eligible: true,
      playable: [v],
      defaultVersion: v,
      summary: `juega la v${v} (publicada)`,
      short: `(v${v})`,
    };
  }
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  const latest = sorted[0];
  const playable = sorted.filter((v) => PLAYABLE_STATES.includes(v.state)).map((v) => v.version);
  if (playable.length === 0) {
    if (!latest) {
      return { eligible: false, playable, summary: "no elegible: el bot no tiene ninguna versión — crea una" };
    }
    const fix =
      latest.state === "validated"
        ? "publícala"
        : latest.state === "rejected"
          ? "corrige el código y vuelve a enviarla"
          : latest.state === "draft"
            ? "envíala a validación"
            : "espera a que termine la validación y publícala";
    return {
      eligible: false,
      playable,
      latest,
      summary: `no elegible: ninguna versión publicada — tienes v${latest.version} ${versionStateLabel(
        latest.state,
      )}: ${fix}`,
    };
  }
  const def = playable[0];
  const latestNote =
    latest && latest.version !== def ? ` · última versión: v${latest.version} ${versionStateLabel(latest.state)}` : "";
  return {
    eligible: true,
    playable,
    defaultVersion: def,
    latest,
    summary: `juega la v${def} (publicada)${latestNote}`,
    short: `(v${def})${latestNote}`,
  };
}

export function BattleNewPage(props: { me: Me }) {
  const [maps, setMaps] = useState<MapVersion[]>([]);
  const [bots, setBots] = useState<BotSummary[]>([]);
  /** Versiones por bot; `null` = no se pudieron cargar (se usa latestPublishedVersion). */
  const [versionsByBot, setVersionsByBot] = useState<Record<string, BotVersionSummary[] | null>>({});
  const [loadErr, setLoadErr] = useState<unknown>(null);
  const [loadEpoch, setLoadEpoch] = useState(0);
  const [modes, setModes] = useState<string[]>([]);
  const [rulesets, setRulesets] = useState<RulesetOption[]>([]);
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [mode, setMode] = useState("");
  const [rulesetId, setRulesetId] = useState("");
  const [redTeam, setRedTeam] = useState("");
  const [blueTeam, setBlueTeam] = useState("");
  const [mapKey, setMapKey] = useState(""); // `${mapId}@${version}`
  const [seed, setSeed] = useState("");
  const [redBot, setRedBot] = useState("");
  const [blueBot, setBlueBot] = useState("");
  const [redVersion, setRedVersion] = useState<number | null>(null);
  const [blueVersion, setBlueVersion] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [submitErr, setSubmitErr] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      setLoadErr(null);
      try {
        const [m, b, r, t] = await Promise.all([
          api<{ items: MapVersion[] }>("GET", "/maps?limit=100"),
          api<{ items: BotSummary[] }>("GET", "/bots?limit=100"),
          api<{ modes: string[]; items: RulesetOption[] }>("GET", "/rulesets"),
          api<{ items: TeamOption[] }>("GET", "/teams?limit=100"),
        ]);
        const allBots = b.items ?? [];
        // Sólo interesan los bots que pueden jugar (para elegir versión) y los PROPIOS
        // (para explicar por qué no pueden). Un bot ajeno sin publicar no se lista.
        const relevant = allBots.filter((x) => x.latestPublishedVersion != null || x.ownerId === props.me.id);
        setMaps((m.items ?? []).filter((x) => x.state === "published"));
        setBots(relevant);
        setModes(r.modes ?? []);
        setRulesets(r.items ?? []);
        setTeams((t.items ?? []).filter((x) => x.isMember));
        if (r.modes?.length) setMode(r.modes[0]);
        // Las versiones de cada bot: un fallo aquí no tumba la página (se cae al
        // `latestPublishedVersion` del listado y se dice que no se conocen las demás).
        const entries = await Promise.all(
          relevant.map(async (x) => {
            try {
              const vs = await api<BotVersionSummary[]>("GET", `/bots/${encodeURIComponent(x.id)}/versions`);
              return [x.id, Array.isArray(vs) ? vs : null] as const;
            } catch {
              return [x.id, null] as const;
            }
          }),
        );
        setVersionsByBot(Object.fromEntries(entries));
      } catch (e) {
        setLoadErr(e ?? new Error("error desconocido"));
      }
    })();
  }, [loadEpoch, props.me.id]);

  const eligibility = (id: string): BotEligibility | undefined => {
    const b = bots.find((x) => x.id === id);
    return b ? botEligibility(b, versionsByBot[id] ?? null) : undefined;
  };
  // Opciones REALES derivadas del modo elegido.
  const modeRulesets = rulesets.filter((r) => r.mode === mode || r.mode === null);
  const modeMaps = maps.filter((m) => (m.supportedModes ?? []).includes(mode));
  const mapsForMode = (md: string) => maps.filter((m) => (m.supportedModes ?? []).includes(md)).length;
  const selectedMap = modeMaps.find((m) => `${m.mapId}@${m.version}` === mapKey);
  const effectiveRuleset = modeRulesets.some((r) => r.id === rulesetId)
    ? rulesetId
    : ((modeRulesets.find((r) => r.mode === mode) ?? modeRulesets[0])?.id ?? "");
  const botsOf = (teamId: string) => {
    if (!teamId) return bots;
    const ids = new Set((teams.find((t) => t.id === teamId)?.bots ?? []).map((x) => x.id));
    return bots.filter((x) => ids.has(x.id));
  };

  const eligibleBots = bots.filter((b) => eligibility(b.id)?.eligible);
  const notEnoughBots = eligibleBots.length < 2;
  const notEnoughMaps = modeMaps.length < 1;

  /** Versión que se enviará para un bando: la elegida si sigue siendo jugable, o la publicada más reciente. */
  function chosenVersion(botId: string, picked: number | null): number | undefined {
    const e = eligibility(botId);
    if (!e?.eligible) return undefined;
    return picked != null && e.playable.includes(picked) ? picked : e.defaultVersion;
  }
  const rv = redBot ? chosenVersion(redBot, redVersion) : undefined;
  const bv = blueBot ? chosenVersion(blueBot, blueVersion) : undefined;

  // Qué falta para poder crear la batalla: una fila ✓/✗ por requisito.
  const checks: { ok: boolean; label: string }[] = [
    {
      ok: Boolean(effectiveRuleset),
      label: effectiveRuleset ? `Ruleset: ${effectiveRuleset}` : "Ruleset: no hay ninguno para este modo",
    },
    {
      ok: Boolean(selectedMap),
      label: selectedMap
        ? `Mapa: ${selectedMap.name ?? selectedMap.mapId} v${selectedMap.version}`
        : notEnoughMaps
          ? `Mapa: no hay mapas publicados que soporten ${modeName(mode)}`
          : "Mapa: elige un mapa publicado",
    },
    participantCheck("Bando rojo", redBot, rv),
    participantCheck("Bando azul", blueBot, bv),
  ];
  if (redBot && blueBot && redBot === blueBot) {
    checks.push({ ok: false, label: "Los dos bandos tienen el mismo bot: elige dos bots distintos" });
  }

  function participantCheck(side: string, botId: string, version: number | undefined): { ok: boolean; label: string } {
    if (!botId) return { ok: false, label: `${side}: elige un bot` };
    const b = bots.find((x) => x.id === botId);
    const e = eligibility(botId);
    if (!b || !e) return { ok: false, label: `${side}: elige un bot` };
    if (!e.eligible || version == null) return { ok: false, label: `${side}: ${b.name} — ${e.summary}` };
    return { ok: true, label: `${side}: ${b.name} v${version}` };
  }

  async function submit() {
    setError("");
    setSubmitErr(null);
    if (!effectiveRuleset) return setError("No hay ningún ruleset para este modo.");
    if (!selectedMap) return setError("Elige un mapa publicado que soporte el modo.");
    if (!redBot || !blueBot) return setError("Elige un bot para cada bando.");
    if (redBot === blueBot) return setError("Elige dos bots distintos.");
    if (rv == null || bv == null) {
      const bad = checks.filter((c) => !c.ok).map((c) => c.label);
      return setError(`No se puede crear la batalla: ${bad.join("; ")}.`);
    }
    setSubmitting(true);
    try {
      const battle = await api<{ id: string }>("POST", "/battles", {
        mode,
        rulesetId: effectiveRuleset, // id de la tabla `rulesets`, servido por GET /rulesets
        mapId: selectedMap.mapId,
        mapVersion: selectedMap.version,
        ...(seed ? { seed } : {}),
        participants: [
          { botId: redBot, version: rv, team: "red" },
          { botId: blueBot, version: bv, team: "blue" },
        ],
      });
      setCreated(battle.id);
    } catch (e) {
      setSubmitErr(e ?? new Error("error desconocido"));
    } finally {
      setSubmitting(false);
    }
  }

  if (created) {
    return (
      <section>
        <h2>Batalla encolada</h2>
        <p className="ok" data-testid="battle-created">
          Batalla <code>{created}</code> creada y encolada.
        </p>

        <p role="status">
          La ejecuta el worker de la plataforma con el código publicado de cada bot. Sigue su estado y su resultado en{" "}
          <a href={`#/battles`}>Batallas</a>; el replay aparece al terminar.
        </p>

        <p>
          <a href={`#/battles/${encodeURIComponent(created)}`} data-testid="battle-detail-link">
            Ver esta batalla
          </a>{" "}
          · <a href="#/battles">Ver batallas</a> · <a href="#/replays">Ver replays</a>
        </p>
      </section>
    );
  }

  function sideControls(
    side: "rojo" | "azul",
    teamId: string,
    setTeamId: (v: string) => void,
    botId: string,
    setBotId: (v: string) => void,
    picked: number | null,
    setPicked: (v: number | null) => void,
  ) {
    const e = botId ? eligibility(botId) : undefined;
    const versions = botId ? (versionsByBot[botId] ?? null) : null;
    const stateOf = (v: number) => versions?.find((x) => x.version === v)?.state ?? "published";
    return (
      <fieldset data-testid={`side-${side}`}>
        <legend>Bando {side}</legend>
        {teams.length > 0 && (
          <label>
            Filtrar bots por equipo (opcional){" "}
            <select
              aria-label={`equipo ${side}`}
              value={teamId}
              onChange={(ev) => {
                setTeamId(ev.target.value);
                setBotId("");
                setPicked(null);
              }}
            >
              <option value="">— todos los bots —</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Bot {side}{" "}
          <select
            aria-label={`bot ${side}`}
            value={botId}
            onChange={(ev) => {
              setBotId(ev.target.value);
              setPicked(null);
            }}
          >
            <option value="">— elige —</option>
            {botsOf(teamId).map((b) => {
              const be = eligibility(b.id)!;
              return (
                <option key={b.id} value={b.id} disabled={!be.eligible}>
                  {be.eligible ? `${b.name} ${be.short}` : `${b.name} — ${be.summary}`}
                </option>
              );
            })}
          </select>
        </label>
        {e?.eligible && (
          <label>
            Versión publicada ({side}){" "}
            <select
              aria-label={`versión ${side}`}
              value={String(chosenVersion(botId, picked) ?? "")}
              onChange={(ev) => setPicked(Number(ev.target.value))}
            >
              {e.playable.map((v) => (
                <option key={v} value={String(v)}>
                  v{v} · {versionStateLabel(stateOf(v))}
                  {v === e.defaultVersion ? " (la más reciente publicada)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        {e && (
          <p className={e.eligible ? "" : "warn"} data-testid={`bot-status-${side}`}>
            {e.summary}
            {versions === null && e.eligible ? " · no se pudieron cargar sus otras versiones" : ""}
          </p>
        )}
      </fieldset>
    );
  }

  const ineligibleOwn = bots.filter((b) => b.ownerId === props.me.id && !eligibility(b.id)?.eligible);

  return (
    <section>
      <h2>Nueva batalla de práctica</h2>
      <p className="warn" role="note">
        La batalla se <strong>encola</strong> y la ejecuta el worker de la plataforma: cada bot corre su versión
        publicada en su contenedor aislado. El límite de ticks lo fija el ruleset.
      </p>
      <p data-testid="battle-concepts">
        Un <strong>bot</strong> es tu programa; una <strong>versión de bot</strong> es una entrega concreta de su
        código. En una batalla juegan <strong>versiones publicadas</strong>. El <strong>bando</strong> (rojo o azul) es
        sólo el lado del campo: no es un equipo de la sección Equipos, que aquí sólo sirve para filtrar la lista. Dos
        bots del mismo equipo pueden enfrentarse.
      </p>
      {loadErr !== null && (
        <ErrorState label="mapas, bots y rulesets" error={loadErr} onRetry={() => setLoadEpoch((n) => n + 1)} />
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <FormError error={submitErr} />

      <label>
        Modo{" "}
        <select
          aria-label="modo"
          value={mode}
          onChange={(e) => {
            setMode(e.target.value);
            setMapKey("");
            setRulesetId("");
          }}
        >
          {modes.map((m) => (
            <option key={m} value={m}>
              {modeName(m)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Ruleset{" "}
        <select aria-label="ruleset" value={effectiveRuleset} onChange={(e) => setRulesetId(e.target.value)}>
          {modeRulesets.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} ({r.id}, {r.budgetCredits} cr)
            </option>
          ))}
        </select>
      </label>
      <label>
        Mapa publicado{" "}
        <select aria-label="mapa" value={mapKey} onChange={(e) => setMapKey(e.target.value)}>
          <option value="">— elige —</option>
          {modeMaps.map((m) => (
            <option key={`${m.mapId}@${m.version}`} value={`${m.mapId}@${m.version}`}>
              {m.name ? `${m.name} · ` : ""}
              {m.mapId} v{m.version}
            </option>
          ))}
        </select>
      </label>
      {notEnoughMaps && mode && (
        <p className="warn" data-testid="maps-for-mode">
          Sólo aparecen los mapas publicados que declaran soportar el modo {modeName(mode)}; ahora no hay ninguno.
          {modes.some((m) => m !== mode && mapsForMode(m) > 0) &&
            ` Modos con mapas: ${modes
              .filter((m) => mapsForMode(m) > 0)
              .map(modeName)
              .join(", ")}.`}
        </p>
      )}
      <label>
        Semilla (opcional) <input aria-label="semilla" value={seed} onChange={(e) => setSeed(e.target.value)} />
      </label>

      {sideControls("rojo", redTeam, setRedTeam, redBot, setRedBot, redVersion, setRedVersion)}
      {sideControls("azul", blueTeam, setBlueTeam, blueBot, setBlueBot, blueVersion, setBlueVersion)}

      <h3>Qué falta para crear la batalla</h3>
      <ul data-testid="battle-checklist">
        {checks.map((c) => (
          <li key={c.label} className={c.ok ? "ok" : "warn"}>
            {c.ok ? "✓" : "✗"} {c.label}
          </li>
        ))}
      </ul>

      <button disabled={submitting || notEnoughBots || notEnoughMaps} onClick={submit}>
        Crear batalla
      </button>
      {notEnoughBots && (
        <p className="warn">Necesitas al menos 2 bots con una versión publicada (ahora hay {eligibleBots.length}).</p>
      )}
      {ineligibleOwn.length > 0 && (
        <div data-testid="ineligible-bots">
          <p>Tus bots que todavía no pueden jugar:</p>
          <ul>
            {ineligibleOwn.map((b) => (
              <li key={b.id}>
                <a href={`#/bots/${encodeURIComponent(b.id)}`}>{b.name}</a> — {eligibility(b.id)!.summary}
              </li>
            ))}
          </ul>
        </div>
      )}
      {notEnoughMaps && <p className="warn">No hay mapas publicados que soporten el modo {modeName(mode)}.</p>}
    </section>
  );
}
