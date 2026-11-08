/**
 * VISIBILIDAD (2026-11) · Controles del DUEÑO para las dos visibilidades
 * independientes de un bot:
 *  - BOT_VISIBILITY (la ficha): `PATCH /bots/{id}` con `visibility` (API existente);
 *  - CODE_VISIBILITY (el código de UNA versión): `PUT /bots/{id}/versions/{v}/code-visibility`.
 * Ninguna depende de la otra, ni de la publicación, ni de los torneos, ni del
 * streaming. La autorización real es de la API (sólo el dueño); la UI sólo
 * evita enseñar controles a quien no podría usarlos.
 */
import { useState } from "react";
import { api } from "./api.js";
import { FormError } from "./ui/primitives.js";

export type BotVisibility = "private" | "team" | "public";

export const BOT_VISIBILITY_OPTIONS: ReadonlyArray<{ value: BotVisibility; label: string; help: string }> = [
  { value: "private", label: "Privado", help: "Sólo tú." },
  { value: "team", label: "Equipo", help: "Los miembros del equipo del bot." },
  { value: "public", label: "Público", help: "Cualquier usuario o visitante." },
];

export const BOT_VISIBILITY_NOTE = "La visibilidad del bot no controla la visibilidad de su código fuente.";
export const COMPETITION_NOTE =
  "Participar en un torneo o salir en una retransmisión no cambia esta visibilidad: en una competición pública sólo se muestran el nombre, la versión, el equipo y el resultado.";
export const CODE_PRIVATE_AGAIN_WARNING =
  "Volver a privado impide nuevas descargas, pero quien ya descargó el código conserva su copia.";

export function botVisibilityLabel(v: string): string {
  return BOT_VISIBILITY_OPTIONS.find((o) => o.value === v)?.label ?? v;
}

/** Control de la visibilidad de la FICHA del bot. Sólo se pinta para el dueño. */
export function BotVisibilityControl(props: {
  botId: string;
  visibility: string;
  hasTeam: boolean;
  onChanged: (visibility: BotVisibility) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function choose(v: BotVisibility) {
    if (v === props.visibility || busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api<{ visibility: BotVisibility }>("PATCH", `/bots/${encodeURIComponent(props.botId)}`, {
        visibility: v,
      });
      props.onChanged(updated.visibility);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <fieldset data-testid="bot-visibility-control" aria-busy={busy}>
      <legend>Visibilidad del bot</legend>
      {BOT_VISIBILITY_OPTIONS.map((o) => (
        <label key={o.value} style={{ marginRight: "1em" }}>
          <input
            type="radio"
            name={`bot-visibility-${props.botId}`}
            value={o.value}
            data-testid={`bot-visibility-${o.value}`}
            checked={props.visibility === o.value}
            disabled={busy}
            onChange={() => void choose(o.value)}
          />{" "}
          {o.label} <small>({o.help})</small>
        </label>
      ))}
      {props.visibility === "team" && !props.hasTeam && (
        <p className="warn" data-testid="bot-visibility-no-team">
          Este bot no tiene equipo asignado: «Equipo» equivale a privado.
        </p>
      )}
      <p>
        <small data-testid="bot-visibility-note">{BOT_VISIBILITY_NOTE}</small>
      </p>
      <p>
        <small>{COMPETITION_NOTE}</small>
      </p>
      <FormError error={error} data-testid="bot-visibility-error" />
    </fieldset>
  );
}

/** «Código de v4 [Privado][Público]». Sólo se pinta para el dueño. */
export function CodeVisibilityControl(props: {
  botId: string;
  version: number;
  codePublic: boolean;
  onChanged: (codePublic: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function choose(codePublic: boolean) {
    if (codePublic === props.codePublic || busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api<{ codePublic: boolean }>(
        "PUT",
        `/bots/${encodeURIComponent(props.botId)}/versions/${props.version}/code-visibility`,
        { codePublic },
      );
      props.onChanged(updated.codePublic === true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <span data-testid={`code-visibility-${props.version}`} aria-busy={busy}>
      Código de v{props.version}{" "}
      <button
        type="button"
        data-testid={`code-private-${props.version}`}
        aria-pressed={!props.codePublic}
        disabled={busy}
        onClick={() => void choose(false)}
      >
        Privado
      </button>
      <button
        type="button"
        data-testid={`code-public-${props.version}`}
        aria-pressed={props.codePublic}
        disabled={busy}
        onClick={() => void choose(true)}
      >
        Público
      </button>
      {props.codePublic && (
        <small className="warn" data-testid={`code-private-warning-${props.version}`}>
          {" "}
          {CODE_PRIVATE_AGAIN_WARNING}
        </small>
      )}
      <FormError error={error} data-testid={`code-visibility-error-${props.version}`} />
    </span>
  );
}
