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
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type Me } from "../api.js";
import { LoadoutEditor, type LoadoutDraft } from "./LoadoutEditor.js";
import { useResource, ResourceView, type Resource } from "../resource.js";
import type { ModuleDefinition } from "../../../../packages/module-catalog/types.js";
import type { Violation } from "../../../../packages/module-catalog/validator/index.js";

interface Bot {
  id: string;
  name: string;
  visibility: string;
  latestPublishedVersion?: number;
}
interface BotVersion {
  version: number;
  state: string;
  runtime: string;
  loadoutRevision: number;
  rejectionReason?: string;
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
  stages: { name: string; status: string; message?: string }[];
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

export function BotsPage(props: {
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
  const maxPolls = props.maxPolls ?? 30; // ~60 s: presupuesto FINITO por diseño
  /**
   * issue #95 · Tope de ESPERA por una lectura que no vuelve. `api.ts` hace
   * `fetch` sin plazo ni `AbortController`, así que una lectura puede quedarse
   * colgada indefinidamente (pasarela colgada, agujero negro TCP). Sin este tope
   * el sondeo esperaría para siempre sin llegar nunca a agotarse y el panel se
   * quedaría en «Validación en curso…» eternamente: el mismo bloqueo que este
   * arreglo persigue, pero por el otro lado (defecto 1 del supervisor).
   */
  const maxPollWaitMs = props.maxPollWaitMs ?? 30_000;

  const [botsRes, reloadBots] = useResource(
    () => api<{ items: Bot[] }>("GET", `/bots?ownerId=${encodeURIComponent(props.me.id)}`),
    [props.me.id],
  );
  const [selected, setSelected] = useState<Bot | null>(null);
  // Versión que el usuario está mirando. null = "la última" (se resuelve al cargar).
  const [focusRequest, setFocusRequest] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [pasted, setPasted] = useState("");
  const [runtime, setRuntime] = useState("python");
  const [error, setError] = useState("");
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

  // --------------------------------------------------------------- acciones
  async function onCreateBot(e: FormEvent) {
    e.preventDefault(); // Enter crea el bot (a11y R3.7)
    setError("");
    try {
      await api("POST", "/bots", { name: newName });
      setNewName("");
      reloadBots();
    } catch (err) {
      setError((err as Error).message);
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
      const created = await api<BotVersion>("POST", `/bots/${selected.id}/versions`, undefined, { formData: fd });
      // El foco pasa a la versión RECIÉN creada: lo que se enseña a partir de
      // aquí es su estado, no el de ninguna anterior.
      setFocusRequest(created?.version ?? null);
      pollsRef.current = 0;
      setPollExhausted(false);
      reloadVersions({ silent: true });
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
      await api("POST", `/bots/${selected.id}/versions/${v}/actions/publish`, { codePublic: false });
      setFocusRequest(v);
      reloadVersions({ silent: true });
      reloadBots();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const detail = combine(versionsRes, loadoutsRes);
  function retryDetail() {
    reloadVersions();
    reloadLoadouts();
  }

  return (
    <div>
      <div className="card">
        <h2>Mis bots</h2>
        <ResourceView resource={botsRes} label="tus bots" onRetry={reloadBots}>
          {(page) =>
            page.items.length === 0 ? (
              <p>Aún no tienes bots: crea el primero abajo.</p>
            ) : (
              <ul>
                {page.items.map((b) => (
                  <li key={b.id}>
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        setSelected(b);
                        setFocusRequest(null);
                      }}
                    >
                      {b.name}
                    </button>{" "}
                    <small>
                      ({b.visibility}
                      {b.latestPublishedVersion ? `, v${b.latestPublishedVersion} publicada` : ""})
                    </small>{" "}
                    <a href={`#/battles?bot=${encodeURIComponent(b.id)}`}>batallas</a>
                  </li>
                ))}
              </ul>
            )
          }
        </ResourceView>
        <form onSubmit={onCreateBot}>
          <label>
            Nombre del bot <input aria-label="nuevo-bot" value={newName} onChange={(e) => setNewName(e.target.value)} />
          </label>{" "}
          <button type="submit">Crear bot</button>
        </form>
      </div>

      {selected && (
        <ResourceView resource={detail} label={`el detalle de ${selected.name}`} onRetry={retryDetail}>
          {(d) => {
            const loadouts = d.b;
            const current = loadouts.length > 0 ? loadouts[loadouts.length - 1] : undefined;
            const build = builds && builds.known && builds.list.length > 0 ? builds.list[0] : undefined;
            const buildFinished = !!build && !isBuildInProgress(build.status);
            // issue #95 (obs. 1 del re-supervisor) · `!!builds` de guarda dejaba un
            // hueco: si la PRIMERA lectura no vuelve nunca, `builds` es null para
            // siempre y el usuario no veía ni «desconocido» ni error — solo un
            // «Consultando…» eterno, que es la mentira que B11 persigue. Si el sondeo
            // se rindió, se dice, haya llegado o no una primera lectura.
            const unknownPipeline =
              (!!builds && (!builds.known || (pollExhausted && !!build && !buildFinished))) ||
              (!builds && pollExhausted);
            const focusedRejection = rejectionToShow(focused);
            return (
              <>
                {/* key={bot.id}: al cambiar de bot el editor SE REMONTA con su revisión vigente. */}
                <LoadoutEditor
                  key={selected.id}
                  catalog={props.catalog}
                  catalogVersion={current?.catalogVersion ?? props.catalogVersion}
                  budgetCredits={props.budgetCredits}
                  initial={
                    current
                      ? { catalogVersion: current.catalogVersion, chassis: current.chassis, modules: current.modules }
                      : undefined
                  }
                  loadedRevision={current?.revision}
                  onSave={saveLoadout}
                />

                {/* B11 · Resumen de LA versión que el usuario está mirando. */}
                {focused && (
                  <div className="card" data-testid="focused-version">
                    <h2>
                      Última subida: v{focused.version} · {focused.state}
                    </h2>
                    <p role="status" aria-live="polite">
                      {focused.state === "validating"
                        ? "Validación en curso…"
                        : pendingActionFor(focused.state) || "sin acciones pendientes"}
                    </p>
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

                <div className="card">
                  <h2>Versiones de {selected.name}</h2>
                  <table>
                    <tbody>
                      {d.a.map((v) => (
                        <tr key={v.version} data-testid={`version-row-${v.version}`}>
                          <td>
                            v{v.version}
                            {v.version === focusedVersion ? " ◀ mirando" : ""}
                          </td>
                          <td>
                            {v.state}
                            {v.state === "draft" && <strong className="warn"> · SIN ENVIAR</strong>}
                          </td>
                          <td>{v.runtime}</td>
                          <td>{rejectionToShow(v) && <span className="error">{rejectionToShow(v)}</span>}</td>
                          <td>{pendingActionFor(v.state)}</td>
                          <td>
                            {(v.state === "draft" || v.state === "rejected") && (
                              <button type="button" onClick={() => submitVersion(v.version)}>
                                {v.state === "draft" ? `Enviar a validación v${v.version}` : `Reenviar v${v.version}`}
                              </button>
                            )}
                            {v.state === "validated" && (
                              <button type="button" onClick={() => publishVersion(v.version)}>
                                Publicar v{v.version}
                              </button>
                            )}
                            {v.version !== focusedVersion && (
                              <button type="button" onClick={() => setFocusRequest(v.version)}>
                                Ver v{v.version}
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <h3>Subir código (pegado)</h3>
                  <label>
                    Runtime{" "}
                    <select aria-label="runtime" value={runtime} onChange={(e) => setRuntime(e.target.value)}>
                      <option value="python">python</option>
                      <option value="node">node</option>
                    </select>
                  </label>
                  <p>
                    <label>
                      Código{" "}
                      <textarea
                        aria-label="codigo"
                        rows={8}
                        cols={70}
                        value={pasted}
                        onChange={(e) => setPasted(e.target.value)}
                      />
                    </label>
                  </p>
                  <button type="button" disabled={!current} onClick={() => current && uploadPasted(current.revision)}>
                    Subir como versión nueva
                  </button>
                  {!current && (
                    <p className="warn">Guarda antes una configuración (loadout) para poder subir código.</p>
                  )}
                  {error && (
                    <p className="error" role="alert">
                      {error}
                    </p>
                  )}
                </div>

                {/* B11 · Pipeline SIEMPRE rotulado con su versión y leído del servidor. */}
                {focusedVersion !== undefined && (
                  <div className="card" data-testid="build-result">
                    <h3>
                      Pipeline de build · v{focusedVersion} ·{" "}
                      {!builds
                        ? "consultando…"
                        : unknownPipeline
                          ? "estado desconocido"
                          : !build
                            ? "sin enviar a validación"
                            : build.status}
                    </h3>
                    {!builds && !unknownPipeline ? (
                      // Aún no ha llegado la respuesta: no se sabe, y tampoco se
                      // afirma "sin enviar" ni se pinta ninguna etapa. Ojo al orden:
                      // si el sondeo ya se rindió, manda «desconocido» — quedarse en
                      // «Consultando…» para siempre sería la mentira de B11.
                      <p role="status" aria-live="polite">
                        Consultando el estado del pipeline…
                      </p>
                    ) : unknownPipeline ? (
                      // Sin resultado fiable NO se pinta ni una etapa: una tabla de
                      // `pending` bajo "estado desconocido" es justo la foto que hizo
                      // creer al usuario que su subida seguía en cola.
                      <p className="warn" data-testid="pipeline-unknown">
                        {builds && !builds.known
                          ? "No se ha podido leer el estado del pipeline: estado desconocido. No se muestra un resultado inventado."
                          : pollStop === "wait"
                            ? // Rendirse esperando NO es haber comprobado N veces: decirlo
                              // así era contarle al usuario comprobaciones que no se
                              // hicieron (defecto 1 del re-supervisor).
                              `El servidor no respondió a la última consulta en ${Math.round(maxPollWaitMs / 1000) || 1} s: estado desconocido. Pulsa «Actualizar estado» para volver a intentarlo.`
                            : `El pipeline sigue sin dar un resultado tras ${maxPolls} comprobaciones: estado desconocido. Pulsa «Actualizar estado» para volver a intentarlo.`}
                      </p>
                    ) : !build ? (
                      <p className="warn">Esta versión todavía no se ha enviado a validación.</p>
                    ) : (
                      <>
                        {!buildFinished && (
                          <p role="status" aria-live="polite" data-testid="pipeline-running">
                            En curso: comprobando cada {Math.round(pollIntervalMs / 1000) || 1} s…
                          </p>
                        )}
                        <table>
                          <tbody>
                            {build.stages.map((s) => (
                              <tr key={s.name}>
                                <td>{s.name}</td>
                                <td className={s.status === "passed" ? "ok" : s.status === "failed" ? "error" : "warn"}>
                                  {s.status}
                                </td>
                                <td>{s.message ?? ""}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </>
                    )}
                  </div>
                )}
              </>
            );
          }}
        </ResourceView>
      )}
    </div>
  );
}
