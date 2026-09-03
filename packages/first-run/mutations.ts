/**
 * R17 · Escenario nominal y MUTACIONES del asistente.
 *
 * "Una comprobación que no puede ponerse roja no es una comprobación." Aquí se
 * define el escenario en el que TODO el recorrido sale satisfecho, y las
 * mutaciones que reproducen fallos concretos —cada una atada a la comprobación
 * que debe detectarla—. El test exige que cada comprobación del asistente
 * tenga al menos una mutación y que TODAS saquen su comprobación de
 * `verified`.
 */
import { nominalEnv, nominalProbes } from "../readiness/mutations.ts";
import type { FirstRunContext, FirstRunProbes } from "./checks.ts";

export function nominalFirstRunEnv(): Record<string, string | undefined> {
  // `REPLAYS_DIR` ya viene del escenario nominal del motor; el árbol de bots
  // es el volumen `arena_bot_sources` del compose.
  return { ...nominalEnv(), BOT_SOURCES_DIR: "/data/bot-sources" };
}

export function nominalFirstRunProbes(): FirstRunProbes {
  return {
    async storageWriteAsProcess(kind, dir) {
      return {
        dir,
        attempted: true,
        uid: 1000,
        gid: 1000,
        bytesWritten: 48,
        readBack: true,
        sameContent: true,
        cleanedUp: true,
      };
    },
    async adminIdentity() {
      return { queried: true, adminCount: 1, seededWithRepoCredentials: 0 };
    },
  };
}

export function nominalFirstRunContext(): FirstRunContext {
  return {
    env: nominalFirstRunEnv(),
    probes: { ...nominalProbes(), ...nominalFirstRunProbes() },
  };
}

export interface FirstRunMutation {
  checkId: string;
  /** Fallo real (o realista) que reproduce. */
  name: string;
  apply(ctx: FirstRunContext): void;
}

export const FIRST_RUN_MUTATIONS: readonly FirstRunMutation[] = [
  {
    checkId: "storage.bots.writable_by_process",
    name: "el volumen de bots existe pero el uid del proceso no puede escribir",
    apply: (c) => {
      c.probes.storageWriteAsProcess = async (kind, dir) => ({
        dir,
        attempted: true,
        uid: 1000,
        gid: 1000,
        bytesWritten: 0,
        readBack: false,
        sameContent: false,
        cleanedUp: false,
        reason: kind === "bots" ? "EACCES: permission denied" : undefined,
      });
    },
  },
  {
    checkId: "storage.bots.writable_by_process",
    name: "se escribió de verdad pero no se sabe QUÉ PROCESO lo hizo (sin uid/gid)",
    apply: (c) => {
      // El intento existió y hasta salió bien: lo que falta es el SUJETO. Sin
      // uid/gid, "el volumen es escribible" no dice por quién, que es la mitad
      // que importa.
      c.probes.storageWriteAsProcess = async (_kind, dir) => ({
        dir,
        attempted: true,
        uid: null,
        gid: null,
        bytesWritten: 128,
        readBack: true,
        sameContent: true,
        cleanedUp: true,
      });
    },
  },
  {
    checkId: "storage.bots.writable_by_process",
    name: "sin BOT_SOURCES_DIR: no se escribió en ninguna parte",
    apply: (c) => {
      c.env.BOT_SOURCES_DIR = "";
    },
  },
  {
    checkId: "storage.replays.writable_by_process",
    name: "escritura aceptada y relectura distinta en replays",
    apply: (c) => {
      c.probes.storageWriteAsProcess = async (_kind, dir) => ({
        dir,
        attempted: true,
        uid: 1000,
        gid: 1000,
        bytesWritten: 48,
        readBack: true,
        sameContent: false,
        cleanedUp: true,
      });
    },
  },
  {
    checkId: "storage.replays.writable_by_process",
    name: "escribe y relee pero no puede borrar: permisos parciales",
    apply: (c) => {
      c.probes.storageWriteAsProcess = async (_kind, dir) => ({
        dir,
        attempted: true,
        uid: 1000,
        gid: 1000,
        bytesWritten: 48,
        readBack: true,
        sameContent: true,
        cleanedUp: false,
        reason: "EPERM al borrar el fichero de prueba",
      });
    },
  },
  {
    checkId: "storage.bots.writable_by_process",
    name: "intento real rechazado por el volumen (debe ser FAILED, no 'ya lo miraremos')",
    apply: (c) => {
      c.probes.storageWriteAsProcess = async (_kind, dir) => ({
        dir,
        attempted: true,
        uid: 1000,
        gid: 1000,
        bytesWritten: 0,
        readBack: false,
        sameContent: false,
        cleanedUp: false,
        reason: "EROFS: read-only file system",
      });
    },
  },
  {
    checkId: "admin.bootstrap_identity",
    name: "la consulta de administradores no llegó a ejecutarse (0 filas != no hay)",
    apply: (c) => {
      c.probes.adminIdentity = async () => ({
        queried: false,
        adminCount: 0,
        seededWithRepoCredentials: 0,
        reason: "conexión rechazada",
      });
    },
  },
  {
    checkId: "admin.bootstrap_identity",
    name: "bootstrap con exit 0 y cero administradores creados",
    apply: (c) => {
      c.probes.adminIdentity = async () => ({ queried: true, adminCount: 0, seededWithRepoCredentials: 0 });
    },
  },
  {
    checkId: "admin.bootstrap_identity",
    name: "administrador sembrado con las credenciales de ejemplo del repositorio",
    apply: (c) => {
      c.probes.adminIdentity = async () => ({ queried: true, adminCount: 2, seededWithRepoCredentials: 1 });
    },
  },
];
