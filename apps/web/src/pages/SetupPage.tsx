/**
 * V1 ADM-SETUP (D-OP-44) · #/setup · Asistente de primer arranque en el navegador.
 *
 * Instalar → abrir el navegador → crear aquí el PRIMER administrador con el token de instalación
 * (contenido de `secrets/setup_token.txt` del host). La API es la autoridad: el asistente sólo está
 * abierto con 0 administradores, la instalación sin completar y el token presente
 * (`GET /setup/status`). Cerrado ⇒ esta pantalla manda al inicio de sesión.
 *
 * Al terminar, la sesión queda iniciada y se muestra UNA vez el kit de recuperación del admin.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, setToken, type Me } from "../api.js";
import { describeApiError } from "../errors.js";
import { DISPLAY_NAME_MAX, PASSWORD_MIN } from "./LoginPage.js";
import { RecoveryKitReveal } from "./recovery-kit-ui.js";

/** Tope de la política de #348 (12-128); el servidor es la autoridad. */
export const PASSWORD_MAX = 128;

type Field = "token" | "displayName" | "email" | "password" | "confirm";

/** Validación local; `null` = se puede enviar. */
export function validateSetupForm(v: {
  token: string;
  displayName: string;
  email: string;
  password: string;
  confirm: string;
}): { field: Field; message: string } | null {
  if (!v.token.trim()) return { field: "token", message: "Pega el token de instalación (secrets/setup_token.txt)." };
  const name = v.displayName.trim();
  if (!name || name.length > DISPLAY_NAME_MAX) {
    return { field: "displayName", message: `Escribe un nombre visible (máximo ${DISPLAY_NAME_MAX} caracteres).` };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim()))
    return { field: "email", message: "Escribe un email válido." };
  const len = [...v.password].length;
  if (len < PASSWORD_MIN || len > PASSWORD_MAX) {
    return {
      field: "password",
      message: `La contraseña debe tener entre ${PASSWORD_MIN} y ${PASSWORD_MAX} caracteres.`,
    };
  }
  if (v.confirm !== v.password) return { field: "confirm", message: "Las dos contraseñas no coinciden." };
  return null;
}

export function SetupPage(props: { onLogin: (me: Me) => void }) {
  const [status, setStatus] = useState<"loading" | "open" | "closed" | "error">("loading");
  const [token, setTokenValue] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState<Field | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<{ me: Me; kit: string } | null>(null);
  const refs = {
    token: useRef<HTMLInputElement>(null),
    displayName: useRef<HTMLInputElement>(null),
    email: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
    confirm: useRef<HTMLInputElement>(null),
  };

  useEffect(() => {
    let alive = true;
    // Sin sesión: un 401 aquí NO es una sesión caducada (no se refresca ni se echa al usuario).
    api<{ open: boolean }>("GET", "/setup/status", undefined, { reauth: true })
      .then((s) => {
        if (!alive) return;
        if (s.open) setStatus("open");
        else {
          setStatus("closed");
          window.location.hash = "#/"; // cerrado ⇒ al inicio de sesión
        }
      })
      .catch(() => alive && setStatus("error"));
    return () => {
      alive = false;
    };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setInvalid(null);
    const bad = validateSetupForm({ token, displayName, email, password, confirm });
    if (bad) {
      setInvalid(bad.field);
      setError(bad.message);
      refs[bad.field].current?.focus();
      return;
    }
    setSubmitting(true);
    try {
      // reauth: un 401 aquí es «token incorrecto», no una sesión caducada (no se refresca).
      const r = await api<{ accessToken: string; recoveryKit: string }>(
        "POST",
        "/setup/admin",
        { setupToken: token.trim(), email: email.trim(), displayName: displayName.trim(), password },
        { reauth: true },
      );
      setToken(r.accessToken);
      const me = await api<Me>("GET", "/users/me");
      setPassword("");
      setConfirm("");
      setTokenValue("");
      setCreated({ me, kit: r.recoveryKit });
    } catch (err) {
      const status = (err as { status?: number }).status;
      const d = describeApiError(err);
      if (status === 401) {
        setInvalid("token");
        setError("El token de instalación no es correcto. Cópialo de nuevo de secrets/setup_token.txt en el host.");
      } else if (status === 410) {
        setStatus("closed");
        setError("La instalación ya tiene administrador: inicia sesión.");
      } else if (status === 429) {
        setError("Demasiados intentos: espera unos minutos antes de volver a probar.");
      } else {
        setError(`${d.title}: ${d.detail}`);
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (created) {
    return (
      <>
        <h1>Instalación completada</h1>
        <p role="status" data-testid="setup-done">
          Ya eres el administrador de esta instalación ({created.me.email}). El asistente queda cerrado para siempre; el
          fichero secrets/setup_token.txt ya no tiene ningún efecto.
        </p>
        <RecoveryKitReveal
          kit={created.kit}
          doneLabel="Entrar al panel"
          onDone={() => {
            props.onLogin(created.me);
            window.location.hash = "#/";
          }}
        />
      </>
    );
  }

  if (status === "loading") {
    return (
      <p role="status" aria-live="polite" data-testid="setup-status">
        Comprobando la instalación…
      </p>
    );
  }
  if (status === "closed") {
    return (
      <p role="status" data-testid="setup-closed">
        Esta instalación ya tiene administrador. <a href="#/">Inicia sesión</a>.
      </p>
    );
  }
  if (status === "error") {
    return (
      <p className="error" role="alert" data-testid="setup-error">
        No se pudo consultar el estado de la instalación. Vuelve a intentarlo en un momento.
      </p>
    );
  }

  const field = (
    f: Field,
    label: string,
    aria: string,
    value: string,
    set: (v: string) => void,
    extra: Record<string, unknown> = {},
  ) => (
    <p>
      <label>
        {label}{" "}
        <input
          ref={refs[f]}
          aria-label={aria}
          aria-invalid={invalid === f || undefined}
          aria-describedby={invalid === f ? "setup-form-error" : undefined}
          value={value}
          onChange={(e) => set(e.target.value)}
          {...extra}
        />
      </label>
    </p>
  );

  return (
    <>
      <h1>Primer arranque</h1>
      <div className="card" data-testid="setup-form">
        <p>
          Esta instalación aún no tiene administrador. Crea aquí la primera cuenta de administración. Para demostrar que
          controlas el servidor, pega el contenido del fichero <code>secrets/setup_token.txt</code> del host (la huella
          aparece en el log de la API al arrancar).
        </p>
        <form onSubmit={submit} noValidate>
          {field("token", "Token de instalación", "token de instalación", token, setTokenValue, {
            autoComplete: "off",
            spellCheck: false,
          })}
          {field("displayName", "Nombre visible", "nombre", displayName, setDisplayName, {
            maxLength: DISPLAY_NAME_MAX,
            autoComplete: "nickname",
          })}
          {field("email", "Email", "email", email, setEmail, { type: "email", autoComplete: "email" })}
          {field("password", `Contraseña (${PASSWORD_MIN}-${PASSWORD_MAX})`, "contraseña", password, setPassword, {
            type: "password",
            autoComplete: "new-password",
          })}
          {field("confirm", "Repite la contraseña", "repite la contraseña", confirm, setConfirm, {
            type: "password",
            autoComplete: "new-password",
          })}
          {error && (
            <p className="error" role="alert" id="setup-form-error" data-testid="setup-form-error">
              {error}
            </p>
          )}
          <button type="submit" disabled={submitting}>
            Crear administrador
          </button>
        </form>
      </div>
    </>
  );
}
