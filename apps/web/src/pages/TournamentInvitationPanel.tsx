/**
 * V1 · TORNEOS POR INVITACIÓN (D-OP-43) · panel del organizador en la ficha del torneo.
 *
 * Sólo se monta si la API dice `viewerCanManage` (dueño del torneo o staff) y el torneo está en
 * `draft`/`open`; la API vuelve a autorizar cada acción. Permite:
 *  - cambiar la modalidad (abierta / por invitación);
 *  - GENERAR un enlace: la API devuelve el token UNA vez; aquí se enseña con «Copiar». No se puede
 *    volver a leer: para copiarlo otra vez se genera uno nuevo y el anterior deja de valer;
 *  - REVOCAR el enlace: deja de valer al momento; las inscripciones ya hechas se mantienen.
 */
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { invitationLink } from "../tournament-invitation.js";

export type Enrollment = "open" | "invitation";

export const ENROLLMENT_NAME: Record<Enrollment, string> = {
  open: "Abierta",
  invitation: "Por invitación",
};

interface InvitationStatus {
  active: boolean;
  createdAt?: string;
}

export function TournamentInvitationPanel(props: {
  tournamentId: string;
  enrollment: Enrollment;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<InvitationStatus | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/tournaments/${encodeURIComponent(props.tournamentId)}`;

  useEffect(() => {
    setLink(null);
    if (props.enrollment !== "invitation") {
      setStatus(null);
      return;
    }
    let alive = true;
    api<InvitationStatus>("GET", `${base}/invitation`).then(
      (s) => alive && setStatus(s),
      () => alive && setStatus(null),
    );
    return () => {
      alive = false;
    };
  }, [base, props.enrollment]);

  async function run(fn: () => Promise<void>) {
    setMsg(null);
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setMsg({ kind: "error", text: (err as Error).message || "no se pudo completar la acción" });
    } finally {
      setBusy(false);
    }
  }

  const setEnrollment = (enrollment: Enrollment) =>
    run(async () => {
      await api("PUT", `${base}/enrollment`, { enrollment });
      setMsg({
        kind: "ok",
        text:
          enrollment === "invitation"
            ? "Inscripción por invitación: genera un enlace y compártelo con quien quieras invitar"
            : "Inscripción abierta: cualquiera con cuenta puede inscribirse desde la ficha",
      });
      props.onChanged();
    });

  const generate = () =>
    run(async () => {
      if (status?.active && !window.confirm("¿Generar un enlace nuevo? El enlace anterior dejará de funcionar."))
        return;
      const r = await api<{ invitationToken: string; createdAt: string }>("POST", `${base}/invitation`, {});
      setLink(invitationLink(props.tournamentId, r.invitationToken));
      setStatus({ active: true, createdAt: r.createdAt });
      setMsg({ kind: "ok", text: "Enlace generado. Cópialo ahora: por seguridad no se puede volver a mostrar." });
    });

  const revoke = () =>
    run(async () => {
      if (!window.confirm("¿Revocar el enlace? Dejará de funcionar al momento; las inscripciones hechas se mantienen."))
        return;
      await api("DELETE", `${base}/invitation`);
      setLink(null);
      setStatus({ active: false });
      setMsg({ kind: "ok", text: "Enlace revocado: ya no permite inscribirse" });
    });

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setMsg({ kind: "ok", text: "Enlace copiado" });
    } catch {
      setMsg({ kind: "error", text: "No se pudo copiar: selecciona el enlace y cópialo a mano" });
    }
  }

  return (
    <section className="card" data-testid="invitation-panel" aria-label="Inscripción e invitaciones">
      <h3>Inscripción</h3>
      <p>
        <label>
          Modalidad{" "}
          <select
            aria-label="modalidad de inscripción"
            data-testid="enrollment-select"
            value={props.enrollment}
            disabled={busy}
            onChange={(e) => void setEnrollment(e.target.value as Enrollment)}
          >
            {(Object.keys(ENROLLMENT_NAME) as Enrollment[]).map((m) => (
              <option key={m} value={m}>
                {ENROLLMENT_NAME[m]}
              </option>
            ))}
          </select>
        </label>{" "}
        <small>
          El torneo se ve igual en el listado en las dos modalidades; la modalidad sólo decide quién puede inscribirse.
        </small>
      </p>
      {props.enrollment === "invitation" && (
        <>
          <p data-testid="invitation-status">
            {status?.active
              ? `Hay un enlace de invitación activo${status.createdAt ? ` (generado el ${new Date(status.createdAt).toLocaleString()})` : ""}.`
              : "No hay ningún enlace activo: nadie puede inscribirse hasta que generes uno."}
          </p>
          <p>
            <button type="button" onClick={() => void generate()} disabled={busy} data-testid="invitation-generate">
              {status?.active ? "Generar enlace nuevo" : "Generar enlace"}
            </button>{" "}
            {status?.active && (
              <button type="button" onClick={() => void revoke()} disabled={busy} data-testid="invitation-revoke">
                Revocar enlace
              </button>
            )}
          </p>
          {link && (
            <p>
              <input
                readOnly
                aria-label="enlace de invitación"
                data-testid="invitation-link"
                value={link}
                onFocus={(e) => e.currentTarget.select()}
                size={60}
              />{" "}
              <button type="button" onClick={() => void copy()} data-testid="invitation-copy">
                Copiar
              </button>
            </p>
          )}
        </>
      )}
      {msg && (
        <p className={msg.kind === "ok" ? "ok" : "error"} role={msg.kind === "ok" ? "status" : "alert"}>
          {msg.text}
        </p>
      )}
    </section>
  );
}
