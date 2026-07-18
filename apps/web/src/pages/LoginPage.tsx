/**
 * T7.4 · Registro, login y 2FA (TOTP en el login cuando la cuenta lo exige).
 * R3.7: formulario real (onSubmit ⇒ Enter funciona), labels visibles, errores
 * con role="alert" y aviso de sesión caducada (interceptor de 401 del api.ts).
 */
import { useState, type FormEvent } from "react";
import { api, setToken, type Me } from "../api.js";

export function LoginPage(props: { onLogin: (me: Me) => void; notice?: string }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [totp, setTotp] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault(); // envío también con Enter (a11y R3.7)
    setError("");
    try {
      if (mode === "register") {
        await api("POST", "/auth/register", { email, password, displayName });
      }
      const tokens = await api<{ accessToken: string }>("POST", "/auth/login", {
        email,
        password,
        ...(totp ? { totp } : {}),
      });
      setToken(tokens.accessToken);
      props.onLogin(await api<Me>("GET", "/users/me"));
    } catch (err) {
      const e2 = err as { status?: number; message: string };
      if (e2.status === 401 && /TOTP|2FA/i.test(e2.message)) setNeedsTotp(true);
      setError(e2.message);
    }
  }

  return (
    <div className="card">
      <h2>{mode === "login" ? "Iniciar sesión" : "Crear cuenta"}</h2>
      {props.notice && (
        <p className="warn" role="alert" data-testid="session-notice">
          {props.notice}
        </p>
      )}
      <form onSubmit={submit}>
        {mode === "register" && (
          <p>
            <label>
              Nombre visible{" "}
              <input aria-label="nombre" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </label>
          </p>
        )}
        <p>
          <label>
            Email{" "}
            <input
              aria-label="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
        </p>
        <p>
          <label>
            Contraseña (≥12){" "}
            <input
              aria-label="contraseña"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        </p>
        {needsTotp && (
          <p>
            <label>
              Código TOTP{" "}
              <input aria-label="totp" inputMode="numeric" value={totp} onChange={(e) => setTotp(e.target.value)} />
            </label>
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit">{mode === "login" ? "Entrar" : "Registrarse y entrar"}</button>{" "}
        <button type="button" className="link" onClick={() => setMode(mode === "login" ? "register" : "login")}>
          {mode === "login" ? "Crear cuenta" : "Ya tengo cuenta"}
        </button>
      </form>
    </div>
  );
}
