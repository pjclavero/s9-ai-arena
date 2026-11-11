/**
 * #255 · B5-B7 · «Hacer públicos los bots que administras» desde la pantalla de
 * Equipo, con previsualización y confirmación obligatoria.
 *
 * La previsualización y el cambio salen del MISMO endpoint del servidor
 * (POST /teams/{id}/actions/publish-bots; `dryRun: true` para previsualizar), que es
 * quien decide qué bots puede cambiar cada persona: SÓLO los suyos (ser capitán no
 * da autoridad sobre bots ajenos). La web no repite esa regla: pinta lo que responde
 * el servidor, también los no autorizados y los parciales, sin ocultar nada.
 *
 * BOT_PUBLIC = sí. CODE_PUBLIC = sin cambios, salvo la casilla explícita «Hacer
 * también público el código de la versión publicada».
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiRequestError } from "../api.js";
import { FormError } from "../ui/primitives.js";

/** Respuesta de publishTeamBots (contrato 0.17.0). */
export interface BulkResult {
  dryRun: boolean;
  includeCode: boolean;
  results: {
    botId: string;
    name: string;
    outcome: "made_public" | "would_make_public" | "already_public" | "not_authorized" | "retired";
    code?: { version: number | null; outcome: string };
  }[];
  summary: { changed: number; alreadyPublic: number; notAuthorized: number; retired?: number };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * #255 R1 (P3-3) · el botón dice lo que va a pasar de verdad: si sólo cambia el
 * código, no «hacer públicos 0 bots».
 */
export function confirmLabel(bots: number, codes: number): string {
  const b = `hacer ${bots === 1 ? "público" : "públicos"} ${plural(bots, "bot", "bots")}`;
  const c = `hacer público el código de ${plural(codes, "versión", "versiones")}`;
  if (bots > 0 && codes > 0) return `Confirmar: ${b} y ${c.replace("hacer público ", "")}`;
  if (codes > 0) return `Confirmar: ${c}`;
  return `Confirmar: ${b}`;
}

function codeText(code: { version: number | null; outcome: string } | undefined): string {
  if (!code) return "";
  switch (code.outcome) {
    case "would_make_public":
    case "made_public":
      return ` y el código de v${code.version}`;
    case "already_public":
      return ` (el código de v${code.version} ya era público)`;
    case "no_published_version":
      return " (sin versión publicada: su código no cambia)";
    default:
      return "";
  }
}

export function TeamBulkPublic(props: { team: { id: string; name: string }; onChanged: () => void }) {
  const { team } = props;
  const [open, setOpen] = useState(false);
  const [includeCode, setIncludeCode] = useState(false);
  const [preview, setPreview] = useState<BulkResult | null>(null);
  const [result, setResult] = useState<BulkResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // #255 R1 (P3-1) · el equipo cambió entre la previsualización y la confirmación.
  const [stale, setStale] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const path = `/teams/${encodeURIComponent(team.id)}/actions/publish-bots`;

  async function loadPreview(withCode: boolean) {
    setBusy(true);
    setError(null);
    try {
      setPreview(await api<BulkResult>("POST", path, { dryRun: true, includeCode: withCode }));
    } catch (e) {
      setPreview(null);
      setError(e ?? new Error("error desconocido"));
    } finally {
      setBusy(false);
    }
  }
  function openDialog() {
    setOpen(true);
    setStale(false);
    setResult(null);
    setIncludeCode(false);
    void loadPreview(false);
  }
  // Al cerrar, el foco vuelve al botón que abrió el diálogo. Tras pintar: mientras el
  // diálogo está abierto el botón está deshabilitado y no admite el foco.
  const returnFocus = useRef(false);
  function close() {
    setOpen(false);
    setStale(false);
    setPreview(null);
    setError(null);
    returnFocus.current = true;
  }
  useEffect(() => {
    if (open) titleRef.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  async function confirm() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      // #255 R1 (P3-1) · la confirmación va atada a lo previsualizado: si el servidor
      // ve otro conjunto de bots, responde 409 y no cambia nada.
      const expectBotIds = preview.results.map((r) => r.botId);
      const r = await api<BulkResult>("POST", path, { dryRun: false, includeCode, expectBotIds });
      setResult(r);
      returnFocus.current = true;
      setOpen(false);
      setPreview(null);
      props.onChanged();
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 409 && e.body?.error === "team_bots_changed") {
        // No se ha cambiado nada: se vuelve a previsualizar y se pide confirmar otra vez.
        setStale(true);
        setBusy(false);
        await loadPreview(includeCode);
        return;
      }
      setError(e ?? new Error("error desconocido"));
    } finally {
      setBusy(false);
    }
  }

  const will = preview?.results.filter((r) => r.outcome === "would_make_public") ?? [];
  const already = preview?.results.filter((r) => r.outcome === "already_public") ?? [];
  const denied = preview?.results.filter((r) => r.outcome === "not_authorized") ?? [];
  const retired = preview?.results.filter((r) => r.outcome === "retired") ?? [];
  const codeChanges = preview?.results.filter((r) => r.code?.outcome === "would_make_public") ?? [];
  const nothingToDo = !!preview && will.length === 0 && codeChanges.length === 0;
  const titleId = `bulk-title-${team.id}`;

  return (
    <div className="card" data-testid="team-bulk-public">
      <h4>Visibilidad de los bots del equipo</h4>
      <p>
        <button type="button" ref={triggerRef} data-testid="team-bulk-open" onClick={openDialog} disabled={open}>
          Hacer públicos los bots que administras
        </button>{" "}
        <small>
          Sólo cambian los bots de los que eres dueño (ser capitán no da permiso sobre los bots de otros). Antes de
          cambiar nada verás la lista y tendrás que confirmar.
        </small>
      </p>
      {open && (
        <div
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          className="confirm-panel"
          data-testid="team-bulk-dialog"
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
          }}
        >
          <h5 id={titleId} ref={titleRef} tabIndex={-1}>
            ¿Hacer públicos los bots de «{team.name}» que administras?
          </h5>
          {busy && !preview && <p role="status">Comprobando qué bots puedes cambiar…</p>}
          <FormError error={error} data-testid="team-bulk-error" />
          {stale && (
            <p className="warn" role="status" data-testid="team-bulk-stale">
              Los bots del equipo han cambiado desde la previsualización: no se ha cambiado nada. Revisa la lista nueva
              y vuelve a confirmar.
            </p>
          )}
          {preview && (
            <>
              <div data-testid="team-bulk-will">
                <strong>Se harán públicos ({will.length}):</strong>
                {will.length === 0 ? (
                  <p>Ninguno.</p>
                ) : (
                  <ul>
                    {will.map((r) => (
                      <li key={r.botId} data-testid={`bulk-will-${r.name}`}>
                        ✓ {r.name}
                        {codeText(r.code)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {already.length > 0 && (
                <div data-testid="team-bulk-already">
                  <strong>Ya son públicos ({already.length}):</strong>
                  <ul>
                    {already.map((r) => (
                      <li key={r.botId}>
                        {r.name}
                        {codeText(r.code)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {denied.length > 0 && (
                <div data-testid="team-bulk-denied">
                  <strong>No se modificarán porque no eres su dueño ({denied.length}):</strong>
                  <ul>
                    {denied.map((r) => (
                      <li key={r.botId} data-testid={`bulk-denied-${r.name}`}>
                        ✗ {r.name}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {retired.length > 0 && (
                <div data-testid="team-bulk-retired">
                  <strong>No se modificarán porque están retirados ({retired.length}):</strong>
                  <ul>
                    {retired.map((r) => (
                      <li key={r.botId} data-testid={`bulk-retired-${r.name}`}>
                        – {r.name} (si quieres hacerlo público, reactívalo o cámbialo en su ficha)
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p data-testid="team-bulk-untouched">
                <strong>No se modificarán:</strong>{" "}
                {includeCode
                  ? "las versiones, el equipamiento ni el código de las demás versiones."
                  : "el código fuente, las versiones ni el equipamiento."}
              </p>
              <p>
                <label>
                  <input
                    type="checkbox"
                    data-testid="team-bulk-include-code"
                    checked={includeCode}
                    disabled={busy}
                    onChange={(e) => {
                      setIncludeCode(e.target.checked);
                      void loadPreview(e.target.checked);
                    }}
                  />{" "}
                  Hacer también público el código de la versión publicada de esos bots
                </label>
                <br />
                <small>Por defecto el código NO cambia: hacer público el bot no hace público su código.</small>
              </p>
              {nothingToDo && (
                <p className="warn" data-testid="team-bulk-nothing">
                  No hay nada que cambiar: no administras ningún bot de este equipo que no sea ya público.
                </p>
              )}
            </>
          )}
          <p>
            <button
              type="button"
              data-testid="team-bulk-confirm"
              disabled={busy || !preview || nothingToDo}
              onClick={() => void confirm()}
            >
              {busy && preview ? "Aplicando…" : confirmLabel(will.length, codeChanges.length)}
            </button>{" "}
            <button type="button" data-testid="team-bulk-cancel" onClick={close}>
              Cancelar
            </button>
          </p>
        </div>
      )}
      {result && (
        <div role="status" data-testid="team-bulk-result">
          <p>
            <strong data-testid="team-bulk-summary">
              Resultado: {result.summary.changed} {result.summary.changed === 1 ? "bot pasa" : "bots pasan"} a público
              {result.summary.alreadyPublic > 0 ? ` · ${result.summary.alreadyPublic} ya lo era(n)` : ""}
              {result.summary.notAuthorized > 0
                ? ` · ${result.summary.notAuthorized} sin autorización: no se han tocado`
                : ""}
              {(result.summary.retired ?? 0) > 0 ? ` · ${result.summary.retired} retirado(s): no se han tocado` : ""}.
            </strong>
          </p>
          <ul>
            {result.results.map((r) => (
              <li key={r.botId} data-testid={`bulk-result-${r.name}`} data-outcome={r.outcome}>
                {r.outcome === "made_public"
                  ? `✓ ${r.name}: ahora es público`
                  : r.outcome === "already_public"
                    ? `· ${r.name}: ya era público`
                    : r.outcome === "retired"
                      ? `– ${r.name}: retirado, no se ha tocado`
                      : `✗ ${r.name}: sin autorización (sólo su dueño puede cambiar su visibilidad)`}
                {r.code?.outcome === "made_public" ? ` · el código de v${r.code.version} ahora es público` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
