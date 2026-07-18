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
 */
import { useState, type FormEvent } from "react";
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
  status: string;
  stages: { name: string; status: string; message?: string }[];
}

export function BotsPage(props: { me: Me; catalog: ModuleDefinition[]; catalogVersion: string; budgetCredits: number }) {
  const [botsRes, reloadBots] = useResource(
    () => api<{ items: Bot[] }>("GET", `/bots?ownerId=${encodeURIComponent(props.me.id)}`),
    [props.me.id],
  );
  const [selected, setSelected] = useState<Bot | null>(null);
  const [build, setBuild] = useState<Build | null>(null);
  const [newName, setNewName] = useState("");
  const [pasted, setPasted] = useState("");
  const [runtime, setRuntime] = useState("python");
  const [error, setError] = useState("");

  // Detalle del bot seleccionado: versiones + revisiones de loadout (la última
  // es la vigente y alimenta el editor).
  const [detail, reloadDetail] = useResource(async () => {
    if (!selected) return null;
    const [versions, loadouts] = await Promise.all([
      api<BotVersion[]>("GET", `/bots/${selected.id}/versions`),
      api<Loadout[]>("GET", `/bots/${selected.id}/loadouts`),
    ]);
    return { versions, loadouts };
  }, [selected?.id]);

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

  async function uploadPasted() {
    if (!selected) return;
    setError("");
    try {
      const fd = new FormData();
      fd.append("source", new Blob([pasted], { type: "text/plain" }), runtime === "python" ? "bot.py" : "bot.js");
      fd.append("runtime", runtime);
      fd.append("loadoutRevision", "1");
      await api("POST", `/bots/${selected.id}/versions`, undefined, { formData: fd });
      reloadDetail();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function submitVersion(v: number) {
    if (!selected) return;
    setError("");
    try {
      setBuild(await api<Build>("POST", `/bots/${selected.id}/versions/${v}/actions/submit`));
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
                    <button type="button" className="link" onClick={() => { setSelected(b); setBuild(null); }}>
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
            Nombre del bot{" "}
            <input aria-label="nuevo-bot" value={newName} onChange={(e) => setNewName(e.target.value)} />
          </label>{" "}
          <button type="submit">Crear bot</button>
        </form>
      </div>

      {selected && (
        <ResourceView resource={detail} label={`el detalle de ${selected.name}`} onRetry={reloadDetail}>
          {(d) => {
            if (!d) return null;
            const current = d.loadouts.length > 0 ? d.loadouts[d.loadouts.length - 1] : undefined;
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

                <div className="card">
                  <h2>Versiones de {selected.name}</h2>
                  <table>
                    <tbody>
                      {d.versions.map((v) => (
                        <tr key={v.version}>
                          <td>v{v.version}</td>
                          <td>{v.state}</td>
                          <td>{v.runtime}</td>
                          <td>{v.rejectionReason && <span className="error">{v.rejectionReason}</span>}</td>
                          <td>
                            {(v.state === "draft" || v.state === "rejected") && (
                              <button type="button" onClick={() => submitVersion(v.version)}>Enviar a validación</button>
                            )}
                            {v.state === "validated" && (
                              <button type="button" onClick={() => publishVersion(v.version)}>Publicar</button>
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
                      <textarea aria-label="codigo" rows={8} cols={70} value={pasted} onChange={(e) => setPasted(e.target.value)} />
                    </label>
                  </p>
                  <button type="button" onClick={uploadPasted}>Subir como versión nueva</button>
                  {error && (
                    <p className="error" role="alert">
                      {error}
                    </p>
                  )}
                </div>

                {build && (
                  <div className="card" data-testid="build-result">
                    <h3>Pipeline de build · {build.status}</h3>
                    <table>
                      <tbody>
                        {build.stages.map((s) => (
                          <tr key={s.name}>
                            <td>{s.name}</td>
                            <td className={s.status === "passed" ? "ok" : s.status === "failed" ? "error" : "warn"}>{s.status}</td>
                            <td>{s.message ?? ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
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
