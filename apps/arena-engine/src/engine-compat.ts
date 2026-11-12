/**
 * ¿Puede ESTE motor re-simular un replay?
 *
 * OLA2-MD · verificador de VERSIÓN ÚNICA (contrato engine-v2 §13, BACKWARD_COMPATIBILITY_REQUIRED=NO).
 * Desaparece `engine.reproduces` (ADR-022): con el replay v2 (hash por componentes, flujos
 * de RNG con nombre) ningún replay de 0.3.0/0.4.0 (formatVersion 1) se puede reproducir, así
 * que el único criterio es `headerIncompatibility()` de replay.ts: mismo formato, motor,
 * física (paquete y wasm), protocolo, runtime, catálogo y esquemas de hash/RNG/ids.
 */
import { headerIncompatibility, type ReplayHeader } from "./replay.js";
import deps from "./engine-deps.json" with { type: "json" };

/** ok ⇒ `verifiedWith`; !ok ⇒ `reason`. (Forma plana: el repo no usa strictNullChecks.) */
export interface EngineVerifyDecision {
  ok: boolean;
  verifiedWith?: string;
  /** Siempre false desde OLA2-MD: ya no hay re-simulación de versiones anteriores. */
  compat?: boolean;
  reason?: string;
}

/** Versiones anteriores que este motor reproduce: ninguna desde el replay v2. */
export function reproducedVersions(): readonly string[] {
  return [];
}

export function engineCanVerify(header: Partial<ReplayHeader> | null | undefined): EngineVerifyDecision {
  const reason = headerIncompatibility(header as ReplayHeader);
  if (reason) return { ok: false, reason };
  return { ok: true, verifiedWith: deps.engine.version, compat: false };
}
