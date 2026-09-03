/**
 * R17 · Asistente de primer arranque. Punto de entrada del paquete.
 *
 * Cuatro capas, en este orden y sin mezclarse:
 *
 *     configuration  →  evidence  →  readiness  →  activation
 *
 * La adquisición de hechos (sondas) no decide; la decisión (asistente) no
 * adquiere; la activación es un acto explícito y separado, nunca la
 * consecuencia automática de que algo salga verde.
 */
export * from "./confusions.ts";
export * from "./domains.ts";
export * from "./checks.ts";
export * from "./probes-local.ts";
export * from "./wizard.ts";
export * from "./activation.ts";
export * from "./mutations.ts";
