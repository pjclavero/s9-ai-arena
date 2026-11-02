/**
 * EQ5b · Administración → Streaming. ADMINISTRA lo que ya existe (streamer,
 * /broadcast, director, retardo del ruleset); no lo reimplementa.
 *
 * Reglas de esta pantalla (encargo §4, §17, §20):
 *  - la clave de emisión se escribe en un campo de contraseña y se envía; el
 *    estado de React se VACÍA en cuanto sale la petición y nunca se guarda en
 *    localStorage/sessionStorage. La API sólo devuelve «configurada» y `****ABCD`;
 *  - guardar con una emisión activa NO reinicia: se avisa «pendiente de reinicio»
 *    y el operador pulsa «Reiniciar emisión»; desactivar pide confirmación;
 *  - los botones contradictorios se deshabilitan (no se puede iniciar con una
 *    emisión activa ni detener lo que no existe);
 *  - el retardo se MUESTRA (sale de la copia de reglas del destino); no se edita.
 *  - la UI sólo oculta: el RBAC lo aplica la API (x-min-role admin).
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, type Me } from "../api.js";
import { ErrorState, FormError, LoadingState, LiveStatus, StatusBadge, type StatusVariant } from "../ui/primitives.js";
import { helpHref } from "../help/tree.js";

// ── tipos del contrato (apps/api/openapi.yaml, tag streaming) ───────────────
interface Branding {
  eventName: string;
  logoUrl: string | null;
  primaryColor: string;
  accentColor: string;
}
interface Retention {
  enabled: boolean;
  maxAgeDays: number | null;
  maxTotalBytes: number | null;
}
export interface StreamingSettings {
  enabled: boolean;
  mode: "rtmps" | "record";
  platform: string;
  ingestUrl: string | null;
  encoder: "x264" | "nvenc";
  preset: "1080p" | "720p";
  fps: 30 | 60;
  videoBitrateKbps: number;
  branding: Branding;
  retention: Retention;
  version: number;
  updatedAt: string;
}
interface CredentialMeta {
  platform: string;
  configured: boolean;
  masked: string | null;
  updatedAt: string | null;
  compatible: boolean | null;
  /** EQ5c · por qué hay que volver a introducirla (la clave está atada a su ingesta). */
  incompatibleReason?: "key_rotated" | "ingest_changed" | null;
}
interface StreamerView {
  state: string;
  desired: boolean;
  target?: string;
  restarts?: number;
  lastError: { message: string; at: string } | null;
  relay?: { state: string | null; bytesOut: number };
  recording?: string | null;
  stats?: { frames: number; fps: number; bitrateKbps: number; droppedFrames: number; outTimeSeconds: number };
  legacyKeyConfigured?: boolean;
}
export type UxState =
  "disabled" | "streamer_unreachable" | "ready" | "live" | "recording" | "retrying" | "failed" | "interrupted";
export interface StreamingAdminState {
  settings: StreamingSettings;
  platforms: { id: string; label: string; ingestUrl: string | null }[];
  credentials: CredentialMeta[];
  capabilities: {
    sealedStore: boolean;
    streamerConfigured: boolean;
    streamerReachable: boolean;
    streamerError: string | null;
    nvenc: boolean | null;
  };
  streamer: StreamerView | null;
  session: { id: string; mode: string; target: { kind: string; id: string } | null; startedAt: string } | null;
  pendingRestart: boolean;
  uxState: UxState;
  bitrate: { min: number; max: number; recommended: number };
  changeClasses: Record<string, "hot" | "restart" | "stop">;
}
interface TargetInfo {
  kind: "battle" | "tournament";
  id: string;
  label: string;
  status: string;
  publicBroadcastable: boolean;
  delaySeconds: number;
  delaySource: "snapshot" | "ruleset" | "final_visible" | "none";
}
interface Recordings {
  dir: string;
  count: number;
  totalBytes: number;
  disk: { totalBytes: number; freeBytes: number } | null;
  files: { name: string; sizeBytes: number; modifiedAt: string; inProgress: boolean }[];
}
interface AuditRow {
  id: string;
  actorId?: string;
  action: string;
  target: string;
  at: string;
}

// ── textos de estado (§17) ──────────────────────────────────────────────────
export const UX_TEXT: Record<UxState, { variant: StatusVariant; title: string; text: string }> = {
  disabled: {
    variant: "neutral",
    title: "Desactivado",
    text: "El streaming está desactivado. Actívalo en «Configuración» para poder emitir o grabar.",
  },
  streamer_unreachable: {
    variant: "error",
    title: "Servicio de emisión no disponible",
    text: "El servicio de emisión (streamer) no responde. Si esta instalación no lo tiene desplegado, no se puede emitir desde aquí.",
  },
  ready: { variant: "ok", title: "Listo", text: "Elige un destino y pulsa «Iniciar». Nada se emite hasta entonces." },
  live: { variant: "ok", title: "En directo", text: "Se está emitiendo hacia la plataforma configurada." },
  recording: { variant: "ok", title: "Grabando", text: "Se está grabando un MP4 (modo sólo grabación, sin emitir)." },
  retrying: {
    variant: "warn",
    title: "Reconectando",
    text: "Se ha cortado la conexión con la ingesta y se está reintentando automáticamente.",
  },
  failed: {
    variant: "error",
    title: "Emisión abandonada",
    text: "Se agotaron los reintentos. Revisa el último error y la configuración, y vuelve a iniciar.",
  },
  interrupted: {
    variant: "error",
    title: "Emisión interrumpida",
    text: "La sesión figura como activa pero el streamer no está emitiendo (¿se reinició?). Detén la sesión o reiníciala.",
  },
};

export const IMPACT_TEXT: Record<"hot" | "restart" | "stop", string> = {
  hot: "se aplica al momento",
  restart: "se aplicará al reiniciar la emisión",
  stop: "detiene la emisión en curso",
};

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
export function validLogo(v: string): boolean {
  if (!v) return true;
  if (v.length > 512 || /[\s"'<>\\`]/.test(v)) return false;
  if (v.startsWith("/") && !v.startsWith("//")) return true;
  return /^https:\/\/[^/]/.test(v);
}

/** Vista previa del branding: la MISMA vista /broadcast, sin destino (pantalla de espera). */
export function previewUrl(b: Branding): string {
  const q = new URLSearchParams();
  q.set("event", b.eventName);
  if (b.logoUrl && validLogo(b.logoUrl)) q.set("logo", b.logoUrl);
  if (HEX.test(b.primaryColor)) q.set("primary", b.primaryColor);
  if (HEX.test(b.accentColor)) q.set("accent", b.accentColor);
  return `/broadcast?${q.toString()}`;
}

function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

/** `#/streaming?battle=<id>` / `?tournament=<id>` (botones «Retransmitir»). */
export function preselectedTarget(route: string): { kind: "battle" | "tournament"; id: string } | null {
  const q = new URLSearchParams(route.split("?")[1] ?? "");
  const b = q.get("battle");
  const t = q.get("tournament");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (b && uuid.test(b)) return { kind: "battle", id: b };
  if (t && uuid.test(t)) return { kind: "tournament", id: t };
  return null;
}

const POLL_MS = 3000;

export function StreamingPage(props: { me: Me; route: string }) {
  const [st, setSt] = useState<StreamingAdminState | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  /** Cada acción terminada refresca la auditoría (una retención no cambia la versión). */
  const [actions, setActions] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const s = await api<StreamingAdminState>("GET", "/admin/streaming");
      setSt(s);
      setLoadError(null);
    } catch (e) {
      setLoadError(e);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  async function act(name: string, fn: () => Promise<string | void>) {
    setBusy(name);
    setActionError(null);
    setNotice("");
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
      await refresh();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(null);
      setActions((n) => n + 1);
    }
  }

  if (!st && loadError) {
    return (
      <div className="card">
        <h2>Streaming</h2>
        <ErrorState label="la administración de streaming" error={loadError} onRetry={() => void refresh()} />
      </div>
    );
  }
  if (!st) return <LoadingState label="la administración de streaming" />;

  const ux = UX_TEXT[st.uxState];
  const active = st.uxState === "live" || st.uxState === "recording" || st.uxState === "retrying";
  return (
    <div data-testid="streaming-page">
      <div className="card">
        <h2>Streaming</h2>
        <p>
          Emite o graba la vista <code>/broadcast</code> de una batalla o un torneo.{" "}
          <a href={helpHref("administracion", "streaming")}>Ayuda de Streaming</a>
        </p>
        <LiveStatus data-testid="streaming-state" busy={st.uxState === "retrying"}>
          <StatusBadge variant={ux.variant} data-testid="streaming-ux-state">
            {ux.title}
          </StatusBadge>{" "}
          {ux.text}
        </LiveStatus>
        {!st.capabilities.sealedStore && (
          <p className="warn" role="status" data-testid="sealed-store-missing">
            No hay almacén seguro de claves en esta instalación: no se pueden guardar claves de emisión (sólo es posible
            grabar).
          </p>
        )}
        {st.pendingRestart && (
          <p className="warn" role="status" data-testid="pending-restart">
            Hay cambios guardados que la emisión en curso aún no usa. Se aplicarán al pulsar «Reiniciar emisión» (corte
            de unos segundos).
          </p>
        )}
        {notice && (
          <p className="ok" role="status" data-testid="streaming-notice">
            {notice}
          </p>
        )}
        <FormError error={actionError} data-testid="streaming-error" />
      </div>

      <MonitorCard st={st} />
      <ControlsCard st={st} route={props.route} busy={busy} act={act} active={active} />
      <SettingsCard key={`s${st.settings.version}`} st={st} busy={busy} act={act} />
      <CredentialsCard st={st} busy={busy} act={act} />
      <BrandingCard key={`b${st.settings.version}`} st={st} busy={busy} act={act} />
      <RecordingsCard key={`r${st.settings.version}`} st={st} busy={busy} act={act} />
      <AuditCard version={st.settings.version * 100000 + actions} />
    </div>
  );
}

type Act = (name: string, fn: () => Promise<string | void>) => Promise<void>;

function MonitorCard({ st }: { st: StreamingAdminState }) {
  const s = st.streamer;
  return (
    <div className="card" data-testid="streaming-monitor">
      <h3>Monitorización</h3>
      {!s ? (
        <p>Sin datos del streamer{st.capabilities.streamerError ? `: ${st.capabilities.streamerError}` : ""}.</p>
      ) : (
        <table>
          <tbody>
            <tr>
              <td>Estado del streamer</td>
              <td data-testid="mon-state">{s.state}</td>
            </tr>
            <tr>
              <td>Destino</td>
              <td data-testid="mon-target">{s.target ?? "—"}</td>
            </tr>
            <tr>
              <td>FPS / bitrate</td>
              <td data-testid="mon-rate">
                {s.stats ? `${s.stats.fps} fps · ${Math.round(s.stats.bitrateKbps)} kbit/s` : "—"}
              </td>
            </tr>
            <tr>
              <td>Frames (descartados)</td>
              <td>{s.stats ? `${s.stats.frames} (${s.stats.droppedFrames})` : "—"}</td>
            </tr>
            <tr>
              <td>Reintentos</td>
              <td>{s.restarts ?? 0}</td>
            </tr>
            <tr>
              <td>Relé RTMP</td>
              <td>{s.relay?.state ?? "—"}</td>
            </tr>
            <tr>
              <td>Grabación en curso</td>
              <td>{s.recording ?? "—"}</td>
            </tr>
            <tr>
              <td>Último error</td>
              <td data-testid="mon-last-error">
                {s.lastError ? `${s.lastError.message} (${new Date(s.lastError.at).toLocaleString("es-ES")})` : "—"}
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

function ControlsCard(props: {
  st: StreamingAdminState;
  route: string;
  busy: string | null;
  act: Act;
  active: boolean;
}) {
  const { st, act, busy, active } = props;
  const pre = preselectedTarget(props.route);
  const [kind, setKind] = useState<"battle" | "tournament">(pre?.kind ?? "battle");
  const [id, setId] = useState(pre?.id ?? "");
  const [target, setTarget] = useState<TargetInfo | null>(null);
  const [targetError, setTargetError] = useState<unknown>(null);
  const checked = useRef<string>("");

  const check = useCallback(async (k: string, i: string) => {
    setTargetError(null);
    setTarget(null);
    if (!i.trim()) return;
    try {
      setTarget(await api<TargetInfo>("GET", `/admin/streaming/target?kind=${k}&id=${encodeURIComponent(i.trim())}`));
    } catch (e) {
      setTargetError(e);
    }
  }, []);
  useEffect(() => {
    // Destino preseleccionado por «Retransmitir»: se comprueba (lectura), no se emite.
    if (pre && checked.current !== `${pre.kind}:${pre.id}`) {
      checked.current = `${pre.kind}:${pre.id}`;
      void check(pre.kind, pre.id);
    }
  }, [pre, check]);

  const mode = st.settings.mode;
  const cred = st.credentials.find((c) => c.platform === st.settings.platform);
  const credOk = mode === "record" || !!cred?.configured;
  const canStart =
    st.settings.enabled &&
    st.capabilities.streamerReachable &&
    !active &&
    !st.session &&
    !!target?.publicBroadcastable &&
    credOk;
  const startLabel = mode === "record" ? "Iniciar grabación" : "Iniciar emisión";
  const stopLabel = mode === "record" ? "Detener grabación" : "Detener emisión";

  return (
    <div className="card" data-testid="streaming-controls">
      <h3>Destino y controles</h3>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void check(kind, id);
        }}
      >
        <p>
          <label htmlFor="stream-kind">Tipo</label>{" "}
          <select id="stream-kind" value={kind} onChange={(e) => setKind(e.target.value as "battle" | "tournament")}>
            <option value="battle">Batalla</option>
            <option value="tournament">Torneo</option>
          </select>{" "}
          <label htmlFor="stream-target">Id</label>{" "}
          <input
            id="stream-target"
            data-testid="stream-target-id"
            value={id}
            onChange={(e) => setId(e.target.value)}
            size={38}
            placeholder="UUID de la batalla o el torneo"
          />{" "}
          <button type="submit" data-testid="stream-target-check">
            Comprobar destino
          </button>
        </p>
      </form>
      <FormError error={targetError} data-testid="stream-target-error" />
      {target && (
        <div data-testid="stream-target-info">
          <p>
            <strong>{target.label}</strong> · estado {target.status}
          </p>
          <p data-testid="stream-delay">
            Retardo del directo: <strong>{target.delaySeconds} s</strong> (
            {target.delaySource === "snapshot"
              ? "de la copia de reglas"
              : target.delaySource === "ruleset"
                ? "del ruleset"
                : target.delaySource === "final_visible"
                  ? "final sin retardo"
                  : "sin retardo declarado"}
            ). Se cambia en las reglas, no aquí.
          </p>
          {!target.publicBroadcastable && (
            <p className="error" role="alert" data-testid="stream-target-private">
              Tiene bots no públicos: la vista /broadcast (anónima) no podría mostrarla. No se puede emitir.
            </p>
          )}
        </div>
      )}
      {mode === "rtmps" && !cred?.configured && (
        <p className="warn" data-testid="stream-no-credential">
          Falta la clave de emisión de {st.platforms.find((p) => p.id === st.settings.platform)?.label}. Añádela en
          «Credenciales».
        </p>
      )}
      <p>
        <button
          type="button"
          data-testid="stream-test"
          disabled={busy !== null || mode !== "rtmps" || !credOk || !st.capabilities.streamerReachable}
          onClick={() =>
            void act("test", async () => {
              const r = await api<{ ok: boolean; error?: string; connectMs?: number; note?: string }>(
                "POST",
                "/admin/streaming/test",
                {},
              );
              return r.ok
                ? `Prueba correcta: TLS verificado y handshake RTMP en ${r.connectMs} ms. ${r.note ?? ""}`
                : `La prueba falló: ${r.error}`;
            })
          }
        >
          Probar configuración
        </button>{" "}
        <button
          type="button"
          data-testid="stream-start"
          disabled={busy !== null || !canStart}
          onClick={() =>
            void act("start", async () => {
              const r = await api<{ alreadyActive: boolean }>("POST", "/admin/streaming/start", {
                target: { kind: target!.kind, id: target!.id },
              });
              return r.alreadyActive ? "Ya estaba activa con este destino." : `${startLabel}: orden enviada.`;
            })
          }
        >
          {startLabel}
        </button>{" "}
        <button
          type="button"
          data-testid="stream-stop"
          disabled={busy !== null || (!active && !st.session)}
          onClick={() => {
            if (!window.confirm(`¿${stopLabel}? Se corta lo que se está emitiendo.`)) return;
            void act("stop", async () => {
              await api("POST", "/admin/streaming/stop", {});
              return "Detenida.";
            });
          }}
        >
          {stopLabel}
        </button>{" "}
        <button
          type="button"
          data-testid="stream-restart"
          disabled={busy !== null || !st.session || !st.pendingRestart}
          onClick={() =>
            void act("restart", async () => {
              await api("POST", "/admin/streaming/restart", {});
              return "Reiniciada con la configuración guardada.";
            })
          }
        >
          Reiniciar emisión
        </button>
      </p>
      {st.session && (
        <p data-testid="stream-session">
          Sesión activa desde {new Date(st.session.startedAt).toLocaleString("es-ES")}
          {st.session.target ? ` · ${st.session.target.kind} ${st.session.target.id}` : ""}
        </p>
      )}
    </div>
  );
}

function SettingsCard({ st, busy, act }: { st: StreamingAdminState; busy: string | null; act: Act }) {
  const s0 = st.settings;
  const [f, setF] = useState({
    enabled: s0.enabled,
    mode: s0.mode,
    platform: s0.platform,
    ingestUrl: s0.ingestUrl ?? "",
    encoder: s0.encoder,
    preset: s0.preset,
    fps: s0.fps,
    videoBitrateKbps: s0.videoBitrateKbps,
  });
  const platform = st.platforms.find((p) => p.id === f.platform);
  const rec = recommendation(f.preset, f.fps);
  const outOfRange = f.videoBitrateKbps < rec.min || f.videoBitrateKbps > rec.max;

  function save(e: FormEvent) {
    e.preventDefault();
    const patch: Record<string, unknown> = { version: s0.version };
    for (const k of Object.keys(f) as (keyof typeof f)[]) {
      const cur = k === "ingestUrl" ? (s0.ingestUrl ?? "") : s0[k];
      if (f[k] !== cur) patch[k] = k === "ingestUrl" ? f.ingestUrl || null : f[k];
    }
    if (patch.fps === 60) {
      if (!window.confirm("60 FPS dobla el coste de CPU y el ancho de banda. ¿Seguro?")) return;
      patch.confirmHighFps = true;
    }
    if (patch.enabled === false && st.session) {
      if (!window.confirm("Desactivar el streaming detiene la emisión en curso. ¿Continuar?")) return;
      patch.confirmStop = true;
    }
    void act("settings", async () => {
      const r = await api<{
        changed: string[];
        impact?: Record<string, "hot" | "restart" | "stop">;
        warnings: string[];
        pendingRestart: boolean;
        stopped: boolean;
      }>("PUT", "/admin/streaming/settings", patch);
      if (r.changed.length === 0) return "Sin cambios.";
      const parts = Object.entries(r.impact ?? {}).map(([k, v]) => `${k}: ${IMPACT_TEXT[v]}`);
      return `Guardado (${parts.join("; ")}).${r.stopped ? " Emisión detenida." : ""}${r.warnings.length ? ` Aviso: ${r.warnings.join("; ")}` : ""}`;
    });
  }

  return (
    <div className="card" data-testid="streaming-settings">
      <h3>Configuración</h3>
      <form onSubmit={save}>
        <p>
          <label>
            <input
              type="checkbox"
              data-testid="set-enabled"
              checked={f.enabled}
              onChange={(e) => setF({ ...f, enabled: e.target.checked })}
            />{" "}
            Streaming activado
          </label>
        </p>
        <p>
          <label htmlFor="set-mode">Modo</label>{" "}
          <select
            id="set-mode"
            data-testid="set-mode"
            value={f.mode}
            onChange={(e) => setF({ ...f, mode: e.target.value as "rtmps" | "record" })}
          >
            <option value="rtmps">Emitir (RTMPS)</option>
            <option value="record">Sólo grabar (MP4)</option>
          </select>
        </p>
        {f.mode === "rtmps" && (
          <>
            <p>
              <label htmlFor="set-platform">Plataforma</label>{" "}
              <select
                id="set-platform"
                data-testid="set-platform"
                value={f.platform}
                onChange={(e) => setF({ ...f, platform: e.target.value })}
              >
                {st.platforms.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>{" "}
              {platform?.ingestUrl && <small>Ingesta: {platform.ingestUrl}</small>}
            </p>
            {platform && platform.ingestUrl === null && (
              <p>
                <label htmlFor="set-ingest">URL de ingesta (rtmps://)</label>{" "}
                <input
                  id="set-ingest"
                  data-testid="set-ingest"
                  value={f.ingestUrl}
                  size={50}
                  placeholder="rtmps://servidor:443/aplicacion"
                  onChange={(e) => setF({ ...f, ingestUrl: e.target.value })}
                />
                <small style={{ display: "block" }}>Sin la clave: la clave va aparte, en «Credenciales».</small>
              </p>
            )}
          </>
        )}
        <p>
          <label htmlFor="set-encoder">Codificador</label>{" "}
          <select
            id="set-encoder"
            data-testid="set-encoder"
            value={f.encoder}
            onChange={(e) => setF({ ...f, encoder: e.target.value as "x264" | "nvenc" })}
          >
            <option value="x264">x264 (CPU)</option>
            <option value="nvenc" disabled={st.capabilities.nvenc !== true}>
              NVENC (GPU){st.capabilities.nvenc !== true ? " — no disponible en este servidor" : ""}
            </option>
          </select>
        </p>
        <p>
          <label htmlFor="set-preset">Resolución</label>{" "}
          <select
            id="set-preset"
            data-testid="set-preset"
            value={f.preset}
            onChange={(e) => setF({ ...f, preset: e.target.value as "1080p" | "720p" })}
          >
            <option value="1080p">1080p (por defecto)</option>
            <option value="720p">720p</option>
          </select>{" "}
          <label htmlFor="set-fps">FPS</label>{" "}
          <select
            id="set-fps"
            data-testid="set-fps"
            value={f.fps}
            onChange={(e) => setF({ ...f, fps: Number(e.target.value) as 30 | 60 })}
          >
            <option value={30}>30 (por defecto)</option>
            <option value={60}>60 (más CPU y ancho de banda)</option>
          </select>
        </p>
        <p>
          <label htmlFor="set-bitrate">Bitrate de vídeo (kbit/s)</label>{" "}
          <input
            id="set-bitrate"
            data-testid="set-bitrate"
            type="number"
            min={1000}
            max={12000}
            step={100}
            value={f.videoBitrateKbps}
            aria-describedby="set-bitrate-hint"
            onChange={(e) => setF({ ...f, videoBitrateKbps: Number(e.target.value) })}
          />
          <small id="set-bitrate-hint" style={{ display: "block" }} className={outOfRange ? "warn" : undefined}>
            Recomendado para {f.preset} a {f.fps} FPS: {rec.recommended} kbit/s (rango {rec.min}-{rec.max}).
            {outOfRange ? " El valor está fuera del rango recomendado." : ""}
          </small>
        </p>
        <p>
          <button type="submit" data-testid="set-save" disabled={busy !== null}>
            Guardar configuración
          </button>
        </p>
        <p>
          <small>
            Con una emisión activa: los cambios de modo, plataforma, codificación y branding se aplican al pulsar
            «Reiniciar emisión»; la retención, al momento; desactivar detiene la emisión.
          </small>
        </p>
      </form>
    </div>
  );
}

/** Mismos rangos que la API (services/streaming.ts → bitrateRecommendation). */
export function recommendation(preset: string, fps: number) {
  if (preset === "720p")
    return fps === 60 ? { min: 2250, max: 6000, recommended: 4500 } : { min: 1500, max: 4000, recommended: 3000 };
  return fps === 60 ? { min: 4500, max: 9000, recommended: 6000 } : { min: 3000, max: 6000, recommended: 4500 };
}

function CredentialsCard({ st, busy, act }: { st: StreamingAdminState; busy: string | null; act: Act }) {
  return (
    <div className="card" data-testid="streaming-credentials">
      <h3>Credenciales</h3>
      <p>
        La clave de emisión se guarda cifrada y <strong>nunca se vuelve a mostrar</strong>: sólo verás si está
        configurada y sus 4 últimos caracteres.
      </p>
      {st.streamer?.legacyKeyConfigured && (
        <p data-testid="legacy-key">Hay además una clave heredada del despliegue (se usa si no configuras una aquí).</p>
      )}
      {st.platforms.map((p) => (
        <CredentialRow
          key={p.id}
          platform={p}
          meta={st.credentials.find((c) => c.platform === p.id)}
          st={st}
          busy={busy}
          act={act}
        />
      ))}
    </div>
  );
}

function CredentialRow(props: {
  platform: { id: string; label: string };
  meta: CredentialMeta | undefined;
  st: StreamingAdminState;
  busy: string | null;
  act: Act;
}) {
  const { platform, meta, act, busy } = props;
  // La clave vive SÓLO en este estado mientras se escribe; se vacía al enviar.
  const [key, setKey] = useState("");
  const inputId = `cred-${platform.id}`;
  return (
    <form
      data-testid={`credential-${platform.id}`}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        const value = key;
        setKey("");
        void act(`cred-${platform.id}`, async () => {
          const r = await api<{ masked: string; appliesOnNextStart: boolean }>(
            "PUT",
            `/admin/streaming/credentials/${platform.id}`,
            { streamKey: value },
          );
          return `Clave de ${platform.label} guardada (${r.masked}).${r.appliesOnNextStart ? " Se usará al reiniciar la emisión." : ""}`;
        });
      }}
    >
      <p>
        <strong>{platform.label}</strong>:{" "}
        <span data-testid={`credential-${platform.id}-state`}>
          {meta?.configured ? `configurada (${meta.masked})` : "no configurada"}
          {meta?.configured && meta.compatible === false
            ? meta.incompatibleReason === "ingest_changed"
              ? " — guardada para otra URL de ingesta: vuelve a introducirla"
              : " — guardada con otra clave de cifrado: vuelve a introducirla"
            : ""}
        </span>
      </p>
      <p>
        <label htmlFor={inputId}>{meta?.configured ? "Cambiar clave" : "Clave de emisión"}</label>{" "}
        <input
          id={inputId}
          data-testid={`credential-${platform.id}-input`}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          disabled={!props.st.capabilities.sealedStore}
        />{" "}
        <button type="submit" disabled={busy !== null || key.length < 8 || !props.st.capabilities.sealedStore}>
          Guardar clave
        </button>{" "}
        {meta?.configured && (
          <button
            type="button"
            data-testid={`credential-${platform.id}-delete`}
            disabled={busy !== null}
            onClick={() => {
              if (!window.confirm(`¿Eliminar la clave de ${platform.label}?`)) return;
              void act(`cred-del-${platform.id}`, async () => {
                await api("DELETE", `/admin/streaming/credentials/${platform.id}`);
                return `Clave de ${platform.label} eliminada.`;
              });
            }}
          >
            Eliminar clave
          </button>
        )}
      </p>
    </form>
  );
}

function BrandingCard({ st, busy, act }: { st: StreamingAdminState; busy: string | null; act: Act }) {
  const [b, setB] = useState<Branding>({ ...st.settings.branding, logoUrl: st.settings.branding.logoUrl ?? "" });
  const errors: string[] = [];
  if (!b.eventName.trim() || b.eventName.length > 80) errors.push("El nombre del evento debe tener 1-80 caracteres.");
  if (!validLogo(b.logoUrl ?? "")) errors.push("El logo debe ser https:// o una ruta del propio sitio (/...).");
  if (!HEX.test(b.primaryColor)) errors.push("Color primario: #rgb o #rrggbb.");
  if (!HEX.test(b.accentColor)) errors.push("Color de acento: #rgb o #rrggbb.");
  return (
    <div className="card" data-testid="streaming-branding">
      <h3>Branding</h3>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (errors.length) return;
          void act("branding", async () => {
            const r = await api<{ pendingRestart: boolean }>("PUT", "/admin/streaming/settings", {
              version: st.settings.version,
              branding: { ...b, logoUrl: b.logoUrl || null },
            });
            return r.pendingRestart ? "Branding guardado: se aplicará al reiniciar la emisión." : "Branding guardado.";
          });
        }}
      >
        <p>
          <label htmlFor="br-name">Nombre del evento</label>{" "}
          <input
            id="br-name"
            data-testid="br-name"
            maxLength={80}
            value={b.eventName}
            onChange={(e) => setB({ ...b, eventName: e.target.value })}
          />
        </p>
        <p>
          <label htmlFor="br-logo">Logo (URL)</label>{" "}
          <input
            id="br-logo"
            data-testid="br-logo"
            size={40}
            value={b.logoUrl ?? ""}
            onChange={(e) => setB({ ...b, logoUrl: e.target.value })}
          />
        </p>
        <p>
          <label htmlFor="br-primary">Color primario</label>{" "}
          <input
            id="br-primary"
            data-testid="br-primary"
            value={b.primaryColor}
            size={9}
            onChange={(e) => setB({ ...b, primaryColor: e.target.value })}
          />{" "}
          <label htmlFor="br-accent">Color de acento</label>{" "}
          <input
            id="br-accent"
            data-testid="br-accent"
            value={b.accentColor}
            size={9}
            onChange={(e) => setB({ ...b, accentColor: e.target.value })}
          />
        </p>
        {errors.length > 0 && (
          <ul className="error" role="alert" data-testid="br-errors">
            {errors.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        )}
        <p>
          <button type="submit" data-testid="br-save" disabled={busy !== null || errors.length > 0}>
            Guardar branding
          </button>
        </p>
      </form>
      <h4>Vista previa</h4>
      <p>
        <small>La misma vista /broadcast que captura el streamer, en su pantalla de espera.</small>
      </p>
      <div
        style={{ width: 480, maxWidth: "100%", aspectRatio: "16 / 9", overflow: "hidden", border: "1px solid #444" }}
      >
        {errors.length === 0 ? (
          <iframe
            title="Vista previa del branding de la emisión"
            data-testid="br-preview"
            src={previewUrl(b)}
            style={{ width: 1920, height: 1080, border: 0, transform: "scale(0.25)", transformOrigin: "0 0" }}
            sandbox="allow-scripts allow-same-origin"
            tabIndex={-1}
          />
        ) : (
          <p>Corrige los errores para ver la vista previa.</p>
        )}
      </div>
    </div>
  );
}

function RecordingsCard({ st, busy, act }: { st: StreamingAdminState; busy: string | null; act: Act }) {
  const r0 = st.settings.retention;
  const [rec, setRec] = useState<Recordings | null>(null);
  const [recError, setRecError] = useState<unknown>(null);
  const preset =
    r0.maxAgeDays === 7 || r0.maxAgeDays === 14 || r0.maxAgeDays === 30
      ? String(r0.maxAgeDays)
      : r0.maxAgeDays === null
        ? "none"
        : "custom";
  const [ageSel, setAgeSel] = useState(preset);
  const [customDays, setCustomDays] = useState(r0.maxAgeDays ?? 60);
  const [enabled, setEnabled] = useState(r0.enabled);
  const [maxGiB, setMaxGiB] = useState(
    r0.maxTotalBytes ? String(Math.round((r0.maxTotalBytes / 1024 ** 3) * 10) / 10) : "",
  );

  const load = useCallback(async () => {
    if (!st.capabilities.streamerReachable) return;
    try {
      setRec(await api<Recordings>("GET", "/admin/streaming/recordings"));
      setRecError(null);
    } catch (e) {
      setRecError(e);
    }
  }, [st.capabilities.streamerReachable]);
  useEffect(() => {
    void load();
  }, [load]);

  const maxAgeDays = ageSel === "none" ? null : ageSel === "custom" ? customDays : Number(ageSel);
  const maxTotalBytes = maxGiB.trim() ? Math.round(Number(maxGiB) * 1024 ** 3) : null;
  const invalid =
    (enabled && maxAgeDays === null && maxTotalBytes === null) ||
    (maxTotalBytes !== null && !(maxTotalBytes >= 1024 * 1024));

  return (
    <div className="card" data-testid="streaming-recordings">
      <h3>Grabaciones y retención</h3>
      {recError ? (
        <FormError error={recError} />
      ) : rec ? (
        <p data-testid="rec-summary">
          Carpeta <code>{rec.dir}</code> · {rec.count} grabaciones · {fmtBytes(rec.totalBytes)} · libre en disco{" "}
          {fmtBytes(rec.disk?.freeBytes)} de {fmtBytes(rec.disk?.totalBytes)}
        </p>
      ) : (
        <p>Sin datos de grabaciones (el streamer no responde).</p>
      )}
      {rec && rec.files.length > 0 && (
        <ul>
          {rec.files.slice(-10).map((f) => (
            <li key={f.name}>
              {f.name} · {fmtBytes(f.sizeBytes)}
              {f.inProgress ? " · grabando (nunca se borra)" : ""}
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (invalid) return;
          void act("retention", async () => {
            await api("PUT", "/admin/streaming/settings", {
              version: st.settings.version,
              retention: { enabled, maxAgeDays, maxTotalBytes },
            });
            return "Retención guardada (se aplica al momento).";
          });
        }}
      >
        <p>
          <label>
            <input
              type="checkbox"
              data-testid="ret-enabled"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />{" "}
            Borrar automáticamente (cada hora)
          </label>
        </p>
        <p>
          <label htmlFor="ret-age">Antigüedad máxima</label>{" "}
          <select id="ret-age" data-testid="ret-age" value={ageSel} onChange={(e) => setAgeSel(e.target.value)}>
            <option value="7">7 días</option>
            <option value="14">14 días</option>
            <option value="30">30 días</option>
            <option value="custom">Personalizada</option>
            <option value="none">Sin límite por edad</option>
          </select>{" "}
          {ageSel === "custom" && (
            <input
              aria-label="Días personalizados"
              data-testid="ret-custom-days"
              type="number"
              min={1}
              max={3650}
              value={customDays}
              onChange={(e) => setCustomDays(Number(e.target.value))}
            />
          )}
        </p>
        <p>
          <label htmlFor="ret-size">Tamaño máximo total (GiB, vacío = sin límite)</label>{" "}
          <input
            id="ret-size"
            data-testid="ret-size"
            value={maxGiB}
            size={6}
            onChange={(e) => setMaxGiB(e.target.value)}
          />
        </p>
        {invalid && (
          <p className="error" role="alert">
            La retención automática necesita una antigüedad o un tamaño máximo (al menos 1 MiB).
          </p>
        )}
        <p>
          <small>
            Sólo se borran las grabaciones MP4 de esta carpeta: nunca replays, ni otros ficheros, ni la grabación en
            curso. Cada borrado queda en la auditoría.
          </small>
        </p>
        <p>
          <button type="submit" data-testid="ret-save" disabled={busy !== null || invalid}>
            Guardar retención
          </button>{" "}
          <button
            type="button"
            data-testid="ret-dry"
            disabled={busy !== null || !st.capabilities.streamerReachable}
            onClick={() =>
              void act("ret-dry", async () => {
                const r = await api<{ deleted: unknown[] }>("POST", "/admin/streaming/retention", { dryRun: true });
                return `Simulación con la política guardada: se borrarían ${r.deleted.length} grabaciones.`;
              })
            }
          >
            Simular
          </button>{" "}
          <button
            type="button"
            data-testid="ret-apply"
            disabled={busy !== null || !st.capabilities.streamerReachable}
            onClick={() => {
              if (!window.confirm("¿Aplicar ahora la política guardada? Los MP4 borrados no se recuperan.")) return;
              void act("ret-apply", async () => {
                const r = await api<{ deleted: unknown[] }>("POST", "/admin/streaming/retention", {});
                await load();
                return `Retención aplicada: ${r.deleted.length} grabaciones borradas (auditadas).`;
              });
            }}
          >
            Aplicar ahora
          </button>
        </p>
      </form>
    </div>
  );
}

function AuditCard({ version }: { version: number }) {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api<AuditRow[]>("GET", "/admin/streaming/audit?limit=20")
      .then((r) => {
        setRows(r);
        setError(null);
      })
      .catch(setError);
  }, [version]);
  return (
    <div className="card" data-testid="streaming-audit">
      <h3>Auditoría</h3>
      {error ? (
        <FormError error={error} />
      ) : !rows ? (
        <p>Cargando…</p>
      ) : rows.length === 0 ? (
        <p>Sin cambios registrados.</p>
      ) : (
        <table className="stack-table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Acción</th>
              <th>Objeto</th>
              <th>Quién</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.at).toLocaleString("es-ES")}</td>
                <td>{r.action}</td>
                <td>{r.target}</td>
                <td>{r.actorId ?? "sistema"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
