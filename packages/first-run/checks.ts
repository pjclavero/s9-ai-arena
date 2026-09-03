/**
 * R17 · Comprobaciones propias del asistente de primer arranque.
 *
 * Sólo las que el catálogo de readiness todavía no cubre y que este carril
 * necesita para cerrar sus dominios: los DOS almacenamientos que el producto
 * usa de verdad (bots subidos y replays) y la identidad administrativa.
 *
 * Regla del carril: "escribible" no es una propiedad del directorio, es una
 * relación entre un directorio y un PROCESO. Por eso estas comprobaciones no
 * aprueban si no pueden decir con qué uid/gid escribieron: sin sujeto, la
 * frase "el volumen es escribible" no significa nada (y es exactamente como se
 * aprobó en su día un volumen que el servicio no podía tocar).
 */
import type { CheckOutcome, ReadinessCheck, ReadinessContext, ReadinessProbes } from "../readiness/engine.ts";
import { requireEffect } from "../readiness/engine.ts";

export type StorageKind = "bots" | "replays";

export interface StorageWriteEffect {
  /** Directorio realmente usado (ya resuelto). */
  dir: string;
  /**
   * ¿Se llegó a INTENTAR la escritura? `false` no es "el volumen la rechazó":
   * es "no se miró". Misma frontera que `dataDirWrite` en el motor.
   */
  attempted: boolean;
  /** uid/gid del proceso que escribió. `null` = no se pudo determinar el sujeto. */
  uid: number | null;
  gid: number | null;
  bytesWritten: number;
  readBack: boolean;
  sameContent: boolean;
  /** El fichero de prueba se pudo borrar (deja el árbol como estaba). */
  cleanedUp: boolean;
  reason?: string;
}

export interface AdminIdentityEffect {
  /** La consulta llegó al motor. `false` no es "no hay admins": es "no se sabe". */
  queried: boolean;
  adminCount: number;
  /** Cuentas cuyo hash coincide con credenciales de ejemplo del repositorio. */
  seededWithRepoCredentials: number;
  reason?: string;
}

export interface FirstRunProbes {
  storageWriteAsProcess(kind: StorageKind, dir: string): Promise<StorageWriteEffect>;
  adminIdentity(): Promise<AdminIdentityEffect>;
}

export interface FirstRunContext extends ReadinessContext {
  probes: ReadinessProbes & FirstRunProbes;
}

/**
 * Claves REALES de cada almacenamiento en este despliegue. No se inventan
 * nombres ni se derivan rutas de una base imaginaria: si la clave no está
 * definida, no hay directorio que mirar y la comprobación queda `not_exercised`
 * — que es distinto de "el volumen no es escribible".
 *
 * `REPLAYS_DIR` está en el modelo de configuración; `BOT_SOURCES_DIR` es la
 * clave con la que el trabajo de copia nombra el árbol de bots
 * (`arena_bot_sources`, montado en /data/bot-sources). Declararla en
 * `CONFIG_MODEL` es trabajo del carril de configuración, no de éste.
 */
export const STORAGE_DIR_KEYS: Readonly<Record<StorageKind, string>> = {
  bots: "BOT_SOURCES_DIR",
  replays: "REPLAYS_DIR",
};

export function resolveStorageDir(env: Record<string, string | undefined>, kind: StorageKind): string {
  return (env[STORAGE_DIR_KEYS[kind]] ?? "").trim();
}

function storageCheck(kind: StorageKind, title: string): ReadinessCheck<FirstRunContext> {
  return {
    id: `storage.${kind}.writable_by_process`,
    block: "almacenamiento",
    title,
    proves: `Que el proceso con uid/gid concretos escribió, releyó y obtuvo el mismo contenido en el árbol de ${kind}.`,
    doesNotProve:
      "Que haya espacio para la carga real, que el volumen sea persistente entre recreaciones, que esté respaldado, ni que OTRO proceso (otro uid, otro contenedor) pueda escribir ahí.",
    required: true,
    async run(ctx: FirstRunContext): Promise<CheckOutcome> {
      const dir = resolveStorageDir(ctx.env, kind);
      if (dir === "") {
        return {
          status: "not_exercised",
          evidence: `${STORAGE_DIR_KEYS[kind]} sin definir: no se ha escrito en ningún sitio`,
          remedy: `Define ${STORAGE_DIR_KEYS[kind]} antes de afirmar nada sobre este almacenamiento.`,
        };
      }
      const r = await ctx.probes.storageWriteAsProcess(kind, dir);
      if (!r.attempted) {
        return {
          status: "not_exercised",
          evidence: `no se intentó escribir en ${dir}${r.reason ? ` (${r.reason})` : ""}`,
          remedy: "Ejecuta el asistente donde el volumen esté montado: sin intentarlo no se sabe nada.",
        };
      }
      if (r.uid === null || r.gid === null) {
        return {
          status: "not_exercised",
          evidence: `no se pudo determinar QUÉ PROCESO escribió en ${dir}${r.reason ? ` (${r.reason})` : ""}`,
          remedy: "Sin sujeto (uid/gid) 'escribible' no es una afirmación comprobable.",
        };
      }
      const empty = requireEffect(r.bytesWritten, {
        // Se intentó y no entró nada: condición MIRADA y no cumplida.
        status: "failed",
        evidence: `uid=${r.uid} gid=${r.gid} intentó escribir en ${dir} y no entró ni un byte${r.reason ? ` (${r.reason})` : ""}`,
        remedy: "Revisa propiedad del volumen y que el montaje no sea de solo lectura para ESE uid.",
      });
      if (empty) return empty;
      if (!r.readBack || !r.sameContent) {
        return {
          status: "failed",
          evidence: `uid=${r.uid} escribió ${r.bytesWritten} B en ${dir} y la relectura no coincide (readBack=${r.readBack}, sameContent=${r.sameContent})`,
          remedy: "Escritura aceptada y contenido perdido o alterado: el backend del volumen miente.",
        };
      }
      if (!r.cleanedUp) {
        return {
          status: "failed",
          evidence: `uid=${r.uid} escribió y releyó en ${dir} pero no pudo borrar el fichero de prueba`,
          remedy: "Escribir sin poder borrar deja basura y sugiere permisos parciales.",
        };
      }
      return {
        status: "verified",
        evidence: `uid=${r.uid} gid=${r.gid} escribió ${r.bytesWritten} B en ${dir}, releyó idéntico y limpió`,
      };
    },
  };
}

export const botsStorageCheck = storageCheck("bots", "El árbol de bots es escribible por el uid del proceso");
export const replaysStorageCheck = storageCheck("replays", "El árbol de replays es escribible por el uid del proceso");

export const adminIdentityCheck: ReadinessCheck<FirstRunContext> = {
  id: "admin.bootstrap_identity",
  block: "seguridad",
  title: "Existe identidad administrativa y no procede de credenciales del repositorio",
  proves:
    "Que la consulta se ejecutó de verdad y vio al menos una cuenta administrativa, ninguna con credenciales de ejemplo del repo.",
  doesNotProve:
    "Que esa cuenta se pueda usar para iniciar sesión, que la contraseña sea fuerte ni que tenga segundo factor. Contar filas no es autenticar.",
  required: true,
  async run(ctx: FirstRunContext): Promise<CheckOutcome> {
    const r = await ctx.probes.adminIdentity();
    if (!r.queried) {
      return {
        status: "not_exercised",
        evidence: `la consulta de administradores no llegó a ejecutarse${r.reason ? ` (${r.reason})` : ""}`,
        remedy: "Un recuento que no se ejecutó no es 'cero administradores': es desconocido.",
      };
    }
    const empty = requireEffect(r.adminCount, {
      // La consulta SÍ se ejecutó: cero administradores es un hecho observado,
      // no una comprobación pendiente. Ésta es exactamente la frontera que el
      // `UPDATE 0` borró en su día.
      status: "failed",
      evidence: "la consulta se ejecutó y no hay ninguna cuenta administrativa (0 filas)",
      remedy:
        "Crea el administrador con el bootstrap del operador. Un comando que termina con éxito sobre 0 filas no creó nada.",
    });
    if (empty) return empty;
    if (r.seededWithRepoCredentials > 0) {
      return {
        status: "failed",
        evidence: `${r.seededWithRepoCredentials} cuenta(s) administrativa(s) con credenciales de ejemplo del repositorio`,
        remedy:
          "Sembrar usuarios con la contraseña del repo es una puerta abierta: recréalos con credenciales propias.",
      };
    }
    return {
      status: "verified",
      evidence: `${r.adminCount} cuenta(s) administrativa(s), ninguna con credenciales del repositorio`,
    };
  },
};

export const FIRST_RUN_CHECKS: readonly ReadinessCheck<FirstRunContext>[] = [
  botsStorageCheck,
  replaysStorageCheck,
  adminIdentityCheck,
];
