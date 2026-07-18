/**
 * T7.4 · Panel de usuario: bots con sus estados, editor de loadout integrado,
 * subida de código (archivo o pegado) y resultado de cada etapa del pipeline E6.
 */
import { useEffect, useState } from "react";
import { api, type Me } from "../api.js";
import { LoadoutEditor, type LoadoutDraft } from "./LoadoutEditor.js";
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
interface Build {
  id: string;
  status: string;
  stages: { name: string; status: string; message?: string }[];
}

export function BotsPage(props: {
  me: Me;
  catalog: ModuleDefinition[];
  catalogVersion: string;
  budgetCredits: number;
}) {
  const [bots, setBots] = useState<Bot[]>([]);
  const [selected, setSelected] = useState<Bot | null>(null);
  const [versions, setVersions] = useState<BotVersion[]>([]);
  const [build, setBuild] = useState<Build | null>(null);
  const [newName, setNewName] = useState("");
  const [pasted, setPasted] = useState("");
  const [runtime, setRuntime] = useState("python");
  const [error, setError] = useState("");

  async function refresh() {
    const page = await api<{ items: Bot[] }>("GET", `/bots?ownerId=${props.me.id}`);
    setBots(page.items);
  }
  useEffect(() => {
    refresh().catch(() => {});
  }, []);

  async function selectBot(bot: Bot) {
    setSelected(bot);
    setBuild(null);
    setVersions(await api<BotVersion[]>("GET", `/bots/${bot.id}/versions`));
  }

  async function saveLoadout(draft: LoadoutDraft): Promise<Violation[] | null> {
    try {
      await api("POST", `/bots/${selected!.id}/loadouts`, draft);
      return null;
    } catch (e) {
      const err = e as { status?: number; body?: { violations?: Violation[] } };
      if (err.status === 422) return err.body?.violations ?? [];
      throw e;
    }
  }

  async function uploadPasted() {
    setError("");
    try {
      const fd = new FormData();
      fd.append("source", new Blob([pasted], { type: "text/plain" }), runtime === "python" ? "bot.py" : "bot.js");
      fd.append("runtime", runtime);
      fd.append("loadoutRevision", "1");
      await api("POST", `/bots/${selected!.id}/versions`, undefined, { formData: fd });
      await selectBot(selected!);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function submitVersion(v: number) {
    setError("");
    try {
      setBuild(await api<Build>("POST", `/bots/${selected!.id}/versions/${v}/actions/submit`));
      await selectBot(selected!);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function publishVersion(v: number) {
    setError("");
    try {
      await api("POST", `/bots/${selected!.id}/versions/${v}/actions/publish`, { codePublic: false });
      await selectBot(selected!);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div>
      <div className="card">
        <h2>Mis bots</h2>
        <ul>
          {bots.map((b) => (
            <li key={b.id}>
              <a href="#" onClick={() => selectBot(b)}>
                {b.name}
              </a>{" "}
              <small>
                ({b.visibility}
                {b.latestPublishedVersion ? `, v${b.latestPublishedVersion} publicada` : ""})
              </small>
            </li>
          ))}
        </ul>
        <input
          aria-label="nuevo-bot"
          placeholder="nombre del bot"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />{" "}
        <button
          onClick={async () => {
            await api("POST", "/bots", { name: newName });
            setNewName("");
            await refresh();
          }}
        >
          Crear bot
        </button>
      </div>

      {selected && (
        <>
          <LoadoutEditor
            catalog={props.catalog}
            catalogVersion={props.catalogVersion}
            budgetCredits={props.budgetCredits}
            onSave={saveLoadout}
          />

          <div className="card">
            <h2>Versiones de {selected.name}</h2>
            <table>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.version}>
                    <td>v{v.version}</td>
                    <td>{v.state}</td>
                    <td>{v.runtime}</td>
                    <td>{v.rejectionReason && <span className="error">{v.rejectionReason}</span>}</td>
                    <td>
                      {(v.state === "draft" || v.state === "rejected") && (
                        <button onClick={() => submitVersion(v.version)}>Enviar a validación</button>
                      )}
                      {v.state === "validated" && <button onClick={() => publishVersion(v.version)}>Publicar</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3>Subir código (pegado)</h3>
            <select aria-label="runtime" value={runtime} onChange={(e) => setRuntime(e.target.value)}>
              <option value="python">python</option>
              <option value="node">node</option>
            </select>
            <p>
              <textarea
                aria-label="codigo"
                rows={8}
                cols={70}
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
              />
            </p>
            <button onClick={uploadPasted}>Subir como versión nueva</button>
            {error && <p className="error">{error}</p>}
          </div>

          {build && (
            <div className="card" data-testid="build-result">
              <h3>Pipeline de build · {build.status}</h3>
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
            </div>
          )}
        </>
      )}
    </div>
  );
}
