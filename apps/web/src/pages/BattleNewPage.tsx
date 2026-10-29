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
 *
 * 4v4 · Dos tipos de batalla:
 *  - BATALLA INDIVIDUAL: el 1v1 de siempre (un bot por bando), sin cambios.
 *  - BATALLA POR EQUIPOS: se eligen Equipo A y Equipo B (de los que el usuario es
 *    miembro); sus bots elegibles se cargan solos con su versión publicada EXACTA
 *    (se puede elegir otra publicada), se pueden excluir o sustituir, hasta 4 por
 *    bando y 8 en total, sin duplicados. Sólo se ofrecen modos de equipo (por defecto
 *    Deathmatch por equipos) y sus mapas. Se envía un participante por bot con
 *    `team` = bando (A → red, B → blue): la batalla sigue sin guardar el equipo.
 *
 * P3 · «cargando» ≠ «falló»: la clave ausente en `versionsByBot` es «todavía
 * cargando»; `null` es que la petición falló de verdad. Antes `?? null` las mezclaba
 * y se decía «no se pudieron cargar sus otras versiones» mientras cargaban.
 */
import { useEffect, useState, type ReactNode } from "react";
import { api, type Me } from "../api.js";
import { ErrorState, FormError } from "../ui/primitives.js";
import { modeName } from "../battle-result.js";
import {
  BattleRulesPicker,
  RulesCheckReport,
  defaultChoice,
  rulesBody,
  useRulesCheck,
  type RulesCatalog,
  type RulesChoice,
} from "./BattleRulesPicker.js";

export interface RulesetOption {
  id: string;
  name: string;
  mode: string | null;
  budgetCredits: number;
}
export interface TeamOption {
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

/** Modos que juegan bandos con varios bots (el motor rechaza equipos compartidos en deathmatch). */
export const TEAM_MODES = ["team_deathmatch", "capture_the_flag", "zone_control"];
/** Límites de la batalla por equipos: los mismos que valida la API (máx. 8 participantes). */
export const MAX_PER_SIDE = 4;
export const MAX_PARTICIPANTS = 8;

/** Un bot que juega en un bando de la batalla por equipos (`picked` = versión elegida a mano). */
export interface TeamSlot {
  botId: string;
  picked: number | null;
}

/** Equipo A juega en el bando rojo; Equipo B, en el azul. */
const SIDES = {
  A: { team: "red", color: "rojo", other: "B" },
  B: { team: "blue", color: "azul", other: "A" },
} as const;
type SideKey = keyof typeof SIDES;

/** Estado de carga de las versiones de un bot: lista, `null` (falló) o `undefined` (cargando). */
type VersionsLoad = BotVersionSummary[] | null | undefined;

export function BattleNewPage(props: { me: Me }) {
  const [maps, setMaps] = useState<MapVersion[]>([]);
  const [bots, setBots] = useState<BotSummary[]>([]);
  /**
   * Versiones por bot. P3: clave AUSENTE = todavía cargando; `null` = la petición
   * falló de verdad (se usa latestPublishedVersion y se dice); lista = cargadas.
   */
  const [versionsByBot, setVersionsByBot] = useState<Record<string, BotVersionSummary[] | null>>({});
  const [loadErr, setLoadErr] = useState<unknown>(null);
  const [loadEpoch, setLoadEpoch] = useState(0);
  const [modes, setModes] = useState<string[]>([]);
  const [rulesets, setRulesets] = useState<RulesetOption[]>([]);
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [kind, setKind] = useState<"individual" | "team">("individual");
  const [modeChoice, setMode] = useState("");
  const [rulesetId, setRulesetId] = useState("");
  const [redTeam, setRedTeam] = useState("");
  const [blueTeam, setBlueTeam] = useState("");
  const [mapKey, setMapKey] = useState(""); // `${mapId}@${version}`
  const [seed, setSeed] = useState("");
  const [redBot, setRedBot] = useState("");
  const [blueBot, setBlueBot] = useState("");
  const [redVersion, setRedVersion] = useState<number | null>(null);
  const [blueVersion, setBlueVersion] = useState<number | null>(null);
  // Batalla por equipos: el equipo de cada bando y los bots que juegan en él.
  const [teamIds, setTeamIds] = useState<Record<SideKey, string>>({ A: "", B: "" });
  const [slots, setSlots] = useState<Record<SideKey, TeamSlot[]>>({ A: [], B: [] });
  const [error, setError] = useState("");
  const [submitErr, setSubmitErr] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  // R-RULES · presets/personalizado/clásico. `null` = el preset por defecto del tipo.
  const [rulesCatalog, setRulesCatalog] = useState<RulesCatalog>({ presets: [], custom: null });
  const [rulesPick, setRulesPick] = useState<RulesChoice | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      setLoadErr(null);
      setVersionsByBot({});
      try {
        const [m, b, r, t] = await Promise.all([
          api<{ items: MapVersion[] }>("GET", "/maps?limit=100"),
          api<{ items: BotSummary[] }>("GET", "/bots?limit=100"),
          api<{
            modes: string[];
            items: RulesetOption[];
            presets?: RulesCatalog["presets"];
            custom?: RulesCatalog["custom"];
          }>("GET", "/rulesets"),
          api<{ items: TeamOption[] }>("GET", "/teams?limit=100"),
        ]);
        if (!alive) return;
        const allBots = b.items ?? [];
        // Sólo interesan los bots que pueden jugar (para elegir versión) y los PROPIOS
        // (para explicar por qué no pueden). Un bot ajeno sin publicar no se lista.
        const relevant = allBots.filter((x) => x.latestPublishedVersion != null || x.ownerId === props.me.id);
        setMaps((m.items ?? []).filter((x) => x.state === "published"));
        setBots(relevant);
        setModes(r.modes ?? []);
        setRulesets(r.items ?? []);
        setRulesCatalog({ presets: r.presets ?? [], custom: r.custom ?? null });
        setTeams((t.items ?? []).filter((x) => x.isMember));
        if (r.modes?.length) setMode(r.modes[0]);
        // Las versiones de cada bot: un fallo aquí no tumba la página (se cae al
        // `latestPublishedVersion` del listado y se dice que no se conocen las demás).
        // Cada bot se apunta al llegar su respuesta: hasta entonces está «cargando».
        await Promise.all(
          relevant.map(async (x) => {
            let vs: BotVersionSummary[] | null;
            try {
              const got = await api<BotVersionSummary[]>("GET", `/bots/${encodeURIComponent(x.id)}/versions`);
              vs = Array.isArray(got) ? got : null;
            } catch {
              vs = null;
            }
            if (alive) setVersionsByBot((prev) => ({ ...prev, [x.id]: vs }));
          }),
        );
      } catch (e) {
        if (alive) setLoadErr(e ?? new Error("error desconocido"));
      }
    })();
    return () => {
      alive = false;
    };
  }, [loadEpoch, props.me.id]);

  /** P3 · `undefined` = cargando, `null` = falló, lista = cargadas. */
  const versionsLoad = (id: string): VersionsLoad =>
    Object.prototype.hasOwnProperty.call(versionsByBot, id) ? versionsByBot[id] : undefined;
  const eligibility = (id: string): BotEligibility | undefined => {
    const b = bots.find((x) => x.id === id);
    return b ? botEligibility(b, versionsLoad(id) ?? null) : undefined;
  };
  /** Aviso de carga de versiones para un bot elegible: nada si ya están. */
  const versionsNote = (id: string): string => {
    const v = versionsLoad(id);
    if (v === undefined) return " · cargando sus versiones…";
    if (v === null) return " · no se pudieron cargar sus otras versiones";
    return "";
  };
  // Opciones REALES derivadas del modo elegido.
  const shownModes = kind === "team" ? modes.filter((m) => TEAM_MODES.includes(m)) : modes;
  // 4v4-FIX · modo EFECTIVO, siempre uno de los que enseña el desplegable. Si se marca
  // «BATALLA POR EQUIPOS» antes de que lleguen los rulesets, la carga hacía
  // `setMode(modes[0])` (= deathmatch): el select de equipos lo pintaba como su
  // primera opción, pero se enviaba el ruleset de DM y la API respondía 409
  // `deathmatch_shared_team` (functional-e2e golden del PR #191).
  // R-RULES · un preset o el personalizado fijan el modo (1v1 → deathmatch, equipos →
  // team_deathmatch); «Clásico» deja elegir cualquier modo como antes.
  const rulesFormat: "1v1" | "team" = kind === "team" ? "team" : "1v1";
  const rulesChoice: RulesChoice = rulesPick ?? defaultChoice(rulesCatalog, rulesFormat);
  const lockedMode = rulesChoice.kind === "classic" ? null : rulesFormat === "team" ? "team_deathmatch" : "deathmatch";
  const mode =
    lockedMode && shownModes.includes(lockedMode)
      ? lockedMode
      : shownModes.includes(modeChoice)
        ? modeChoice
        : kind === "team" && shownModes.includes("team_deathmatch")
          ? "team_deathmatch"
          : (shownModes[0] ?? "");
  const modeRulesets = rulesets.filter((r) => r.mode === mode || r.mode === null);
  const modeMaps = maps.filter((m) => (m.supportedModes ?? []).includes(mode));
  const mapsForMode = (md: string) => maps.filter((m) => (m.supportedModes ?? []).includes(md)).length;
  // UX-F (DEF-R8) · el primer mapa publicado compatible con el modo viene
  // preseleccionado (como el ruleset): antes había que adivinar que faltaba elegirlo.
  const keyOf = (m: MapVersion) => `${m.mapId}@${m.version}`;
  const effectiveMapKey = modeMaps.some((m) => keyOf(m) === mapKey) ? mapKey : modeMaps[0] ? keyOf(modeMaps[0]) : "";
  const selectedMap = modeMaps.find((m) => keyOf(m) === effectiveMapKey);
  // …y se dice qué mapas publicados NO salen y por qué (p. ej. mvp-arena-01 no admite deathmatch).
  const hiddenMaps = maps.filter((m) => !(m.supportedModes ?? []).includes(mode));
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

  const contentChecks: { ok: boolean; label: string }[] = [
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
  ];

  // Qué falta para poder crear la batalla individual: una fila ✓/✗ por requisito.
  const checks: { ok: boolean; label: string }[] = [
    ...contentChecks,
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

  // ------------------------------------------------ batalla por equipos (4v4)
  const teamById = (id: string) => teams.find((t) => t.id === id);
  const botName = (id: string): string =>
    bots.find((b) => b.id === id)?.name ??
    teams.flatMap((t) => t.bots ?? []).find((b) => b.id === id)?.name ??
    `bot ${id.slice(0, 8)}`;
  const inSlots = (side: SideKey) => new Set(slots[side].map((s) => s.botId));
  const allSlotIds = new Set([...slots.A, ...slots.B].map((s) => s.botId));
  const slotVersion = (s: TeamSlot) => chosenVersion(s.botId, s.picked);

  /** Bots elegibles del equipo que entran solos: hasta 4 y sin los que ya juegan en el otro bando. */
  function autoSlots(teamId: string, taken: Set<string>): TeamSlot[] {
    const out: TeamSlot[] = [];
    for (const tb of teamById(teamId)?.bots ?? []) {
      if (out.length >= MAX_PER_SIDE) break;
      if (taken.has(tb.id) || !eligibility(tb.id)?.eligible) continue;
      out.push({ botId: tb.id, picked: null });
    }
    return out;
  }
  function chooseTeam(side: SideKey, teamId: string) {
    setTeamIds((prev) => ({ ...prev, [side]: teamId }));
    setSlots((prev) => ({
      ...prev,
      [side]: teamId ? autoSlots(teamId, new Set(prev[SIDES[side].other].map((s) => s.botId))) : [],
    }));
  }
  const updateSlots = (side: SideKey, f: (list: TeamSlot[]) => TeamSlot[]) =>
    setSlots((prev) => ({ ...prev, [side]: f(prev[side]) }));

  /** Bots que pueden ENTRAR en un bando (añadir o sustituir): elegibles y que no juegan ya. */
  function candidates(side: SideKey): { fromTeam: BotSummary[]; others: BotSummary[] } {
    const teamBotIds = new Set((teamById(teamIds[side])?.bots ?? []).map((b) => b.id));
    const free = bots.filter((b) => !allSlotIds.has(b.id) && eligibility(b.id)?.eligible);
    return { fromTeam: free.filter((b) => teamBotIds.has(b.id)), others: free.filter((b) => !teamBotIds.has(b.id)) };
  }

  /** Por qué un bot del equipo NO está jugando en su bando. */
  function notPlayingReason(side: SideKey, botId: string): string {
    const other = SIDES[side].other;
    if (inSlots(other).has(botId)) return `ya juega en el Equipo ${other}: un bot sólo puede jugar una vez por batalla`;
    const e = eligibility(botId);
    if (!e) return "no elegible: no tiene ninguna versión publicada";
    if (!e.eligible) return e.summary;
    if (slots[side].length >= MAX_PER_SIDE)
      return `no cabe: máximo ${MAX_PER_SIDE} por bando (excluye otro para meterlo)`;
    return "excluido de esta batalla (puedes volver a añadirlo)";
  }

  function sideCheck(side: SideKey): { ok: boolean; label: string } {
    const head = `Equipo ${side} (bando ${SIDES[side].color})`;
    const team = teamById(teamIds[side]);
    if (!team) return { ok: false, label: `${head}: elige un equipo` };
    const list = slots[side];
    if (list.length === 0)
      return { ok: false, label: `${head}: ${team.name} no tiene ningún bot elegible (con versión publicada)` };
    if (list.length > MAX_PER_SIDE) return { ok: false, label: `${head}: máximo ${MAX_PER_SIDE} bots por bando` };
    const bad = list.filter((s) => slotVersion(s) == null);
    if (bad.length > 0)
      return {
        ok: false,
        label: `${head}: ${bad.map((s) => `${botName(s.botId)} — ${eligibility(s.botId)?.summary ?? "no elegible"}`).join("; ")}`,
      };
    return { ok: true, label: `${head}: ${team.name} · ${list.length} bot${list.length === 1 ? "" : "s"}` };
  }
  const nA = slots.A.length;
  const nB = slots.B.length;
  const teamChecks: { ok: boolean; label: string }[] = [...contentChecks, sideCheck("A"), sideCheck("B")];
  {
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const s of [...slots.A, ...slots.B]) (seen.has(s.botId) ? dup : seen).add(s.botId);
    for (const id of dup)
      teamChecks.push({
        ok: false,
        label: `${botName(id)} está dos veces: un bot sólo puede jugar una vez por batalla`,
      });
    if (nA + nB > MAX_PARTICIPANTS)
      teamChecks.push({ ok: false, label: `Demasiados participantes: ${nA + nB} (máximo ${MAX_PARTICIPANTS})` });
  }
  // R-RULES · tamaño NvN y comprobación en servidor (reglas + topes de créditos/masa).
  const rulesTeamSize = kind === "team" ? Math.max(nA, nB) : 1;
  const rulesPayload = rulesBody(rulesChoice, rulesTeamSize);
  const draftParticipants =
    kind === "team"
      ? (["A", "B"] as const).flatMap((side) =>
          slots[side].map((s) => ({ botId: s.botId, version: slotVersion(s), team: SIDES[side].team })),
        )
      : [
          { botId: redBot, version: rv, team: "red" },
          { botId: blueBot, version: bv, team: "blue" },
        ];
  const draftComplete =
    draftParticipants.length >= 2 &&
    draftParticipants.every((p) => p.botId && p.version != null) &&
    Boolean(selectedMap);
  const rulesCheck = useRulesCheck(
    rulesPayload && draftComplete && effectiveRuleset
      ? {
          mode,
          rulesetId: effectiveRuleset,
          mapId: selectedMap!.mapId,
          mapVersion: selectedMap!.version,
          participants: draftParticipants,
          rules: rulesPayload,
        }
      : null,
  );
  const rulesChecks: { ok: boolean; label: string }[] = [];
  if (rulesPayload && kind === "team" && nA !== nB) {
    rulesChecks.push({
      ok: false,
      label: `Reglas ${nA} contra ${nB}: estas reglas exigen el mismo número de bots en cada bando`,
    });
  }
  if (rulesPayload && rulesCheck.result && !rulesCheck.result.ok) {
    const why = [
      ...rulesCheck.result.errors.map((e) => e.message),
      ...(rulesCheck.result.composition?.violations ?? []).map((v) => v.message),
    ];
    rulesChecks.push({ ok: false, label: `Reglas: ${why.join("; ") || "no válidas"}` });
  }
  if (rulesPayload && rulesCheck.result?.ok) rulesChecks.push({ ok: true, label: "Reglas y presupuestos: válidos" });
  teamChecks.push(...rulesChecks);
  checks.push(...rulesChecks);
  const rulesBlocked = rulesChecks.some((c) => !c.ok);
  const teamValid = teamChecks.every((c) => c.ok);

  function chooseKind(k: "individual" | "team") {
    setKind(k);
    setError("");
    setSubmitErr(null);
    setMapKey("");
    setRulesetId("");
    setRulesPick(null);
    if (k === "team") {
      const tm = modes.filter((m) => TEAM_MODES.includes(m));
      setMode(tm.includes("team_deathmatch") ? "team_deathmatch" : (tm[0] ?? ""));
    } else {
      setMode(modes[0] ?? "");
    }
  }

  async function post(participants: { botId: string; version: number; team: string }[]) {
    setSubmitting(true);
    try {
      const battle = await api<{ id: string }>("POST", "/battles", {
        mode,
        rulesetId: effectiveRuleset, // id de la tabla `rulesets`, servido por GET /rulesets
        mapId: selectedMap!.mapId,
        mapVersion: selectedMap!.version,
        ...(seed ? { seed } : {}),
        participants,
        // R-RULES · el servidor valida y guarda la copia inmutable; ausente = clásico.
        ...(rulesPayload ? { rules: rulesPayload } : {}),
      });
      setCreated(battle.id);
    } catch (e) {
      setSubmitErr(e ?? new Error("error desconocido"));
    } finally {
      setSubmitting(false);
    }
  }

  async function submit() {
    setError("");
    setSubmitErr(null);
    if (!effectiveRuleset) return setError("No hay ningún ruleset para este modo.");
    if (!selectedMap) return setError("Elige un mapa publicado que soporte el modo.");
    if (!redBot || !blueBot) return setError("Elige un bot para cada bando.");
    if (redBot === blueBot) return setError("Elige dos bots distintos.");
    if (rv == null || bv == null || rulesBlocked) {
      const bad = checks.filter((c) => !c.ok).map((c) => c.label);
      return setError(`No se puede crear la batalla: ${bad.join("; ")}.`);
    }
    await post([
      { botId: redBot, version: rv, team: "red" },
      { botId: blueBot, version: bv, team: "blue" },
    ]);
  }

  async function submitTeam() {
    setError("");
    setSubmitErr(null);
    if (!teamValid || !selectedMap) {
      const bad = teamChecks.filter((c) => !c.ok).map((c) => c.label);
      return setError(`No se puede crear la batalla: ${bad.join("; ")}.`);
    }
    // Uno por bot, con la versión elegida; `team` es el BANDO (A → rojo, B → azul).
    await post(
      (["A", "B"] as const).flatMap((side) =>
        slots[side].map((s) => ({ botId: s.botId, version: slotVersion(s)!, team: SIDES[side].team })),
      ),
    );
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
    const versions = botId ? versionsLoad(botId) : undefined;
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
            {e.eligible ? versionsNote(botId) : ""}
          </p>
        )}
      </fieldset>
    );
  }

  /** Opciones de bots que pueden entrar en un bando: primero los del equipo, luego el resto. */
  function candidateOptions(side: SideKey): ReactNode {
    const c = candidates(side);
    return (
      <>
        {c.fromTeam.length > 0 && (
          <optgroup label="Del equipo">
            {c.fromTeam.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} {eligibility(b.id)!.short}
              </option>
            ))}
          </optgroup>
        )}
        {c.others.length > 0 && (
          <optgroup label="Otros bots que puedes usar">
            {c.others.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} {eligibility(b.id)!.short}
              </option>
            ))}
          </optgroup>
        )}
      </>
    );
  }

  function teamSide(side: SideKey) {
    const { color } = SIDES[side];
    const team = teamById(teamIds[side]);
    const list = slots[side];
    const mine = inSlots(side);
    const notPlaying = (team?.bots ?? []).filter((b) => !mine.has(b.id));
    const c = candidates(side);
    const anyCandidate = c.fromTeam.length + c.others.length > 0;
    return (
      <fieldset data-testid={`team-side-${side}`}>
        <legend>
          Equipo {side} · juega en el bando {color}
        </legend>
        <label>
          Equipo {side}{" "}
          <select
            aria-label={`equipo ${side}`}
            value={teamIds[side]}
            onChange={(ev) => chooseTeam(side, ev.target.value)}
          >
            <option value="">— elige un equipo —</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        {team && (
          <>
            <ul data-testid={`team-slots-${side}`}>
              {list.map((s, i) => {
                const name = botName(s.botId);
                const e = eligibility(s.botId);
                const v = slotVersion(s);
                const versions = versionsLoad(s.botId);
                const stateOf = (n: number) => versions?.find((x) => x.version === n)?.state ?? "published";
                return (
                  <li key={s.botId} data-testid="team-slot" data-bot-id={s.botId} className={v != null ? "ok" : "warn"}>
                    {v != null ? "✓" : "✗"} {name}
                    {v != null ? ` · v${v}` : ` — ${e?.summary ?? "no elegible"}`}{" "}
                    {e?.eligible && (
                      <select
                        aria-label={`versión ${name}`}
                        value={String(v ?? "")}
                        onChange={(ev) =>
                          updateSlots(side, (l) =>
                            l.map((x, j) => (j === i ? { ...x, picked: Number(ev.target.value) } : x)),
                          )
                        }
                      >
                        {e.playable.map((n) => (
                          <option key={n} value={String(n)}>
                            v{n} · {versionStateLabel(stateOf(n))}
                            {n === e.defaultVersion ? " (la más reciente publicada)" : ""}
                          </option>
                        ))}
                      </select>
                    )}{" "}
                    <button
                      type="button"
                      aria-label={`excluir ${name}`}
                      onClick={() => updateSlots(side, (l) => l.filter((_, j) => j !== i))}
                    >
                      Excluir
                    </button>{" "}
                    {anyCandidate && (
                      <select
                        aria-label={`sustituir ${name}`}
                        value=""
                        onChange={(ev) => {
                          const id = ev.target.value;
                          if (id)
                            updateSlots(side, (l) => l.map((x, j) => (j === i ? { botId: id, picked: null } : x)));
                        }}
                      >
                        <option value="">sustituir por…</option>
                        {candidateOptions(side)}
                      </select>
                    )}
                    {e?.eligible && versionsNote(s.botId) && <small>{versionsNote(s.botId)}</small>}
                  </li>
                );
              })}
            </ul>
            {list.length < MAX_PER_SIDE && anyCandidate && (
              <label>
                Añadir bot{" "}
                <select
                  aria-label={`añadir bot al equipo ${side}`}
                  value=""
                  onChange={(ev) => {
                    const id = ev.target.value;
                    if (id) updateSlots(side, (l) => [...l, { botId: id, picked: null }]);
                  }}
                >
                  <option value="">— elige —</option>
                  {candidateOptions(side)}
                </select>
              </label>
            )}
            {notPlaying.length > 0 && (
              <div data-testid={`team-not-playing-${side}`}>
                <p>
                  <small>Bots de {team.name} que no juegan:</small>
                </p>
                <ul>
                  {notPlaying.map((b) => (
                    <li key={b.id} className="warn">
                      {b.name} — {notPlayingReason(side, b.id)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </fieldset>
    );
  }

  const ineligibleOwn = bots.filter((b) => b.ownerId === props.me.id && !eligibility(b.id)?.eligible);
  const summaryLine = (side: SideKey) => {
    const ok = sideCheck(side).ok;
    const names = slots[side].map((s) => `${botName(s.botId)}${slotVersion(s) != null ? ` · v${slotVersion(s)}` : ""}`);
    return `Equipo ${side} ${ok ? "✓" : "✗"} ${names.length > 0 ? names.join(", ") : "sin bots"}`;
  };

  return (
    <section>
      <h2>Nueva batalla de práctica</h2>
      <p className="warn" role="note">
        La batalla se <strong>encola</strong> y la ejecuta el worker de la plataforma: cada bot corre su versión
        publicada en su contenedor aislado. El límite de ticks lo fija el ruleset.
      </p>
      <fieldset data-testid="battle-kind">
        <legend>Tipo de batalla</legend>
        <label>
          <input
            type="radio"
            name="battle-kind"
            checked={kind === "individual"}
            onChange={() => chooseKind("individual")}
          />{" "}
          <strong>BATALLA INDIVIDUAL</strong> · un bot contra otro (1 vs 1)
        </label>{" "}
        <label>
          <input type="radio" name="battle-kind" checked={kind === "team"} onChange={() => chooseKind("team")} />{" "}
          <strong>BATALLA POR EQUIPOS</strong> · hasta {MAX_PER_SIDE} bots por bando ({MAX_PER_SIDE} vs {MAX_PER_SIDE})
        </label>
      </fieldset>
      {kind === "individual" ? (
        <p data-testid="battle-concepts">
          Un <strong>bot</strong> es tu programa; una <strong>versión de bot</strong> es una entrega concreta de su
          código. En una batalla juegan <strong>versiones publicadas</strong>. El <strong>bando</strong> (rojo o azul)
          es sólo el lado del campo: no es un equipo de la sección Equipos, que aquí sólo sirve para filtrar la lista.
          Dos bots del mismo equipo pueden enfrentarse.
        </p>
      ) : (
        <p data-testid="team-concepts">
          Elige dos equipos de la sección Equipos: el <strong>Equipo A</strong> juega en el <strong>bando rojo</strong>{" "}
          y el <strong>Equipo B</strong> en el <strong>bando azul</strong>. El bando sigue siendo sólo el lado del
          campo: la batalla guarda el bando de cada bot, <strong>no</strong> qué equipo de la sección Equipos jugó, y el
          resultado se da por bando. Cada bot juega su versión publicada (puedes elegir otra), como mucho {MAX_PER_SIDE}{" "}
          por bando y {MAX_PARTICIPANTS} en total, y un bot sólo puede jugar una vez.
        </p>
      )}
      {loadErr !== null && (
        <ErrorState label="mapas, bots y rulesets" error={loadErr} onRetry={() => setLoadEpoch((n) => n + 1)} />
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <FormError error={submitErr} />

      {(rulesCatalog.presets.length > 0 || rulesCatalog.custom) && (
        <BattleRulesPicker
          catalog={rulesCatalog}
          format={rulesFormat}
          teamSize={rulesTeamSize}
          choice={rulesChoice}
          onChange={setRulesPick}
        />
      )}

      <label>
        Modo{" "}
        <select
          aria-label="modo"
          value={mode}
          onChange={(e) => {
            setMode(e.target.value);
            setMapKey("");
            setRulesetId("");
            // R-RULES · otro modo distinto del que fija el preset ⇒ reglas clásicas.
            if (lockedMode && e.target.value !== lockedMode) setRulesPick({ kind: "classic" });
          }}
        >
          {shownModes.map((m) => (
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
        <select aria-label="mapa" value={effectiveMapKey} onChange={(e) => setMapKey(e.target.value)}>
          {modeMaps.length === 0 && <option value="">— no hay mapas para este modo —</option>}
          {modeMaps.map((m) => (
            <option key={`${m.mapId}@${m.version}`} value={`${m.mapId}@${m.version}`}>
              {m.name ? `${m.name} · ` : ""}
              {m.mapId} v{m.version}
            </option>
          ))}
        </select>
      </label>
      {mode && hiddenMaps.length > 0 && (
        <p data-testid="maps-hidden">
          <small>
            No aparecen porque no admiten {modeName(mode)}:{" "}
            {hiddenMaps
              .map(
                (m) =>
                  `${m.name ?? m.mapId} v${m.version} (${
                    (m.supportedModes ?? []).length > 0
                      ? (m.supportedModes ?? []).map(modeName).join(", ")
                      : "sin modos declarados"
                  })`,
              )
              .join(" · ")}
            .
          </small>
        </p>
      )}
      {notEnoughMaps && mode && (
        <p className="warn" data-testid="maps-for-mode">
          Sólo aparecen los mapas publicados que declaran soportar el modo {modeName(mode)}; ahora no hay ninguno.
          {shownModes.some((m) => m !== mode && mapsForMode(m) > 0) &&
            ` Modos con mapas: ${shownModes
              .filter((m) => mapsForMode(m) > 0)
              .map(modeName)
              .join(", ")}.`}
        </p>
      )}
      {kind === "team" && shownModes.length === 0 && (
        <p className="warn" data-testid="no-team-modes">
          La plataforma no ofrece ningún modo por equipos ahora mismo.
        </p>
      )}
      <label>
        Semilla (opcional) <input aria-label="semilla" value={seed} onChange={(e) => setSeed(e.target.value)} />
      </label>

      {kind === "individual" ? (
        <>
          {sideControls("rojo", redTeam, setRedTeam, redBot, setRedBot, redVersion, setRedVersion)}
          {sideControls("azul", blueTeam, setBlueTeam, blueBot, setBlueBot, blueVersion, setBlueVersion)}

          <RulesCheckReport result={rulesPayload ? rulesCheck.result : null} checking={rulesCheck.checking} />
          <h3>Qué falta para crear la batalla</h3>
          <ul data-testid="battle-checklist">
            {checks.map((c) => (
              <li key={c.label} className={c.ok ? "ok" : "warn"}>
                {c.ok ? "✓" : "✗"} {c.label}
              </li>
            ))}
          </ul>

          <button disabled={submitting || notEnoughBots || notEnoughMaps || rulesBlocked} onClick={submit}>
            Crear batalla
          </button>
          {notEnoughBots && (
            <p className="warn">
              Necesitas al menos 2 bots con una versión publicada (ahora hay {eligibleBots.length}).
            </p>
          )}
        </>
      ) : (
        <>
          {teams.length === 0 && (
            <p className="warn" data-testid="no-teams">
              No eres miembro de ningún equipo. Crea uno en <a href="#/teams">Equipos</a> y asígnale bots con versión
              publicada.
            </p>
          )}
          {teamSide("A")}
          {teamSide("B")}

          <div data-testid="team-composition">
            <p data-testid="team-summary-A">
              {summaryLine("A")} <small>(bando rojo)</small>
            </p>
            <p data-testid="team-summary-B">
              {summaryLine("B")} <small>(bando azul)</small>
            </p>
            <p data-testid="participants-count">
              Participantes: {nA} vs {nB} · {nA + nB} / {MAX_PARTICIPANTS}
            </p>
          </div>

          <RulesCheckReport result={rulesPayload ? rulesCheck.result : null} checking={rulesCheck.checking} />
          <h3>Qué falta para crear la batalla</h3>
          <ul data-testid="battle-checklist">
            {teamChecks.map((c) => (
              <li key={c.label} className={c.ok ? "ok" : "warn"}>
                {c.ok ? "✓" : "✗"} {c.label}
              </li>
            ))}
          </ul>

          <button disabled={submitting || !teamValid} onClick={submitTeam}>
            Crear batalla
          </button>
        </>
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
