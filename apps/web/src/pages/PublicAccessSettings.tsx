/**
 * MG · Administración → «Acceso público / Broadcast». Dos interruptores (espectador
 * público y replays públicos) que se guardan EN CALIENTE (PATCH
 * /admin/settings/public-access, sin recrear servicios), y el estado EFECTIVO con su
 * motivo. La UI sólo muestra lo que la API devuelve: no calcula nada por su cuenta, y la
 * autorización la hace la API (sólo admin).
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { FormError } from "../ui/primitives.js";

export interface PublicAccessSettingsView {
  publicSpectateEnabled: boolean;
  publicReplaysEnabled: boolean;
  source: "database" | "environment" | "unavailable";
  updatedAt: string | null;
  updatedBy: string | null;
  propagationMaxMs: number;
  effective: {
    publicSpectate: boolean;
    publicReplays: boolean;
    broadcastLiveAvailable: boolean;
    reason: string | null;
  };
}

/** Motivo legible (mismos códigos que getStreamingTarget). */
export function broadcastReasonText(reason: string | null | undefined): string {
  switch (reason) {
    case null:
    case undefined:
      return "";
    case "public_spectate_disabled":
      return "El espectador público está desactivado: /broadcast no puede mostrar batallas en directo.";
    case "public_replays_disabled":
      return "Los replays públicos están desactivados: /broadcast no puede mostrar una batalla ya terminada.";
    case "battle_not_public":
      return "La batalla tiene bots no públicos y no es de un torneo con retransmisión pública.";
    case "tournament_not_broadcastable":
      return "La batalla tiene bots no públicos y su torneo se creó sin retransmisión pública.";
    case "battle_not_started":
      return "La batalla aún no ha empezado: /broadcast mostrará la espera y la verá cuando empiece.";
    case "battle_not_available":
      return "La batalla no está disponible (fallida o revertida): no se puede retransmitir.";
    case "target_not_available":
      return "El torneo está cancelado.";
    case "streaming_not_configured":
      return "No hay servicio de streaming configurado en este despliegue.";
    default:
      return "La página pública no puede leer este destino.";
  }
}

/** Una respuesta con otra forma (API antigua, proxy) no tumba el panel: se trata como error. */
function validView(v: unknown): PublicAccessSettingsView {
  const o = v as PublicAccessSettingsView | null;
  if (
    !o ||
    typeof o.publicSpectateEnabled !== "boolean" ||
    typeof o.publicReplaysEnabled !== "boolean" ||
    !o.effective ||
    typeof o.effective.broadcastLiveAvailable !== "boolean"
  ) {
    throw new Error("Respuesta inesperada de /admin/settings/public-access");
  }
  return o;
}

const SWITCHES: { key: "publicSpectateEnabled" | "publicReplaysEnabled"; label: string; help: string }[] = [
  {
    key: "publicSpectateEnabled",
    label: "Espectador público (batallas en directo sin cuenta)",
    help: "Necesario para retransmitir batallas en directo por /broadcast.",
  },
  {
    key: "publicReplaysEnabled",
    label: "Replays públicos (batallas terminadas sin cuenta)",
    help: "Necesario para que /broadcast muestre la pantalla final de una batalla terminada.",
  },
];

export function PublicAccessSettings() {
  const [view, setView] = useState<PublicAccessSettingsView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<PublicAccessSettingsView>("GET", "/admin/settings/public-access")
      // Recarga tras un fallo: se pinta lo guardado, pero el error SIGUE a la vista.
      .then((v) => setView(validView(v)))
      .catch((e) => setError(e));
  }, []);
  useEffect(load, [load]);

  async function toggle(key: "publicSpectateEnabled" | "publicReplaysEnabled", value: boolean) {
    setBusy(true);
    try {
      // Lo que se pinta es la RESPUESTA (estado real guardado), no el valor pedido.
      setView(validView(await api<unknown>("PATCH", "/admin/settings/public-access", { [key]: value })));
      setError(null);
    } catch (e) {
      setError(e);
      load();
    } finally {
      setBusy(false);
    }
  }

  const live = view?.effective.broadcastLiveAvailable ?? false;
  return (
    <div className="card" data-testid="public-access-settings">
      <h2>Acceso público / Broadcast</h2>
      {!view && !error && <p>Cargando…</p>}
      {view && (
        <>
          {SWITCHES.map((s) => (
            <p key={s.key}>
              <label>
                <input
                  type="checkbox"
                  data-testid={`toggle-${s.key}`}
                  checked={view[s.key]}
                  disabled={busy}
                  onChange={(e) => void toggle(s.key, e.target.checked)}
                />{" "}
                {s.label}
              </label>
              <br />
              <small>{s.help}</small>
            </p>
          ))}
          <p
            data-testid="public-access-effective"
            data-available={live ? "1" : "0"}
            data-reason={view.effective.reason ?? undefined}
            className={live ? "ok" : "error"}
            role={live ? undefined : "alert"}
          >
            {live
              ? "Estado efectivo: /broadcast puede retransmitir batallas en directo públicas."
              : `Estado efectivo: no se puede retransmitir en directo. ${broadcastReasonText(view.effective.reason)}`}
          </p>
          <p>
            <small data-testid="public-access-meta">
              Espectador público: {view.effective.publicSpectate ? "activado" : "desactivado"} · Replays públicos:{" "}
              {view.effective.publicReplays ? "activados" : "desactivados"} · Origen:{" "}
              {view.source === "database"
                ? "guardado en la aplicación"
                : view.source === "unavailable"
                  ? "sin lectura válida de la base de datos (acceso público cerrado)"
                  : "entorno (.env)"}
              {view.updatedAt ? ` · Último cambio: ${new Date(view.updatedAt).toLocaleString()}` : ""} · Los demás
              servicios lo aplican en ≤ {Math.ceil(view.propagationMaxMs / 1000)} s, sin reiniciar.
            </small>
          </p>
        </>
      )}
      <FormError error={error} data-testid="public-access-error" />
    </div>
  );
}
