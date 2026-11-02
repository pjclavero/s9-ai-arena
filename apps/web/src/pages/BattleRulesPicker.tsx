/**
 * R-UI (ADR-021) · Elección de REGLAS de una batalla: presets oficiales, personalizado
 * y clásico (rulesets de la plataforma). La página no es un formulario técnico:
 *   1. el tipo de batalla (1 contra 1 / por equipos) lo elige BattleNewPage;
 *   2. aquí se elige el CONJUNTO DE REGLAS (tarjetas con nombre y una frase);
 *   3. «Personalizado» despliega las opciones avanzadas, con los límites que da el
 *      servidor (GET /rulesets → custom.limits). La UI sólo ayuda: el servidor valida.
 *
 * Módulo propio (frontera con H-ELIG/UX): BattleNewPage sólo lo monta y envía `rules`.
 */
import { useEffect, useState } from "react";
import { api } from "../api.js";
import {
  TIEBREAK_RULES,
  respawnLabel,
  summarizeParams,
  tiebreakFamilyOf,
  type RulesParams,
  type RulesPreset,
  type CompositionReport,
} from "../../../../packages/game-rules/battle-rules.js";

export interface RulesCatalog {
  presets: RulesPreset[];
  custom: {
    defaults: Omit<RulesParams, "teamSize">;
    /** ADR-022 · defectos del personalizado de CTF (los del preset base ctf@1). */
    ctfDefaults?: Omit<RulesParams, "teamSize">;
    limits: Record<string, { min: number; max: number }>;
    maxParticipants: number;
  } | null;
}

/** Lo elegido: un preset oficial, el personalizado o el ruleset clásico de la plataforma. */
export type RulesChoice =
  | { kind: "preset"; presetId: string }
  | { kind: "custom"; params: Omit<RulesParams, "teamSize"> }
  | { kind: "classic" };

/** Cuerpo `rules` de POST /battles (undefined = clásico). */
export function rulesBody(choice: RulesChoice, teamSize: number): Record<string, unknown> | undefined {
  if (choice.kind === "classic") return undefined;
  if (choice.kind === "preset") return { preset: choice.presetId, teamSize };
  const p = choice.params;
  // Sólo se envía lo que aplica: el servidor rechaza campos incompatibles.
  const respawn: Record<string, unknown> = { mode: p.respawn.mode };
  if (p.respawn.mode === "limited") respawn.maxRespawns = p.respawn.maxRespawns;
  if (p.respawn.mode !== "none") respawn.delaySeconds = p.respawn.delaySeconds;
  const params: Record<string, unknown> = { respawn, victory: p.victory, timeLimitMinutes: p.timeLimitMinutes };
  if (p.game === "capture_the_flag") {
    params.game = "capture_the_flag";
    if (p.ctf) params.ctf = { ...p.ctf };
  }
  if (p.victory === "score_limit") params.scoreLimit = p.scoreLimit;
  for (const k of ["botCredits", "botMassKg"] as const) if (p[k] !== null) params[k] = p[k];
  if (teamSize > 1) {
    for (const k of ["teamCredits", "teamMassKg"] as const) if (p[k] !== null) params[k] = p[k];
    params.friendlyFire = p.friendlyFire;
  }
  return { preset: "custom", teamSize, params };
}

/**
 * ADR-022 · Modo de plataforma que FIJA una elección de reglas (null = «Clásico», deja
 * elegir). CTF ⇒ capture_the_flag; el resto, deathmatch (1v1) o team_deathmatch.
 */
export function lockedModeOf(catalog: RulesCatalog, choice: RulesChoice, format: "1v1" | "team"): string | null {
  if (choice.kind === "classic") return null;
  const game =
    choice.kind === "custom" ? choice.params.game : catalog.presets.find((x) => x.id === choice.presetId)?.game;
  if (game === "capture_the_flag") return "capture_the_flag";
  return format === "team" ? "team_deathmatch" : "deathmatch";
}

/** Preset por defecto de cada tipo de batalla. */
export function defaultChoice(catalog: RulesCatalog, format: "1v1" | "team"): RulesChoice {
  const wanted = format === "1v1" ? "duel" : "team_deathmatch";
  const p = catalog.presets.find((x) => x.id === wanted) ?? catalog.presets.find((x) => x.format === format);
  return p ? { kind: "preset", presetId: p.id } : { kind: "classic" };
}

/** Parámetros efectivos (para el resumen): los del preset o los del personalizado. */
export function effectiveParams(catalog: RulesCatalog, choice: RulesChoice, teamSize: number): RulesParams | null {
  if (choice.kind === "classic") return null;
  if (choice.kind === "custom") return { ...choice.params, teamSize };
  const p = catalog.presets.find((x) => x.id === choice.presetId);
  return p ? { ...p.params, teamSize } : null;
}

/** Presentación local: cada opción y cada campo en su línea (el CSS global es de UX). */
const ROW = { display: "block", margin: "0.35rem 0" } as const;
const CARD = {
  display: "block",
  margin: "0.5rem 0",
  padding: "0.4rem 0.6rem",
  border: "1px solid rgba(127,127,127,0.35)",
  borderRadius: 6,
} as const;

function NumberField(props: {
  label: string;
  testid: string;
  value: number | null;
  limit?: { min: number; max: number };
  nullable?: boolean;
  unit?: string;
  onChange: (v: number | null) => void;
}) {
  const { label, value, limit, nullable, unit } = props;
  // Texto local: vaciar el campo para teclear otro número NO es «sin restricción» (eso
  // sólo lo decide la casilla) ni borra el valor; hasta que haya un número se conserva
  // el último. Un valor fuera de rango SÍ se propaga: el servidor lo rechaza y se dice.
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => {
    if (value !== null && Number(text) !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <label style={ROW}>
      {label}{" "}
      {nullable && (
        <>
          <input
            type="checkbox"
            aria-label={`${label}: sin restricción`}
            checked={value === null}
            onChange={(e) => props.onChange(e.target.checked ? null : (limit?.min ?? 1))}
          />{" "}
          sin restricción adicional{" "}
        </>
      )}
      {(value !== null || !nullable) && (
        <input
          type="number"
          aria-label={label}
          data-testid={props.testid}
          min={limit?.min}
          max={limit?.max}
          step={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const n = Number(e.target.value);
            if (e.target.value !== "" && Number.isFinite(n)) props.onChange(n);
          }}
        />
      )}
      {unit ? ` ${unit}` : ""}
      {limit && (
        <small>
          {" "}
          ({limit.min}–{limit.max})
        </small>
      )}
    </label>
  );
}

export function BattleRulesPicker(props: {
  catalog: RulesCatalog;
  format: "1v1" | "team";
  teamSize: number;
  choice: RulesChoice;
  onChange: (c: RulesChoice) => void;
}) {
  const { catalog, format, choice, teamSize } = props;
  const presets = catalog.presets.filter((p) => p.format === format);
  const L = catalog.custom?.limits ?? {};
  const custom = choice.kind === "custom" ? choice.params : null;
  const setCustom = (f: (p: Omit<RulesParams, "teamSize">) => Omit<RulesParams, "teamSize">) =>
    custom && props.onChange({ kind: "custom", params: f(custom) });
  const params = effectiveParams(catalog, choice, teamSize);
  const ctf = custom?.game === "capture_the_flag";
  return (
    <fieldset data-testid="battle-rules">
      <legend>Conjunto de reglas</legend>
      {presets.map((p) => (
        <label key={p.id} data-testid={`rules-preset-${p.id}`} style={CARD}>
          <input
            type="radio"
            name="battle-rules"
            aria-label={`reglas ${p.name}`}
            checked={choice.kind === "preset" && choice.presetId === p.id}
            onChange={() => props.onChange({ kind: "preset", presetId: p.id })}
          />{" "}
          <strong>{p.name}</strong> · {p.tagline}
          {choice.kind === "preset" && choice.presetId === p.id && (
            <>
              <br />
              <small data-testid="rules-preset-description">{p.description}</small>
            </>
          )}
        </label>
      ))}
      {catalog.custom && (
        <label data-testid="rules-preset-custom" style={CARD}>
          <input
            type="radio"
            name="battle-rules"
            aria-label="reglas Personalizado"
            checked={choice.kind === "custom"}
            onChange={() => props.onChange({ kind: "custom", params: structuredClone(catalog.custom!.defaults) })}
          />{" "}
          <strong>Personalizado</strong> · Configura las reglas manualmente.
        </label>
      )}
      <label data-testid="rules-preset-classic" style={CARD}>
        <input
          type="radio"
          name="battle-rules"
          aria-label="reglas Clásico"
          checked={choice.kind === "classic"}
          onChange={() => props.onChange({ kind: "classic" })}
        />{" "}
        <strong>Clásico</strong> · El ruleset de la plataforma de cada modo (incluye control de zona), con sus reglas de
        siempre.
      </label>

      {custom && (
        <div data-testid="rules-custom">
          <p>
            <small data-testid="rules-custom-scope">
              El personalizado cambia sólo reglas competitivas (participantes, reapariciones, tiempo, objetivo,
              presupuestos, masa, fuego amigo y opciones de CTF). La física, el daño, la vida, los sensores y la
              munición no se pueden alterar.
            </small>
          </p>
          {format === "team" && (
            // CTF necesita bandos con base y bandera (rojo/azul): se juega desde «por equipos».
            <label style={ROW}>
              Juego{" "}
              <select
                aria-label="juego"
                value={custom.game}
                onChange={(e) => {
                  const game = e.target.value as RulesParams["game"];
                  const base =
                    game === "capture_the_flag"
                      ? (catalog.custom?.ctfDefaults ?? catalog.custom!.defaults)
                      : catalog.custom!.defaults;
                  props.onChange({ kind: "custom", params: structuredClone({ ...base, game }) });
                }}
              >
                <option value="combat">Combate (bajas)</option>
                <option value="capture_the_flag">Capturar la bandera</option>
              </select>
            </label>
          )}
          {!ctf && (
            <label style={ROW}>
              Reaparición{" "}
              <select
                aria-label="respawn"
                value={custom.respawn.mode}
                onChange={(e) => {
                  const mode = e.target.value as RulesParams["respawn"]["mode"];
                  setCustom((p) => ({
                    ...p,
                    respawn: {
                      mode,
                      maxRespawns: mode === "limited" ? (p.respawn.maxRespawns ?? 2) : null,
                      delaySeconds: mode === "none" ? null : (p.respawn.delaySeconds ?? 5),
                    },
                    // Combinaciones que el servidor rechaza: se corrigen al cambiar el respawn.
                    victory:
                      mode === "unlimited" && p.victory === "elimination"
                        ? "score_limit"
                        : mode !== "unlimited" && p.victory === "time_score"
                          ? "elimination"
                          : p.victory,
                    scoreLimit:
                      mode === "unlimited" && p.victory === "elimination" ? (p.scoreLimit ?? 10) : p.scoreLimit,
                  }));
                }}
              >
                <option value="none">ninguna (1 vida)</option>
                <option value="limited">limitada (maxRespawns)</option>
                <option value="unlimited">ilimitada</option>
              </select>
            </label>
          )}
          {ctf && (
            <p style={ROW}>
              Reaparición: ilimitada <small>(en CTF la reaparición siempre es ilimitada)</small>
            </p>
          )}
          {custom.respawn.mode === "limited" && (
            <NumberField
              label="Reapariciones por bot (maxRespawns)"
              testid="rules-respawns"
              value={custom.respawn.maxRespawns}
              limit={L.maxRespawns}
              onChange={(v) => setCustom((p) => ({ ...p, respawn: { ...p.respawn, maxRespawns: v } }))}
            />
          )}
          {custom.respawn.mode === "limited" && custom.respawn.maxRespawns !== null && (
            <small data-testid="rules-lives">
              {" "}
              = {custom.respawn.maxRespawns + 1} {custom.respawn.maxRespawns + 1 === 1 ? "vida" : "vidas"} en total por
              bot (la vida inicial + {custom.respawn.maxRespawns}{" "}
              {custom.respawn.maxRespawns === 1 ? "reaparición" : "reapariciones"})
            </small>
          )}
          {custom.respawn.mode !== "none" && (
            <NumberField
              label="Espera para reaparecer"
              testid="rules-delay"
              unit="s"
              value={custom.respawn.delaySeconds}
              limit={L.delaySeconds}
              onChange={(v) => setCustom((p) => ({ ...p, respawn: { ...p.respawn, delaySeconds: v } }))}
            />
          )}
          {!ctf && (
            <label style={ROW}>
              Condición de victoria{" "}
              <select
                aria-label="victoria"
                value={custom.victory}
                onChange={(e) => {
                  const victory = e.target.value as RulesParams["victory"];
                  setCustom((p) => ({
                    ...p,
                    victory,
                    scoreLimit: victory === "score_limit" ? (p.scoreLimit ?? 10) : null,
                  }));
                }}
              >
                {custom.respawn.mode !== "unlimited" && <option value="elimination">eliminación</option>}
                <option value="score_limit">límite de bajas</option>
                {custom.respawn.mode === "unlimited" && <option value="time_score">puntos al acabar el tiempo</option>}
              </select>
            </label>
          )}
          {custom.victory === "score_limit" && (
            <NumberField
              label={ctf ? "Capturas para ganar" : "Límite de bajas"}
              testid="rules-score"
              value={custom.scoreLimit}
              limit={ctf ? L.captures : L.scoreLimit}
              onChange={(v) => setCustom((p) => ({ ...p, scoreLimit: v }))}
            />
          )}
          <NumberField
            label={custom.victory === "time_score" ? "Duración" : "Tiempo máximo"}
            testid="rules-time"
            unit="min"
            value={custom.timeLimitMinutes}
            limit={L.timeLimitMinutes}
            onChange={(v) => setCustom((p) => ({ ...p, timeLimitMinutes: v ?? 1 }))}
          />
          {ctf && custom.ctf && (
            <>
              <NumberField
                label="Retorno automático de la bandera"
                testid="rules-flag-return"
                unit="s"
                value={custom.ctf.flagReturnSeconds}
                limit={L.flagReturnSeconds}
                onChange={(v) =>
                  setCustom((p) => ({ ...p, ctf: { ...p.ctf!, flagReturnSeconds: v ?? p.ctf!.flagReturnSeconds } }))
                }
              />
              <label style={ROW}>
                <input
                  type="checkbox"
                  aria-label="bandera propia en base"
                  checked={custom.ctf.requireOwnFlagAtBase}
                  onChange={(e) =>
                    setCustom((p) => ({ ...p, ctf: { ...p.ctf!, requireOwnFlagAtBase: e.target.checked } }))
                  }
                />{" "}
                Exigir la bandera propia en su base para puntuar
              </label>
              <p style={ROW}>
                <small data-testid="rules-overtime">
                  Prórroga: si empatan al acabar el tiempo, se sigue jugando con el mismo estado y la siguiente captura
                  gana. No hay límite de tiempo competitivo.
                </small>
              </p>
            </>
          )}
          <NumberField
            label="Créditos máximos por bot"
            testid="rules-bot-credits"
            unit="cr"
            nullable
            value={custom.botCredits}
            limit={L.botCredits}
            onChange={(v) => setCustom((p) => ({ ...p, botCredits: v }))}
          />
          <NumberField
            label="Masa máxima por bot"
            testid="rules-bot-mass"
            unit="kg"
            nullable
            value={custom.botMassKg}
            limit={L.botMassKg}
            onChange={(v) => setCustom((p) => ({ ...p, botMassKg: v }))}
          />
          {format === "team" && (
            <>
              <NumberField
                label="Presupuesto total del equipo"
                testid="rules-team-credits"
                unit="cr"
                nullable
                value={custom.teamCredits}
                limit={L.teamCredits}
                onChange={(v) => setCustom((p) => ({ ...p, teamCredits: v }))}
              />
              {custom.teamCredits !== null && (
                <small data-testid="rules-team-budget-help">
                  {" "}
                  Se reparte como quieras entre los bots del equipo (p. ej. 3500 cr: 1000 + 1000 + 600 + 900); el tope
                  por bot es opcional.
                </small>
              )}
              <NumberField
                label="Masa máxima por equipo"
                testid="rules-team-mass"
                unit="kg"
                nullable
                value={custom.teamMassKg}
                limit={L.teamMassKg}
                onChange={(v) => setCustom((p) => ({ ...p, teamMassKg: v }))}
              />
              <label style={ROW}>
                <input
                  type="checkbox"
                  aria-label="fuego amigo"
                  checked={custom.friendlyFire}
                  onChange={(e) => setCustom((p) => ({ ...p, friendlyFire: e.target.checked }))}
                />{" "}
                Fuego amigo{ctf ? "" : " (un aliado destruido da un punto al rival)"}
              </label>
            </>
          )}
        </div>
      )}

      {params && (
        <div data-testid="rules-summary">
          <strong>Resumen</strong>
          <ul>
            <li>
              {choice.kind === "custom"
                ? "Batalla personalizada"
                : (presets.find((p) => choice.kind === "preset" && p.id === choice.presetId)?.name ?? "")}
            </li>
            {summarizeParams(params).map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <p data-testid="rules-respawn-label">
            <small>
              {respawnLabel(params)}. «maxRespawns» es el número de veces que un bot puede volver tras morir: 0 = 1
              vida, 1 = 2 vidas, 2 = 3 vidas.
            </small>
          </p>
          <div data-testid="rules-tiebreak">
            <strong>Desempate · {TIEBREAK_RULES[tiebreakFamilyOf(params)].label}</strong>
            <ol>
              {TIEBREAK_RULES[tiebreakFamilyOf(params)].steps.map((st) => (
                <li key={st}>{st}</li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </fieldset>
  );
}

export interface RulesCheckResult {
  ok: boolean;
  errors: { field: string; message: string }[];
  composition: CompositionReport | null;
}

/**
 * Checklist de la FASE 11: pide a POST /battles/rules-check el informe por bando y
 * bot (coste y masa REALES). Si la comprobación falla por red, no bloquea: el servidor
 * vuelve a validar al crear y respondería 400/422 igual.
 */
export function useRulesCheck(body: Record<string, unknown> | null): {
  result: RulesCheckResult | null;
  checking: boolean;
} {
  const [result, setResult] = useState<RulesCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const key = body ? JSON.stringify(body) : "";
  useEffect(() => {
    if (!key) {
      setResult(null);
      return;
    }
    let alive = true;
    // Un resultado viejo no vale para un cuerpo nuevo: se descarta hasta que llegue el suyo.
    setResult(null);
    setChecking(true);
    const t = setTimeout(() => {
      api<RulesCheckResult>("POST", "/battles/rules-check", JSON.parse(key))
        .then((r) => {
          if (alive) setResult({ ok: Boolean(r?.ok), errors: r?.errors ?? [], composition: r?.composition ?? null });
        })
        .catch(() => {
          if (alive) setResult(null);
        })
        .finally(() => {
          if (alive) setChecking(false);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [key]);
  return { result, checking };
}

const sideName = (team: string) => (team === "red" ? "Bando rojo" : team === "blue" ? "Bando azul" : `Bando ${team}`);

/** Informe por bando y bot: «✓ A-ATK-1 — 890/900 cr · 2.890/3.000 kg». */
export function RulesCheckReport(props: { result: RulesCheckResult | null; checking: boolean }) {
  const { result, checking } = props;
  if (!result) return checking ? <p role="status">Comprobando reglas y presupuestos…</p> : null;
  const c = result.composition;
  const L = c?.limits;
  return (
    <div data-testid="rules-check">
      {result.errors.length > 0 && (
        <ul data-testid="rules-errors">
          {result.errors.map((e) => (
            <li key={e.field + e.message} className="warn">
              ✗ {e.message}
            </li>
          ))}
        </ul>
      )}
      {c &&
        (L?.botCredits !== null || L?.teamCredits !== null || L?.botMassKg !== null || L?.teamMassKg !== null) &&
        c.teams.map((t) => (
          <div key={t.team} data-testid="rules-check-team" data-team={t.team}>
            <strong>{sideName(t.team)}</strong>
            <ul>
              {t.bots.map((b) => (
                <li key={b.botId} className={b.ok ? "ok" : "warn"} data-testid="rules-check-bot">
                  {b.ok ? "✓" : "✗"} {b.label}
                  {L?.botCredits !== null || L?.teamCredits !== null
                    ? ` — ${b.costCredits}${L?.botCredits !== null ? `/${L?.botCredits}` : ""} cr`
                    : ""}
                  {L?.botMassKg !== null || L?.teamMassKg !== null
                    ? ` · ${b.massKg}${L?.botMassKg !== null ? `/${L?.botMassKg}` : ""} kg`
                    : ""}
                </li>
              ))}
              {L?.teamCredits !== null && (
                <li className={t.totalCredits <= (L?.teamCredits ?? 0) ? "ok" : "warn"}>
                  Total equipo: {t.totalCredits}/{L?.teamCredits} cr
                </li>
              )}
              {L?.teamMassKg !== null && (
                <li className={t.totalMassKg <= (L?.teamMassKg ?? 0) ? "ok" : "warn"}>
                  Masa del equipo: {t.totalMassKg}/{L?.teamMassKg} kg
                </li>
              )}
            </ul>
          </div>
        ))}
      {c && c.violations.length > 0 && (
        <p className="warn" data-testid="rules-check-invalid">
          Equipo no válido: {c.violations.map((v) => v.message).join("; ")}.
        </p>
      )}
    </div>
  );
}
