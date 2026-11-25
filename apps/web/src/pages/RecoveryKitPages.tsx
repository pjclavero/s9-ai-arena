/**
 * V1 ADM-SETUP · D-5 · Kit de recuperación del administrador en la web.
 *
 *  - `#/recover-kit` (público): email + kit + contraseña nueva (+ TOTP o código de recuperación si la
 *    cuenta tiene 2FA) ⇒ `POST /auth/recovery-kit/redeem`. El kit queda consumido: después hay que
 *    entrar y generar otro.
 *  - `#/recovery-kit` (Administración): estado del kit y regeneración con reautenticación
 *    (`GET/POST /auth/recovery-kit`); el kit nuevo se muestra UNA vez.
 *  - `AccessHelp`: en la pantalla de acceso, aviso del asistente de primer arranque (si está abierto)
 *    y enlace a la recuperación con kit.
 */
import { useEffect, useState, type FormEvent } from "react";
import { api, type Me } from "../api.js";
import { describeApiError } from "../errors.js";
import { PASSWORD_MIN } from "./LoginPage.js";
import { PASSWORD_MAX } from "./SetupPage.js";
import { RecoveryKitReveal } from "./recovery-kit-ui.js";

export function AccessHelp() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    // Sin sesión: un 401 aquí NO es una sesión caducada (no se refresca ni se echa al usuario).
    api<{ open: boolean }>("GET", "/setup/status", undefined, { reauth: true })
      .then((s) => alive && setOpen(!!s?.open))
      .catch(() => {
        // sin respuesta no se avisa de nada: el acceso normal sigue funcionando
      });
    return () => {
      alive = false;
    };
  }, []);
  return (
    <>
      {open && (
        <p className="warn" role="status" data-testid="setup-open-notice">
          Instalación nueva sin administrador: <a href="#/setup">abre el asistente de primer arranque</a>.
        </p>
      )}
      <p data-testid="recover-kit-link">
        <small>
          ¿Eres administrador y olvidaste la contraseña? <a href="#/recover-kit">Usa tu kit de recuperación</a>.
        </small>
      </p>
    </>
  );
}

export function RecoveryKitRedeemPage() {
  const [email, setEmail] = useState("");
  const [kit, setKit] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [totp, setTotp] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    const len = [...password].length;
    if (!email.trim() || !kit.trim()) return setError("Escribe tu email y el kit de recuperación.");
    if (len < PASSWORD_MIN || len > PASSWORD_MAX) {
      return setError(`La contraseña nueva debe tener entre ${PASSWORD_MIN} y ${PASSWORD_MAX} caracteres.`);
    }
    if (confirm !== password) return setError("Las dos contraseñas no coinciden.");
    setSubmitting(true);
    try {
      await api("POST", "/auth/recovery-kit/redeem", {
        email: email.trim(),
        recoveryKit: kit.trim(),
        newPassword: password,
        ...(totp.trim() ? { totp: totp.trim() } : {}),
      });
      setPassword("");
      setConfirm("");
      setKit("");
      setDone(true);
    } catch (err) {
      const e2 = err as { status?: number; body?: { error?: string } };
      const code = e2.body?.error;
      if (e2.status === 401 && code === "totp_required") {
        setNeedsTotp(true);
        setError("La cuenta tiene verificación en dos pasos: añade un código TOTP o un código de recuperación.");
      } else if (e2.status === 401) {
        setError("Email o kit de recuperación incorrectos (o el kit ya se usó).");
      } else if (e2.status === 429) {
        setError("Demasiados intentos: espera unos minutos.");
      } else {
        const d = describeApiError(err);
        setError(`${d.title}: ${d.detail}`);
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="card" role="status" data-testid="recover-kit-done">
        <h1>Contraseña cambiada</h1>
        <p>
          El kit ya está consumido y se han cerrado todas las sesiones de la cuenta. <a href="#/">Inicia sesión</a> con
          la contraseña nueva y genera un kit nuevo en Administración → Kit de recuperación.
        </p>
      </div>
    );
  }

  return (
    <>
      <h1>Recuperar el acceso con el kit</h1>
      <div className="card">
        <p>
          Sólo para cuentas de administración. Con tu email y el kit que guardaste al crear la cuenta (o al regenerarlo)
          fijas una contraseña nueva. Si la cuenta tiene verificación en dos pasos, añade también un código TOTP o uno
          de sus códigos de recuperación: el kit no la desactiva.
        </p>
        <form onSubmit={submit} noValidate>
          <p>
            <label>
              Email <input aria-label="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
          </p>
          <p>
            <label>
              Kit de recuperación{" "}
              <input
                aria-label="kit de recuperación"
                autoComplete="off"
                spellCheck={false}
                value={kit}
                onChange={(e) => setKit(e.target.value)}
              />
            </label>
          </p>
          <p>
            <label>
              Contraseña nueva{" "}
              <input
                aria-label="contraseña nueva"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          </p>
          <p>
            <label>
              Repite la contraseña nueva{" "}
              <input
                aria-label="repite la contraseña nueva"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </label>
          </p>
          {needsTotp && (
            <p>
              <label>
                Código TOTP o de recuperación{" "}
                <input
                  aria-label="totp"
                  autoComplete="one-time-code"
                  value={totp}
                  onChange={(e) => setTotp(e.target.value)}
                />
              </label>
            </p>
          )}
          {error && (
            <p className="error" role="alert" data-testid="recover-kit-error">
              {error}
            </p>
          )}
          <button type="submit" disabled={submitting}>
            Cambiar la contraseña
          </button>
        </form>
      </div>
    </>
  );
}

export function RecoveryKitAdminPage(props: { me: Me }) {
  const [status, setStatus] = useState<{ active: boolean; createdAt: string | null } | null>(null);
  const [loadError, setLoadError] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [error, setError] = useState("");
  const [kit, setKit] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function load() {
    api<{ active: boolean; createdAt: string | null }>("GET", "/auth/recovery-kit")
      .then((s) => setStatus(s))
      .catch((e) => {
        const d = describeApiError(e);
        setLoadError(`${d.title}: ${d.detail}`);
      });
  }
  useEffect(load, []);

  async function regenerate(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!password) return setError("Escribe tu contraseña actual.");
    setSubmitting(true);
    try {
      const r = await api<{ recoveryKit: string }>(
        "POST",
        "/auth/recovery-kit",
        { password, ...(totp.trim() ? { totp: totp.trim() } : {}) },
        { reauth: true },
      );
      setPassword("");
      setTotp("");
      setKit(r.recoveryKit);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401) setError("Contraseña o código TOTP incorrectos.");
      else if (status === 429) setError("Demasiados intentos fallidos: espera unos minutos.");
      else {
        const d = describeApiError(err);
        setError(`${d.title}: ${d.detail}`);
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (kit) {
    return (
      <RecoveryKitReveal
        kit={kit}
        doneLabel="Hecho"
        onDone={() => {
          setKit(null);
          load();
        }}
      />
    );
  }

  return (
    <>
      <h1>Kit de recuperación</h1>
      <div className="card">
        <p>
          El kit te permite fijar una contraseña nueva desde la web si la olvidas, sin consola. Es de un solo uso:
          regenerarlo invalida el anterior.
        </p>
        {loadError && (
          <p className="error" role="alert">
            {loadError}
          </p>
        )}
        {status && (
          <p data-testid="recovery-kit-status" data-active={status.active ? "true" : "false"}>
            {status.active
              ? `Tienes un kit activo (generado el ${new Date(status.createdAt!).toLocaleString()}).`
              : "No tienes ningún kit activo: genera uno ahora."}
          </p>
        )}
        <form onSubmit={regenerate} noValidate>
          <p>
            <label>
              Contraseña actual{" "}
              <input
                aria-label="contraseña actual"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          </p>
          {props.me.twoFactorEnabled && (
            <p>
              <label>
                Código TOTP o de recuperación{" "}
                <input
                  aria-label="totp"
                  autoComplete="one-time-code"
                  value={totp}
                  onChange={(e) => setTotp(e.target.value)}
                />
              </label>
            </p>
          )}
          {error && (
            <p className="error" role="alert" data-testid="recovery-kit-error">
              {error}
            </p>
          )}
          <button type="submit" disabled={submitting}>
            Generar un kit nuevo
          </button>
        </form>
      </div>
    </>
  );
}
