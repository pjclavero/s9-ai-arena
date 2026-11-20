/**
 * T7.4 · Registro, login y 2FA (TOTP en el login cuando la cuenta lo exige).
 * R3.7: formulario real (onSubmit ⇒ Enter funciona), labels visibles, errores
 * con role="alert" y aviso de sesión caducada (interceptor de 401 del api.ts).
 *
 * UX-A (C-G12) · El registro sin nombre visible mostraba el mensaje crudo de la
 * API, «displayName obligatorio (máx. 48)»: un nombre de campo interno que el
 * usuario no ve en ningún sitio. Ahora:
 *  - el formulario valida ANTES de enviar (nombre, email, contraseña ≥12) con
 *    mensajes en lenguaje de la pantalla, y lleva el foco al campo que falla;
 *  - los mensajes de validación de la API que nombran campos internos se
 *    traducen a la etiqueta visible (`humanizeAuthError`), sin esconder el resto.
 */
import { useRef, useState, type FormEvent } from "react";
import { api, setToken, type Me } from "../api.js";
import { describeApiError } from "../errors.js";

export const DISPLAY_NAME_MAX = 48;
export const PASSWORD_MIN = 12;

type Field = "displayName" | "email" | "password";

const MSG: Record<Field, string> = {
  displayName: `Escribe tu nombre visible: es el nombre con el que te verán los demás (máximo ${DISPLAY_NAME_MAX} caracteres).`,
  email: "Escribe un email válido (por ejemplo, nombre@dominio.com).",
  password: `La contraseña debe tener al menos ${PASSWORD_MIN} caracteres.`,
};

/** Validación local del formulario; `null` = se puede enviar. */
export function validateAuthForm(
  mode: "login" | "register",
  v: { displayName: string; email: string; password: string },
): { field: Field; message: string } | null {
  if (mode === "register") {
    const name = v.displayName.trim();
    if (!name || name.length > DISPLAY_NAME_MAX) return { field: "displayName", message: MSG.displayName };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim())) return { field: "email", message: MSG.email };
  if (mode === "register" && v.password.length < PASSWORD_MIN) return { field: "password", message: MSG.password };
  if (mode === "login" && !v.password) return { field: "password", message: "Escribe tu contraseña." };
  return null;
}

/**
 * Traduce los mensajes de la API que nombran CAMPOS INTERNOS (displayName,
 * refreshToken…) a lo que la pantalla enseña. Lo que no reconoce lo devuelve tal
 * cual: el mensaje real del servidor no se esconde.
 */
export function humanizeAuthError(message: string): string {
  if (/displayName/i.test(message)) return MSG.displayName;
  if (/^email inválido/i.test(message)) return MSG.email;
  if (/email y password obligatorios/i.test(message)) return "Escribe tu email y tu contraseña.";
  return message;
}

export function LoginPage(props: { onLogin: (me: Me) => void; notice?: string }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [totp, setTotp] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState<Field | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const refs = {
    displayName: useRef<HTMLInputElement>(null),
    email: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
  };

  async function submit(e: FormEvent) {
    e.preventDefault(); // envío también con Enter (a11y R3.7)
    setError("");
    setInvalid(null);
    const bad = validateAuthForm(mode, { displayName, email, password });
    if (bad) {
      setInvalid(bad.field);
      setError(bad.message);
      refs[bad.field].current?.focus();
      return;
    }
    setSubmitting(true);
    try {
      if (mode === "register") {
        await api("POST", "/auth/register", { email: email.trim(), password, displayName: displayName.trim() });
      }
      const tokens = await api<{ accessToken: string }>("POST", "/auth/login", {
        email: email.trim(),
        password,
        ...(totp ? { totp } : {}),
      });
      setToken(tokens.accessToken);
      props.onLogin(await api<Me>("GET", "/users/me"));
    } catch (err) {
      const e2 = err as { status?: number; message: string };
      if (e2.status === 401 && /TOTP|2FA/i.test(e2.message)) setNeedsTotp(true);
      // FC-D (D2): API caída, plazo o 5xx se nombran como tales (no como
      // «credenciales incorrectas»); el resto muestra el mensaje real del servidor.
      const d = describeApiError(err);
      setError(
        d.kind === "timeout" || d.kind === "network" || d.kind === "server" || d.kind === "unavailable"
          ? `${d.title}: ${d.detail}. Inténtalo de nuevo en un momento.`
          : humanizeAuthError(e2.message),
      );
      if (/displayName/i.test(e2.message)) setInvalid("displayName");
    } finally {
      setSubmitting(false);
    }
  }

  const describedBy = (f: Field, hint?: string) =>
    [hint, invalid === f ? "login-error" : undefined].filter(Boolean).join(" ") || undefined;

  return (
    <div className="card">
      <h2>{mode === "login" ? "Iniciar sesión" : "Crear cuenta"}</h2>
      {props.notice && (
        <p className="warn" role="alert" data-testid="session-notice">
          {props.notice}
        </p>
      )}
      <p>
        {mode === "login"
          ? "¿Primera vez en S9? Pulsa «Crear cuenta» debajo del formulario."
          : "Todos los campos son obligatorios. Al registrarte entras directamente."}
      </p>
      {/* noValidate: los avisos son los nuestros (accesibles y en español), no los del navegador. */}
      <form onSubmit={submit} noValidate>
        {mode === "register" && (
          <p>
            <label>
              Nombre visible{" "}
              <input
                ref={refs.displayName}
                aria-label="nombre"
                autoComplete="nickname"
                maxLength={DISPLAY_NAME_MAX}
                aria-invalid={invalid === "displayName" || undefined}
                aria-describedby={describedBy("displayName", "hint-nombre")}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </label>{" "}
            <small id="hint-nombre">El que verán los demás jugadores (máx. {DISPLAY_NAME_MAX}).</small>
          </p>
        )}
        <p>
          <label>
            Email{" "}
            <input
              ref={refs.email}
              aria-label="email"
              type="email"
              autoComplete="email"
              aria-invalid={invalid === "email" || undefined}
              aria-describedby={describedBy("email")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
        </p>
        <p>
          <label>
            Contraseña (≥12){" "}
            <input
              ref={refs.password}
              aria-label="contraseña"
              type="password"
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              aria-invalid={invalid === "password" || undefined}
              aria-describedby={describedBy("password", "hint-pass")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>{" "}
          <small id="hint-pass">Mínimo {PASSWORD_MIN} caracteres.</small>
        </p>
        {needsTotp && (
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
            <small>El código de 6 cifras de tu app de autenticación (o un código de recuperación).</small>
          </p>
        )}
        {error && (
          <p className="error" role="alert" id="login-error" data-testid="login-error">
            {error}
          </p>
        )}
        <button type="submit" disabled={submitting}>
          {mode === "login" ? "Entrar" : "Registrarse y entrar"}
        </button>{" "}
        <button
          type="button"
          className="link"
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError("");
            setInvalid(null);
          }}
        >
          {mode === "login" ? "Crear cuenta" : "Ya tengo cuenta"}
        </button>
      </form>
    </div>
  );
}
