/**
 * ADR-022 · ¿Puede ESTE motor re-simular un replay grabado con otra versión?
 *
 * Regla: un replay se verifica con este motor si su versión es la actual, o si está en
 * `engine.reproduces` (engine-deps.json) Y el ruleset de su cabecera no usa ninguna regla
 * nueva de 0.4.0. Esas versiones antiguas no conocían las reglas nuevas, así que un replay
 * suyo que las «declarase» sería un replay fabricado o corrupto: no se re-simula.
 *
 * Por qué es seguro para 0.3.0: el motor 0.4.0 SOLO cambia la simulación cuando el
 * ruleset declara `respawn.maxRespawns`, `timeoutTiebreak` u `overtime` (todos los
 * caminos nuevos están detrás de esos campos). Lo prueban replays REALES grabados con el
 * motor de producción (main a1a6c4e, 0.3.0) que se re-simulan idénticos tick a tick
 * (apps/replay-service/tests/engine-0.3.0-compat.test.ts) y los hashes fijados con el
 * motor de 9aaad79 (apps/arena-engine/tests/rules-respawn-tiebreak.test.ts).
 */
import deps from "./engine-deps.json" with { type: "json" };

/** Reglas que sólo existen desde 0.4.0. */
export function rulesetUsesEngine040Rules(ruleset: unknown): string[] {
  if (!ruleset || typeof ruleset !== "object") return [];
  const r = ruleset as Record<string, any>;
  const used: string[] = [];
  if (r.respawn && typeof r.respawn === "object" && r.respawn.maxRespawns !== undefined)
    used.push("respawn.maxRespawns");
  if (r.timeoutTiebreak !== undefined) used.push("timeoutTiebreak");
  if (r.overtime !== undefined) used.push("overtime");
  return used;
}

export type EngineVerifyDecision = { ok: true; verifiedWith: string; compat: boolean } | { ok: false; reason: string };

/** Versiones anteriores que este motor reproduce (vacío si no declara ninguna). */
export function reproducedVersions(): readonly string[] {
  const list = (deps.engine as { reproduces?: unknown }).reproduces;
  return Array.isArray(list) ? list.filter((v): v is string => typeof v === "string") : [];
}

export function engineCanVerify(header: { versions?: { engine?: string }; ruleset?: unknown }): EngineVerifyDecision {
  const recorded = header.versions?.engine;
  const current = deps.engine.version;
  if (recorded === current) return { ok: true, verifiedWith: current, compat: false };
  if (typeof recorded === "string" && reproducedVersions().includes(recorded)) {
    const used = rulesetUsesEngine040Rules(header.ruleset);
    if (used.length > 0) {
      return {
        ok: false,
        reason: `engine_rules_mismatch: replay=${recorded} declara reglas de ${current} (${used.join(", ")})`,
      };
    }
    return { ok: true, verifiedWith: current, compat: true };
  }
  return { ok: false, reason: `engine_version_mismatch: replay=${recorded}, disponible=${current}` };
}
