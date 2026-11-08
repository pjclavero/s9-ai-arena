/**
 * EQ5b · Administración → Streaming. ADMINISTRA lo que ya existe (streamer,
 * /broadcast, director, retardo del ruleset); no lo reimplementa.
 *
 * STREAMING-UX (2026-11) · la pantalla se separa en cuatro secciones con menú a la
 * IZQUIERDA (en móvil, pestañas horizontales con scroll):
 *  - «Streaming» (operación normal): estado en lenguaje humano, qué retransmitir
 *    (selector de batallas y torneos con nombre legible, SIN UUID), canal, calidad
 *    (cuatro preajustes) e INICIAR. Con una emisión activa, la vista en directo:
 *    «● EN DIRECTO», destino, canal, calidad, duración, FPS, bitrate, frames
 *    descartados, ingesta activa y DETENER siempre a la vista;
 *  - «Configuración avanzada»: destino manual (UUID), plataforma y modo, servidores
 *    principal y de respaldo, clave, codificación y bitrate, branding y diagnóstico;
 *  - «Grabaciones» y «Auditoría», lejos de INICIAR y DETENER.
 * Los códigos internos (`battle_not_public`, `credential_missing`…) sólo salen en
 * «Ver detalles técnicos».
 *
 * Reglas que se mantienen (encargo EQ5b §4, §17, §20):
 *  - la clave de emisión se escribe en un campo de contraseña y se envía; el
 *    estado de React se VACÍA en cuanto sale la petición y nunca se guarda en
 *    localStorage/sessionStorage. La API sólo devuelve «configurada» y `****ABCD`;
 *  - guardar con una emisión activa NO reinicia: se avisa «pendiente de reinicio»
 *    y el operador pulsa «Reiniciar emisión»; desactivar pide confirmación;
 *  - los botones contradictorios se deshabilitan;
 *  - la UI sólo oculta: el RBAC lo aplica la API (x-min-role admin).
 *
 * Preparada para perfiles de canal por usuario (siguiente carril): el selector
 * «Canal» recibe una lista de `ChannelOption` (hoy, una por plataforma más «Sólo
 * grabar»); un perfil sería otra opción con su propio id, sin tocar la vista.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
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
  /** STREAMING-UX · sobre de la ingesta de respaldo. */
  backup?: "none" | "ready" | "needs_key";
}
export interface IngestsView {
  platform: string;
  primaryIngestUrl: string | null;
  backupIngestUrl: string | null;
  source: "configured" | "default";
  backupQueryAllowed: boolean;
}
interface RelayView {
  state: string | null;
  bytesOut: number;
  ingest?: "primary" | "backup" | null;
  backupAvailable?: boolean;
  failedOver?: boolean;
  ingestErrors?: { primary: string | null; backup: string | null };
}
interface StreamerView {
  state: string;
  desired: boolean;
  target?: string;
  restarts?: number;
  lastError: { message: string; at: string } | null;
  relay?: RelayView;
  recording?: string | null;
  stats?: { frames: number; fps: number; bitrateKbps: number; droppedFrames: number; outTimeSeconds: number };
  legacyKeyConfigured?: boolean;
  session?: { sessionId?: string | null } | null;
}
export type UxState =
  | "disabled"
  | "streamer_unreachable"
  | "ready"
  | "starting"
  | "live"
  | "recording"
  | "retrying"
  | "failed"
  | "interrupted";
export interface StreamingAdminState {
  settings: StreamingSettings;
  platforms: { id: string; label: string; ingestUrl: string | null }[];
  ingests?: IngestsView[];
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
  /** VISIBILIDAD · autorizado para retransmisión (no exige bots públicos). */
  broadcastable?: boolean;
  broadcastBlockedReason?: "battle_not_public" | "tournament_not_broadcastable" | null;
  tournamentBroadcast?: boolean | null;
  /** @deprecated alias de `broadcastable`. */
  publicBroadcastable: boolean;
  delaySeconds: number;
  delaySource: "snapshot" | "ruleset" | "final_visible" | "none";
}
/** STREAMING-UX · elemento del selector de destinos (listStreamingDestinations). */
export interface Destination {
  kind: "battle" | "tournament";
  id: string;
  label: string;
  status: string;
  mode: string | null;
  tournamentName: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  broadcastable: boolean;
  broadcastBlockedReason: "battle_not_public" | "tournament_not_broadcastable" | null;
  tournamentBroadcast: boolean | null;
}
interface Recordings {
  dir: string;
  count: number;
  totalBytes: number;
  disk: { totalBytes: number; freeBytes: number } | null;
  dirError?: string | null;
  files: { name: string; sizeBytes: number; modifiedAt: string; inProgress: boolean }[];
}
interface AuditRow {
  id: string;
  actorId?: string;
  action: string;
  target: string;
  at: string;
}

// ── textos de estado (§11, lenguaje humano) ─────────────────────────────────
export const UX_TEXT: Record<UxState, { variant: StatusVariant; title: string; text: string }> = {
  disabled: {
    variant: "neutral",
    title: "Desactivado",
    text: "El streaming está desactivado. Actívalo para poder emitir o grabar.",
  },
  streamer_unreachable: {
    variant: "error",
    title: "Servicio no disponible",
    text: "El servicio de streaming no está disponible.",
  },
  ready: { variant: "ok", title: "Listo", text: "Listo para emitir. Nada se emite hasta que pulses «Iniciar»." },
  // EQ5d · emisión pedida y relé aún sin publicar: no es «En directo».
  starting: {
    variant: "warn",
    title: "Iniciando",
    text: "Conectando con la plataforma… Todavía no está en directo.",
  },
  live: { variant: "ok", title: "En directo", text: "Se está emitiendo." },
  recording: { variant: "ok", title: "Grabando", text: "Se está grabando un MP4 (sin emitir)." },
  retrying: {
    variant: "warn",
    title: "Reconectando",
    text: "Se cortó la conexión y se está reintentando automáticamente.",
  },
  failed: {
    variant: "error",
    title: "Error",
    text: "La emisión se detuvo tras varios intentos. Revisa el motivo y vuelve a iniciar.",
  },
  interrupted: {
    variant: "error",
    title: "Emisión interrumpida",
    text: "La emisión figura como activa pero el servicio no está emitiendo. Detenla y vuelve a iniciarla.",
  },
};

/** Texto del estado con el nombre del canal («Conectando con YouTube…»). */
export function uxText(ux: UxState, channel: string): string {
  if (ux === "starting") return `Conectando con ${channel}… Todavía no está en directo.`;
  if (ux === "live") return `Se está emitiendo en ${channel}.`;
  return UX_TEXT[ux].text;
}

export const IMPACT_TEXT: Record<"hot" | "restart" | "stop", string> = {
  hot: "se aplica al momento",
  restart: "se aplicará al reiniciar la emisión",
  stop: "detiene la emisión en curso",
};

// ── errores en lenguaje humano (§35, §36) ───────────────────────────────────
const TIMEOUT_RE = /no respondió|ETIMEDOUT|timeout|a tiempo/i;
export function humanReason(code: string | null | undefined, message: string | null | undefined, channel = "YouTube") {
  switch (code) {
    case "credential_missing":
      return `No hay una clave de ${channel} configurada.`;
    case "credential_stale":
    case "credential_unbound":
      return "La clave guardada ya no vale para este servidor: vuelve a introducirla en «Configuración avanzada».";
    case "streamer_unavailable":
    case "streamer_unreachable":
      return "El servicio de streaming no está disponible.";
    case "battle_not_public":
      return "Esta batalla no puede retransmitirse públicamente.";
    case "tournament_not_broadcastable":
      return "Esta batalla no puede retransmitirse públicamente: su torneo no tiene la retransmisión pública activada.";
    case "streaming_disabled":
      return "El streaming está desactivado.";
    case "already_active":
    case "streamer_busy":
      return "Ya hay una emisión en marcha. Detenla antes de iniciar otra.";
    case "disk_low":
      return "Queda poco espacio en disco para grabar.";
    case "disk_unknown":
    case "record_dir_unavailable":
      return "No se puede grabar: el disco de grabaciones no está disponible.";
    case "ingest_missing":
      return "Falta el servidor de emisión: configúralo en «Configuración avanzada».";
    case "backup_key_missing":
      return "La clave no está guardada para el servidor de respaldo: vuelve a introducirla.";
  }
  if (message && TIMEOUT_RE.test(message)) return `${channel} no respondió a la conexión.`;
  if (message && /certificado/i.test(message)) return `No se pudo verificar el certificado de ${channel}.`;
  if (message && /rechaz/i.test(message)) return `${channel} rechazó la emisión (¿la clave es correcta?).`;
  if (message && /conexión con la ingesta|ECONNREFUSED|ENETUNREACH/i.test(message))
    return `No se pudo conectar con ${channel}.`;
  return message || "Algo ha fallado.";
}

function TechDetails(props: { children: ReactNode; testId?: string }) {
  return (
    <details data-testid={props.testId}>
      <summary>Ver detalles técnicos</summary>
      <div style={{ fontSize: "0.9rem", opacity: 0.9 }}>{props.children}</div>
    </details>
  );
}

/** Error de una acción: frase humana y, plegado, el código y el mensaje técnicos. */
function HumanError(props: { error: unknown; channel: string; "data-testid"?: string }) {
  if (props.error === null || props.error === undefined) return null;
  const body = ((props.error as { body?: Record<string, unknown> })?.body ?? {}) as Record<string, unknown>;
  const code = typeof body.error === "string" ? body.error : null;
  const message =
    typeof body.message === "string" ? body.message : ((props.error as Error)?.message ?? String(props.error));
  return (
    <div role="alert" className="error" data-testid={props["data-testid"]} data-code={code ?? undefined}>
      <strong>{humanReason(code, message, props.channel)}</strong>
      <TechDetails>
        <p>
          Código: <code>{code ?? "—"}</code>
        </p>
        <p>{message}</p>
      </TechDetails>
    </div>
  );
}

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

// ── selector de destinos (§4, §6) ───────────────────────────────────────────
/** «hace 12 min», «hace 3 h», «hace 2 días». */
export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "hace un momento";
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} días`;
}

const STATUS_HUMAN: Record<string, string> = {
  running: "En curso",
  finished: "Finalizada",
  scheduled: "Programada",
  failed: "Fallida",
  open: "Inscripción abierta",
  closed: "Inscripción cerrada",
  draft: "Borrador",
  cancelled: "Cancelado",
};

/** Texto de una opción del selector: «Team A vs Team B · Finalizada · hace 12 min». */
export function destinationText(d: Destination, now = Date.now()): string {
  if (d.kind === "tournament") {
    const st =
      d.status === "running"
        ? "En curso"
        : d.status === "finished"
          ? "Terminado"
          : (STATUS_HUMAN[d.status] ?? d.status);
    return `${d.label} · ${st}`;
  }
  const st = STATUS_HUMAN[d.status] ?? d.status;
  const when = d.status === "running" ? relativeTime(d.startedAt, now) : relativeTime(d.finishedAt ?? d.createdAt, now);
  return [d.label, st, when].filter(Boolean).join(" · ") + (d.broadcastable ? "" : " · No retransmisible");
}

/** §6 · Explicación humana de si un destino se puede retransmitir. */
export function eligibilityText(
  d: Pick<Destination, "kind" | "broadcastable" | "broadcastBlockedReason" | "tournamentBroadcast">,
): string {
  if (d.broadcastable) {
    if (d.kind === "tournament") {
      return d.tournamentBroadcast
        ? "Retransmisible: torneo con retransmisión pública. Se emiten todas sus batallas."
        : "Retransmisible: se emiten las batallas del torneo que son públicas.";
    }
    return d.tournamentBroadcast
      ? "Retransmisible: pertenece a un torneo con retransmisión pública. Los bots privados salen sólo con su nombre, versión, equipo y resultado; su ficha y su código siguen privados."
      : "Retransmisible: todos sus bots son públicos.";
  }
  return d.broadcastBlockedReason === "tournament_not_broadcastable"
    ? "No retransmisible: esta batalla no puede retransmitirse porque contiene bots privados y su torneo se creó sin retransmisión pública."
    : "No retransmisible: esta batalla no puede retransmitirse porque contiene bots privados y no pertenece a un torneo con retransmisión pública.";
}

// ── canal y calidad (§3, §32, §33) ──────────────────────────────────────────
/**
 * Opción del selector «Canal». Hoy sale de las plataformas configuradas (y «Sólo
 * grabar»); el siguiente carril («user streaming profiles») añadirá perfiles con su
 * propio `id` sin cambiar la vista.
 */
export interface ChannelOption {
  id: string;
  label: string;
  mode: "rtmps" | "record";
  platform: string | null;
  /** Lista para emitir (clave configurada y válida, o grabación). */
  ready: boolean;
  /** Estado en lenguaje humano: «Clave configurada · ****ABCD», «Sin clave»… */
  detail: string;
}

export function channelOptions(st: StreamingAdminState): ChannelOption[] {
  const out: ChannelOption[] = st.platforms.map((p) => {
    const c = st.credentials.find((x) => x.platform === p.id);
    const ok = !!c?.configured && c.compatible !== false;
    return {
      id: `platform:${p.id}`,
      label: p.label,
      mode: "rtmps" as const,
      platform: p.id,
      ready: ok,
      detail: !c?.configured
        ? "Sin clave de emisión"
        : c.compatible === false
          ? "La clave hay que volver a introducirla"
          : `Clave configurada · ${c.masked}`,
    };
  });
  out.push({
    id: "record",
    label: "Sólo grabar (MP4)",
    mode: "record",
    platform: null,
    ready: true,
    detail: "Graba sin emitir",
  });
  return out;
}

function currentChannelId(s: StreamingSettings): string {
  return s.mode === "record" ? "record" : `platform:${s.platform}`;
}

export const QUALITY_PRESETS = [
  { id: "1080p@30", label: "1080p · 30 FPS", preset: "1080p", fps: 30 },
  { id: "720p@30", label: "720p · 30 FPS", preset: "720p", fps: 30 },
  { id: "1080p@60", label: "1080p · 60 FPS", preset: "1080p", fps: 60 },
  { id: "720p@60", label: "720p · 60 FPS", preset: "720p", fps: 60 },
] as const;

const POLL_MS = 3000;
type Section = "streaming" | "advanced" | "recordings" | "audit";
const SECTIONS: { id: Section; label: string }[] = [
  { id: "streaming", label: "Streaming" },
  { id: "advanced", label: "Configuración avanzada" },
  { id: "recordings", label: "Grabaciones" },
  { id: "audit", label: "Auditoría" },
];

function initialSection(route: string): Section {
  const t = new URLSearchParams(route.split("?")[1] ?? "").get("tab");
  return SECTIONS.some((s) => s.id === t) ? (t as Section) : "streaming";
}

export function StreamingPage(props: { me: Me; route: string }) {
  const [st, setSt] = useState<StreamingAdminState | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [section, setSection] = useState<Section>(() => initialSection(props.route));
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

  const channel =
    st.settings.mode === "record"
      ? "la grabación"
      : (st.platforms.find((p) => p.id === st.settings.platform)?.label ?? "la plataforma");
  return (
    <div data-testid="streaming-page" className="streaming-layout">
      <nav aria-label="Secciones de streaming" className="streaming-nav" data-testid="streaming-nav">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            data-testid={`streaming-tab-${s.id}`}
            aria-current={section === s.id ? "page" : undefined}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <div style={{ minWidth: 0 }}>
        <div className="card">
          <h2>
            {SECTIONS.find((s) => s.id === section)!.label === "Streaming"
              ? "Streaming"
              : SECTIONS.find((s) => s.id === section)!.label}
          </h2>
          <LiveStatus data-testid="streaming-state" busy={st.uxState === "retrying" || st.uxState === "starting"}>
            <span
              aria-hidden="true"
              className={UX_TEXT[st.uxState].variant === "neutral" ? undefined : UX_TEXT[st.uxState].variant}
            >
              ●{" "}
            </span>
            <StatusBadge variant={UX_TEXT[st.uxState].variant} data-testid="streaming-ux-state">
              {UX_TEXT[st.uxState].title}
            </StatusBadge>{" "}
            {uxText(st.uxState, channel)}
          </LiveStatus>
          {!st.capabilities.sealedStore && (
            <p className="warn" role="status" data-testid="sealed-store-missing">
              No hay almacén seguro de claves en esta instalación: no se pueden guardar claves de emisión (sólo es
              posible grabar).
            </p>
          )}
          {st.pendingRestart && (
            <p className="warn" role="status" data-testid="pending-restart">
              Hay cambios guardados que la emisión en curso aún no usa. Se aplicarán al pulsar «Reiniciar emisión»
              (corte de unos segundos).
            </p>
          )}
          {notice && (
            <p className="ok" role="status" data-testid="streaming-notice">
              {notice}
            </p>
          )}
          <HumanError error={actionError} channel={channel} data-testid="streaming-error" />
          <p style={{ marginBottom: 0 }}>
            <small>
              <a href={helpHref("administracion", "streaming")}>Ayuda de Streaming</a>
            </small>
          </p>
        </div>

        {section === "streaming" && (
          <SimpleView
            st={st}
            route={props.route}
            busy={busy}
            act={act}
            channel={channel}
            onAdvanced={() => setSection("advanced")}
          />
        )}
        {section === "advanced" && (
          <>
            <ManualTargetCard st={st} route={props.route} busy={busy} act={act} />
            <SettingsCard key={`s${st.settings.version}`} st={st} busy={busy} act={act} />
            <IngestsCard
              key={`i${st.settings.version}-${JSON.stringify(st.ingests ?? [])}`}
              st={st}
              busy={busy}
              act={act}
            />
            <CredentialsCard st={st} busy={busy} act={act} />
            <BrandingCard key={`b${st.settings.version}`} st={st} busy={busy} act={act} />
            <MonitorCard st={st} />
          </>
        )}
        {section === "recordings" && <RecordingsCard key={`r${st.settings.version}`} st={st} busy={busy} act={act} />}
        {section === "audit" && <AuditCard version={st.settings.version * 100000 + actions} />}
      </div>
    </div>
  );
}

type Act = (name: string, fn: () => Promise<string | void>) => Promise<void>;

function isActive(st: StreamingAdminState): boolean {
  return st.uxState === "starting" || st.uxState === "live" || st.uxState === "recording" || st.uxState === "retrying";
}

/** Botón de inicio común (vista simple y destino manual). */
async function startTo(target: { kind: string; id: string }, mode: string): Promise<string> {
  const r = await api<{ alreadyActive: boolean }>("POST", "/admin/streaming/start", {
    target: { kind: target.kind, id: target.id },
  });
  if (r.alreadyActive) return "Ya estaba activa con este destino.";
  return mode === "record" ? "Grabación iniciada." : "Emisión iniciada: conectando…";
}

function stopNow(act: Act, mode: string) {
  const label = mode === "record" ? "Detener grabación" : "Detener emisión";
  if (!window.confirm(`¿${label}? Se corta lo que se está emitiendo.`)) return;
  void act("stop", async () => {
    await api("POST", "/admin/streaming/stop", {});
    return "Detenida.";
  });
}

// ── vista simple (§3, §12, §13) ─────────────────────────────────────────────
function SimpleView(props: {
  st: StreamingAdminState;
  route: string;
  busy: string | null;
  act: Act;
  channel: string;
  onAdvanced: () => void;
}) {
  const { st, busy, act } = props;
  const active = isActive(st);
  if (active || st.session) return <LiveView {...props} />;
  return <ReadyView {...props} />;
}

function ReadyView(props: {
  st: StreamingAdminState;
  route: string;
  busy: string | null;
  act: Act;
  channel: string;
  onAdvanced: () => void;
}) {
  const { st, busy, act } = props;
  const pre = preselectedTarget(props.route);
  const [kind, setKind] = useState<"battle" | "tournament">(pre?.kind ?? "battle");
  const [list, setList] = useState<{ battles: Destination[]; tournaments: Destination[] } | null>(null);
  const [listError, setListError] = useState<unknown>(null);
  const [selected, setSelected] = useState<string>(pre ? `${pre.kind}:${pre.id}` : "");
  const [extra, setExtra] = useState<Destination | null>(null);

  const load = useCallback(async () => {
    try {
      setList(
        await api<{ battles: Destination[]; tournaments: Destination[] }>(
          "GET",
          "/admin/streaming/destinations?limit=30",
        ),
      );
      setListError(null);
    } catch (e) {
      setListError(e);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // «Retransmitir» desde una batalla o torneo: si no está entre los recientes, se
  // comprueba (lectura) y se añade al selector. Nunca arranca nada.
  const preKey = pre ? `${pre.kind}:${pre.id}` : "";
  useEffect(() => {
    if (!pre || !list) return;
    const all = [...list.battles, ...list.tournaments];
    if (all.some((d) => `${d.kind}:${d.id}` === preKey)) return;
    void api<TargetInfo>("GET", `/admin/streaming/target?kind=${pre.kind}&id=${encodeURIComponent(pre.id)}`)
      .then((t) =>
        setExtra({
          kind: t.kind,
          id: t.id,
          label: t.label,
          status: t.status,
          mode: null,
          tournamentName: null,
          startedAt: null,
          finishedAt: null,
          createdAt: new Date().toISOString(),
          broadcastable: !!(t.broadcastable ?? t.publicBroadcastable),
          broadcastBlockedReason: t.broadcastBlockedReason ?? null,
          tournamentBroadcast: t.tournamentBroadcast ?? null,
        }),
      )
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preKey, list]);

  const options = useMemo(() => {
    const base = kind === "battle" ? (list?.battles ?? []) : (list?.tournaments ?? []);
    return extra && extra.kind === kind && !base.some((d) => d.id === extra.id) ? [extra, ...base] : base;
  }, [list, kind, extra]);
  const dest = options.find((d) => `${d.kind}:${d.id}` === selected) ?? null;

  const channels = channelOptions(st);
  const channelId = currentChannelId(st.settings);
  const ch = channels.find((c) => c.id === channelId);
  const quality = `${st.settings.preset}@${st.settings.fps}`;

  const blockers: string[] = [];
  if (!st.settings.enabled) blockers.push("El streaming está desactivado.");
  if (!st.capabilities.streamerReachable) blockers.push("El servicio de streaming no está disponible.");
  if (!dest) blockers.push(kind === "battle" ? "Elige una batalla." : "Elige un torneo.");
  else if (!dest.broadcastable) blockers.push("Este destino no se puede retransmitir.");
  if (ch && !ch.ready)
    blockers.push(st.settings.mode === "rtmps" ? `No hay una clave de ${props.channel} configurada.` : "");
  const canStart = blockers.filter(Boolean).length === 0;

  function changeChannel(id: string) {
    const c = channels.find((x) => x.id === id);
    if (!c) return;
    const patch: Record<string, unknown> = { version: st.settings.version, mode: c.mode };
    if (c.platform) patch.platform = c.platform;
    void act("channel", async () => {
      await api("PUT", "/admin/streaming/settings", patch);
      return `Canal: ${c.label}.`;
    });
  }
  function changeQuality(id: string) {
    const q = QUALITY_PRESETS.find((x) => x.id === id);
    if (!q) return;
    const patch: Record<string, unknown> = {
      version: st.settings.version,
      preset: q.preset,
      fps: q.fps,
      videoBitrateKbps: recommendation(q.preset, q.fps).recommended,
    };
    if (q.fps === 60 && st.settings.fps !== 60) {
      if (!window.confirm("60 FPS dobla el coste de CPU y el ancho de banda. ¿Seguro?")) return;
      patch.confirmHighFps = true;
    }
    void act("quality", async () => {
      await api("PUT", "/admin/streaming/settings", patch);
      return `Calidad: ${q.label}.`;
    });
  }

  return (
    <div className="card" data-testid="streaming-simple">
      <h3>Retransmitir</h3>
      {!st.settings.enabled && (
        <p>
          <button
            type="button"
            data-testid="simple-enable"
            disabled={busy !== null}
            onClick={() =>
              void act("enable", async () => {
                await api("PUT", "/admin/streaming/settings", { version: st.settings.version, enabled: true });
                return "Streaming activado.";
              })
            }
          >
            Activar streaming
          </button>
        </p>
      )}
      <div className="streaming-field">
        <label htmlFor="simple-kind">Tipo</label>
        <select
          id="simple-kind"
          data-testid="simple-kind"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as "battle" | "tournament");
            setSelected("");
          }}
        >
          <option value="battle">Batalla</option>
          <option value="tournament">Torneo</option>
        </select>
      </div>
      <div className="streaming-field">
        <label htmlFor="simple-destination">{kind === "battle" ? "Batalla" : "Torneo"}</label>
        <select
          id="simple-destination"
          data-testid="simple-destination"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="">
            {list ? (options.length ? "— Elige —" : "No hay nada que retransmitir") : "Cargando…"}
          </option>
          {options.map((d) => (
            <option key={d.id} value={`${d.kind}:${d.id}`} data-broadcastable={d.broadcastable ? "1" : "0"}>
              {destinationText(d)}
            </option>
          ))}
        </select>
        {listError ? <FormError error={listError} /> : null}
      </div>
      {dest && (
        <div data-testid="stream-target-info">
          <p
            data-testid={dest.broadcastable ? "simple-broadcastable" : "stream-target-private"}
            data-reason={dest.broadcastBlockedReason ?? undefined}
            className={dest.broadcastable ? "ok" : "error"}
            role={dest.broadcastable ? undefined : "alert"}
          >
            {eligibilityText(dest)}
          </p>
          <TechDetails testId="simple-target-tech">
            <p>
              {dest.kind} <code data-testid="simple-target-id">{dest.id}</code>
            </p>
            {dest.broadcastBlockedReason && (
              <p>
                Motivo: <code>{dest.broadcastBlockedReason}</code>
              </p>
            )}
          </TechDetails>
        </div>
      )}
      <div className="streaming-field">
        <label htmlFor="simple-channel">Canal</label>
        <select
          id="simple-channel"
          data-testid="simple-channel"
          value={channelId}
          disabled={busy !== null}
          onChange={(e) => changeChannel(e.target.value)}
        >
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <small data-testid="channel-status" className={ch?.ready ? "ok" : "warn"}>
          {ch?.detail}
          {ch && !ch.ready && (
            <>
              {" "}
              ·{" "}
              <a
                href="#/streaming?tab=advanced"
                onClick={(e) => {
                  e.preventDefault();
                  props.onAdvanced();
                }}
              >
                Configurar la clave
              </a>
            </>
          )}
        </small>
      </div>
      <div className="streaming-field">
        <label htmlFor="simple-quality">Calidad</label>
        <select
          id="simple-quality"
          data-testid="simple-quality"
          value={quality}
          disabled={busy !== null}
          onChange={(e) => changeQuality(e.target.value)}
        >
          {QUALITY_PRESETS.map((q) => (
            <option key={q.id} value={q.id}>
              {q.label}
            </option>
          ))}
        </select>
      </div>
      <p>
        <button
          type="button"
          className="streaming-big start"
          data-testid="stream-start"
          disabled={busy !== null || !canStart}
          onClick={() => void act("start", () => startTo(dest!, st.settings.mode))}
        >
          {st.settings.mode === "record" ? "INICIAR GRABACIÓN" : "INICIAR EMISIÓN"}
        </button>
      </p>
      {!canStart && (
        <ul data-testid="start-blockers" className="warn">
          {blockers.filter(Boolean).map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
      <p>
        <a
          href="#/streaming?tab=advanced"
          data-testid="simple-advanced-link"
          onClick={(e) => {
            e.preventDefault();
            props.onAdvanced();
          }}
        >
          Configuración avanzada &gt;
        </a>
      </p>
      <p>
        <small data-testid="replay-note">
          Las batallas finalizadas se emiten con su pantalla de resultado; la reproducción completa (replay) aún no se
          puede emitir.
        </small>
      </p>
    </div>
  );
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${hh > 0 ? `${hh}:` : ""}${String(mm).padStart(hh > 0 ? 2 : 1, "0")}:${String(ss).padStart(2, "0")}`;
}

/** §12, §13 · Vista en directo: lo esencial y DETENER siempre a la vista. */
function LiveView(props: { st: StreamingAdminState; busy: string | null; act: Act; channel: string }) {
  const { st, busy, act } = props;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const [label, setLabel] = useState<string | null>(null);
  const target = st.session?.target ?? null;
  useEffect(() => {
    if (!target) return;
    void api<TargetInfo>("GET", `/admin/streaming/target?kind=${target.kind}&id=${encodeURIComponent(target.id)}`)
      .then((t) => setLabel(t.label))
      .catch(() => setLabel(null));
  }, [target?.kind, target?.id]);
  const s = st.streamer;
  const relay = s?.relay;
  const record = st.session?.mode === "record" || st.uxState === "recording";
  const live = st.uxState === "live" || st.uxState === "recording";
  const quality = `${st.settings.preset} · ${st.settings.fps} FPS`;
  const failed = st.uxState === "failed" || st.uxState === "interrupted";
  const errs = relay?.ingestErrors;
  return (
    <div className="card" data-testid="streaming-live">
      <div className="streaming-live-bar">
        <strong data-testid="live-badge" className={live ? "error" : "warn"} style={{ fontSize: "1.3rem" }}>
          ●{" "}
          {record
            ? "GRABANDO"
            : st.uxState === "live"
              ? "EN DIRECTO"
              : failed
                ? "DETENIDA POR ERROR"
                : st.uxState === "retrying"
                  ? "RECONECTANDO"
                  : "CONECTANDO…"}
        </strong>
        <button
          type="button"
          className="streaming-big stop"
          data-testid="stream-stop"
          disabled={busy !== null}
          onClick={() => stopNow(act, record ? "record" : "rtmps")}
        >
          {record ? "DETENER GRABACIÓN" : "DETENER EMISIÓN"}
        </button>
      </div>
      {failed && (
        <div role="alert" className="error" data-testid="live-failure">
          <strong>
            {humanReason(null, s?.lastError?.message ?? "", props.channel) ||
              `No se pudo conectar con ${props.channel}`}
          </strong>
          {errs && (errs.primary || errs.backup) && (
            <p data-testid="live-failure-ingests">
              Principal: {errs.primary ? humanReason(null, errs.primary, props.channel) : "OK"}
              {relay?.backupAvailable
                ? ` / Respaldo: ${errs.backup ? humanReason(null, errs.backup, props.channel) : "sin probar"}`
                : ""}
            </p>
          )}
        </div>
      )}
      <div className="streaming-facts">
        <div>
          <span>Destino</span>
          <strong data-testid="live-destination">
            {label ?? (target ? (target.kind === "battle" ? "Batalla" : "Torneo") : "—")}
          </strong>
        </div>
        <div>
          <span>Canal</span>
          <strong data-testid="live-channel">{record ? "Grabación local" : props.channel}</strong>
        </div>
        <div>
          <span>Calidad</span>
          <strong>{quality}</strong>
        </div>
        <div>
          <span>Duración</span>
          <strong data-testid="live-duration">
            {st.session ? fmtDuration(now - new Date(st.session.startedAt).getTime()) : "—"}
          </strong>
        </div>
        <div>
          <span>FPS · bitrate</span>
          <strong data-testid="mon-rate">
            {s?.stats ? `${s.stats.fps} fps · ${Math.round(s.stats.bitrateKbps)} kbit/s` : "—"}
          </strong>
        </div>
        <div>
          <span>Frames descartados</span>
          <strong data-testid="live-dropped">{s?.stats ? s.stats.droppedFrames : "—"}</strong>
        </div>
        <div>
          <span>Reintentos</span>
          <strong>{s?.restarts ?? 0}</strong>
        </div>
        {!record && (
          <div>
            <span>Ingesta activa</span>
            <strong data-testid="active-ingest">{relay?.ingest === "backup" ? "Respaldo" : "Principal"}</strong>
          </div>
        )}
      </div>
      {!record && relay?.failedOver && (
        <p className="warn" data-testid="failover-notice">
          Principal no disponible · Usando servidor de respaldo
        </p>
      )}
      {st.pendingRestart && (
        <p>
          <button
            type="button"
            data-testid="stream-restart"
            disabled={busy !== null || !st.session}
            onClick={() =>
              void act("restart", async () => {
                await api("POST", "/admin/streaming/restart", {});
                return "Reiniciada con la configuración guardada.";
              })
            }
          >
            Reiniciar emisión (aplica los cambios guardados)
          </button>
        </p>
      )}
      <TechDetails testId="live-tech">
        <MonitorTable st={st} />
      </TechDetails>
    </div>
  );
}

function MonitorTable({ st }: { st: StreamingAdminState }) {
  const s = st.streamer;
  if (!s)
    return <p>Sin datos del streamer{st.capabilities.streamerError ? `: ${st.capabilities.streamerError}` : ""}.</p>;
  const rows: [string, ReactNode, string?][] = [
    ["Estado interno del streamer", s.state, "mon-state"],
    ["Relé RTMP", s.relay?.state ?? "—", "mon-relay"],
    ["Ingesta (URL, sin clave)", s.target ?? "—", "mon-target"],
    ["Ingesta activa", s.relay?.ingest ?? "—"],
    ["Error de la principal", s.relay?.ingestErrors?.primary ?? "—"],
    ["Error del respaldo", s.relay?.ingestErrors?.backup ?? "—"],
    ["Frames", s.stats ? `${s.stats.frames} (${s.stats.droppedFrames} descartados)` : "—"],
    ["Sesión", st.session?.id ?? "—", "mon-session"],
    ["Grabación en curso", s.recording ?? "—"],
    [
      "Último error",
      s.lastError ? `${s.lastError.message} (${new Date(s.lastError.at).toLocaleString("es-ES")})` : "—",
      "mon-last-error",
    ],
  ];
  return (
    <table className="stack-table">
      <tbody>
        {rows.map(([k, v, id]) => (
          <tr key={k}>
            <th scope="row">{k}</th>
            <td data-label={k} data-testid={id}>
              {v}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Avanzada → Diagnóstico: la tabla técnica completa. */
function MonitorCard({ st }: { st: StreamingAdminState }) {
  return (
    <div className="card" data-testid="streaming-monitor">
      <h3>Diagnóstico</h3>
      <MonitorTable st={st} />
    </div>
  );
}

/** Avanzada → Destino manual (UUID): el único sitio donde se escribe un UUID (§5). */
function ManualTargetCard(props: { st: StreamingAdminState; route: string; busy: string | null; act: Act }) {
  const { st, act, busy } = props;
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
    if (pre && checked.current !== `${pre.kind}:${pre.id}`) {
      checked.current = `${pre.kind}:${pre.id}`;
      void check(pre.kind, pre.id);
    }
  }, [pre, check]);
  const active = isActive(st);
  const cred = st.credentials.find((c) => c.platform === st.settings.platform);
  const credOk = st.settings.mode === "record" || !!cred?.configured;
  const ok = !!(target?.broadcastable ?? target?.publicBroadcastable);
  const canStart = st.settings.enabled && st.capabilities.streamerReachable && !active && !st.session && ok && credOk;
  return (
    <div className="card" data-testid="streaming-controls">
      <h3>Destino manual</h3>
      <p>
        <small>Sólo si el destino no aparece en el selector de «Streaming». Se escribe su identificador (UUID).</small>
      </p>
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
        <div data-testid="manual-target-info">
          <p>
            <strong>{target.label}</strong> · {STATUS_HUMAN[target.status] ?? target.status}
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
          <p
            className={ok ? "ok" : "error"}
            data-testid="manual-target-eligibility"
            data-reason={target.broadcastBlockedReason ?? undefined}
          >
            {eligibilityText({
              kind: target.kind,
              broadcastable: ok,
              broadcastBlockedReason: target.broadcastBlockedReason ?? null,
              tournamentBroadcast: target.tournamentBroadcast ?? null,
            })}
          </p>
          <p>
            <button
              type="button"
              data-testid="manual-start"
              disabled={busy !== null || !canStart}
              onClick={() => void act("start", () => startTo(target, st.settings.mode))}
            >
              Iniciar con este destino
            </button>
          </p>
        </div>
      )}
    </div>
  );
}

/** Avanzada → Servidores de YouTube (o de la plataforma): principal y respaldo (§16-§21, §26). */
function IngestsCard({ st, busy, act }: { st: StreamingAdminState; busy: string | null; act: Act }) {
  const platform = st.settings.platform;
  const ing = st.ingests?.find((i) => i.platform === platform) ?? null;
  const label = st.platforms.find((p) => p.id === platform)?.label ?? platform;
  const [primary, setPrimary] = useState(ing?.primaryIngestUrl ?? "");
  const [backup, setBackup] = useState(ing?.backupIngestUrl ?? "");
  const [test, setTest] = useState<{
    primary: { ok: boolean; error?: string; connectMs?: number };
    backup: { ok: boolean; error?: string; code?: string; connectMs?: number } | null;
  } | null>(null);
  const cred = st.credentials.find((c) => c.platform === platform);
  if (st.settings.mode !== "rtmps") return null;
  const line = (r: { ok: boolean; error?: string; connectMs?: number } | null) =>
    !r
      ? "sin respaldo configurado"
      : r.ok
        ? `OK (${r.connectMs ?? "?"} ms)`
        : humanReason((r as { code?: string }).code ?? null, r.error ?? "", label);
  return (
    <div className="card" data-testid="streaming-ingests">
      <h3>Servidores de {label}</h3>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void act("ingests", async () => {
            const r = await api<{ warnings: string[]; changed: boolean }>(
              "PUT",
              `/admin/streaming/ingests/${platform}`,
              {
                primaryIngestUrl: primary,
                backupIngestUrl: backup || null,
              },
            );
            return r.changed
              ? `Servidores guardados.${r.warnings.length ? ` ${r.warnings.join(" ")}` : ""}`
              : "Sin cambios.";
          });
        }}
      >
        <div className="streaming-field">
          <label htmlFor="ing-primary">Servidor principal</label>
          <input
            id="ing-primary"
            data-testid="ing-primary"
            value={primary}
            onChange={(e) => setPrimary(e.target.value)}
            placeholder="rtmps://servidor/aplicacion"
          />
        </div>
        <div className="streaming-field">
          <label htmlFor="ing-backup">Servidor de respaldo (opcional)</label>
          <input
            id="ing-backup"
            data-testid="ing-backup"
            value={backup}
            onChange={(e) => setBackup(e.target.value)}
            placeholder={
              ing?.backupQueryAllowed ? "rtmps://servidor/aplicacion?backup=1" : "rtmps://servidor/aplicacion"
            }
          />
          <small>
            Se guardan tal cual, sin la clave.{" "}
            {ing?.backupQueryAllowed
              ? "En YouTube, el respaldo lleva «?backup=1»; no se admite ninguna otra query."
              : "Sin query."}
            {cred?.configured && cred.backup === "needs_key" && (
              <strong className="warn" data-testid="backup-needs-key">
                {" "}
                Para usar el respaldo, vuelve a introducir la clave.
              </strong>
            )}
          </small>
        </div>
        <p>
          <button type="submit" data-testid="ing-save" disabled={busy !== null || !primary}>
            Guardar servidores
          </button>{" "}
          <button
            type="button"
            data-testid="stream-test"
            disabled={busy !== null || !cred?.configured || !st.capabilities.streamerReachable}
            onClick={() =>
              void act("test", async () => {
                setTest(null);
                const r = await api<{
                  ok: boolean;
                  error?: string;
                  connectMs?: number;
                  primary?: { ok: boolean; error?: string; connectMs?: number };
                  backup?: { ok: boolean; error?: string; code?: string } | null;
                }>("POST", "/admin/streaming/test", {});
                const res = {
                  primary: r.primary ?? { ok: r.ok, error: r.error, connectMs: r.connectMs },
                  backup: r.backup ?? null,
                };
                setTest(res);
                return res.primary.ok
                  ? `Prueba correcta: TLS verificado y conexión RTMP en ${res.primary.connectMs} ms (la clave no se valida sin publicar).`
                  : `La prueba falló: ${humanReason(null, res.primary.error ?? "", label)}`;
              })
            }
          >
            Probar ingesta
          </button>
        </p>
      </form>
      {test && (
        <p data-testid="ingest-test-result">
          <span data-testid="ingest-test-primary">Principal: {line(test.primary)}</span>
          {" / "}
          <span data-testid="ingest-test-backup">Respaldo: {line(test.backup)}</span>
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
      <h3>Emisión: activación, plataforma, modo y codificación</h3>
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
      <h3>Clave de emisión</h3>
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
          {meta?.configured ? `Configurada · ${meta.masked}` : "No configurada"}
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
          {meta?.configured ? "Reemplazar clave" : "Guardar clave"}
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
