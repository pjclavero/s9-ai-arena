/**
 * R17 · Dominios del asistente de primer arranque.
 *
 * El asistente NO es un instalador: es un recorrido ordenado por los trece
 * dominios de los que depende una instalación, donde cada uno declara (a) de
 * qué otros depende, (b) qué comprobaciones le dan evidencia y (c) qué
 * confusiones tiene la obligación de resolver.
 *
 * Capas, y no se mezclan:
 *
 *     configuration  →  evidence  →  readiness  →  activation
 *
 * Este fichero es la capa de MODELO. No adquiere hechos (eso son las sondas) y
 * no decide readiness (eso es el motor): sólo declara qué tiene que quedar
 * demostrado y en qué orden. La activación vive aparte, en `activation.ts`, y
 * jamás es consecuencia automática de que algo salga verde.
 */
import type { ConfusionId } from "./confusions.ts";

export type DomainId =
  | "sistema"
  | "administrador"
  | "base-de-datos"
  | "almacenamiento"
  | "almacenamiento-bots"
  | "almacenamiento-replays"
  | "copias"
  | "restauracion"
  | "ejecucion"
  | "spectator"
  | "seguridad"
  | "preflight"
  | "readiness";

export interface Domain {
  id: DomainId;
  /** Posición en el recorrido. Un dominio no se evalúa antes que sus requisitos. */
  order: number;
  title: string;
  /** Qué queda instalado/decidido cuando este dominio está satisfecho. */
  purpose: string;
  /** Dominios que deben estar satisfechos antes; si no, éste queda `blocked`. */
  requires: DomainId[];
  /** Comprobaciones (de readiness o del propio asistente) que le dan evidencia. */
  evidence: string[];
  /** Confusiones que este dominio DEBE resolver con evidencia verificada. */
  mustResolve: ConfusionId[];
  /**
   * Puerta asociada. Un dominio con puerta no se "completa" encendiéndola: se
   * completa demostrando que está APAGADA. Encenderla es un acto aparte.
   */
  gateKey?: string;
}

export const DOMAINS: readonly Domain[] = [
  {
    id: "sistema",
    order: 1,
    title: "Sistema",
    purpose: "Configuración declarada, coherente y sin claves fantasma; identidad de la versión desplegada.",
    requires: [],
    evidence: ["security.deployed_version"],
    mustResolve: ["tag_vs_deployed_version"],
  },
  {
    id: "administrador",
    order: 2,
    title: "Administrador",
    purpose: "Existe una identidad administrativa creada por el operador, no sembrada con credenciales del repo.",
    requires: ["base-de-datos"],
    evidence: ["admin.bootstrap_identity"],
    mustResolve: ["exit_zero_vs_effect_verified"],
  },
  {
    id: "base-de-datos",
    order: 3,
    title: "Base de datos",
    purpose: "El motor responde, la consulta se ejecutó de verdad y se distingue 'vacío correcto' de 'no se ejecutó'.",
    requires: ["sistema"],
    evidence: ["diagnostics.db_canary"],
    mustResolve: ["exit_zero_vs_effect_verified"],
  },
  {
    id: "almacenamiento",
    order: 4,
    title: "Almacenamiento",
    purpose: "El directorio de datos es escribible POR EL PROCESO que corre el servicio.",
    requires: ["sistema"],
    evidence: ["storage.writable"],
    mustResolve: ["storage_exists_vs_writable"],
  },
  {
    id: "almacenamiento-bots",
    order: 5,
    title: "Almacenamiento de bots",
    purpose: "El árbol de bots subidos admite escritura y relectura íntegra por el uid del proceso.",
    requires: ["almacenamiento"],
    evidence: ["storage.bots.writable_by_process"],
    mustResolve: ["storage_exists_vs_writable", "exit_zero_vs_effect_verified"],
  },
  {
    id: "almacenamiento-replays",
    order: 6,
    title: "Almacenamiento de replays",
    purpose: "El árbol de replays admite escritura y relectura íntegra por el uid del proceso.",
    requires: ["almacenamiento"],
    evidence: ["storage.replays.writable_by_process"],
    mustResolve: ["storage_exists_vs_writable", "exit_zero_vs_effect_verified"],
  },
  {
    id: "copias",
    order: 7,
    title: "Copias de seguridad",
    purpose:
      "La ÚLTIMA ejecución del trabajo terminó bien, dejó un snapshot reciente con bytes y el volcado releído cuadra con su hash. `backup.process_alive` NO cuenta: es la señal que engaña.",
    requires: ["almacenamiento", "base-de-datos"],
    evidence: ["backup.last_run_success", "backup.last_snapshot_verified", "backup.pg_dump_checksum_verified"],
    mustResolve: ["healthy_vs_ready", "process_alive_vs_job_success", "exit_zero_vs_effect_verified"],
  },
  {
    id: "restauracion",
    order: 8,
    title: "Restauración",
    purpose: "Un simulacro devuelve bytes y el canario: tener copia no es poder volver.",
    requires: ["copias"],
    evidence: ["backup.restore_verified"],
    mustResolve: ["backed_up_vs_recovery_verified"],
  },
  {
    id: "seguridad",
    order: 9,
    title: "Seguridad",
    purpose: "El secreto de firma está montado y legible DENTRO del proceso, y el diagnóstico va redactado.",
    requires: ["sistema"],
    evidence: ["security.secret_mounted", "diagnostics.bundle_redacted"],
    mustResolve: ["secret_exists_vs_mounted"],
  },
  {
    id: "ejecucion",
    order: 10,
    title: "Ejecución",
    purpose: "La puerta de ejecución real de bots está demostradamente APAGADA, en entorno y en runtime.",
    requires: ["almacenamiento-bots", "seguridad"],
    evidence: ["gate.s9_enable_real_battle_runs"],
    mustResolve: [],
    gateKey: "S9_ENABLE_REAL_BATTLE_RUNS",
  },
  {
    id: "spectator",
    order: 11,
    title: "Spectator",
    purpose: "La puerta de spectator/replay público está demostradamente APAGADA, en entorno y en runtime.",
    requires: ["almacenamiento-replays", "seguridad"],
    evidence: ["gate.s9_public_spectate_enabled"],
    mustResolve: [],
    gateKey: "S9_PUBLIC_SPECTATE_ENABLED",
  },
  {
    id: "preflight",
    order: 12,
    title: "Preflight",
    purpose: "La configuración declarada no tiene errores: es la condición PREVIA a mirar readiness, no un sustituto.",
    requires: ["sistema"],
    evidence: [],
    mustResolve: [],
  },
  {
    id: "readiness",
    order: 13,
    title: "Readiness",
    purpose: "Veredicto final con evidencia: todo dominio obligatorio satisfecho y ninguna laguna sin declarar.",
    requires: [
      "administrador",
      "base-de-datos",
      "almacenamiento-bots",
      "almacenamiento-replays",
      "restauracion",
      "seguridad",
      "ejecucion",
      "spectator",
      "preflight",
    ],
    evidence: [],
    mustResolve: [],
  },
];

/**
 * Qué confusión cubre cada comprobación. Vive aquí, y no dentro de cada check,
 * para que los carriles hermanos puedan añadir comprobaciones sin que este
 * carril les toque los ficheros: una comprobación desconocida simplemente no
 * cubre ninguna confusión, que es el defecto seguro.
 */
export const CHECK_COVERAGE: Readonly<Record<string, readonly ConfusionId[]>> = {
  "storage.writable": ["storage_exists_vs_writable"],
  "storage.bots.writable_by_process": ["storage_exists_vs_writable", "exit_zero_vs_effect_verified"],
  "storage.replays.writable_by_process": ["storage_exists_vs_writable", "exit_zero_vs_effect_verified"],
  // `backup.last_run_success` mira el TRABAJO: cuándo corrió y con qué código.
  // Es lo único que separa "cron vivo" de "copia hecha".
  "backup.last_run_success": ["healthy_vs_ready", "process_alive_vs_job_success"],
  "backup.last_snapshot_verified": ["exit_zero_vs_effect_verified"],
  "backup.pg_dump_checksum_verified": ["exit_zero_vs_effect_verified"],
  "backup.restore_verified": ["backed_up_vs_recovery_verified"],
  "security.secret_mounted": ["secret_exists_vs_mounted"],
  // Sólo llega a `verified` con identidad de build embebida: `RUNTIME_MATCH` a
  // secas se queda en `not_exercised` y por tanto NO cubre esta confusión.
  "security.deployed_version": ["tag_vs_deployed_version"],
  "diagnostics.db_canary": ["exit_zero_vs_effect_verified"],
  "admin.bootstrap_identity": ["exit_zero_vs_effect_verified"],
};

/**
 * Comprobaciones que existen y a propósito NO cubren ninguna confusión.
 * `backup.process_alive` es la señal que engañó al proyecto: pasa en verde con
 * la copia fallando cada noche. Está en el catálogo para informar, y aquí para
 * dejar dicho que informar no es demostrar.
 */
export const CHECKS_SIN_COBERTURA: readonly string[] = ["backup.process_alive", "diagnostics.bundle_redacted"];

export const DOMAIN_BY_ID: ReadonlyMap<DomainId, Domain> = new Map(DOMAINS.map((d) => [d.id, d]));
