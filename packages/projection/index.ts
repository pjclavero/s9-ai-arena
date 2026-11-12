/**
 * OLA 2 · MA · `packages/projection`: la ÚNICA frontera de proyección pública.
 *
 *   ENGINE INTERNAL STATE → projectFrame() → viewer/public state
 *
 * Consumidores: gateway de espectador (directo y broadcast), API de replays (índice,
 * segmento y descarga pública), getBattleStats, WELCOME del bot. Ninguno lee estado crudo
 * del motor. Contrato: `contracts.ts` y docs/technical/engine-v2-contracts.md.
 */
export * from "./audience.js";
export * from "./equipment.js";
export type * from "./frame-types.js";
export * from "./policy.js";
export * from "./project-frame.js";
export * from "./projection-key.js";
export * from "./public-id-mapper.js";
export * from "./stream.js";
export * from "./visibility.js";
export * from "./bot-ids.js";
