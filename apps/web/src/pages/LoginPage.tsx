/** T7.4 · Registro, login y 2FA (TOTP en el login cuando la cuenta lo exige). */
import { useState } from "react";
import { api, setToken, type Me } from "../api.js";

export function LoginPage(props: { onLogin: (me: Me) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [totp, setTotp] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
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
    } catch (e) {
      const err = e as { status?: number; message: string };
      if (err.status === 401 && /TOTP|2FA/i.test(err.message)) setNeedsTotp(true);
      setError(err.message);
    }
  }

  return (
    <div className="card">
      <h2>{mode === "login" ? "Iniciar sesión" : "Crear cuenta"}</h2>
      {mode === "register" && (
        <p>
          <input aria-label="nombre" placeholder="Nombre visible" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </p>
      )}
      <p>
        <input aria-label="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </p>
      <p>
        <input aria-label="contraseña" type="password" placeholder="contraseña (≥12)" value={password} onChange={(e) => setPassword(e.target.value)} />
      </p>
      {needsTotp && (
        <p>
          <input aria-label="totp" placeholder="código TOTP" value={totp} onChange={(e) => setTotp(e.target.value)} />
        </p>
      )}
      {error && <p className="error">{error}</p>}
      <button onClick={submit}>{mode === "login" ? "Entrar" : "Registrarse y entrar"}</button>{" "}
      <a href="#" onClick={() => setMode(mode === "login" ? "register" : "login")}>
        {mode === "login" ? "Crear cuenta" : "Ya tengo cuenta"}
      </a>
    </div>
  );
}
