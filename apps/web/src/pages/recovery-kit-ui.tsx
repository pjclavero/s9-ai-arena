/**
 * V1 ADM-SETUP · D-5 · Piezas comunes del kit de recuperación del administrador en la web.
 *
 * El kit se muestra UNA sola vez (al crear el primer admin y al regenerarlo). Esta pieza lo enseña,
 * deja copiarlo y no permite seguir hasta marcar «lo he guardado».
 */
import { useState } from "react";

export function RecoveryKitReveal(props: { kit: string; onDone: () => void; doneLabel: string }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(props.kit);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="card" data-testid="recovery-kit-reveal">
      <h2>Kit de recuperación</h2>
      <p>
        Guárdalo <strong>ahora</strong> fuera de esta máquina (gestor de contraseñas o papel). Sólo se muestra esta vez.
        Si algún día olvidas la contraseña, con tu email y este kit podrás fijar una nueva desde la web, sin consola.
        Sirve una sola vez; después puedes generar otro.
      </p>
      <p>
        <code data-testid="recovery-kit-value" style={{ fontSize: "1.1em", userSelect: "all" }}>
          {props.kit}
        </code>{" "}
        <button type="button" onClick={() => void copy()}>
          Copiar
        </button>{" "}
        {copied && <small role="status">Copiado.</small>}
      </p>
      <p>
        <label>
          <input
            type="checkbox"
            aria-label="lo he guardado"
            checked={saved}
            onChange={(e) => setSaved(e.target.checked)}
          />{" "}
          He guardado el kit en un lugar seguro
        </label>
      </p>
      <button type="button" disabled={!saved} onClick={props.onDone} data-testid="recovery-kit-done">
        {props.doneLabel}
      </button>
    </div>
  );
}
