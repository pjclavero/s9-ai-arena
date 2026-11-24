/**
 * V1-B · Mi cuenta: cambio de contraseña (`POST /auth/password`).
 * ACC-2FA · y la verificación en dos pasos (`TwoFactorSection`).
 *
 * Exige la contraseña actual (y el código TOTP si la cuenta tiene 2FA), aplica la política
 * (≥12 caracteres, distinta de la actual), y al terminar avisa de que se han cerrado las
 * demás sesiones. La validación local usa mensajes de la propia pantalla; el servidor es la
 * autoridad (también limita los intentos: 429).
 */
import { useRef, useState, type FormEvent } from "react";
import { api } from "../api.js";
import { describeApiError } from "../errors.js";
import { TwoFactorSection } from "./TwoFactorSection.js";

export const NEW_PASSWORD_MIN = 12;

type Field = "current" | "next" | "confirm";

/** Validación local del formulario; `null` = se puede enviar. */
export function validatePasswordChange(v: {
  current: string;
  next: string;
  confirm: string;
}): { field: Field; message: string } | null {
  if (!v.current) return { field: "current", message: "Escribe tu contraseña actual." };
  if (v.next.length < NEW_PASSWORD_MIN) {
    return { field: "next", message: `La nueva contraseña debe tener al menos ${NEW_PASSWORD_MIN} caracteres.` };
  }
  if (v.next === v.current) {
    return { field: "next", message: "La nueva contraseña debe ser distinta de la actual." };
  }
  if (v.confirm !== v.next) return { field: "confirm", message: "Las dos contraseñas nuevas no coinciden." };
  return null;
}

export function AccountPage() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [totp, setTotp] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [invalid, setInvalid] = useState<Field | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const refs = {
    current: useRef<HTMLInputElement>(null),
    next: useRef<HTMLInputElement>(null),
    confirm: useRef<HTMLInputElement>(null),
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setDone(false);
    setInvalid(null);
    const bad = validatePasswordChange({ current, next, confirm });
    if (bad) {
      setInvalid(bad.field);
      setError(bad.message);
      refs[bad.field].current?.focus();
      return;
    }
    setSubmitting(true);
    try {
      await api("POST", "/auth/password", {
        currentPassword: current,
        newPassword: next,
        ...(totp.trim() ? { totp: totp.trim() } : {}),
      });
      setCurrent("");
      setNext("");
      setConfirm("");
      setTotp("");
      setDone(true);
    } catch (err) {
      const e2 = err as { status?: number; message: string };
      const d = describeApiError(err);
      if (e2.status === 401) setInvalid("current");
      setError(
        e2.status === 429
          ? "Demasiados intentos fallidos: espera unos minutos antes de volver a intentarlo."
          : d.kind === "timeout" || d.kind === "network" || d.kind === "server" || d.kind === "unavailable"
            ? `${d.title}: ${d.detail}. Inténtalo de nuevo en un momento.`
            : e2.message,
      );
    } finally {
      setSubmitting(false);
    }
  }

  const describedBy = (f: Field, hint?: string) =>
    [hint, invalid === f ? "account-error" : undefined].filter(Boolean).join(" ") || undefined;

  return (
    <>
      <h1>Mi cuenta</h1>
      <div className="card">
        <h2>Cambiar la contraseña</h2>
        <p>
          Se cerrarán tus otras sesiones abiertas (otros navegadores o dispositivos); esta sigue activa. Si tu cuenta
          tiene verificación en dos pasos, escribe también el código.
        </p>
        <form onSubmit={submit} noValidate aria-label="cambiar contraseña">
          <p>
            <label>
              Contraseña actual{" "}
              <input
                ref={refs.current}
                aria-label="contraseña actual"
                type="password"
                autoComplete="current-password"
                aria-invalid={invalid === "current" || undefined}
                aria-describedby={describedBy("current")}
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </label>
          </p>
          <p>
            <label>
              Contraseña nueva{" "}
              <input
                ref={refs.next}
                aria-label="contraseña nueva"
                type="password"
                autoComplete="new-password"
                aria-invalid={invalid === "next" || undefined}
                aria-describedby={describedBy("next", "hint-nueva")}
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
            </label>{" "}
            <small id="hint-nueva">Mínimo {NEW_PASSWORD_MIN} caracteres.</small>
          </p>
          <p>
            <label>
              Repite la contraseña nueva{" "}
              <input
                ref={refs.confirm}
                aria-label="repite la contraseña nueva"
                type="password"
                autoComplete="new-password"
                aria-invalid={invalid === "confirm" || undefined}
                aria-describedby={describedBy("confirm")}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </label>
          </p>
          <p>
            <label>
              Código TOTP{" "}
              <input
                aria-label="totp"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
              />
            </label>{" "}
            <small>Sólo si tienes la verificación en dos pasos activada (o un código de recuperación).</small>
          </p>
          {error && (
            <p className="error" role="alert" id="account-error" data-testid="account-error">
              {error}
            </p>
          )}
          {done && (
            <p role="status" data-testid="account-done">
              Contraseña cambiada. Tus otras sesiones se han cerrado.
            </p>
          )}
          <button type="submit" disabled={submitting}>
            Cambiar la contraseña
          </button>
        </form>
      </div>
      <TwoFactorSection />
    </>
  );
}
