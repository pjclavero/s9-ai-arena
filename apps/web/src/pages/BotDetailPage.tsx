/**
 * DEV-A · A9.19 — vista de un bot: Overview · Code · Equipment · Versions.
 *
 * Ruta: #/bots/<botId> (la resuelve BotsPage; ver informe DEV-A para registrarla
 * explícitamente en App.tsx). Todo sale de la API de versionado (A9.11–A9.13):
 *   GET /bots/{id}, /bots/{id}/versions, /bots/{id}/versions/{v} (detalle con
 *   build y artefacto), /files, /diff?against=, /bots/{id}/loadouts,
 *   POST /actions/clone y POST /versions con parentVersion.
 * Los errores se ENSEÑAN (nunca un vacío silencioso): 403 = código privado.
 */
import { useCallback, useEffect, useState } from "react";
import { api, ApiRequestError } from "../api.js";
import { ErrorState } from "../ui/primitives.js";
import { useSessionDraft } from "../ui/draft.js";
import { BuildDiagnosisView, diagnoseBuild } from "../build-diagnosis.js";
import { isBattleEligible, VersionEligibilityNote, type BattleEligibilityInfo } from "../version-eligibility.js";

export interface BotInfo {
  id: string;
  name: string;
  ownerId: string;
  visibility: string;
  latestPublishedVersion?: number;
  createdAt: string;
}
export interface VersionInfo {
  botId: string;
  version: number;
  state: string;
  runtime: string;
  loadoutRevision: number;
  artifactHash?: string;
  rejectionReason?: string;
  createdAt: string;
  parentVersion?: number;
  validatedBuildId?: string;
  publishedAt?: string;
  /** ELIG · elegibilidad para batallas nuevas (sólo published/frozen). */
  battleEligibility?: BattleEligibilityInfo;
}
interface StageInfo {
  name: string;
  status: string;
  message?: string;
  logs?: string[];
  metrics?: Record<string, number>;
}
interface BuildInfo {
  id: string;
  status: string;
  stages: StageInfo[];
  createdAt: string;
}
export interface VersionDetail extends VersionInfo {
  canReadSource: boolean;
  sourceSha256?: string;
  latestBuild?: BuildInfo;
  artifact?: { hash: string; signature?: string; sizeBytes?: number; buildId: string; createdAt: string };
  childVersions: number[];
}
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
interface LoadoutInfo {
  revision: number;
  chassis: string;
  modules: { slot: string; moduleId: string }[];
}

type Tab = "overview" | "code" | "equipment" | "versions";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "code", label: "Code" },
  { id: "equipment", label: "Equipment" },
  { id: "versions", label: "Versions" },
];

/**
 * UX-B · G-15 · ¿se puede editar esta versión en la web sin perder nada? Sólo si se
 * subió como UN fichero pegado (`packaged: false`: la plataforma le pone el
 * esqueleto estándar). Un paquete `{"files": [...]}` puede traer varios ficheros o
 * manifiestos propios, y el editor web sólo reenvía uno: guardar «como versión
 * nueva» los perdería en silencio. Eso se bloquea y se explica.
 */
export function isWebEditable(files: { packaged: boolean } | null): boolean {
  return !!files && !files.packaged;
}

const MAIN_ENTRY = /(^|\/)(bot|main)\.(py|js|mjs)$/;
function mainEntry(f: FilesInfo): { path: string; content: string } | undefined {
  return f.files.find((x) => MAIN_ENTRY.test(x.path)) ?? f.files[0];
}

/**
 * UX-R · Editor del fichero principal con BORRADOR de sesión (useSessionDraft):
 * si la sesión caduca de verdad y el panel se desmonta, lo escrito no se pierde;
 * al volver se recupera y se dice. Guardar en el servidor borra el borrador.
 */
function CodeDraftEditor(props: {
  draftKey: string;
  initial: string;
  version: number;
  onSave: (src: string) => Promise<boolean>;
}) {
  const draft = useSessionDraft(props.draftKey, props.initial);
  return (
    <>
      {draft.restored && (
        <p className="warn" role="status" data-testid="code-draft-restored">
          Recuperado el borrador sin guardar de esta sesión (no está en el servidor).{" "}
          <button
            type="button"
            className="link"
            onClick={() => {
              draft.setValue(props.initial);
              draft.clear();
            }}
          >
            Descartar borrador
          </button>
        </p>
      )}
      <textarea
        aria-label="codigo-editado"
        rows={14}
        cols={80}
        value={draft.value}
        onChange={(e) => draft.setValue(e.target.value)}
      />
      <br />
      <button
        type="button"
        data-testid="save-as-new"
        onClick={() =>
          void props.onSave(draft.value).then((ok) => {
            if (ok) draft.clear();
          })
        }
      >
        Guardar como versión nueva desde v{props.version}
      </button>
    </>
  );
}

const short = (h?: string) => (h ? `${h.slice(0, 12)}…` : "—");
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : "—");
const errText = (e: unknown) =>
  e instanceof ApiRequestError
    ? e.status === 403
      ? "No tienes permiso para ver el código de esta versión (es privado)."
      : e.status === 404
        ? "No existe o no es visible para ti."
        : e.message
    : String((e as Error)?.message ?? e);

export function BotDetailPage(props: { botId: string; meId?: string; initialTab?: Tab }) {
  const { botId } = props;
  const [tab, setTab] = useState<Tab>(props.initialTab ?? "overview");
  const [bot, setBot] = useState<BotInfo | null>(null);
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [details, setDetails] = useState<Record<number, VersionDetail>>({});
  const [loadouts, setLoadouts] = useState<LoadoutInfo[]>([]);
  // UX-R · el fallo ORIGINAL, para que ErrorState lo clasifique (no un texto suelto).
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [codeVersion, setCodeVersion] = useState<number | null>(null);
  const [files, setFiles] = useState<FilesInfo | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [openBuild, setOpenBuild] = useState<number | null>(null);
  const [diffPair, setDiffPair] = useState<{ from: number; to: number } | null>(null);
  const [diff, setDiff] = useState<DiffInfo | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [createdDraft, setCreatedDraft] = useState<number | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [b, vs, ls] = await Promise.all([
        api<BotInfo>("GET", `/bots/${botId}`),
        api<VersionInfo[]>("GET", `/bots/${botId}/versions`),
        api<LoadoutInfo[]>("GET", `/bots/${botId}/loadouts`).catch(() => []),
      ]);
      setBot(b);
      setVersions(vs);
      setLoadouts(ls);
      const ds = await Promise.all(vs.map((v) => api<VersionDetail>("GET", `/bots/${botId}/versions/${v.version}`)));
      setDetails(Object.fromEntries(ds.map((d) => [d.version, d])));
      setCodeVersion((cur) => cur ?? (vs.length ? vs[vs.length - 1].version : null));
    } catch (e) {
      setError(e ?? new Error("error desconocido"));
    }
  }, [botId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (codeVersion === null || tab !== "code") return;
    setFiles(null);
    setFilesError(null);
    api<FilesInfo>("GET", `/bots/${botId}/versions/${codeVersion}/files`)
      .then(setFiles)
      .catch((e) => setFilesError(errText(e)));
  }, [botId, codeVersion, tab]);

  useEffect(() => {
    if (!diffPair) return;
    setDiff(null);
    setDiffError(null);
    api<DiffInfo>("GET", `/bots/${botId}/versions/${diffPair.to}/diff?against=${diffPair.from}`)
      .then(setDiff)
      .catch((e) => setDiffError(errText(e)));
  }, [botId, diffPair]);

  async function cloneFrom(v: number) {
    setNotice(null);
    try {
      const created = await api<VersionInfo>("POST", `/bots/${botId}/versions/${v}/actions/clone`, {});
      setNotice(`Creada v${created.version} (draft) desde v${v}. v${v} no cambia.`);
      await reload();
    } catch (e) {
      setNotice(`No se pudo crear la versión: ${errText(e)}`);
    }
  }

  async function submitVersion(v: number) {
    setNotice(null);
    try {
      await api("POST", `/bots/${botId}/versions/${v}/actions/submit`);
      setNotice(`v${v} enviada a validación. Sigue su resultado en la pestaña Versions («Ver build»).`);
      setCreatedDraft(null);
      await reload();
    } catch (e) {
      setNotice(`No se pudo enviar v${v} a validación: ${errText(e)}`);
    }
  }

  /** true = guardado en el servidor (el borrador local ya puede borrarse). */
  async function saveEditedAsNew(edited: string): Promise<boolean> {
    if (codeVersion === null) return false;
    const base = versions?.find((v) => v.version === codeVersion);
    if (!base) return false;
    if (!isWebEditable(files)) return false; // G-15: un paquete no se reescribe como un único fichero
    const fd = new FormData();
    fd.append("runtime", base.runtime);
    fd.append("loadoutRevision", String(base.loadoutRevision));
    fd.append("parentVersion", String(base.version));
    fd.append("source", new Blob([edited], { type: "text/plain" }), base.runtime === "python" ? "bot.py" : "bot.js");
    try {
      const created = await api<VersionInfo>("POST", `/bots/${botId}/versions`, undefined, { formData: fd });
      setNotice(`Guardado como v${created.version} (borrador) desde v${base.version}. v${base.version} no cambia.`);
      setCreatedDraft(created.version);
      await reload();
      return true;
    } catch (e) {
      setNotice(`No se pudo guardar: ${errText(e)}`);
      return false;
    }
  }

  if (error !== null) {
    return (
      <div className="card" data-testid="bot-detail-error">
        <ErrorState label="el bot" error={error} onRetry={() => void reload()} />
        <p>
          <a href="#/bots">← Mis bots</a>
        </p>
      </div>
    );
  }
  if (!bot || !versions) return <p role="status">Cargando el bot…</p>;

  const isOwner = props.meId === undefined || props.meId === bot.ownerId;
  // UX-B · B6 · la versión que usan las batallas nuevas es la publicada más alta.
  // ELIG · y elegible: una publicada no elegible se conserva pero no juega batallas nuevas.
  const publishedVersions = versions
    .filter((v) => v.state === "published" && isBattleEligible(v))
    .map((v) => v.version);
  const inBattles = publishedVersions.length ? Math.max(...publishedVersions) : undefined;
  const editable = isWebEditable(files);

  return (
    <div data-testid="bot-detail">
      <p>
        <a href="#/bots">← Mis bots</a>
      </p>
      <h1>{bot.name}</h1>
      <div role="tablist" aria-label="Secciones del bot">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            data-testid={`tab-${t.id}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {notice && (
        <p role="status" data-testid="bot-detail-notice">
          {notice}
          {createdDraft !== null && isOwner && (
            <>
              {" "}
              <button
                type="button"
                data-testid={`submit-${createdDraft}`}
                onClick={() => void submitVersion(createdDraft)}
              >
                Enviar v{createdDraft} a validación
              </button>
            </>
          )}
        </p>
      )}

      {tab === "overview" && (
        <div className="card" data-testid="panel-overview">
          <p>Visibilidad: {bot.visibility}</p>
          <p>
            Versión publicada más reciente: {bot.latestPublishedVersion ? `v${bot.latestPublishedVersion}` : "ninguna"}
          </p>
          <p data-testid="overview-in-battles">
            {inBattles
              ? `Las batallas nuevas usan la v${inBattles}. Una versión rechazada o en borrador nunca entra en batalla.`
              : "Sin versión publicada: el bot todavía no puede entrar en batallas."}
          </p>
          <p>Versiones: {versions.length}</p>
          <p>Creado: {when(bot.createdAt)}</p>
          <p>
            <a href={`#/battles?bot=${encodeURIComponent(bot.id)}`}>Batallas de este bot</a>
          </p>
        </div>
      )}

      {tab === "code" && (
        <div className="card" data-testid="panel-code">
          <label>
            Versión{" "}
            <select
              aria-label="version-codigo"
              value={codeVersion ?? ""}
              onChange={(e) => setCodeVersion(Number(e.target.value))}
            >
              {versions.map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version} · {v.state}
                </option>
              ))}
            </select>
          </label>
          {filesError && <p role="alert">{filesError}</p>}
          {!files && !filesError && <p role="status">Cargando código…</p>}
          {files &&
            files.files.map((f) => (
              <details key={f.path} open={/(^|\/)(bot|main)\.(py|js|mjs)$/.test(f.path)}>
                <summary>{f.path}</summary>
                <pre data-testid={`file-${f.path}`}>{f.content}</pre>
              </details>
            ))}
          {files && isOwner && !editable && (
            <p className="warn" role="note" data-testid="multi-file-locked">
              v{codeVersion} se subió como paquete ({files.files.length} ficheros). El editor web sólo guarda un fichero
              y perdería el resto, así que aquí no se puede editar: crea la versión nueva subiendo el paquete completo (
              {"{"}"files": [...]{"}"}) por la API (POST /bots/{"{"}id{"}"}/versions), o usa «Nueva versión desde ésta»
              en Versions para clonarla tal cual.
            </p>
          )}
          {files && isOwner && editable && (
            <div>
              <h3>Editar en una versión NUEVA (v{codeVersion} no se modifica)</h3>
              <CodeDraftEditor
                key={`${botId}:${codeVersion}`}
                draftKey={`bot:${botId}:v${codeVersion}:code`}
                initial={mainEntry(files)?.content ?? ""}
                version={codeVersion!}
                onSave={saveEditedAsNew}
              />
            </div>
          )}
        </div>
      )}

      {tab === "equipment" && (
        <div className="card" data-testid="panel-equipment">
          {loadouts.length === 0 && <p>Sin revisiones de loadout.</p>}
          {loadouts.map((l) => (
            <div key={l.revision}>
              <h3>
                Revisión {l.revision} · {l.chassis}
              </h3>
              <p>
                Usada por:{" "}
                {versions
                  .filter((v) => v.loadoutRevision === l.revision)
                  .map((v) => `v${v.version}`)
                  .join(", ") || "ninguna versión"}
              </p>
              <ul>
                {l.modules.map((m) => (
                  <li key={m.slot}>
                    {m.slot}: {m.moduleId}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p>
            Para editar el equipamiento usa el editor de <a href="#/bots">Mis bots</a>.
          </p>
        </div>
      )}

      {tab === "versions" && (
        <div className="card" data-testid="panel-versions">
          <table>
            <thead>
              <tr>
                <th>Versión</th>
                <th>Fecha</th>
                <th>Estado</th>
                <th>Build</th>
                <th>Artefacto</th>
                <th>Publicada</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {[...versions].reverse().map((v) => {
                const d = details[v.version];
                return (
                  <tr key={v.version} data-testid={`version-row-${v.version}`}>
                    <td>
                      v{v.version}
                      {v.parentVersion ? ` (desde v${v.parentVersion})` : ""}
                    </td>
                    <td>{when(v.createdAt)}</td>
                    <td>
                      {v.state}
                      {v.state === "rejected" && v.rejectionReason ? ` — ${v.rejectionReason}` : ""}
                      <VersionEligibilityNote version={v.version} be={v.battleEligibility} suggestVersion={inBattles} />
                      {v.version === inBattles && (
                        <strong className="ok" data-testid={`detail-in-battles-${v.version}`}>
                          {" "}
                          · en batallas
                        </strong>
                      )}
                    </td>
                    <td>{d?.latestBuild ? d.latestBuild.status : "sin build"}</td>
                    <td title={d?.artifact?.hash}>{short(d?.artifact?.hash ?? v.artifactHash)}</td>
                    <td>{v.publishedAt ? when(v.publishedAt) : v.state === "published" ? "sí" : "no"}</td>
                    <td>
                      <button
                        type="button"
                        onClick={() => {
                          setCodeVersion(v.version);
                          setTab("code");
                        }}
                      >
                        Ver código
                      </button>{" "}
                      <button
                        type="button"
                        data-testid={`show-build-${v.version}`}
                        onClick={() => setOpenBuild(openBuild === v.version ? null : v.version)}
                      >
                        Ver build
                      </button>{" "}
                      {isOwner && (
                        <button
                          type="button"
                          data-testid={`clone-${v.version}`}
                          onClick={() => void cloneFrom(v.version)}
                        >
                          Nueva versión desde ésta
                        </button>
                      )}{" "}
                      {v.version > 1 && (
                        <button
                          type="button"
                          data-testid={`compare-${v.version}`}
                          onClick={() => setDiffPair({ from: v.version - 1, to: v.version })}
                        >
                          Comparar con v{v.version - 1}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {openBuild !== null && (
            <div data-testid="build-detail">
              <h3>Build de v{openBuild}</h3>
              {(() => {
                const v = versions.find((x) => x.version === openBuild);
                const diag = v
                  ? diagnoseBuild({
                      state: v.state,
                      rejectionReason: v.rejectionReason,
                      stages: details[openBuild]?.latestBuild?.stages,
                    })
                  : null;
                return diag ? (
                  <BuildDiagnosisView
                    diagnosis={diag}
                    version={openBuild}
                    publishedVersion={inBattles}
                    {...(isOwner
                      ? {
                          onFix: () => {
                            setCodeVersion(openBuild);
                            setTab("code");
                          },
                          onRetry: () => void submitVersion(openBuild),
                        }
                      : {})}
                  />
                ) : null;
              })()}
              {!details[openBuild]?.latestBuild ? (
                <p>Esta versión aún no se ha enviado a validación.</p>
              ) : (
                <ol>
                  {details[openBuild].latestBuild!.stages.map((s) => (
                    <li key={s.name}>
                      <strong>{s.name}</strong>: {s.status}
                      {s.message ? ` — ${s.message}` : ""}
                      {s.metrics ? (
                        <small>
                          {" "}
                          (
                          {Object.entries(s.metrics)
                            .map(([k, val]) => `${k}=${Math.round(val * 10) / 10}`)
                            .join(", ")}
                          )
                        </small>
                      ) : null}
                      {s.logs && s.logs.length > 0 && (
                        <details>
                          <summary>logs</summary>
                          <pre>{s.logs.join("\n")}</pre>
                        </details>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          {diffPair && (
            <div data-testid="diff-view">
              <h3>
                Diferencias v{diffPair.from} → v{diffPair.to}
              </h3>
              <label>
                Comparar v{diffPair.to} con{" "}
                <select
                  aria-label="diff-contra"
                  value={diffPair.from}
                  onChange={(e) => setDiffPair({ from: Number(e.target.value), to: diffPair.to })}
                >
                  {versions
                    .filter((x) => x.version !== diffPair.to)
                    .map((x) => (
                      <option key={x.version} value={x.version}>
                        v{x.version}
                      </option>
                    ))}
                </select>
              </label>
              {diffError && <p role="alert">{diffError}</p>}
              {!diff && !diffError && <p role="status">Calculando diferencias…</p>}
              {diff &&
                diff.files
                  .filter((f) => f.status !== "unchanged")
                  .map((f) => (
                    <div key={f.path}>
                      <h4>
                        {f.path} · {f.status} (+{f.additions} −{f.deletions})
                      </h4>
                      <pre data-testid={`diff-${f.path}`}>{f.diff}</pre>
                    </div>
                  ))}
              {diff && diff.files.every((f) => f.status === "unchanged") && <p>Sin diferencias de código.</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
