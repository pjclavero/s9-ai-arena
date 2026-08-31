/**
 * R17 · Catálogo de comprobaciones de readiness.
 *
 * Cada comprobación nace de un fallo REAL observado en este proyecto y está
 * escrita para distinguir PRESENTE de FUNCIONAL. El campo `doesNotProve` no es
 * decoración: es lo que impide que el verde de una comprobación se lea como
 * garantía de otra cosa.
 */
import { isEnabled } from "./config.ts";
import type { ReadinessCheck, ReadinessContext } from "./engine.ts";
import { requireEffect } from "./engine.ts";

/** Antigüedad máxima tolerada de la última copia con éxito. */
export const BACKUP_MAX_AGE_HOURS = 26;

// ── Bloque: almacenamiento ───────────────────────────────────────────────────
const storageWritable: ReadinessCheck = {
  id: "storage.writable",
  block: "almacenamiento",
  title: "El directorio de datos es escribible por el uid del proceso",
  proves: "Que ESTE proceso puede crear, escribir y releer un fichero en el directorio de datos.",
  doesNotProve:
    "Que haya espacio para la carga real, que el volumen sea persistente ni que esté respaldado. STORAGE EXISTS != STORAGE WRITABLE, y writable != duradero.",
  required: true,
  async run(ctx: ReadinessContext) {
    const dir = (ctx.env.S9_DATA_DIR ?? "").trim();
    if (dir === "") {
      return {
        status: "not_exercised" as const,
        evidence: "S9_DATA_DIR sin definir: no se ha escrito en ningún sitio.",
        remedy: "Define S9_DATA_DIR apuntando al volumen de datos.",
      };
    }
    const r = await ctx.probes.dataDirWrite(dir);
    const empty = requireEffect(r.bytesWritten, {
      evidence: `no se escribió ni un byte en ${dir}${r.reason ? ` (${r.reason})` : ""}`,
      remedy: "Comprueba propiedad del volumen (uid del proceso) y que el montaje no sea de solo lectura.",
    });
    if (empty) return empty;
    if (!r.readBack || !r.sameContent) {
      return {
        status: "failed" as const,
        evidence: `se escribió en ${dir} pero la relectura no coincide (readBack=${r.readBack}, sameContent=${r.sameContent})`,
        remedy: "Escritura aceptada y contenido perdido: revisa el backend del volumen.",
      };
    }
    return {
      status: "verified" as const,
      evidence: `escritos ${r.bytesWritten} B en ${dir} y releídos idénticos`,
    };
  },
};

// ── Bloque: copias de seguridad ──────────────────────────────────────────────
const backupRan: ReadinessCheck = {
  id: "backup.last_run_succeeded",
  block: "copias",
  title: "La última copia se ejecutó, terminó bien y escribió datos",
  proves: "Que existe una ejecución reciente de la copia con código 0 y con bytes en el último snapshot.",
  doesNotProve:
    "Que esos datos se puedan restaurar. BACKED_UP != RECOVERY_VERIFIED. Tampoco prueba que el contenido sea el correcto.",
  required: true,
  async run(ctx: ReadinessContext) {
    const r = await ctx.probes.backupLastRun();
    if (r.ranAt === null || r.exitCode === null) {
      return {
        status: "not_exercised" as const,
        evidence: `no consta ninguna ejecución de la copia${r.reason ? ` (${r.reason})` : ""}`,
        remedy: "El temporizador puede estar sano y no haber ejecutado nada: revisa su última salida.",
      };
    }
    if (r.exitCode !== 0) {
      return {
        status: "failed" as const,
        evidence: `la última copia (${r.ranAt}) terminó con código ${r.exitCode}`,
        remedy: "Contenedor 'healthy' con su único trabajo fallando: el healthcheck no mira esto.",
      };
    }
    const empty = requireEffect(r.lastSnapshotBytes, {
      evidence: `la copia salió con código 0 pero el último snapshot tiene 0 bytes (${r.snapshotCount} snapshots)`,
      remedy: "EXIT 0 != BEHAVIOR EXERCISED: una copia vacía no es una copia.",
    });
    if (empty) return empty;
    if (r.ageHours !== null && r.ageHours > BACKUP_MAX_AGE_HOURS) {
      return {
        status: "failed" as const,
        evidence: `la última copia con éxito tiene ${r.ageHours} h (> ${BACKUP_MAX_AGE_HOURS} h)`,
        remedy: "Copia rancia: existe, pero ya no representa el estado actual.",
      };
    }
    return {
      status: "verified" as const,
      evidence: `copia de ${r.ranAt}, código 0, ${r.lastSnapshotBytes} B en el último de ${r.snapshotCount} snapshots`,
    };
  },
};

const backupRestorable: ReadinessCheck = {
  id: "backup.restore_drill",
  block: "copias",
  title: "Un simulacro de restauración recupera el canario",
  proves: "Que una restauración a destino desechable devuelve bytes y contiene el canario sembrado antes de la copia.",
  doesNotProve:
    "Que una restauración COMPLETA en producción funcione, ni el tiempo que tardaría (RTO). El simulacro es parcial por diseño.",
  required: true,
  async run(ctx: ReadinessContext) {
    const r = await ctx.probes.backupRestoreDrill();
    if (!r.attempted) {
      return {
        status: "not_exercised" as const,
        evidence: `no se intentó ninguna restauración${r.reason ? ` (${r.reason})` : ""}`,
        remedy: "Sin simulacro no hay recuperación verificada: existir una copia no basta.",
      };
    }
    const empty = requireEffect(r.restoredBytes, {
      evidence: "la restauración se ejecutó pero recuperó 0 bytes",
      remedy: "Restaurar la nada devuelve éxito: exige bytes y canario.",
    });
    if (empty) return empty;
    if (!r.canaryFound) {
      return {
        status: "failed" as const,
        evidence: `restaurados ${r.restoredBytes} B pero el canario no aparece`,
        remedy: "Se restauró algo que no es lo que se creía respaldar.",
      };
    }
    return {
      status: "verified" as const,
      evidence: `restaurados ${r.restoredBytes} B con el canario presente`,
    };
  },
};

// ── Bloque: seguridad ────────────────────────────────────────────────────────
const secretMounted: ReadinessCheck = {
  id: "security.secret_mounted",
  block: "seguridad",
  title: "El secreto de firma está montado y es legible DENTRO del proceso",
  proves: "Que el proceso puede leer bytes del secreto en su propio espacio de montaje.",
  doesNotProve:
    "Que el secreto sea fuerte, ni que sea el mismo que usan los demás servicios. SECRET EXISTS != SECRET MOUNTED, y montado != correcto.",
  required: true,
  async run(ctx: ReadinessContext) {
    const r = await ctx.probes.secretMounted("S9_JWT_SECRET");
    if (!r.mountedInProcess) {
      return {
        status: "failed" as const,
        evidence: `el secreto ${r.existsOnHost ? "existe en el host pero" : "no existe y"} no está montado en el proceso`,
        remedy: "Añade el montaje al servicio: el fichero en el host no viaja solo al contenedor.",
      };
    }
    const empty = requireEffect(r.readableBytes, {
      evidence: "el secreto está montado pero se leen 0 bytes",
      remedy: "Montaje presente y fichero vacío: el arranque parecería correcto y firmaría con nada.",
    });
    if (empty) return empty;
    return {
      status: "verified" as const,
      evidence: `secreto montado y legible (${r.readableBytes} B; valor no impreso)`,
    };
  },
};

const deployedVersionMatches: ReadinessCheck = {
  id: "security.deployed_version",
  block: "seguridad",
  title: "La versión en ejecución es la que dice la etiqueta",
  proves:
    "Que el contenedor corre una image ID que sigue existiendo en el daemon y que la etiqueta se construyó desde el commit que declara.",
  doesNotProve: "Que ese commit sea el que se revisó o mergeó. IMAGE TAG != DEPLOYED VERSION.",
  required: true,
  async run(ctx: ReadinessContext) {
    const r = await ctx.probes.deployedVersion();
    if (!r.runningImageId || !r.imageTag) {
      return {
        status: "not_exercised" as const,
        evidence: `no se pudo determinar la versión en ejecución${r.reason ? ` (${r.reason})` : ""}`,
        remedy: "Sin identidad de imagen no se puede afirmar qué está corriendo.",
      };
    }
    if (!r.imageIdPresentInDaemon) {
      return {
        status: "failed" as const,
        evidence: `el contenedor corre una image ID que ya no existe en el daemon (${r.imageTag})`,
        remedy: "No se puede reproducir ni reiniciar con lo mismo: reconstruye y redespliega.",
      };
    }
    if (r.taggedCommit && r.builtFromCommit && r.taggedCommit !== r.builtFromCommit) {
      return {
        status: "failed" as const,
        evidence: `la etiqueta dice ${r.taggedCommit} y la imagen se construyó desde ${r.builtFromCommit}`,
        remedy: "Etiqueta mentirosa: el despliegue no es el commit que crees.",
      };
    }
    return {
      status: "verified" as const,
      evidence: `imagen ${r.imageTag} presente en el daemon y construida desde ${r.builtFromCommit ?? "commit declarado"}`,
    };
  },
};

// ── Bloque: puertas ──────────────────────────────────────────────────────────
function gateCheck(
  key: string,
  block: "puertas-ejecucion" | "puertas-spectator",
  title: string,
  what: string,
): ReadinessCheck {
  return {
    id: `gate.${key.toLowerCase()}`,
    block,
    title,
    proves: `Que ${what} está apagada tanto en el entorno como en lo que expone el runtime.`,
    doesNotProve:
      "Que el código de detrás sea seguro si se encendiera. Una puerta apagada no valida lo que hay al otro lado.",
    required: true,
    async run(ctx: ReadinessContext) {
      const envOn = isEnabled(ctx.env[key]);
      const r = await ctx.probes.gateState(key);
      if (!r.probedRuntime) {
        return {
          status: "not_exercised" as const,
          evidence: `no se pudo consultar al runtime el estado de ${key}${r.reason ? ` (${r.reason})` : ""}`,
          remedy: "Creer al entorno sin preguntar al runtime es exactamente el fallo que evitamos.",
        };
      }
      if (envOn || r.envEnabled || r.runtimeAdvertisesEnabled) {
        return {
          status: "failed" as const,
          evidence: `${key} aparece ENCENDIDA (entorno=${envOn || r.envEnabled}, runtime=${r.runtimeAdvertisesEnabled}) y el operador la mantiene bloqueada`,
          remedy: `Apaga ${key} y reinicia el servicio: encenderla requiere un acto explícito y autorizado.`,
        };
      }
      return {
        status: "verified" as const,
        evidence: `${key} apagada en entorno y en runtime`,
      };
    },
  };
}

const realBattleGate = gateCheck(
  "S9_ENABLE_REAL_BATTLE_RUNS",
  "puertas-ejecucion",
  "La puerta de ejecución real está apagada",
  "la ejecución de contenedores de bots reales",
);

const spectateGate = gateCheck(
  "S9_PUBLIC_SPECTATE_ENABLED",
  "puertas-spectator",
  "La puerta de spectator/replay público está apagada",
  "la exposición pública de partidas y replays",
);

// ── Bloque: diagnóstico ──────────────────────────────────────────────────────
const dbCanaryCheck: ReadinessCheck = {
  id: "diagnostics.db_canary",
  block: "diagnostico",
  title: "La base de datos responde y la consulta se ejecutó de verdad",
  proves:
    "Que la consulta llegó al motor y vio el canario sembrado: distingue 'vacío correcto' de 'no se ejecutó nada'.",
  doesNotProve:
    "Que el esquema esté migrado al día ni que los datos de negocio sean correctos. EMPTY != ERROR sólo se resuelve con canario.",
  required: true,
  async run(ctx: ReadinessContext) {
    const r = await ctx.probes.dbCanary();
    if (!r.queryExecuted) {
      return {
        status: "not_exercised" as const,
        evidence: `la consulta no llegó a ejecutarse${r.reason ? ` (${r.reason})` : ""}`,
        remedy: "Un resultado vacío sin ejecución no es 'todo correcto'.",
      };
    }
    const empty = requireEffect(r.canaryRowsSeen, {
      evidence: `la consulta se ejecutó y devolvió 0 filas de canario (rowsAffected=${r.rowsAffected})`,
      remedy: "Sin canario, 0 filas es ambiguo: puede ser correcto-y-vacío o no haber ejercido nada.",
    });
    if (empty) return empty;
    return {
      status: "verified" as const,
      evidence: `consulta ejecutada, ${r.canaryRowsSeen} fila(s) de canario visibles`,
    };
  },
};

const diagnosticsRedacted: ReadinessCheck = {
  id: "diagnostics.bundle_redacted",
  block: "diagnostico",
  title: "El paquete de diagnóstico se genera y va redactado",
  proves: "Que se produce un paquete con contenido y sin patrones con pinta de secreto.",
  doesNotProve: "Que contenga lo necesario para diagnosticar un incidente concreto, ni que no filtre datos personales.",
  required: false,
  async run(ctx: ReadinessContext) {
    const r = await ctx.probes.diagnosticsBundle();
    if (!r.generated) {
      return {
        status: "not_exercised" as const,
        evidence: `no se generó ningún paquete${r.reason ? ` (${r.reason})` : ""}`,
        remedy: "Genera el paquete en frío, antes de necesitarlo en una incidencia.",
      };
    }
    const empty = requireEffect(r.bytes, {
      evidence: "el paquete se generó con 0 bytes",
      remedy: "Un fichero vacío con exit 0 no es diagnóstico.",
    });
    if (empty) return empty;
    if (r.secretLikeMatches > 0) {
      return {
        status: "failed" as const,
        evidence: `el paquete contiene ${r.secretLikeMatches} coincidencia(s) con pinta de secreto`,
        remedy: "Redacta antes de exportar: un diagnóstico se comparte fuera de la máquina.",
      };
    }
    return { status: "verified" as const, evidence: `paquete de ${r.bytes} B sin patrones de secreto` };
  },
};

export const READINESS_CHECKS: readonly ReadinessCheck[] = [
  storageWritable,
  backupRan,
  backupRestorable,
  secretMounted,
  deployedVersionMatches,
  realBattleGate,
  spectateGate,
  dbCanaryCheck,
  diagnosticsRedacted,
];
