/**
 * ADM-1 · Componente REUTILIZABLE de confirmación en dos pasos para acciones destructivas.
 *
 * Paso 1 (lo hace la pantalla que lo usa): `POST /admin/operations` → el SERVIDOR devuelve el
 * resumen de impacto, la frase literal y el token de un solo uso. Paso 2 (este componente): muestra
 * el impacto TAL CUAL lo calculó el servidor (la UI no calcula nada), exige teclear la frase
 * LITERAL y la contraseña (y el TOTP si la cuenta lo tiene) y sólo entonces habilita «Confirmar».
 * La autorización real la hace la API (token, frase, reautenticación y segundo admin): esto
 * sólo evita errores humanos y no autoriza nada.
 */
import { useState } from "react";
import { Button, Field, FormError, Panel } from "../../ui/primitives.js";

export interface ConfirmImpact {
  summary: string;
  counts: Record<string, number>;
}

export interface ConfirmCredentials {
  phrase: string;
  password: string;
  totp?: string;
}

/** La frase debe coincidir EXACTAMENTE (salvo espacios en los extremos), sin normalizar mayúsculas. */
export function phraseMatches(typed: string, phrase: string): boolean {
  return phrase.length > 0 && typed.trim() === phrase;
}

export function ConfirmDestructive(props: {
  title: string;
  impact: ConfirmImpact;
  /** Frase literal fijada por el servidor. */
  phrase: string;
  /** La confirma un admin distinto del solicitante. */
  requiresSecondAdmin?: boolean;
  /** La cuenta tiene 2FA: pedir el código. */
  needsTotp?: boolean;
  /** Fallo de la última confirmación (se pinta en el propio componente). */
  error?: unknown;
  busy?: boolean;
  onConfirm: (c: ConfirmCredentials) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const ready =
    phraseMatches(typed, props.phrase) && password.length > 0 && (!props.needsTotp || totp.trim().length > 0);
  const counts = Object.entries(props.impact.counts);

  return (
    <Panel data-testid="confirm-destructive">
      <h3>{props.title}</h3>
      <p data-testid="confirm-impact-summary">
        <strong>Impacto:</strong> {props.impact.summary}
      </p>
      {counts.length > 0 && (
        <ul data-testid="confirm-impact-counts">
          {counts.map(([k, v]) => (
            <li key={k}>
              {k}: {v}
            </li>
          ))}
        </ul>
      )}
      {props.requiresSecondAdmin && (
        <p role="note" data-testid="confirm-second-admin">
          Acción irreversible: la tiene que confirmar un segundo administrador, distinto de quien la solicitó.
        </p>
      )}
      <Field
        label="Escribe la frase exacta para confirmar"
        hint={<code data-testid="confirm-phrase">{props.phrase}</code>}
      >
        {(c) => (
          <input
            {...c}
            data-testid="confirm-phrase-input"
            value={typed}
            autoComplete="off"
            onChange={(e) => setTyped(e.target.value)}
          />
        )}
      </Field>
      <Field label="Tu contraseña (reautenticación)">
        {(c) => (
          <input
            {...c}
            type="password"
            data-testid="confirm-password-input"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        )}
      </Field>
      {props.needsTotp && (
        <Field label="Código de 2FA (o de recuperación)">
          {(c) => (
            <input
              {...c}
              data-testid="confirm-totp-input"
              value={totp}
              autoComplete="one-time-code"
              onChange={(e) => setTotp(e.target.value)}
            />
          )}
        </Field>
      )}
      <FormError error={props.error} data-testid="confirm-error" />
      <p>
        <Button
          data-testid="confirm-submit"
          disabled={!ready || props.busy}
          onClick={() =>
            void props.onConfirm({ phrase: typed.trim(), password, totp: props.needsTotp ? totp.trim() : undefined })
          }
        >
          Confirmar
        </Button>{" "}
        <Button data-testid="confirm-cancel" variant="link" onClick={props.onCancel}>
          Cancelar
        </Button>
      </p>
    </Panel>
  );
}
