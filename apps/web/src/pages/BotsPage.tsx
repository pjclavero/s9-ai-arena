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
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type Me } from "../api.js";
import { LoadoutEditor, type LoadoutDraft } from "./LoadoutEditor.js";
import { useResource, ResourceView } from "../resource.js";
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

interface BotDetail {
  versions: BotVersion[];
  loadouts: Loadout[];
  /** Versión sobre la que se ha resuelto la vista (la enfocada). */
  focusedVersion?: number;
  /** Builds de la versión enfocada, del más reciente al más antiguo. */
  builds: Build[];
  /** false si la consulta de builds falló: no se sabe, y así se dice. */
  buildsKnown: boolean;
}

/** Estados de versión en los que HAY trabajo del pipeline en curso (cap. 17.1). */
const VERSION_IN_PROGRESS = ["validating"];
/** Estados de build no terminales (migración `builds`: queued|running|passed|failed). */
const BUILD_IN_PROGRESS = ["queued", "running"];

/** ¿Queda trabajo en curso sobre la versión enfocada? Decide si merece sondear. */
export function detailInProgress(d: BotDetail | null): boolean {
  if (!d || d.focusedVersion === undefined) return false;
  const v = d.versions.find((x) => x.version === d.focusedVersion);
  if (v && VERSION_IN_PROGRESS.includes(v.state)) return true;
  return d.buildsKnown && d.builds.length > 0 && BUILD_IN_PROGRESS.includes(d.builds[0].status);
}

/** Qué le falta al usuario por hacer con esta versión (vacío = nada). */
export function pendingActionFor(state: string): string {
  if (state === "draft") return "sin enviar — pulsa «Enviar a validación»";
  if (state === "rejected") return "corrige el código y vuelve a enviarla";
  if (state === "validated") return "pendiente de publicar";
  return "";
}

export function BotsPage(props: {
  me: Me;
  catalog: ModuleDefinition[];
  catalogVersion: string;
  budgetCredits: number;
  /** Sondeo del pipeline: parametrizado para poder probarlo sin esperas reales. */
  pollIntervalMs?: number;
  maxPolls?: number;
}) {
  const pollIntervalMs = props.pollIntervalMs ?? 2000;
  const maxPolls = props.maxPolls ?? 30; // ~60 s: presupuesto FINITO por diseño

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
  const [polls, setPolls] = useState(0);
  const [pollExhausted, setPollExhausted] = useState(false);

  // Detalle del bot seleccionado: versiones + revisiones de loadout (la última
  // es la vigente y alimenta el editor) + builds DE LA VERSIÓN ENFOCADA.
  const [detail, reloadDetail] = useResource<BotDetail | null>(async () => {
    if (!selected) return null;
    const [versions, loadouts] = await Promise.all([
      api<BotVersion[]>("GET", `/bots/${selected.id}/versions`),
      api<Loadout[]>("GET", `/bots/${selected.id}/loadouts`),
    ]);
    // La enfocada es la pedida explícitamente; si no, la MÁS ALTA (la última
    // subida). Nunca la primera: ese era el error de v1 pintado sobre v4.
    const requested = focusRequest !== null && versions.some((v) => v.version === focusRequest) ? focusRequest : null;
    const focusedVersion = requested ?? (versions.length > 0 ? Math.max(...versions.map((v) => v.version)) : undefined);
    if (focusedVersion === undefined) return { versions, loadouts, builds: [], buildsKnown: true };
    // Los builds son un recurso aparte: si esta lectura falla NO se inventa un
    // pipeline, se marca como desconocido.
    let builds: Build[] = [];
    let buildsKnown = true;
    try {
      builds = await api<Build[]>("GET", `/bots/${selected.id}/versions/${focusedVersion}/builds`);
    } catch {
      buildsKnown = false;
    }
    return { versions, loadouts, focusedVersion, builds, buildsKnown };
  }, [selected?.id, focusRequest]);

  // Cambiar de bot o de versión enfocada reinicia el presupuesto de sondeos.
  useEffect(() => {
    setPolls(0);
    setPollExhausted(false);
  }, [selected?.id, focusRequest]);

  // Sondeo ACOTADO: solo mientras haya trabajo en curso y queden intentos.
  const reloadRef = useRef(reloadDetail);
  reloadRef.current = reloadDetail;
  const data = detail.status === "ready" ? detail.data : null;
  const inProgress = detailInProgress(data);
  useEffect(() => {
    if (!inProgress) return;
    if (polls >= maxPolls) {
      setPollExhausted(true);
      return;
    }
    const t = setTimeout(() => {
      setPolls((n) => n + 1);
      reloadRef.current();
    }, pollIntervalMs);
    return () => clearTimeout(t);
  }, [inProgress, data, polls, maxPolls, pollIntervalMs]);

  function refreshNow() {
    setPolls(0);
    setPollExhausted(false);
    reloadDetail();
  }

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
      reloadDetail(); // la nueva revisión pasa a ser la vigente
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
      setPolls(0);
      setPollExhausted(false);
      reloadDetail();
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
      setPolls(0);
      setPollExhausted(false);
      reloadDetail();
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
      reloadDetail();
      reloadBots();
    } catch (e) {
      setError((e as Error).message);
    }
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
        <ResourceView resource={detail} label={`el detalle de ${selected.name}`} onRetry={reloadDetail}>
          {(d) => {
            if (!d) return null;
            const current = d.loadouts.length > 0 ? d.loadouts[d.loadouts.length - 1] : undefined;
            const focused = d.versions.find((v) => v.version === d.focusedVersion);
            const build = d.builds.length > 0 ? d.builds[0] : undefined;
            const buildFinished = !!build && !BUILD_IN_PROGRESS.includes(build.status);
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
                    {focused.rejectionReason && (
                      <p className="error" data-testid="focused-rejection">
                        Motivo del rechazo de v{focused.version}: {focused.rejectionReason}
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
                      {d.versions.map((v) => (
                        <tr key={v.version} data-testid={`version-row-${v.version}`}>
                          <td>
                            v{v.version}
                            {v.version === d.focusedVersion ? " ◀ mirando" : ""}
                          </td>
                          <td>
                            {v.state}
                            {v.state === "draft" && <strong className="warn"> · SIN ENVIAR</strong>}
                          </td>
                          <td>{v.runtime}</td>
                          <td>{v.rejectionReason && <span className="error">{v.rejectionReason}</span>}</td>
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
                            {v.version !== d.focusedVersion && (
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
                {d.focusedVersion !== undefined && (
                  <div className="card" data-testid="build-result">
                    <h3>
                      Pipeline de build · v{d.focusedVersion} ·{" "}
                      {!d.buildsKnown
                        ? "estado desconocido"
                        : !build
                          ? "sin enviar a validación"
                          : pollExhausted && !buildFinished
                            ? "estado desconocido"
                            : build.status}
                    </h3>
                    {!d.buildsKnown ? (
                      <p className="warn" data-testid="pipeline-unknown">
                        No se ha podido leer el estado del pipeline. No se muestra un resultado inventado.
                      </p>
                    ) : !build ? (
                      <p className="warn">Esta versión todavía no se ha enviado a validación.</p>
                    ) : (
                      <>
                        {pollExhausted && !buildFinished && (
                          <p className="warn" data-testid="pipeline-unknown">
                            El pipeline sigue sin dar un resultado tras {maxPolls} comprobaciones: estado desconocido.
                            Pulsa «Actualizar estado» para volver a intentarlo.
                          </p>
                        )}
                        {!pollExhausted && !buildFinished && (
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
