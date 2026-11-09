/**
 * T7.4 · Panel de usuario: bots con sus estados, editor de loadout integrado,
 * subida de código (archivo o pegado) y resultado de cada etapa del pipeline E6.
 *
 * R3.7 (ERR-VIS-04/10):
 *  - el editor CARGA la revisión vigente del bot (GET /bots/{id}/loadouts) y se
 *    remonta con key={bot.id} para no arrastrar estado entre bots;
 *  - la lista de bots y el detalle del bot son recursos con carga/error visibles
 *    (un fallo nunca se pinta como "no tienes bots");
 *  - enlace bot → batallas (#/battles?bot=<id>) → replay, sin teclear UUIDs;
 *  - sin non-null assertions sobre la selección.
 *
 * B11 · El panel MENTÍA sobre el estado de las versiones. Tres defectos reales
 * sufridos por el dueño del proyecto (verificados contra la BD de producción):
 *
 *  1. Enseñaba el error de una versión ANTIGUA. El detalle se cargaba UNA vez
 *     por bot y el "Pipeline de build" era un recuerdo congelado del 202 del
 *     submit, sin decir a qué versión pertenecía: tras subir v2/v3/v4 seguía
 *     en pantalla el resultado de v1. Ahora hay una versión ENFOCADA explícita
 *     (la recién subida, o la más alta) y tanto el resumen como el pipeline se
 *     leen SIEMPRE de esa versión y van rotulados con su número.
 *  2. El pipeline se quedaba en `queued` con todas las etapas `pending` para
 *     siempre, aunque el build hubiera terminado hacía minutos. Ahora el estado
 *     se lee del servidor (GET /bots/{id}/versions/{v}/builds, extensión B11:
 *     el id de build del submit se perdía en cada F5) y se sondea mientras haya
 *     trabajo en curso, con FIN: agotado el presupuesto de sondeos se dice
 *     "estado desconocido" y se ofrece actualizar. Nunca se inventa un final.
 *  3. Un `draft` sin enviar parecía una versión más. Ahora sale marcado como
 *     SIN ENVIAR con la acción que falta.
 *
 * B11 (correcciones del supervisor):
 *  - el motivo de rechazo SOLO se pinta si la versión está `rejected`. Al
 *    reenviar una rechazada, la fila conservaba el `rejection_reason` anterior
 *    (la API ya lo limpia en `submit`, pero el cliente no debe depender de eso)
 *    y salía "validating" junto al error del intento previo: la misma mentira
 *    que motivó el bloque, ascendida a la tarjeta destacada;
 *  - el sondeo REVALIDA EN SILENCIO y solo el recurso de builds. Recargar los
 *    tres recursos volviendo a "loading" desmontaba el subárbol entero cada 2 s:
 *    el editor de loadout y el área de código se recreaban, el foco se perdía y
 *    los cambios sin guardar del usuario se revertían solos. El recurso de
 *    loadouts NO se sondea nunca (es el que remonta el editor y no hace falta
 *    para el pipeline); el de versiones se revalida solo cuando el build llega a
 *    un estado terminal, que es cuando puede haber cambiado.
 *
 * #255 · UNA sola navegación del bot (ver ./bot-nav.ts). Antes convivían esta
 * página larga con su índice por `scrollIntoView` (EQ4), una segunda vista del
 * mismo bot con pestañas propias (`BotDetailPage`, DEV-A A9.19) y un enlace
 * «detalle y versiones» entre ambas: dos tablas de versiones, dos editores de
 * código, dos vistas de build y la visibilidad del bot y la del código en
 * pestañas distintas. Ahora: [lista de bots] | [menú de secciones | UNA sección].
 * Cambiar de sección cambia el hash (`#/bots/<id>/<sección>`), pinta sólo esa
 * sección y lleva el foco a su encabezado; no desplaza la página. Lo que hacía
 * `BotDetailPage` (visor de código, diff, clonado, build con logs, visibilidad)
 * vive en la sección que le toca, una sola vez.
 */
import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { api, type Me } from "../api.js";
import { LoadoutEditor, type LoadoutDraft } from "./LoadoutEditor.js";
import { useResource, ResourceView, type Resource } from "../resource.js";
import { FormError, LiveStatus } from "../ui/primitives.js";
import { BOT_PANEL_SECTIONS, botHref, parseBotsRoute, sectionLabel, type BotSection } from "./bot-nav.js";
import { BotVisibilityCard, botVisibilityLabel } from "../visibility.js";
import { isBattleEligible, VersionEligibilityNote, type BattleEligibilityInfo } from "../version-eligibility.js";
import { slotName } from "../help/names.js";
import { BotBattlesSection, BotReplaysSection } from "./BotActivity.js";
import { useSessionDraft } from "../ui/draft.js";
import { BOT_TEMPLATES, HOOK_HELP, isUntouchedTemplate, type BotRuntime } from "../bot-templates.js";
import { BuildDiagnosisView, diagnoseBuild } from "../build-diagnosis.js";
import type { ModuleDefinition } from "../../../../packages/module-catalog/types.js";
import type { Violation } from "../../../../packages/module-catalog/validator/index.js";

interface Bot {
  id: string;
  name: string;
  visibility: string;
  /** Ausente en dobles de prueba de la lista propia (la lista es `ownerId=<yo>`). */
  ownerId?: string;
  teamId?: string;
  createdAt?: string;
  latestPublishedVersion?: number;
  /** EQ4 · retirado (organizativo) o null/ausente = activo. */
  retiredAt?: string | null;
}
interface BotVersion {
  version: number;
  state: string;
  runtime: string;
  loadoutRevision: number;
  rejectionReason?: string;
  /** VISIBILIDAD · el código de ESTA versión es público (independiente de bot.visibility). */
  codePublic?: boolean;
  createdAt?: string;
  parentVersion?: number;
  publishedAt?: string;
  artifactHash?: string;
  /** ELIG · elegibilidad para batallas nuevas (sólo published/frozen). */
  battleEligibility?: BattleEligibilityInfo;
}
interface Loadout {
  revision: number;
  catalogVersion: string;
  chassis: string;
  modules: { slot: string; moduleId: string; ammo?: string }[];
}
interface Build {
  id: string;
  version?: number;
  status: string;
  stages: { name: string; status: string; message?: string; logs?: string[]; metrics?: Record<string, number> }[];
  artifactHash?: string;
}
/** Builds de la versión enfocada. `known:false` = no se sabe (y así se dice). */
interface BuildsView {
  list: Build[];
  known: boolean;
  /** Versión a la que corresponde esta lectura; undefined = ninguna todavía. */
  forVersion?: number;
}

/** Estados de versión en los que HAY trabajo del pipeline en curso (cap. 17.1). */
const VERSION_IN_PROGRESS = ["validating"];
/** Estados de build no terminales (migración `builds`: queued|running|passed|failed). */
const BUILD_IN_PROGRESS = ["queued", "running"];

export const isBuildInProgress = (status: string): boolean => BUILD_IN_PROGRESS.includes(status);

/** ¿Queda trabajo en curso sobre la versión enfocada? Decide si merece sondear. */
export function workInProgress(versionState: string | undefined, builds: BuildsView | null): boolean {
  if (!versionState) return false;
  if (VERSION_IN_PROGRESS.includes(versionState)) return true;
  return !!builds && builds.known && builds.list.length > 0 && isBuildInProgress(builds.list[0].status);
}

/**
 * El motivo de rechazo pertenece al estado `rejected` y a ningún otro. La API
 * guarda `rejection_reason` en la fila de la versión y una versión reenviada
 * pasa por `validating` — pintarlo ahí es contar el error del intento anterior
 * como si fuera el actual.
 */
export function rejectionToShow(v: { state: string; rejectionReason?: string } | undefined): string | undefined {
  if (!v || v.state !== "rejected") return undefined;
  return v.rejectionReason;
}

/** Qué le falta al usuario por hacer con esta versión (vacío = nada). */
export function pendingActionFor(state: string): string {
  if (state === "draft") return "sin enviar — pulsa «Enviar a validación»";
  if (state === "rejected") return "corrige el código y vuelve a enviarla";
  if (state === "validated") return "pendiente de publicar";
  return "";
}

/** Gating conjunto de dos recursos sin anidar dos ResourceView. */
function combine<A, B>(a: Resource<A>, b: Resource<B>): Resource<{ a: A; b: B }> {
  if (a.status === "error") return a;
  if (b.status === "error") return b;
  if (a.status === "loading" || b.status === "loading") return { status: "loading" };
  return { status: "ready", data: { a: a.data, b: b.data } };
}

/** UX-B · B1 · límite del nombre (el mismo que valida la API, routes/bots.ts). */
export const BOT_NAME_MAX = 48;

/** Validación en cliente del nombre del bot: mensaje legible o null si vale. */
export function botNameProblem(raw: string, existing: string[] = []): string | null {
  const name = raw.trim();
  if (!name) return "Escribe un nombre para el bot.";
  if (name.length > BOT_NAME_MAX)
    return `El nombre admite como máximo ${BOT_NAME_MAX} caracteres (tiene ${name.length}).`;
  if (existing.includes(name)) return `Ya tienes un bot llamado «${name}».`;
  return null;
}

/** UX-B · B6 · versión que usan las batallas NUEVAS: la publicada más alta (G-18). */
export function versionInBattles(versions: { version: number; state: string }[]): number | undefined {
  const published = versions.filter((v) => v.state === "published").map((v) => v.version);
  return published.length ? Math.max(...published) : undefined;
}

/** DEV-A · A9.19 · `#/bots/<botId>` → bot elegido en el panel único (#255; ver bot-nav.ts). */
export function matchBotDetailRoute(hash: string): string | null {
  const m = /^#\/bots\/([^/?#]+)/.exec(hash);
  return m ? decodeURIComponent(m[1]) : null;
}

/** EQ4 · tamaño de página de «Mis bots» (máximo del contrato). */
export const BOTS_PAGE = 100;

interface BotListPage {
  items: Bot[];
  nextCursor?: string;
  counts?: { total: number; active: number; retired: number };
}

/** EQ4 · visibilidad en palabras. */
const VISIBILITY_TEXT: Record<string, string> = { private: "privado", team: "de equipo", public: "público" };

export function BotsPage(props: Parameters<typeof BotsWorkspace>[0]) {
  return <BotsWorkspace {...props} />;
}

/** El hash vigente, vivo (las secciones y el bot elegido viven en él). */
function useHash(): [string, (href: string) => void] {
  const [hash, setHash] = useState(() => (typeof window !== "undefined" ? window.location.hash : ""));
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = (href: string) => {
    if (window.location.hash !== href) window.location.hash = href;
    setHash(href);
  };
  return [hash, go];
}

/** Ficheros de una versión (visor de código). */
interface FilesInfo {
  version: number;
  packaged: boolean;
  files: { path: string; content: string }[];
}
interface DiffInfo {
  from: number;
  to: number;
  files: { path: string; status: string; additions: number; deletions: number; diff: string }[];
}

/**
 * UX-B · G-15 · ¿se puede editar esta versión en la web sin perder nada? Sólo si se
 * subió como UN fichero pegado (`packaged: false`). Un paquete `{"files": [...]}`
 * puede traer varios ficheros, y el editor web sólo reenvía uno.
 */
export function isWebEditable(files: { packaged: boolean } | null): boolean {
  return !!files && !files.packaged;
}

const MAIN_ENTRY = /(^|\/)(bot|main)\.(py|js|mjs)$/;
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : "—");
const short = (h?: string) => (h ? `${h.slice(0, 12)}…` : "—");
/** Se clasifica por FORMA (status), como ErrorState: no depende de la clase concreta. */
const errText = (e: unknown) => {
  const status = (e as { status?: number } | null)?.status;
  if (status === 403) return "No tienes permiso para ver el código de esta versión (es privado).";
  if (status === 404) return "No existe o no es visible para ti.";
  return String((e as Error)?.message ?? e);
};

function BotsWorkspace(props: {
  me: Me;
  catalog: ModuleDefinition[];
  catalogVersion: string;
  budgetCredits: number;
  /** Sondeo del pipeline: parametrizado para poder probarlo sin esperas reales. */
  pollIntervalMs?: number;
  maxPolls?: number;
  /** Tope de espera por una lectura que no vuelve (issue #95). */
  maxPollWaitMs?: number;
}) {
  const pollIntervalMs = props.pollIntervalMs ?? 2000;
  // ~5 min: presupuesto FINITO por diseño. Era 30 (~60 s) y en producción (RC5)
  // un build de 68 s, el primero tras recrear los servicios con el hipervisor
  // cargado, dejó el panel en «Validación en curso…» sin enterarse del final.
  const maxPolls = props.maxPolls ?? 150;
  /**
   * issue #95 · Tope de ESPERA por una lectura que no vuelve. `api.ts` hace
   * `fetch` sin plazo ni `AbortController`, así que una lectura puede quedarse
   * colgada indefinidamente (pasarela colgada, agujero negro TCP). Sin este tope
   * el sondeo esperaría para siempre sin llegar nunca a agotarse y el panel se
   * quedaría en «Validación en curso…» eternamente: el mismo bloqueo que este
   * arreglo persigue, pero por el otro lado (defecto 1 del supervisor).
   */
  const maxPollWaitMs = props.maxPollWaitMs ?? 30_000;

  // EQ4 (rev. EQ6 P2-2) · antes sólo llegaban los 20 primeros (límite por defecto)
  // y Activos/Retirados se contaba sobre esa página parcial. Ahora: páginas de
  // BOTS_PAGE por cursor («Cargar más») y contadores REALES del servidor
  // (includeCounts). Una recarga trae las mismas páginas que ya se veían.
  const botPages = useRef(1);
  const [botsRes, reloadBots] = useResource(async () => {
    const base = `/bots?ownerId=${encodeURIComponent(props.me.id)}&limit=${BOTS_PAGE}&includeCounts=true`;
    const first = await api<BotListPage>("GET", base);
    const items = [...(first.items ?? [])];
    let cursor = first.nextCursor;
    for (let p = 1; p < botPages.current && cursor; p++) {
      const next = await api<BotListPage>("GET", `${base}&cursor=${encodeURIComponent(cursor)}`);
      items.push(...(next.items ?? []));
      cursor = next.nextCursor;
    }
    return { items, nextCursor: cursor, counts: first.counts };
  }, [props.me.id]);
  const loadMoreBots = () => {
    botPages.current += 1;
    reloadBots({ silent: true });
  };
  // #255 · el bot elegido y la sección viven en el HASH (F5 los conserva).
  const [hash, go] = useHash();
  const route = parseBotsRoute(hash);
  const section: BotSection = route.botId ? route.section : "resumen";
  const listed =
    route.botId && botsRes.status === "ready" ? botsRes.data.items.find((b) => b.id === route.botId) : undefined;
  // Un bot que no está en «Mis bots» (p. ej. el de un compañero de equipo, enlazado
  // desde una batalla) se lee de la API: si no es visible, la API dice 404.
  // (Y también si «Mis bots» no ha cargado: el panel del bot no depende de la lista.)
  const needsFetch = !!route.botId && (botsRes.status === "error" || (botsRes.status === "ready" && !listed));
  const [extBotRes, reloadExtBot] = useResource<Bot | null>(
    async () => (needsFetch && route.botId ? api<Bot>("GET", `/bots/${encodeURIComponent(route.botId)}`) : null),
    [needsFetch, route.botId],
  );
  // Lo que acaba de confirmar la API (PATCH) se ve ya, sin esperar a recargar la lista.
  const [patched, setPatched] = useState<Record<string, Partial<Bot>>>({});
  const base: Bot | null = listed ?? (needsFetch && extBotRes.status === "ready" ? extBotRes.data : null) ?? null;
  const selected: Bot | null = base ? { ...base, ...(patched[base.id] ?? {}) } : null;
  const patchBot = (id: string, p: Partial<Bot>) => setPatched((cur) => ({ ...cur, [id]: { ...cur[id], ...p } }));
  // El dueño es quien edita; la lista propia no trae `ownerId` en todos los dobles.
  const isOwner = !!selected && (selected.ownerId === undefined || selected.ownerId === props.me.id);
  // Versión que el usuario está mirando. null = "la última" (se resuelve al cargar).
  const [focusRequest, setFocusRequest] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  // UX-B · B3: el editor arranca con una plantilla VÁLIDA del runtime, nunca vacío.
  // UX-R · código y runtime en BORRADOR de sesión (useSessionDraft): si la sesión
  // caduca de verdad y el panel se desmonta, lo escrito vuelve al iniciar sesión.
  const runtimeDraft = useSessionDraft("bots:upload:runtime", "python");
  const runtime: BotRuntime = runtimeDraft.value === "node" ? "node" : "python";
  const setRuntime = (r: BotRuntime) => runtimeDraft.setValue(r);
  const codeDraft = useSessionDraft("bots:upload:code", BOT_TEMPLATES.python);
  const pasted = codeDraft.value;
  const setPasted = codeDraft.setValue;
  // Versión de la que se cargó el código del editor (para decir qué se edita).
  const [editingFrom, setEditingFrom] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const codeRef = useRef<HTMLTextAreaElement | null>(null);
  const [error, setError] = useState("");
  // REVIEW (R4.8) · el error de «Crear bot» se pinta JUNTO al formulario (antes
  // sólo se veía con un bot abierto) con el componente común de D.
  const [createErr, setCreateErr] = useState<unknown>(null);
  /**
   * issue #95 (defecto 1 del re-supervisor) · POR QUÉ se dejó de sondear, no solo
   * "se dejó". Eran dos causas distintas metidas en un booleano, y el mensaje solo
   * sabía contar una: al vencer la espera decía «tras N comprobaciones» sin haber
   * hecho N —medido: 3 lecturas reales anunciadas como 100—. En el componente cuyo
   * contrato es «el panel debe decir LA VERDAD», eso es una cadena falsa.
   */
  const [pollStop, setPollStop] = useState<null | "budget" | "wait">(null);
  const pollExhausted = pollStop !== null;
  const setPollExhausted = (v: boolean) => setPollStop(v ? "budget" : null);
  /** issue #95 · Reanudar el sondeo es CAMBIAR DE ÉPOCA: rearma el bucle. */
  const [pollEpoch, setPollEpoch] = useState(0);

  // ---------------------------------------------------------------- recursos
  // Tres recursos INDEPENDIENTES a propósito: el sondeo solo toca el de builds
  // (y el de versiones cuando el build termina). El de loadouts, que es el que
  // alimenta el editor, no se sondea nunca.
  const [versionsRes, reloadVersions] = useResource<BotVersion[]>(
    async () => (selected ? api<BotVersion[]>("GET", `/bots/${selected.id}/versions`) : []),
    [selected?.id],
  );
  // N1: la marca de "desfasado" la lleva el PROPIO recurso, no un estado que
  // fije el loader. Marcarla desde el loader es una carrera: con dos lecturas
  // solapadas, la vieja resolvía con éxito después de que la nueva fallara y
  // borraba el aviso, dejando datos viejos con cara de sanos. Aquí solo la
  // lectura vigente (la que `useResource` considera viva) puede tocarla.
  const versionsStale = versionsRes.status === "ready" && versionsRes.staleError !== undefined;

  const [loadoutsRes, reloadLoadouts] = useResource<Loadout[]>(
    async () => (selected ? api<Loadout[]>("GET", `/bots/${selected.id}/loadouts`) : []),
    [selected?.id],
  );

  const versions = versionsRes.status === "ready" ? versionsRes.data : null;
  // La enfocada es la pedida explícitamente; si no, la MÁS ALTA (la última
  // subida). Nunca la primera: ese era el error de v1 pintado sobre v4.
  const focusedVersion =
    versions && versions.length > 0
      ? focusRequest !== null && versions.some((v) => v.version === focusRequest)
        ? focusRequest
        : Math.max(...versions.map((v) => v.version))
      : undefined;
  const focused = versions?.find((v) => v.version === focusedVersion);

  const [buildsRes, reloadBuilds] = useResource<BuildsView>(async () => {
    if (!selected || focusedVersion === undefined) return { list: [], known: true };
    try {
      const list = await api<Build[]>("GET", `/bots/${selected.id}/versions/${focusedVersion}/builds`);
      return { list, known: true, forVersion: focusedVersion };
    } catch {
      // No se inventa un pipeline: se marca como desconocido.
      return { list: [], known: false, forVersion: focusedVersion };
    }
  }, [selected?.id, focusedVersion]);
  // Solo vale si es la lectura DE ESTA versión: si no, todavía no se sabe nada
  // (mostrar los builds de otra versión es exactamente el defecto de B11).
  const builds = buildsRes.status === "ready" && buildsRes.data.forVersion === focusedVersion ? buildsRes.data : null;

  // ----------------------------------------------------------------- sondeo
  const reloadBuildsRef = useRef(reloadBuilds);
  reloadBuildsRef.current = reloadBuilds;
  const reloadVersionsRef = useRef(reloadVersions);
  reloadVersionsRef.current = reloadVersions;

  // issue #95 · El presupuesto de sondeos lo lleva un REF, no solo el estado.
  // El contador de render es para pintar; el que decide si queda presupuesto es
  // este, y se consulta en el instante de disparar. Ver el bucle de abajo.
  const pollsRef = useRef(0);
  // ¿Hay una lectura de builds del SONDEO en vuelo? Se cierra cuando el recurso
  // publica una lectura nueva.
  //
  // OJO, no es exclusión mutua estricta: el liberador se dispara con cualquier
  // cambio de identidad de `buildsRes` —incluido el `loading` de un cambio de
  // dependencias—, así que puede haber dos lecturas solapadas (el supervisor
  // midió 2). Lo que SÍ garantiza es el presupuesto, porque el hueco se reserva
  // contra `pollsRef` en el instante de disparar, no al publicarse la respuesta.
  const pollInFlightRef = useRef(false);
  useEffect(() => {
    pollInFlightRef.current = false;
  }, [buildsRes]);
  const needVersionPollRef = useRef(false);

  // Cambiar de bot o de versión enfocada reinicia el presupuesto de sondeos.
  //
  // issue #102 · Y REANUDA EL BUCLE, que es lo que faltaba. Reiniciar el contador
  // no basta: si el presupuesto ya se había agotado, el bucle salió SIN
  // reprogramarse, y sus dependencias (`inProgress`, `maxPolls`, `pollIntervalMs`,
  // `maxPollWaitMs`, `pollEpoch`) no cambian al enfocar otra versión del mismo
  // bot —`focused.state` sigue siendo `validating`, así que `inProgress` ni
  // siquiera parpadea—. El panel quedaba diciendo «En curso: comprobando cada N
  // s…» sin comprobar nada: la mentira de B11 por tercera puerta. El caso de
  // cambio de BOT se salvaba de casualidad, porque al recargarse el recurso de
  // versiones `focused` queda indefinido un instante e `inProgress` cae a false,
  // rearmando el efecto. Con la época, los dos casos reanudan por el mismo
  // camino y ninguno depende de esa casualidad.
  useEffect(() => {
    pollsRef.current = 0;
    setPollExhausted(false);
    setPollEpoch((n) => n + 1);
  }, [selected?.id, focusRequest]);

  const inProgress = workInProgress(focused?.state, builds);
  // Caso raro (anomalía de datos): la versión dice `validating` pero no hay
  // build que seguir. Entonces lo que hay que revalidar es la versión.
  const needVersionPoll = focused?.state === "validating" && !!builds && (!builds.known || builds.list.length === 0);
  needVersionPollRef.current = needVersionPoll;

  // issue #95 · UN SOLO bucle de sondeo, que se reprograma a sí mismo. Antes el
  // efecto se rearmaba con cada cambio de `builds` y de `polls`, y eso rompía
  // las dos garantías del sondeo:
  //
  //  1. EL PRESUPUESTO NO SE RESPETABA. La guarda leía el `polls` del render y
  //     el incremento era funcional, así que dos ejecuciones del efecto nacidas
  //     de renders con el MISMO `polls` (la del incremento y la de la respuesta
  //     que llegaba a la vez) armaban dos temporizadores: dos peticiones para un
  //     único hueco de presupuesto. Medido: 7 peticiones con `maxPolls: 6`.
  //     Ahora el hueco se reserva en el disparo contra `pollsRef`, que es
  //     inmediato: nunca salen más de `maxPolls` peticiones, se rendericé lo que
  //     se renderice por el camino.
  //
  //  2. SE MACHACABA LA PASARELA. Cada rearme lanzaba una lectura aunque la
  //     anterior siguiera en vuelo, y `useResource` descarta por diseño la
  //     vieja: con la pasarela más lenta que el intervalo, casi todas las
  //     lecturas se cancelaban entre sí. Medido con la pasarela fallando y
  //     `maxPolls: 4`: 5 peticiones antes / 4 exactas ahora (reproducido por el
  //     supervisor). NO se apunta aquí ninguna cifra de "sondeos totales con N
  //     cambios de foco": el re-supervisor midió que ese número no es estable
  //     —cada cambio de foco reinicia el presupuesto— y en su banco salía incluso
  //     al revés. Una cifra que no se reproduce no se queda escrita. Un ciclo espera
  //     ahora al anterior, y esperar NO gasta presupuesto (no se ha preguntado
  //     nada) pero SÍ tiene tope (ver `maxPollWaitMs`).
  //
  //     HONESTIDAD SOBRE EL ALCANCE: la primera versión de este comentario
  //     afirmaba "161 lecturas descartadas y 0 publicadas, panel congelado para
  //     siempre". El supervisor independiente NO consiguió reproducir el panel
  //     congelado —en su banco las lecturas resolvían y el estado final llegaba—,
  //     así que esa afirmación queda retirada por no demostrada. Lo confirmado
  //     es el sobre-sondeo y el presupuesto excedido, que es motivo suficiente.
  useEffect(() => {
    if (!inProgress) return;
    let cancelled = false;
    let waitedMs = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(tick, pollIntervalMs);
    };
    function tick() {
      if (cancelled) return;
      if (pollInFlightRef.current) {
        // Esperar NO gasta presupuesto (no se ha preguntado nada), pero la espera
        // es FINITA: una lectura que no vuelve nunca no puede dejar el panel
        // diciendo «en curso» para siempre. Al agotarse, se declara desconocido,
        // que es la respuesta honesta.
        waitedMs += pollIntervalMs;
        if (waitedMs >= maxPollWaitMs) {
          setPollStop("wait");
          return;
        }
        schedule();
        return;
      }
      waitedMs = 0;
      if (pollsRef.current >= maxPolls) {
        setPollExhausted(true);
        return;
      }
      pollsRef.current += 1;
      pollInFlightRef.current = true;
      // SILENCIOSO: revalida sin desmontar el panel (ni el editor, ni el área
      // de código, ni el foco del usuario).
      reloadBuildsRef.current({ silent: true });
      if (needVersionPollRef.current) reloadVersionsRef.current({ silent: true });
      schedule();
    }
    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [inProgress, maxPolls, pollIntervalMs, maxPollWaitMs, pollEpoch]);

  // Cuando el build llega a un estado TERMINAL, la versión ya ha cambiado en la
  // misma transacción (completeBuild): una única revalidación silenciosa de
  // versiones trae el estado final y su motivo de rechazo. Sin esto habría que
  // sondear versiones cada tick (el triple de peticiones) para nada.
  const reconciledRef = useRef<string>("");
  useEffect(() => {
    const b = builds?.list[0];
    if (!builds?.known || !b || isBuildInProgress(b.status)) return;
    if (focused?.state !== "validating") return;
    const key = `${b.id}:${b.status}`;
    if (reconciledRef.current === key) return;
    reconciledRef.current = key;
    reloadVersionsRef.current({ silent: true });
  }, [builds, focused?.state]);

  function refreshNow() {
    pollsRef.current = 0;
    setPollExhausted(false);
    reconciledRef.current = "";
    // issue #95 (defecto 2 del supervisor) · Apagar el aviso sin REANUDAR el
    // sondeo es peor que no hacer nada: el bucle había salido sin reprogramarse
    // y sus dependencias no cambian, así que el usuario se quedaba mirando un
    // pipeline «en curso» que ya no se iba a actualizar jamás. La época fuerza a
    // que el efecto se rearme. (No se toca `pollInFlightRef`: el re-supervisor
    // demostró que la reanudación funciona igual sin ello —con una lectura colgada
    // pasó de 3 a 33 lecturas— y una línea que ningún test puede matar es una
    // línea que sobra.)
    setPollEpoch((n) => n + 1);
    reloadVersions({ silent: true });
    reloadBuilds({ silent: true });
  }

  // ------------------------------------------------- navegación y sección
  const sectionHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const editorFocusPending = useRef(false);
  const navMounted = useRef(false);
  // Al cambiar de sección (o de bot) el foco va al encabezado de la sección, SIN
  // desplazar la página (`preventScroll`): el lector de pantalla lo anuncia y el
  // teclado sigue desde ahí. No en el primer montaje (no se roba el foco al entrar).
  useEffect(() => {
    if (!navMounted.current) {
      navMounted.current = true;
      return;
    }
    if (editorFocusPending.current) return;
    sectionHeadingRef.current?.focus({ preventScroll: true });
  }, [section, selected?.id]);
  useEffect(() => {
    if (!editorFocusPending.current || section !== "codigo") return;
    if (!codeRef.current) return;
    editorFocusPending.current = false;
    codeRef.current.focus({ preventScroll: true });
  });

  /** Enlace interno: cambia el hash y la sección sin recargar ni desplazar. */
  const navTo = (href: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(href);
  };
  const openSection = (s: BotSection) => {
    if (selected) go(botHref(selected.id, s));
  };

  // Versión que se mira en «Código» (visor) y comparación pedida.
  const [codeVersion, setCodeVersion] = useState<number | null>(null);
  const [diffAgainst, setDiffAgainst] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    setCodeVersion(null);
    setDiffAgainst(null);
    setNotice(null);
  }, [selected?.id]);
  const viewerVersion =
    codeVersion ?? (versions && versions.length ? Math.max(...versions.map((v) => v.version)) : null);
  const [filesRes] = useResource<FilesInfo | null>(
    async () =>
      selected && section === "codigo" && viewerVersion !== null
        ? api<FilesInfo>("GET", `/bots/${selected.id}/versions/${viewerVersion}/files`)
        : null,
    [selected?.id, section === "codigo", viewerVersion],
  );
  const [diffRes] = useResource<DiffInfo | null>(
    async () =>
      selected && section === "codigo" && viewerVersion !== null && diffAgainst !== null
        ? api<DiffInfo>("GET", `/bots/${selected.id}/versions/${viewerVersion}/diff?against=${diffAgainst}`)
        : null,
    [selected?.id, section === "codigo", viewerVersion, diffAgainst],
  );

  // --------------------------------------------------------------- acciones
  async function onCreateBot(e: FormEvent) {
    e.preventDefault(); // Enter crea el bot (a11y R3.7)
    // UX-B · B1: un doble clic (o Enter + clic) no crea dos bots: mientras hay una
    // creación en vuelo, el formulario no envía otra.
    if (creating) return;
    setCreateErr(null);
    const existing = botsRes.status === "ready" ? botsRes.data.items.map((b) => b.name) : [];
    const problem = botNameProblem(newName, existing);
    if (problem) {
      setCreateErr(Object.assign(new Error(problem), { status: 400 }));
      return;
    }
    setCreating(true);
    try {
      const created = await api<Bot>("POST", "/bots", { name: newName.trim() });
      setNewName("");
      reloadBots();
      // El paso siguiente es su equipamiento: se abre el bot recién creado ahí.
      if (created?.id) {
        setFocusRequest(null);
        go(botHref(created.id, "equipamiento"));
      }
    } catch (err) {
      setCreateErr(err ?? new Error("error desconocido"));
    } finally {
      setCreating(false);
    }
  }

  function changeRuntime(next: BotRuntime) {
    // La plantilla sólo se sustituye si el usuario no ha escrito nada propio.
    if (isUntouchedTemplate(pasted)) setPasted(BOT_TEMPLATES[next]);
    setRuntime(next);
  }

  /** Carga el código de una versión en el ÚNICO editor (la versión no cambia). */
  function editFrom(v: BotVersion, content: string) {
    setRuntime(v.runtime === "node" ? "node" : "python");
    setPasted(content);
    setEditingFrom(v.version);
    editorFocusPending.current = true;
    openSection("codigo");
  }

  /** UX-02 · «Corregir»: carga el código de la versión rechazada en el editor. */
  async function loadCodeForFix(v: BotVersion) {
    if (!selected) return;
    setError("");
    try {
      const f = await api<{ files: { path: string; content: string }[] }>(
        "GET",
        `/bots/${selected.id}/versions/${v.version}/files`,
      );
      const entry = f.files.find((x) => MAIN_ENTRY.test(x.path)) ?? f.files[0];
      if (!entry) throw new Error("la versión no tiene ficheros de código");
      editFrom(v, entry.content);
    } catch (e) {
      setError(`No se pudo cargar el código de v${v.version}: ${(e as Error).message}`);
      openSection("codigo");
    }
  }

  async function saveLoadout(draft: LoadoutDraft): Promise<Violation[] | null> {
    if (!selected) return null;
    try {
      await api("POST", `/bots/${selected.id}/loadouts`, draft);
      reloadLoadouts({ silent: true }); // la nueva revisión pasa a ser la vigente
      return null;
    } catch (e) {
      const err = e as { status?: number; body?: { violations?: Violation[] } };
      if (err.status === 422) return err.body?.violations ?? [];
      throw e;
    }
  }

  async function uploadPasted(loadoutRevision: number) {
    if (!selected) return;
    setError("");
    try {
      const fd = new FormData();
      fd.append("source", new Blob([pasted], { type: "text/plain" }), runtime === "python" ? "bot.py" : "bot.js");
      fd.append("runtime", runtime);
      // B11: antes iba fijo a "1" — si la revisión 1 ya no existía, la subida
      // fallaba con un 400 que el usuario leía como "no se ha subido nada".
      fd.append("loadoutRevision", String(loadoutRevision));
      if (editingFrom !== null) fd.append("parentVersion", String(editingFrom));
      const created = await api<BotVersion>("POST", `/bots/${selected.id}/versions`, undefined, { formData: fd });
      // El foco pasa a la versión RECIÉN creada: lo que se enseña a partir de
      // aquí es su estado, no el de ninguna anterior.
      setFocusRequest(created?.version ?? null);
      setEditingFrom(null);
      // Ya está en el servidor: el borrador local deja de hacer falta.
      codeDraft.clear();
      runtimeDraft.clear();
      pollsRef.current = 0;
      setPollExhausted(false);
      reloadVersions({ silent: true });
      // #255 · el paso siguiente (enviarla a validación) está en «Versiones y build»:
      // se abre esa sección (una sola acción en un solo sitio, sin desplazar).
      setNotice(created?.version ? `Creada v${created.version} (borrador). Envíala a validación.` : null);
      openSection("versiones");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function submitVersion(v: number) {
    if (!selected) return;
    setError("");
    try {
      await api<Build>("POST", `/bots/${selected.id}/versions/${v}/actions/submit`);
      setFocusRequest(v);
      pollsRef.current = 0;
      setPollExhausted(false);
      reconciledRef.current = "";
      setNotice(null);
      reloadVersions({ silent: true });
      reloadBuilds({ silent: true });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function publishVersion(v: number) {
    if (!selected) return;
    setError("");
    try {
      // El código NUNCA se hace público al publicar: eso se decide en «Visibilidad».
      await api("POST", `/bots/${selected.id}/versions/${v}/actions/publish`, { codePublic: false });
      setFocusRequest(v);
      reloadVersions({ silent: true });
      reloadBots({ silent: true });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** DEV-A · copia exacta de una versión como borrador nuevo (sirve también para paquetes). */
  async function cloneFrom(v: number) {
    if (!selected) return;
    setError("");
    try {
      const created = await api<BotVersion>("POST", `/bots/${selected.id}/versions/${v}/actions/clone`, {});
      setNotice(`Creada v${created.version} (borrador) desde v${v}. v${v} no cambia.`);
      setFocusRequest(created.version);
      reloadVersions({ silent: true });
    } catch (e) {
      setError(`No se pudo crear la versión: ${errText(e)}`);
    }
  }

  async function setRetired(bot: Bot, retired: boolean) {
    setError("");
    try {
      const updated = await api<Bot>("PATCH", `/bots/${bot.id}`, { retired });
      patchBot(bot.id, { retiredAt: updated?.retiredAt ?? (retired ? new Date().toISOString() : null) });
      reloadBots({ silent: true });
      if (needsFetch) reloadExtBot({ silent: true });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const detail = combine(versionsRes, loadoutsRes);
  function retryDetail() {
    reloadVersions();
    reloadLoadouts();
  }

  const botItem = (b: Bot) => (
    <li key={b.id} data-testid={`bot-item-${b.id}`}>
      <a
        href={botHref(b.id, section)}
        className="master-item"
        aria-current={selected?.id === b.id ? "true" : undefined}
        onClick={(e) => {
          setFocusRequest(null);
          navTo(botHref(b.id, selected ? section : "resumen"))(e);
        }}
      >
        {b.name}
      </a>
      <small className="master-item-meta">
        ({VISIBILITY_TEXT[b.visibility] ?? b.visibility}
        {b.latestPublishedVersion ? `, v${b.latestPublishedVersion} publicada` : ""})
      </small>
    </li>
  );

  // ------------------------------------------------------------ secciones
  function renderSection() {
    if (!selected) return null;
    switch (section) {
      case "resumen":
        return (
          <ResourceView resource={versionsRes} label={`el detalle de ${selected.name}`} onRetry={reloadVersions}>
            {(vs) => {
              const eligible = versionInBattles(vs.filter((v) => isBattleEligible(v)));
              return (
                <>
                  <dl data-testid="bot-overview">
                    <dt>Visibilidad</dt>
                    <dd data-testid="overview-visibility">
                      {botVisibilityLabel(selected.visibility)} ·{" "}
                      <a
                        href={botHref(selected.id, "visibilidad")}
                        onClick={navTo(botHref(selected.id, "visibilidad"))}
                      >
                        {isOwner ? "cambiar la del bot o la del código" : "ver detalle"}
                      </a>
                    </dd>
                    <dt>En batallas</dt>
                    <dd data-testid="in-battles">
                      {eligible
                        ? `Las batallas nuevas usan la v${eligible} (la publicada elegible más reciente). Una versión rechazada o en borrador nunca entra en batalla.`
                        : "Ninguna versión publicada y elegible: este bot todavía no puede entrar en batallas."}
                    </dd>
                    <dt>Versiones</dt>
                    <dd>
                      {vs.length} ·{" "}
                      <a href={botHref(selected.id, "versiones")} onClick={navTo(botHref(selected.id, "versiones"))}>
                        ver versiones y build
                      </a>
                    </dd>
                    {selected.createdAt && (
                      <>
                        <dt>Creado</dt>
                        <dd>{when(selected.createdAt)}</dd>
                      </>
                    )}
                    <dt>Estado</dt>
                    <dd>{selected.retiredAt ? "retirado" : "activo"}</dd>
                  </dl>
                  {isOwner && (
                    <p>
                      <button
                        type="button"
                        data-testid="bot-retire"
                        onClick={() => void setRetired(selected, !selected.retiredAt)}
                      >
                        {selected.retiredAt ? "Reactivar bot" : "Retirar bot"}
                      </button>{" "}
                      <small>
                        {selected.retiredAt
                          ? "Vuelve a la lista de activos."
                          : "Lo pasa a «Retirados»: no borra versiones, batallas ni replays, ni cambia qué versión juega."}
                      </small>
                    </p>
                  )}
                </>
              );
            }}
          </ResourceView>
        );
      case "visibilidad":
        return (
          <ResourceView resource={versionsRes} label={`el detalle de ${selected.name}`} onRetry={reloadVersions}>
            {(vs) => (
              <BotVisibilityCard
                botId={selected.id}
                visibility={selected.visibility}
                hasTeam={!!selected.teamId}
                versions={vs}
                canEdit={isOwner}
                onBotChanged={(visibility) => {
                  patchBot(selected.id, { visibility });
                  reloadBots({ silent: true });
                  if (needsFetch) reloadExtBot({ silent: true });
                }}
                onCodeChanged={() => reloadVersions({ silent: true })}
              />
            )}
          </ResourceView>
        );
      case "equipamiento":
        return (
          <ResourceView resource={detail} label={`el detalle de ${selected.name}`} onRetry={retryDetail}>
            {(d) => {
              const loadouts = d.b;
              const current = loadouts.length > 0 ? loadouts[loadouts.length - 1] : undefined;
              return (
                <>
                  {isOwner && (
                    // key={bot.id}: al cambiar de bot el editor SE REMONTA con su revisión vigente.
                    <LoadoutEditor
                      key={selected.id}
                      catalog={props.catalog}
                      catalogVersion={current?.catalogVersion ?? props.catalogVersion}
                      budgetCredits={props.budgetCredits}
                      initial={
                        current
                          ? {
                              catalogVersion: current.catalogVersion,
                              chassis: current.chassis,
                              modules: current.modules,
                            }
                          : undefined
                      }
                      loadedRevision={current?.revision}
                      draftKey={`loadout:${selected.id}:r${current?.revision ?? 0}`}
                      onSave={saveLoadout}
                    />
                  )}
                  <details className="card" data-testid="loadout-history" open={!isOwner}>
                    <summary>Historial de revisiones del equipamiento ({loadouts.length})</summary>
                    {loadouts.length === 0 && <p>Sin revisiones de equipamiento.</p>}
                    {[...loadouts].reverse().map((l) => (
                      <div key={l.revision}>
                        <h4>
                          Revisión {l.revision} · {l.chassis}
                        </h4>
                        <p>
                          Usada por:{" "}
                          {d.a
                            .filter((v) => v.loadoutRevision === l.revision)
                            .map((v) => `v${v.version}`)
                            .join(", ") || "ninguna versión"}
                        </p>
                        <ul>
                          {l.modules.map((m) => (
                            <li key={m.slot}>
                              {slotName(m.slot)}{" "}
                              <small>
                                (<code>{m.slot}</code>)
                              </small>
                              : {m.moduleId}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </details>
                </>
              );
            }}
          </ResourceView>
        );
      case "codigo":
        return (
          <ResourceView resource={detail} label={`el detalle de ${selected.name}`} onRetry={retryDetail}>
            {(d) => renderCode(d.a, d.b)}
          </ResourceView>
        );
      case "versiones":
        return (
          <ResourceView resource={detail} label={`el detalle de ${selected.name}`} onRetry={retryDetail}>
            {(d) => renderVersions(d.a)}
          </ResourceView>
        );
      case "batallas":
        return <BotBattlesSection botId={selected.id} botName={selected.name} />;
      case "replays":
        return <BotReplaysSection botId={selected.id} botName={selected.name} />;
    }
  }

  function renderCode(vs: BotVersion[], loadouts: Loadout[]) {
    if (!selected) return null;
    const current = loadouts.length > 0 ? loadouts[loadouts.length - 1] : undefined;
    const nextVersion = vs.length ? Math.max(...vs.map((v) => v.version)) + 1 : 1;
    const viewed = vs.find((v) => v.version === viewerVersion);
    const files = filesRes.status === "ready" ? filesRes.data : null;
    const editable = isWebEditable(files);
    return (
      <>
        {isOwner && (
          <div className="card" data-testid="code-editor">
            <h4>Nueva versión</h4>
            <label>
              Runtime{" "}
              <select
                aria-label="runtime"
                value={runtime}
                onChange={(e) => changeRuntime(e.target.value === "node" ? "node" : "python")}
              >
                <option value="python">Python</option>
                <option value="node">JavaScript (Node)</option>
              </select>
            </label>
            <p className="muted" data-testid="hook-help">
              {HOOK_HELP[runtime]}
            </p>
            {codeDraft.restored && !isUntouchedTemplate(pasted) && (
              <p className="warn" role="status" data-testid="code-draft-restored">
                Recuperado el código sin subir de esta sesión (aún no es ninguna versión).
              </p>
            )}
            {editingFrom !== null && (
              <p className="warn" data-testid="editing-from">
                Editando el código de v{editingFrom}: al subirlo se crea la v{nextVersion}; v{editingFrom} no cambia.
              </p>
            )}
            <p>
              <label>
                Código{" "}
                <textarea
                  ref={codeRef}
                  className="code-editor"
                  aria-label="codigo"
                  rows={16}
                  cols={80}
                  spellCheck={false}
                  value={pasted}
                  onChange={(e) => setPasted(e.target.value)}
                />
              </label>
            </p>
            <button
              type="button"
              data-testid="reset-template"
              onClick={() => {
                setPasted(BOT_TEMPLATES[runtime]);
                setEditingFrom(null);
                codeDraft.clear();
              }}
            >
              Restaurar la plantilla de {runtime === "node" ? "JavaScript" : "Python"}
            </button>{" "}
            <button type="button" disabled={!current} onClick={() => current && uploadPasted(current.revision)}>
              Subir como versión nueva
            </button>
            {current && (
              <small data-testid="upload-target">
                {" "}
                Se creará la v{nextVersion} con la revisión {current.revision} del equipamiento (borrador: después pulsa
                «Enviar a validación» en «Versiones y build»).
              </small>
            )}
            {!current && (
              <p className="warn">
                Guarda antes una configuración en{" "}
                <a href={botHref(selected.id, "equipamiento")} onClick={navTo(botHref(selected.id, "equipamiento"))}>
                  Equipamiento
                </a>{" "}
                para poder subir código.
              </p>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </div>
        )}

        <div className="card" data-testid="code-viewer">
          <h4>Código de una versión</h4>
          {vs.length === 0 ? (
            <p>Este bot todavía no tiene versiones.</p>
          ) : (
            <>
              <p>
                <label>
                  Versión{" "}
                  <select
                    aria-label="version-codigo"
                    value={viewerVersion ?? ""}
                    onChange={(e) => {
                      setCodeVersion(Number(e.target.value));
                      setDiffAgainst(null);
                    }}
                  >
                    {[...vs].reverse().map((v) => (
                      <option key={v.version} value={v.version}>
                        v{v.version} · {v.state}
                      </option>
                    ))}
                  </select>
                </label>{" "}
                {vs.length > 1 && viewerVersion !== null && (
                  <label>
                    Comparar con{" "}
                    <select
                      aria-label="diff-contra"
                      value={diffAgainst ?? ""}
                      onChange={(e) => setDiffAgainst(e.target.value === "" ? null : Number(e.target.value))}
                    >
                      <option value="">— sin comparar —</option>
                      {vs
                        .filter((x) => x.version !== viewerVersion)
                        .map((x) => (
                          <option key={x.version} value={x.version}>
                            v{x.version}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
              </p>
              {filesRes.status === "loading" && <p role="status">Cargando código…</p>}
              {filesRes.status === "error" && <p role="alert">{errText(filesRes.error ?? filesRes.message)}</p>}
              {files &&
                files.files.map((f) => (
                  <details key={f.path} open={MAIN_ENTRY.test(f.path)}>
                    <summary>{f.path}</summary>
                    <pre data-testid={`file-${f.path}`}>{f.content}</pre>
                  </details>
                ))}
              {files && isOwner && !editable && (
                <p className="warn" role="note" data-testid="multi-file-locked">
                  v{viewerVersion} se subió como paquete ({files.files.length} ficheros). El editor web sólo guarda un
                  fichero y perdería el resto, así que no se puede editar aquí: sube el paquete completo por la API, o
                  usa «Nueva versión desde ésta» en «Versiones y build» para clonarla tal cual.
                </p>
              )}
              {files && isOwner && editable && viewed && (
                <button
                  type="button"
                  data-testid="edit-as-new"
                  onClick={() => {
                    const entry = files.files.find((x) => MAIN_ENTRY.test(x.path)) ?? files.files[0];
                    if (entry) editFrom(viewed, entry.content);
                  }}
                >
                  Editar en una versión nueva desde v{viewerVersion}
                </button>
              )}
              {diffAgainst !== null && (
                <div data-testid="diff-view">
                  <h4>
                    Diferencias v{diffAgainst} → v{viewerVersion}
                  </h4>
                  {diffRes.status === "loading" && <p role="status">Calculando diferencias…</p>}
                  {diffRes.status === "error" && <p role="alert">{errText(diffRes.error ?? diffRes.message)}</p>}
                  {diffRes.status === "ready" &&
                    diffRes.data &&
                    diffRes.data.files
                      .filter((f) => f.status !== "unchanged")
                      .map((f) => (
                        <div key={f.path}>
                          <h5>
                            {f.path} · {f.status} (+{f.additions} −{f.deletions})
                          </h5>
                          <pre data-testid={`diff-${f.path}`}>{f.diff}</pre>
                        </div>
                      ))}
                  {diffRes.status === "ready" &&
                    diffRes.data &&
                    diffRes.data.files.every((f) => f.status === "unchanged") && <p>Sin diferencias de código.</p>}
                </div>
              )}
            </>
          )}
        </div>
      </>
    );
  }

  function renderVersions(vs: BotVersion[]) {
    if (!selected) return null;
    const build = builds && builds.known && builds.list.length > 0 ? builds.list[0] : undefined;
    const buildFinished = !!build && !isBuildInProgress(build.status);
    // issue #95 (obs. 1 del re-supervisor) · `!!builds` de guarda dejaba un
    // hueco: si la PRIMERA lectura no vuelve nunca, `builds` es null para
    // siempre y el usuario no veía ni «desconocido» ni error — solo un
    // «Consultando…» eterno, que es la mentira que B11 persigue. Si el sondeo
    // se rindió, se dice, haya llegado o no una primera lectura.
    const unknownPipeline =
      (!!builds && (!builds.known || (pollExhausted && !!build && !buildFinished))) || (!builds && pollExhausted);
    const focusedRejection = rejectionToShow(focused);
    const inBattles = versionInBattles(vs.filter((v) => isBattleEligible(v)));
    const diagnosis = focused
      ? diagnoseBuild({ state: focused.state, rejectionReason: focused.rejectionReason, stages: build?.stages })
      : null;
    return (
      <>
        {notice && (
          <p role="status" className="ok" data-testid="bot-notice">
            {notice}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {/* B11 · Resumen de LA versión que el usuario está mirando. */}
        {focused && (
          <div className="card" data-testid="focused-version">
            <h4>
              Mirando v{focused.version} · {focused.state}
            </h4>
            {/* UX-R · LiveStatus: se anuncia sin mover el foco y marca aria-busy mientras valida. */}
            <LiveStatus busy={focused.state === "validating"} data-testid="focused-status">
              {focused.state === "validating"
                ? "Validación en curso…"
                : pendingActionFor(focused.state) || "sin acciones pendientes"}
            </LiveStatus>
            {focusedRejection && (
              <p className="error" data-testid="focused-rejection">
                Motivo del rechazo de v{focused.version}: {focusedRejection}
              </p>
            )}
            {versionsStale && (
              <p className="warn" data-testid="versions-stale">
                No se ha podido actualizar el estado: lo que ves puede estar desfasado.
              </p>
            )}
            <button type="button" onClick={refreshNow}>
              Actualizar estado
            </button>
          </div>
        )}
        {focused && diagnosis && (
          <BuildDiagnosisView
            diagnosis={diagnosis}
            version={focused.version}
            publishedVersion={inBattles}
            {...(isOwner
              ? { onFix: () => void loadCodeForFix(focused), onRetry: () => void submitVersion(focused.version) }
              : {})}
          />
        )}

        <div className="card table-wide" data-testid="versions-card">
          <h4>Versiones de {selected.name}</h4>
          {vs.length === 0 && (
            <p>
              Todavía no hay versiones: sube código en{" "}
              <a href={botHref(selected.id, "codigo")} onClick={navTo(botHref(selected.id, "codigo"))}>
                Código
              </a>
              .
            </p>
          )}
          {vs.length > 0 && (
            <div className="table-scroll">
              <table className="stack-table stack-table--wide">
                <thead>
                  <tr>
                    <th>Versión</th>
                    <th>Estado</th>
                    <th>Runtime</th>
                    <th>Código</th>
                    <th>Motivo</th>
                    <th>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {[...vs].reverse().map((v) => (
                    <tr key={v.version} data-testid={`version-row-${v.version}`}>
                      <td>
                        v{v.version}
                        {v.parentVersion ? ` (desde v${v.parentVersion})` : ""}
                        {v.version === focusedVersion ? " ◀ mirando" : ""}
                        {v.version === inBattles && (
                          <strong className="ok" data-testid={`in-battles-${v.version}`}>
                            {" "}
                            · en batallas
                          </strong>
                        )}
                      </td>
                      <td>
                        {v.state}
                        {v.state === "draft" && <strong className="warn"> · SIN ENVIAR</strong>}
                        {pendingActionFor(v.state) && <small> · {pendingActionFor(v.state)}</small>}
                        {v.createdAt && (
                          <>
                            <br />
                            <small className="muted">{when(v.createdAt)}</small>
                          </>
                        )}
                        <VersionEligibilityNote
                          version={v.version}
                          be={v.battleEligibility}
                          suggestVersion={inBattles}
                        />
                      </td>
                      <td>{v.runtime}</td>
                      {/* Sólo se MUESTRA: se cambia en «Visibilidad» (una sola fuente de verdad). */}
                      <td data-testid={`code-cell-${v.version}`}>{v.codePublic ? "público" : "privado"}</td>
                      <td>{rejectionToShow(v) && <span className="error">{rejectionToShow(v)}</span>}</td>
                      <td>
                        {isOwner && (v.state === "draft" || v.state === "rejected") && (
                          <button type="button" onClick={() => submitVersion(v.version)}>
                            {v.state === "draft" ? `Enviar a validación v${v.version}` : `Reenviar v${v.version}`}
                          </button>
                        )}
                        {isOwner && v.state === "validated" && (
                          <button type="button" onClick={() => publishVersion(v.version)}>
                            Publicar v{v.version}
                          </button>
                        )}
                        {v.version !== focusedVersion && (
                          <button type="button" onClick={() => setFocusRequest(v.version)}>
                            Ver v{v.version}
                          </button>
                        )}{" "}
                        <button
                          type="button"
                          className="link"
                          data-testid={`view-code-${v.version}`}
                          onClick={() => {
                            setCodeVersion(v.version);
                            setDiffAgainst(null);
                            openSection("codigo");
                          }}
                        >
                          Ver código
                        </button>{" "}
                        {isOwner && (
                          <button
                            type="button"
                            className="link"
                            data-testid={`clone-${v.version}`}
                            onClick={() => void cloneFrom(v.version)}
                          >
                            Nueva versión desde ésta
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* B11 · Pipeline SIEMPRE rotulado con su versión y leído del servidor. */}
        {focusedVersion !== undefined && (
          <div className="card" data-testid="build-result">
            <h4>
              Pipeline de build · v{focusedVersion} ·{" "}
              {!builds
                ? "consultando…"
                : unknownPipeline
                  ? "estado desconocido"
                  : !build
                    ? "sin enviar a validación"
                    : build.status}
            </h4>
            {!builds && !unknownPipeline ? (
              // Aún no ha llegado la respuesta: no se sabe, y tampoco se
              // afirma "sin enviar" ni se pinta ninguna etapa. Ojo al orden:
              // si el sondeo ya se rindió, manda «desconocido».
              <p role="status" aria-live="polite">
                Consultando el estado del pipeline…
              </p>
            ) : unknownPipeline ? (
              // Sin resultado fiable NO se pinta ni una etapa.
              <p className="warn" data-testid="pipeline-unknown">
                {builds && !builds.known
                  ? "No se ha podido leer el estado del pipeline: estado desconocido. No se muestra un resultado inventado."
                  : pollStop === "wait"
                    ? // Rendirse esperando NO es haber comprobado N veces.
                      `El servidor no respondió a la última consulta en ${Math.round(maxPollWaitMs / 1000) || 1} s: estado desconocido. Pulsa «Actualizar estado» para volver a intentarlo.`
                    : `El pipeline sigue sin dar un resultado tras ${maxPolls} comprobaciones: estado desconocido. Pulsa «Actualizar estado» para volver a intentarlo.`}
              </p>
            ) : !build ? (
              <p className="warn">Esta versión todavía no se ha enviado a validación.</p>
            ) : (
              <>
                {!buildFinished && (
                  <LiveStatus busy data-testid="pipeline-running">
                    En curso: comprobando cada {Math.round(pollIntervalMs / 1000) || 1} s…
                  </LiveStatus>
                )}
                <table className="stack-table">
                  <tbody>
                    {build.stages.map((s) => (
                      <tr key={s.name}>
                        <td>{s.name}</td>
                        <td className={s.status === "passed" ? "ok" : s.status === "failed" ? "error" : "warn"}>
                          {s.status}
                        </td>
                        <td>
                          {s.message ?? ""}
                          {s.metrics && (
                            <small>
                              {" "}
                              (
                              {Object.entries(s.metrics)
                                .map(([k, val]) => `${k}=${Math.round(val * 10) / 10}`)
                                .join(", ")}
                              )
                            </small>
                          )}
                          {s.logs && s.logs.length > 0 && (
                            <details>
                              <summary>logs</summary>
                              <pre>{s.logs.join("\n")}</pre>
                            </details>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {build.artifactHash && (
                  <p>
                    <small title={build.artifactHash}>Artefacto firmado: {short(build.artifactHash)}</small>
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </>
    );
  }

  return (
    <div className="master-detail" data-testid="bots-master-detail">
      <div className="card master-list">
        <h2>Mis bots</h2>
        <ResourceView resource={botsRes} label="tus bots" onRetry={reloadBots}>
          {(page) => {
            if (page.items.length === 0) return <p>Aún no tienes bots: crea el primero abajo.</p>;
            const items = page.items.map((b) => ({ ...b, ...(patched[b.id] ?? {}) }));
            // EQ4 · los retirados no saturan la lista principal (y no se borra nada).
            const active = items.filter((b) => !b.retiredAt);
            const retired = items.filter((b) => !!b.retiredAt);
            // Contadores del SERVIDOR (todos tus bots); si no los da, los de lo cargado.
            const nActive = page.counts?.active ?? active.length;
            const nRetired = page.counts?.retired ?? retired.length;
            return (
              <nav aria-label="tus bots">
                <h3 id="bots-active-title">Activos ({nActive})</h3>
                {active.length === 0 ? (
                  nActive === 0 && <p data-testid="bots-active-empty">Todos tus bots están retirados.</p>
                ) : (
                  <ul aria-labelledby="bots-active-title" data-testid="bots-active">
                    {active.map(botItem)}
                  </ul>
                )}
                {nRetired > 0 && (
                  <details data-testid="bots-retired">
                    <summary>Retirados ({nRetired})</summary>
                    <ul>{retired.map(botItem)}</ul>
                    {retired.length < nRetired && (
                      <p className="muted">
                        <small>Hay más retirados: pulsa «Cargar más bots».</small>
                      </p>
                    )}
                  </details>
                )}
                {page.nextCursor && (
                  <p>
                    <button type="button" data-testid="bots-load-more" onClick={loadMoreBots}>
                      Cargar más bots
                    </button>{" "}
                    <small data-testid="bots-loaded">
                      {page.counts
                        ? `Cargados ${page.items.length} de ${page.counts.total}.`
                        : `Cargados ${page.items.length}.`}
                    </small>
                  </p>
                )}
              </nav>
            );
          }}
        </ResourceView>
        <form onSubmit={onCreateBot}>
          <label>
            Nombre del bot <input aria-label="nuevo-bot" value={newName} onChange={(e) => setNewName(e.target.value)} />
          </label>{" "}
          <button type="submit" disabled={creating} aria-busy={creating}>
            {creating ? "Creando…" : "Crear bot"}
          </button>{" "}
          <small>Máximo {BOT_NAME_MAX} caracteres; no puedes repetir el nombre de otro de tus bots.</small>
        </form>
        <FormError error={createErr} data-testid="create-bot-error" />
      </div>

      <div className="master-pane" data-testid="bot-pane">
        {!route.botId && (
          <div className="card" data-testid="bot-pane-empty">
            <p>
              Elige un bot de la lista para ver su resumen, visibilidad, equipamiento, código, versiones y build,
              batallas y replays.
            </p>
          </div>
        )}
        {route.botId && !selected && (
          <div className="card" data-testid="bot-pane-missing">
            {!needsFetch || extBotRes.status === "loading" ? (
              <p role="status">Cargando el bot…</p>
            ) : (
              <ResourceView resource={extBotRes} label="el bot" onRetry={reloadExtBot}>
                {() => <p>Este bot no existe o no es visible para ti.</p>}
              </ResourceView>
            )}
            <p>
              <a href="#/bots" onClick={navTo("#/bots")}>
                ← Mis bots
              </a>
            </p>
          </div>
        )}
        {selected && (
          <div className="card bot-workspace" data-testid="bot-workspace">
            <header className="bot-head" data-testid="bot-summary">
              <h2>{selected.name}</h2>
              {selected.retiredAt && <small className="warn"> retirado</small>}
              {!isOwner && <small className="muted"> · bot de otra persona: sólo lectura</small>}
            </header>
            <div className="bot-sections">
              <nav aria-label={`secciones de ${selected.name}`} className="section-nav" data-testid="bot-section-nav">
                <ul>
                  {BOT_PANEL_SECTIONS.map((s) => (
                    <li key={s.id}>
                      <a
                        href={botHref(selected.id, s.id)}
                        aria-current={section === s.id ? "page" : undefined}
                        data-testid={`bot-section-link-${s.id}`}
                        onClick={navTo(botHref(selected.id, s.id))}
                      >
                        {s.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
              <section
                className="bot-section"
                data-testid="bot-section"
                data-section={section}
                aria-labelledby="bot-section-heading"
              >
                <h3 id="bot-section-heading" ref={sectionHeadingRef} tabIndex={-1}>
                  {sectionLabel(section)}
                </h3>
                {renderSection()}
                {error && section !== "codigo" && section !== "versiones" && (
                  <p className="error" role="alert">
                    {error}
                  </p>
                )}
              </section>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
