/**
 * VISIBILIDAD (2026-11) · Controles del DUEÑO para las dos visibilidades
 * independientes de un bot (#255: juntas en UNA tarjeta, `BotVisibilityCard`,
 * que es el ÚNICO sitio donde se editan; el resto de la web sólo las muestra):
 *  - BOT_VISIBILITY (la ficha): `PATCH /bots/{id}` con `visibility` (API existente);
 *  - CODE_VISIBILITY (el código de UNA versión): `PUT /bots/{id}/versions/{v}/code-visibility`.
 * Ninguna depende de la otra, ni de la publicación, ni de los torneos, ni del
 * streaming. La autorización real es de la API (sólo el dueño); la UI sólo
 * evita enseñar controles a quien no podría usarlos.
 */
import { useState, type ReactNode } from "react";
import { api } from "./api.js";
import { FormError } from "./ui/primitives.js";

export type BotVisibility = "private" | "team" | "public";

export const BOT_VISIBILITY_OPTIONS: ReadonlyArray<{ value: BotVisibility; label: string; help: string }> = [
  { value: "private", label: "Privado", help: "Sólo tú." },
  { value: "team", label: "Equipo", help: "Los miembros del equipo del bot." },
  { value: "public", label: "Público", help: "Cualquier usuario o visitante." },
];

export const BOT_VISIBILITY_NOTE = "Hacer público el bot NO hace público automáticamente su código.";
/** #255 · y viceversa. */
export const CODE_VISIBILITY_NOTE = "Hacer público el código de una versión NO hace público el bot.";
export const COMPETITION_NOTE =
  "Participar en un torneo o salir en una retransmisión no cambia esta visibilidad: en una competición pública sólo se muestran el nombre, la versión, el equipo y el resultado.";
export const CODE_PRIVATE_AGAIN_WARNING =
  "Volver a privado impide nuevas descargas, pero quien ya descargó el código conserva su copia.";

export function botVisibilityLabel(v: string): string {
  return BOT_VISIBILITY_OPTIONS.find((o) => o.value === v)?.label ?? v;
}

/**
 * Control de la visibilidad de la FICHA del bot. Sólo se pinta para el dueño, y
 * sólo dentro de `BotVisibilityCard` (que lleva la nota de independencia).
 */
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

/** Versión tal y como la necesita la tarjeta (la de GET /bots/{id}/versions). */
export interface VisibilityVersion {
  version: number;
  state: string;
  codePublic?: boolean;
}

const dot = (pub: boolean) => (
  <span aria-hidden="true" className={pub ? "ok" : "muted"}>
    ●
  </span>
);

/**
 * #255 · B3-B4 · Tarjeta ÚNICA de visibilidad: la del bot y la del código de cada
 * versión, juntas y explicadas como independientes. Una sola fuente de verdad: cada
 * estado tiene UN control editable (la versión publicada más reciente arriba, como
 * acción rápida; las demás en la lista, sin repetir la publicada). Sin permiso de
 * dueño, todo es texto (la API manda igual).
 */
export function BotVisibilityCard(props: {
  botId: string;
  visibility: string;
  hasTeam: boolean;
  versions: VisibilityVersion[];
  canEdit: boolean;
  onBotChanged: (visibility: BotVisibility) => void;
  onCodeChanged: (version: number, codePublic: boolean) => void;
}) {
  const published = props.versions.filter((v) => v.state === "published").map((v) => v.version);
  const pubVersion = published.length ? Math.max(...published) : undefined;
  const pub = props.versions.find((v) => v.version === pubVersion);
  const others = [...props.versions].filter((v) => v.version !== pubVersion).sort((a, b) => b.version - a.version);
  const botPublic = props.visibility === "public";
  const codeLine = (v: VisibilityVersion): ReactNode =>
    props.canEdit ? (
      <CodeVisibilityControl
        botId={props.botId}
        version={v.version}
        codePublic={v.codePublic === true}
        onChanged={(c) => props.onCodeChanged(v.version, c)}
      />
    ) : (
      <span data-testid={`code-visibility-readonly-${v.version}`}>
        Código de v{v.version}: {v.codePublic ? "público" : "privado"}
      </span>
    );
  return (
    <div className="card" data-testid="visibility-card">
      <p data-testid="visibility-independence">
        <strong>{BOT_VISIBILITY_NOTE}</strong> {CODE_VISIBILITY_NOTE}
      </p>
      <p data-testid="visibility-quick" aria-label="estado actual de la visibilidad">
        <span data-testid="visibility-quick-bot">
          Bot {dot(botPublic)} {botVisibilityLabel(props.visibility)}
        </span>
        {" · "}
        <span data-testid="visibility-quick-code">
          {pub ? (
            <>
              Código v{pub.version} {dot(pub.codePublic === true)} {pub.codePublic ? "Público" : "Privado"}
            </>
          ) : (
            "Sin versión publicada"
          )}
        </span>
      </p>
      {props.canEdit ? (
        <BotVisibilityControl
          botId={props.botId}
          visibility={props.visibility}
          hasTeam={props.hasTeam}
          onChanged={props.onBotChanged}
        />
      ) : (
        <p data-testid="bot-visibility-readonly">Visibilidad del bot: {botVisibilityLabel(props.visibility)}</p>
      )}
      <fieldset data-testid="code-visibility-published">
        <legend>Código de la versión publicada</legend>
        {pub ? <p>{codeLine(pub)}</p> : <p className="muted">Este bot no tiene ninguna versión publicada.</p>}
      </fieldset>
      {others.length > 0 && (
        <details data-testid="code-visibility-others">
          <summary>Código de las demás versiones ({others.length})</summary>
          <p className="muted">
            <small>Sólo se puede leer públicamente el código de una versión PUBLICADA y marcada como pública.</small>
          </p>
          <ul>
            {others.map((v) => (
              <li key={v.version}>
                {codeLine(v)} <small>({v.state})</small>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
