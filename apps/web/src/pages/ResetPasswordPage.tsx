/**
 * V1 ADM-3 · «Restablecer contraseña» (pública, `#/reset`). El usuario canjea aquí el token de recuperación que le
 * entregó un administrador FUERA DE BANDA (no hay correo): token + contraseña nueva (política única: ≥12). El servidor
 * lo canjea una sola vez, cierra todas sus sesiones y no revela si una cuenta existe: ante un token inválido, usado,
 * caducado o de una cuenta bloqueada la respuesta es la misma.
 */
import { useState, type FormEvent } from "react";
import { api } from "../api.js";
import { FormError } from "../ui/primitives.js";

export const RESET_PASSWORD_MIN = 12;

/** Validación local previa al envío; `null` = se puede enviar. */
export function validateReset(token: string, password: string, repeat: string): string | null {
  if (!token.trim()) return "Pega el token de recuperación que te dio el administrador.";
  if (password.length < RESET_PASSWORD_MIN)
    return `La contraseña debe tener al menos ${RESET_PASSWORD_MIN} caracteres.`;
  if (password !== repeat) return "Las dos contraseñas no coinciden.";
  return null;
}

export function ResetPasswordPage() {
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [local, setLocal] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const bad = validateReset(token, password, repeat);
    setLocal(bad ?? "");
    if (bad) return;
    setBusy(true);
    try {
      await api("POST", "/auth/reset", { token: token.trim(), newPassword: password });
      setDone(true);
      setToken("");
      setPassword("");
      setRepeat("");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="card" data-testid="reset-done">
        <h2>Contraseña restablecida</h2>
        <p role="status">
          Ya puedes iniciar sesión con tu contraseña nueva. Por seguridad se han cerrado todas tus sesiones anteriores.
        </p>
        <p>
          <a href="#/">Ir al inicio de sesión</a>
        </p>
      </div>
    );
  }
  return (
    <div className="card" data-testid="reset-page">
      <h2>Restablecer contraseña</h2>
      <p>
        Un administrador te habrá dado un <strong>token de recuperación</strong> (caduca a los 30 minutos y sólo sirve
        una vez). Pégalo aquí y elige una contraseña nueva. Si tu cuenta tiene 2FA, seguirás necesitando tu código al
        entrar.
      </p>
      <form onSubmit={submit} noValidate>
        <p>
          <label>
            Token de recuperación{" "}
            <input
              aria-label="token de recuperación"
              data-testid="reset-token"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
        </p>
        <p>
          <label>
            Contraseña nueva (≥{RESET_PASSWORD_MIN}){" "}
            <input
              aria-label="contraseña nueva"
              data-testid="reset-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        </p>
        <p>
          <label>
            Repite la contraseña{" "}
            <input
              aria-label="repite la contraseña"
              data-testid="reset-repeat"
              type="password"
              autoComplete="new-password"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
            />
          </label>
        </p>
        {local && (
          <p className="error" role="alert" data-testid="reset-local-error">
            {local}
          </p>
        )}
        <FormError error={error} data-testid="reset-error" />
        <button type="submit" disabled={busy} data-testid="reset-submit">
          Restablecer contraseña
        </button>{" "}
        <a href="#/">Volver</a>
      </form>
    </div>
  );
}
