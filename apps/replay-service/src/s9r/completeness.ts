/**
 * V1 REPLAYS PR-4b · Puerta ÚNICA de completitud de un replay (antes `validateReplay` de store.ts,
 * la puerta de la ingesta retirada). La aplican:
 *  - el worker, a su grabación, ANTES de cerrarla y publicarla (engine-executor; H-4b-1): un
 *    replay incompleto es un FALLO TÉCNICO, nunca un resultado deportivo;
 *  - las herramientas (CLI del motor, smoke) vía `validateReplay` / `writeS9rReplay({validate})`.
 * Lista de problemas; vacía = publicable.
 */
export interface ReplayContent {
  header: unknown;
  stateHashes: number;
  checkpoints: number;
  snapshots: number;
  finalStateHash: unknown;
}

export function completenessProblems(c: ReplayContent): string[] {
  const problems: string[] = [];
  const h = c.header as Record<string, any> | null | undefined;
  if (!h || typeof h !== "object") return ["sin cabecera"];
  if (h.formatVersion !== 2) problems.push(`formatVersion no soportada: ${String(h.formatVersion)}`);
  if (!h.battleId) problems.push("cabecera sin battleId");
  if (!h.seed) problems.push("cabecera sin seed");
  if (!h.ruleset || !h.rulesetId) problems.push("cabecera sin ruleset");
  if (!h.map) problems.push("cabecera sin mapa");
  else if (typeof h.map.checksum !== "string" || h.map.checksum.length === 0) problems.push("mapa sin checksum");
  if (!Array.isArray(h.participants) || h.participants.length === 0) problems.push("cabecera sin participantes");
  for (const k of ["engine", "physics", "rules", "protocol"] as const) {
    if (!h.versions?.[k]) problems.push(`cabecera sin versión de ${k}`);
  }
  if (!(c.stateHashes > 0)) problems.push("sin hashes intermedios: verify() no podría localizar divergencias");
  if (!c.finalStateHash) problems.push("sin resultado oficial (finalStateHash)");
  if (!(c.checkpoints > 0)) problems.push("sin checkpoints: verify() v2 no podría decir qué componente divergió");
  if (!(c.snapshots > 0)) problems.push("sin snapshots: el reproductor no tendría nada que enseñar");
  return problems;
}
