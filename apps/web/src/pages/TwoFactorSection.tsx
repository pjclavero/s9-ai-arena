/**
 * ACC-2FA · «Verificación en dos pasos» en Mi cuenta (cualquier usuario autenticado).
 *
 *  - Estado: activa o no, y cuántos códigos de recuperación quedan (`GET /users/me`). Aviso con menos de 3.
 *  - Activar en dos fases: `POST /auth/2fa/setup` (QR + secreto para escribirlo a mano; la cuenta NO cambia)
 *    y `POST /auth/2fa/confirm` con un código de la app. Si el usuario no confirma, nada se activa.
 *  - Los códigos de recuperación se enseñan UNA vez (al activar y al regenerar) y sólo viven en la memoria
 *    de este componente: nada en localStorage, sessionStorage ni la URL. Para cerrar el aviso hay que marcar
 *    «Los he guardado». El servidor responde con Cache-Control: no-store.
 *  - Regenerar los códigos y desactivar piden contraseña + código (TOTP o de recuperación).
 *  - Ayuda: cómo entrar con un código de recuperación si se pierde el dispositivo.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { encode } from "uqr";
import { api, type Me } from "../api.js";
import { describeApiError } from "../errors.js";

/** Con menos códigos que estos la pantalla avisa de que conviene regenerarlos. */
export const LOW_RECOVERY_CODES = 3;

type MeWith2fa = Me & { recoveryCodesRemaining?: number };

type Stage =
  | { kind: "loading" }
  | { kind: "load-error"; message: string }
  | { kind: "off" }
  | { kind: "enrolling"; otpauthUrl: string; secret: string; enrollmentToken: string }
  | { kind: "codes"; codes: string[]; reason: "enabled" | "regenerated" }
  | { kind: "on"; remaining: number };

/** Mensaje legible de un fallo de la API en esta sección. */
export function twoFactorErrorMessage(err: unknown, ctx: "confirm" | "reauth"): string {
  const e = err as { status?: number; message?: string };
  // 429 antes que los transitorios: describeApiError lo clasifica como «unavailable», pero aquí es el
  // bloqueo por intentos fallidos (15 min), no un servicio caído.
  if (e.status === 429) return "Demasiados intentos fallidos: espera unos 15 minutos antes de volver a intentarlo.";
  const d = describeApiError(err);
  if (d.kind === "timeout" || d.kind === "network" || d.kind === "server" || d.kind === "unavailable") {
    return `${d.title}: ${d.detail}. Inténtalo de nuevo en un momento.`;
  }
  if (ctx === "confirm") {
    if (e.status === 401)
      return "El código no es correcto. Comprueba que la hora del móvil está en automático y escribe el código que se ve ahora.";
    if (e.status === 400) return "El alta ha caducado (10 minutos). Vuelve a pulsar «Activar» para empezar de nuevo.";
  } else if (e.status === 401) {
    return "La contraseña o el código no son correctos.";
  }
  if (e.status === 409)
    return "El estado de la verificación en dos pasos ha cambiado en otra pestaña. Recarga la página.";
  return e.message ?? "Error inesperado";
}

/** Agrupa el secreto base32 de 4 en 4 para copiarlo a mano sin errores. */
export function groupSecret(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

/** QR del enlace otpauth como SVG: un rectángulo por módulo, sin innerHTML ni red. */
export function QrSvg(props: { value: string; label: string }) {
  const qr = useMemo(() => encode(props.value, { ecc: "M", border: 2 }), [props.value]);
  const rects: string[] = [];
  qr.data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) rects.push(`M${x} ${y}h1v1h-1z`);
    }),
  );
  return (
    <svg
      role="img"
      aria-label={props.label}
      data-testid="totp-qr"
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      width={220}
      height={220}
      shapeRendering="crispEdges"
      style={{ background: "#fff" }}
    >
      <path d={rects.join("")} fill="#000" />
    </svg>
  );
}

function ReauthFields(props: {
  idPrefix: string;
  password: string;
  code: string;
  onPassword: (v: string) => void;
  onCode: (v: string) => void;
}) {
  return (
    <>
      <p>
        <label>
          Contraseña{" "}
          <input
            aria-label={`${props.idPrefix} contraseña`}
            type="password"
            autoComplete="current-password"
            value={props.password}
            onChange={(e) => props.onPassword(e.target.value)}
          />
        </label>
      </p>
      <p>
        <label>
          Código{" "}
          <input
            aria-label={`${props.idPrefix} código`}
            autoComplete="one-time-code"
            spellCheck={false}
            value={props.code}
            onChange={(e) => props.onCode(e.target.value)}
          />
        </label>{" "}
        <small>El de 6 cifras de tu app o uno de tus códigos de recuperación.</small>
      </p>
    </>
  );
}

export function TwoFactorSection() {
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [reauthCode, setReauthCode] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    try {
      const me = await api<MeWith2fa>("GET", "/users/me");
      setStage(me.twoFactorEnabled ? { kind: "on", remaining: me.recoveryCodesRemaining ?? 0 } : { kind: "off" });
    } catch (err) {
      setStage({ kind: "load-error", message: twoFactorErrorMessage(err, "reauth") });
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function resetForms() {
    setCode("");
    setPassword("");
    setReauthCode("");
    setSaved(false);
    setError("");
  }

  async function start() {
    resetForms();
    setNotice("");
    setBusy(true);
    try {
      const r = await api<{ otpauthUrl: string; secret: string; enrollmentToken: string }>("POST", "/auth/2fa/setup");
      setStage({ kind: "enrolling", otpauthUrl: r.otpauthUrl, secret: r.secret, enrollmentToken: r.enrollmentToken });
    } catch (err) {
      setError(twoFactorErrorMessage(err, "confirm"));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(e: FormEvent) {
    e.preventDefault();
    if (stage.kind !== "enrolling") return;
    setError("");
    const typed = code.replace(/\s+/g, "");
    if (!/^[0-9]{6}$/.test(typed)) {
      setError("Escribe el código de 6 cifras que muestra tu app de autenticación.");
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ recoveryCodes: string[] }>("POST", "/auth/2fa/confirm", {
        enrollmentToken: stage.enrollmentToken,
        totp: typed,
      });
      resetForms();
      setStage({ kind: "codes", codes: r.recoveryCodes, reason: "enabled" });
    } catch (err) {
      const status = (err as { status?: number }).status;
      setError(twoFactorErrorMessage(err, "confirm"));
      if (status === 400) setStage({ kind: "off" });
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  async function reauthAction(action: "regenerate" | "disable") {
    setError("");
    setNotice("");
    if (!password || !reauthCode.trim()) {
      setError("Escribe tu contraseña y un código (de la app o de recuperación).");
      return;
    }
    setBusy(true);
    try {
      const body = { password, totp: reauthCode.trim() };
      if (action === "regenerate") {
        const r = await api<{ recoveryCodes: string[] }>("POST", "/auth/2fa/recovery-codes", body);
        resetForms();
        setStage({ kind: "codes", codes: r.recoveryCodes, reason: "regenerated" });
      } else {
        await api("DELETE", "/auth/2fa", body);
        resetForms();
        setNotice("Verificación en dos pasos desactivada. Tus otras sesiones se han cerrado.");
        setStage({ kind: "off" });
      }
    } catch (err) {
      setError(twoFactorErrorMessage(err, "reauth"));
      setReauthCode("");
    } finally {
      setBusy(false);
    }
  }

  function finishCodes() {
    if (stage.kind !== "codes") return;
    const n = stage.codes.length;
    const reason = stage.reason;
    resetForms(); // los códigos dejan de existir en la memoria del componente
    setNotice(
      reason === "enabled"
        ? "Verificación en dos pasos activada. Tus otras sesiones se han cerrado."
        : "Códigos nuevos guardados. Los anteriores ya no sirven.",
    );
    setStage({ kind: "on", remaining: n });
  }

  return (
    <div className="card" data-testid="twofa-section">
      <h2>Verificación en dos pasos</h2>
      <p>
        Además de la contraseña, al entrar se pide un código de 6 cifras que genera una app de autenticación del móvil
        (Google Authenticator, Aegis, FreeOTP, 1Password…). Si alguien averigua tu contraseña, sin el móvil no puede
        entrar.
      </p>

      {stage.kind === "loading" && <p role="status">Cargando…</p>}
      {stage.kind === "load-error" && (
        <p className="error" role="alert">
          {stage.message}{" "}
          <button type="button" onClick={() => void load()}>
            Reintentar
          </button>
        </p>
      )}

      {stage.kind === "off" && (
        <>
          <p data-testid="twofa-status">
            Estado: <strong>desactivada</strong>.
          </p>
          <button type="button" onClick={() => void start()} disabled={busy}>
            Activar la verificación en dos pasos
          </button>
        </>
      )}

      {stage.kind === "enrolling" && (
        <form onSubmit={confirm} noValidate aria-label="confirmar verificación en dos pasos">
          <ol>
            <li>Abre tu app de autenticación y añade una cuenta escaneando este código QR:</li>
          </ol>
          <QrSvg value={stage.otpauthUrl} label="código QR para la app de autenticación" />
          <p>
            ¿No puedes escanearlo? Escribe esta clave en la app (tipo «basada en el tiempo»):{" "}
            <code data-testid="totp-secret">{groupSecret(stage.secret)}</code>
          </p>
          <ol start={2}>
            <li>Escribe el código de 6 cifras que aparece en la app y pulsa «Confirmar».</li>
          </ol>
          <p>
            <label>
              Código de la app{" "}
              <input
                aria-label="código de confirmación"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={9}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
          </p>
          <p>
            <small>
              Hasta que confirmes, la verificación en dos pasos NO está activa: si cancelas, tu cuenta sigue como
              estaba.
            </small>
          </p>
          <button type="submit" disabled={busy}>
            Confirmar
          </button>{" "}
          <button
            type="button"
            className="link"
            onClick={() => {
              resetForms();
              setStage({ kind: "off" });
            }}
          >
            Cancelar
          </button>
        </form>
      )}

      {stage.kind === "codes" && (
        <div data-testid="recovery-codes">
          <p className="warn" role="alert">
            {stage.reason === "enabled"
              ? "Verificación en dos pasos ACTIVADA. "
              : "Códigos de recuperación NUEVOS: los anteriores ya no sirven. "}
            Guarda estos códigos ahora en un lugar seguro (gestor de contraseñas o papel). Es la única vez que se
            muestran. Cada uno sirve para entrar UNA vez si pierdes el móvil.
          </p>
          <ul aria-label="códigos de recuperación" style={{ fontFamily: "monospace", columns: 2 }}>
            {stage.codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <p>
            <label>
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> Los he guardado
            </label>
          </p>
          <button type="button" onClick={finishCodes} disabled={!saved}>
            Hecho
          </button>
        </div>
      )}

      {stage.kind === "on" && (
        <>
          <p data-testid="twofa-status">
            Estado: <strong>activada</strong>. Te quedan <strong>{stage.remaining}</strong> códigos de recuperación.
          </p>
          {stage.remaining < LOW_RECOVERY_CODES && (
            <p className="warn" role="alert" data-testid="twofa-low-codes">
              Te quedan pocos códigos de recuperación. Genera unos nuevos para no quedarte sin forma de entrar si
              pierdes el móvil.
            </p>
          )}
          <form onSubmit={(e) => e.preventDefault()} noValidate aria-label="gestionar verificación en dos pasos">
            <p>
              Para <strong>regenerar los códigos de recuperación</strong> (crea 8 nuevos y anula todos los anteriores,
              también los no usados) o para <strong>desactivar</strong> la verificación (tu cuenta volverá a pedir sólo
              la contraseña y se cerrarán tus otras sesiones), confirma que eres tú:
            </p>
            <ReauthFields
              idPrefix="2fa"
              password={password}
              code={reauthCode}
              onPassword={setPassword}
              onCode={setReauthCode}
            />
            <button type="button" disabled={busy} onClick={() => void reauthAction("regenerate")}>
              Regenerar los códigos
            </button>{" "}
            <button type="button" disabled={busy} onClick={() => void reauthAction("disable")}>
              Desactivar la verificación en dos pasos
            </button>
          </form>
        </>
      )}

      {error && (
        <p className="error" role="alert" data-testid="twofa-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" data-testid="twofa-done">
          {notice}
        </p>
      )}

      <details data-testid="twofa-help">
        <summary>¿Has perdido el móvil o la app?</summary>
        <ol>
          <li>
            En «Iniciar sesión» escribe tu email y tu contraseña y pulsa «Entrar». Aparecerá el campo «Código TOTP».
          </li>
          <li>
            Escribe ahí <strong>uno de tus códigos de recuperación</strong> (12 caracteres; da igual mayúsculas,
            espacios o guiones) y vuelve a pulsar «Entrar». Ese código queda gastado.
          </li>
          <li>
            Ya dentro, vuelve aquí: regenera los códigos o desactiva la verificación y actívala otra vez con el móvil
            nuevo.
          </li>
        </ol>
        <p>Sin móvil y sin códigos no hay forma de entrar desde la web: pide a un administrador que te ayude.</p>
      </details>
    </div>
  );
}
