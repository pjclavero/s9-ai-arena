/**
 * R7-A · Listado de los replays que el usuario puede ver.
 *
 * PRC (TD-004) · Consume `GET /api/v1/replays` (listReplays): SÓLO los replays que el
 * usuario puede ver (staff, dueño o equipo de un bot participante, o públicos si
 * S9_PUBLIC_REPLAYS_ENABLED). Antes leía `GET /replays/` del replay-service a
 * través del gateway: el inventario de TODOS los ficheros, también para anónimos.
 * Enlaza al reproductor (`#/replay/:battleId`). No expone secretos ni rutas internas.
 *
 * TD-014 sigue cerrada: la ruta es de la API (`/api/v1/replays`), sin barra final
 * ni redirección; el gateway ya no tiene `location /replays/` que redirigir.
 *
 * FC-D (D1/D2) · Estados con los componentes comunes: carga, error clasificado
 * (502 del gateway, timeout, red) con «Reintentar», vacío con siguiente paso.
 *
 * EQ4 · Búsqueda, filtros y paginación EN SERVIDOR. Nunca se descargan todas las
 * filas para filtrar aquí: cada filtro viaja como parámetro de `listReplays` y la
 * API lo aplica junto con la política de acceso. El estado de los filtros vive en
 * el hash (`#/replays?mode=deathmatch&bot=<id>`), así que se puede enlazar desde
 * otras pantallas (detalle de bot o de equipo) y sobrevive a F5. La paginación es
 * por cursor (`nextCursor`); «Anterior» recuerda los cursores ya recorridos.
 * Sin ningún filtro la petición es exactamente la de siempre (`GET /replays`).
 */
import { PLATFORM_MODES } from "../map-editor/model.js";
import { useEffect, useId, useState, type FormEvent } from "react";
import { api } from "../api.js";
import { ApiRequestError } from "../errors.js";
import { useResource, ResourceView } from "../resource.js";
import { Button, EmptyState } from "../ui/primitives.js";
import { MODE_NAME, teamText } from "../battle-result.js";

interface ReplaySummary {
  battleId: string;
  ticks: number;
  winner: string;
  /** ADR-022 · `technical_limit`: detenida por límite técnico, sin resultado deportivo. */
  endReason?: string;
  official: boolean;
  createdAt: string;
  sizeBytes: number;
}

interface ReplayPage {
  items: ReplaySummary[];
  nextCursor?: string;
  total?: number;
}

/** Ruta del listado en la API (relativa a /api/v1, la antepone `api()`). */
export const REPLAYS_LIST_PATH = "/replays";

/** Duración aproximada de un replay a 30 ticks/s (motor E2). */
export function formatTicksAsDuration(ticks: number): string {
  const s = Math.round(ticks / 30);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Modos con su nombre humano (el de CTF lleva la sigla, que es como se le conoce). */
export const REPLAY_MODE_OPTIONS: [string, string][] = PLATFORM_MODES.map((m) => [
  m,
  m === "capture_the_flag" ? `${MODE_NAME[m]} (CTF)` : MODE_NAME[m],
]);

export const REPLAY_RESULT_OPTIONS: [string, string][] = [
  ["win", "Victoria"],
  ["loss", "Derrota"],
  ["draw", "Empate"],
  ["aborted", "Abortada o con incidencia"],
];

/** Filtros tal y como viven en el hash (fechas como AAAA-MM-DD locales). */
export interface ReplayFilters {
  battleId: string;
  from: string;
  to: string;
  mode: string;
  result: string;
  bot: string;
  team: string;
  user: string;
}

export const FILTER_KEYS = ["battleId", "from", "to", "mode", "result", "bot", "team", "user"] as const;
const EMPTY: ReplayFilters = { battleId: "", from: "", to: "", mode: "", result: "", bot: "", team: "", user: "" };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Lee los filtros del hash `#/replays?…`; lo desconocido se ignora. */
export function filtersFromHash(hash: string): ReplayFilters {
  const i = hash.indexOf("?");
  const sp = new URLSearchParams(i >= 0 ? hash.slice(i + 1) : "");
  const f: ReplayFilters = { ...EMPTY };
  for (const k of FILTER_KEYS) f[k] = (sp.get(k) ?? "").trim();
  if (!REPLAY_MODE_OPTIONS.some(([v]) => v === f.mode)) f.mode = "";
  if (!REPLAY_RESULT_OPTIONS.some(([v]) => v === f.result)) f.result = "";
  if (!DATE_RE.test(f.from)) f.from = "";
  if (!DATE_RE.test(f.to)) f.to = "";
  return f;
}

/** Hash canónico para unos filtros (sin filtros = `#/replays`). */
export function hashForFilters(f: ReplayFilters): string {
  const sp = new URLSearchParams();
  for (const k of FILTER_KEYS) if (f[k].trim()) sp.set(k, f[k].trim());
  const qs = sp.toString();
  return qs ? `#/replays?${qs}` : "#/replays";
}

export function hasFilters(f: ReplayFilters): boolean {
  return FILTER_KEYS.some((k) => f[k].trim() !== "");
}

/** Fecha local AAAA-MM-DD → instante ISO del inicio (o del final) de ese día en la zona del navegador. */
function localDayBound(day: string, end: boolean): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = end ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d, 0, 0, 0, 0);
  return dt.toISOString();
}

/**
 * Ruta de la API para unos filtros y un cursor. Sin filtros ni cursor es
 * EXACTAMENTE `/replays` (la petición histórica). Con filtros pide `total`.
 */
export function replaysQueryPath(f: ReplayFilters, cursor?: string): string {
  const sp = new URLSearchParams();
  if (f.battleId.trim()) sp.set("battleId", f.battleId.trim());
  if (f.from) sp.set("from", localDayBound(f.from, false));
  if (f.to) sp.set("to", localDayBound(f.to, true));
  if (f.mode) sp.set("mode", f.mode);
  if (f.result) sp.set("result", f.result);
  for (const k of ["bot", "team", "user"] as const) if (f[k].trim()) sp.set(k, f[k].trim());
  if (hasFilters(f)) sp.set("includeTotal", "true");
  if (cursor) sp.set("cursor", cursor);
  const qs = sp.toString();
  return qs ? `${REPLAYS_LIST_PATH}?${qs}` : REPLAYS_LIST_PATH;
}

/** Validación de cliente (la autoridad es la API, que responde 400). */
export function validateFilters(f: ReplayFilters): string | null {
  if (f.battleId.trim() && !/^[0-9a-fA-F][0-9a-fA-F-]{0,35}$/.test(f.battleId.trim())) {
    return "El ID de batalla sólo admite dígitos, letras a-f y guiones (un UUID o su principio).";
  }
  if (f.from && f.to && f.from > f.to) return "La fecha «desde» no puede ser posterior a «hasta».";
  for (const [k, label] of [
    ["bot", "bot"],
    ["team", "equipo"],
    ["user", "usuario"],
  ] as const) {
    if (f[k].trim().length > 48 && !/^[0-9a-f-]{36}$/i.test(f[k].trim())) {
      return `El ${label} debe ser un id o un nombre de como mucho 48 caracteres.`;
    }
  }
  return null;
}

export function ReplaysPage() {
  const formId = useId();
  const [filters, setFilters] = useState<ReplayFilters>(() => filtersFromHash(window.location.hash));
  const [draft, setDraft] = useState<ReplayFilters>(filters);
  const [formError, setFormError] = useState<string | null>(null);
  /** Cursores de las páginas anteriores a la actual (la primera es `undefined`). */
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors[cursors.length - 1];
  /** EQ1 · el cursor de la página caducó (400): se volvió a la primera página. */
  const [cursorReset, setCursorReset] = useState(false);

  // Un enlace externo a `#/replays?…` con la página ya abierta cambia los filtros.
  useEffect(() => {
    const onHash = () => {
      if (!/^#\/replays\/?(?:\?.*)?$/.test(window.location.hash)) return;
      const next = filtersFromHash(window.location.hash);
      setFilters((prev) => (hashForFilters(prev) === hashForFilters(next) ? prev : next));
      setDraft(next);
      setCursors([undefined]);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const filterKey = hashForFilters(filters);
  const [list, reload] = useResource(async () => {
    let body: ReplayPage;
    try {
      body = await api<ReplayPage>("GET", replaysQueryPath(filters, cursor));
    } catch (e) {
      // EQ1 · un cursor inválido o caducado (p. ej. de antes de un despliegue) da 400:
      // en vez de quedarse en error con «Reintentar» (que repetiría el mismo cursor), se
      // vuelve a la primera página con los mismos filtros. Un 400 en la primera página
      // (filtro inválido) se muestra como siempre.
      if (cursor === undefined || !(e instanceof ApiRequestError) || e.status !== 400) throw e;
      setCursors([undefined]);
      setCursorReset(true);
      body = await api<ReplayPage>("GET", replaysQueryPath(filters));
    }
    if (!body || !Array.isArray(body.items)) throw new Error("respuesta de la API de replays sin `items`");
    return body;
  }, [filterKey, cursor]);

  function apply(next: ReplayFilters) {
    const err = validateFilters(next);
    setFormError(err);
    if (err) return;
    setFilters(next);
    setCursors([undefined]);
    setCursorReset(false);
    const hash = hashForFilters(next);
    // replaceState: actualiza la URL sin disparar `hashchange` (no se re-enruta el panel).
    if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    apply(draft);
  }

  function clear() {
    setDraft({ ...EMPTY });
    apply({ ...EMPTY });
  }

  const set = (k: keyof ReplayFilters) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }));
  const fid = (k: string) => `${formId}-${k}`;
  const filtered = hasFilters(filters);
  const page = cursors.length;

  return (
    <section>
      <h2>Replays</h2>
      <form
        role="search"
        aria-label="Buscar y filtrar replays"
        data-testid="replays-filters"
        className="replays-filters"
        onSubmit={onSubmit}
        noValidate
      >
        <fieldset>
          <legend>Filtros</legend>
          <p>
            <label htmlFor={fid("battleId")}>ID de batalla</label>{" "}
            <input
              id={fid("battleId")}
              name="battleId"
              value={draft.battleId}
              onChange={set("battleId")}
              maxLength={36}
              spellCheck={false}
              autoComplete="off"
              aria-describedby={fid("battleId-hint")}
            />
            <small id={fid("battleId-hint")} style={{ display: "block" }}>
              Completo o sólo el principio (p. ej. los 8 primeros caracteres).
            </small>
          </p>
          <p>
            <label htmlFor={fid("from")}>Desde</label>{" "}
            <input id={fid("from")} name="from" type="date" value={draft.from} onChange={set("from")} />{" "}
            <label htmlFor={fid("to")}>Hasta</label>{" "}
            <input id={fid("to")} name="to" type="date" value={draft.to} onChange={set("to")} />
          </p>
          <p>
            <label htmlFor={fid("mode")}>Modo</label>{" "}
            <select id={fid("mode")} name="mode" value={draft.mode} onChange={set("mode")}>
              <option value="">Todos</option>
              {REPLAY_MODE_OPTIONS.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>{" "}
            <label htmlFor={fid("result")}>Resultado</label>{" "}
            <select
              id={fid("result")}
              name="result"
              value={draft.result}
              onChange={set("result")}
              aria-describedby={fid("result-hint")}
            >
              <option value="">Cualquiera</option>
              {REPLAY_RESULT_OPTIONS.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
            <small id={fid("result-hint")} style={{ display: "block" }}>
              Victoria y derrota se refieren al bot, equipo o usuario filtrado; sin ellos, a tus bots.
            </small>
          </p>
          <p>
            <label htmlFor={fid("bot")}>Bot</label>{" "}
            <input
              id={fid("bot")}
              name="bot"
              value={draft.bot}
              onChange={set("bot")}
              placeholder="nombre o id"
              autoComplete="off"
            />{" "}
            <label htmlFor={fid("team")}>Equipo</label>{" "}
            <input
              id={fid("team")}
              name="team"
              value={draft.team}
              onChange={set("team")}
              placeholder="nombre o id"
              autoComplete="off"
            />{" "}
            <label htmlFor={fid("user")}>Usuario</label>{" "}
            <input
              id={fid("user")}
              name="user"
              value={draft.user}
              onChange={set("user")}
              placeholder="nombre o id"
              autoComplete="off"
            />
          </p>
          {formError && (
            <p className="error" role="alert" data-testid="replays-filters-error">
              {formError}
            </p>
          )}
          <p>
            <Button type="submit" data-testid="replays-filters-apply">
              Buscar
            </Button>{" "}
            <Button onClick={clear} disabled={!filtered && !hasFilters(draft)} data-testid="replays-filters-clear">
              Quitar filtros
            </Button>
          </p>
        </fieldset>
      </form>
      {cursorReset && (
        <p role="status" data-testid="replays-cursor-reset">
          La paginación había caducado: se muestra de nuevo la primera página.
        </p>
      )}
      <ResourceView resource={list} label="los replays" onRetry={reload}>
        {({ items, nextCursor, total }) =>
          items.length === 0 && page === 1 ? (
            filtered ? (
              <EmptyState
                data-testid="replays-empty"
                message="Ningún replay casa con estos filtros."
                action={
                  <Button variant="link" onClick={clear}>
                    Quitar filtros
                  </Button>
                }
              />
            ) : (
              <EmptyState
                data-testid="replays-empty"
                message="No hay replays todavía. Se crean al terminar una batalla."
                action={<a href="#/battles">Ir a Batallas</a>}
              />
            )
          ) : (
            <>
              {typeof total === "number" && (
                <p role="status" aria-live="polite" data-testid="replays-total">
                  {total === 1 ? "1 replay encontrado" : `${total} replays encontrados`}
                </p>
              )}
              <table className="stack-table stack-table--wide">
                <thead>
                  <tr>
                    <th>Batalla</th>
                    <th>Resultado</th>
                    <th>Duración</th>
                    <th>Oficial</th>
                    <th>Fecha</th>
                    <th>Ver</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r) => (
                    <tr key={r.battleId} data-testid="replay-row" data-battle-id={r.battleId}>
                      <td>
                        <code title={r.battleId}>{r.battleId.slice(0, 8)}</code>
                      </td>
                      <td>
                        {r.endReason === "technical_limit"
                          ? "detenida por límite técnico"
                          : r.winner === "draw"
                            ? "empate"
                            : r.winner
                              ? `gana ${teamText(r.winner)}`
                              : "—"}
                      </td>
                      <td>
                        {formatTicksAsDuration(r.ticks)} ({r.ticks} ticks)
                      </td>
                      <td>{r.official ? "sí" : "no"}</td>
                      <td>{new Date(r.createdAt).toLocaleString()}</td>
                      <td>
                        <a href={`#/replay/${encodeURIComponent(r.battleId)}?t=0`} data-testid="replay-open">
                          Ver replay
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(page > 1 || nextCursor) && (
                <nav aria-label="Paginación de replays" data-testid="replays-pagination">
                  <Button
                    onClick={() => setCursors((c) => c.slice(0, -1))}
                    disabled={page <= 1}
                    data-testid="replays-prev"
                  >
                    Anterior
                  </Button>{" "}
                  <span aria-current="page">Página {page}</span>{" "}
                  <Button
                    onClick={() => {
                      if (!nextCursor) return;
                      setCursorReset(false);
                      setCursors((c) => [...c, nextCursor]);
                    }}
                    disabled={!nextCursor}
                    data-testid="replays-next"
                  >
                    Siguiente
                  </Button>
                </nav>
              )}
            </>
          )
        }
      </ResourceView>
    </section>
  );
}
