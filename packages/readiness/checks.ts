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
    const dir = (ctx.env.REPLAYS_DIR ?? "").trim();
    if (dir === "") {
      return {
        status: "not_exercised" as const,
        evidence: "REPLAYS_DIR sin definir: no se ha escrito en ningún sitio.",
        remedy: "Define REPLAYS_DIR apuntando al volumen de replays (en el despliegue real, /data/replays).",
      };
    }
    const r = await ctx.probes.dataDirWrite(dir);
    if (!r.attempted) {
      // No se intentó escribir: eso NO es un volumen de solo lectura, es una
      // comprobación que no se ha hecho.
      return {
        status: "not_exercised" as const,
        evidence: `no se intentó escribir en ${dir}${r.reason ? ` (${r.reason})` : ""}`,
        remedy: "Ejecuta el motor donde el volumen esté montado: sin intentar la escritura no se sabe nada.",
      };
    }
    const empty = requireEffect(r.bytesWritten, {
      // Se intentó y el volumen lo rechazó: condición comprobada y NO cumplida.
      status: "failed" as const,
      evidence: `se intentó escribir en ${dir} y no entró ni un byte${r.reason ? ` (${r.reason})` : ""}`,
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
//
// Por qué CINCO comprobaciones y no una: el healthcheck real del servicio de
// copias en este despliegue es `pgrep crond`. Ese healthcheck pasa en verde con
// la copia fallando todas las noches — que es literalmente el incidente que R17
// existe para evitar. "Cron vivo" y "copia lista" son afirmaciones distintas y
// se miden por separado, cada una diciendo qué NO demuestra:
//
//   backup.process_alive             hay quien dispare la copia          (NO bloqueante)
//   backup.last_run_success          la última ejecución terminó bien    (bloqueante)
//   backup.last_snapshot_verified    dejó un snapshot reciente con bytes (bloqueante)
//   backup.pg_dump_checksum_verified el volcado releído cuadra con su hash (bloqueante)
//   backup.restore_verified          restaurar devuelve el canario       (bloqueante)
//
// La cadena es acumulativa: cada una es necesaria para la siguiente y ninguna
// implica la siguiente. `process_alive` es la única NO bloqueante, y a
// propósito: es la señal que engaña, así que puede informar pero nunca puede
// ser el motivo por el que una instalación se declara lista. Las tres últimas
// son las que separan BACKED_UP de RECOVERY_VERIFIED; si el entorno no permite
// ejercerlas, quedan `not_exercised` CON MOTIVO y bloquean — nunca aprobadas
// por omisión.

const backupProcessAlive: ReadinessCheck = {
  id: "backup.process_alive",
  block: "copias",
  title: "Hay un proceso vivo que puede disparar la copia",
  proves: "Que el planificador (cron/temporizador) del servicio de copias está corriendo AHORA.",
  doesNotProve:
    "Que la copia se haya ejecutado nunca, ni que la última saliera bien, ni que haya datos. Es el healthcheck que pasa en verde con la copia fallando cada noche: por eso esta comprobación NO es bloqueante.",
  required: false,
  async run(ctx: ReadinessContext) {
    const r = await ctx.probes.backupProcessAlive();
    if (!r.probed) {
      return {
        status: "not_exercised" as const,
        evidence: `no se pudo mirar si el planificador de copias está vivo${r.reason ? ` (${r.reason})` : ""}`,
        remedy: "Sin observar el proceso no se afirma nada: ni vivo ni muerto.",
      };
    }
    if (!r.processRunning) {
      return {
        status: "failed" as const,
        evidence: "se miró el servicio de copias y no hay planificador corriendo",
        remedy: "Nadie va a disparar la copia esta noche: revisa el servicio (no lo reinicies sin autorización).",
      };
    }
    return {
      status: "verified" as const,
      evidence: "planificador de copias vivo (esto NO dice nada del resultado de la última copia)",
    };
  },
};

const backupLastRunSuccess: ReadinessCheck = {
  id: "backup.last_run_success",
  block: "copias",
  title: "La última copia se ejecutó, terminó con código 0 y es reciente",
  proves: "Que existe una ejecución registrada de la copia, con su código de salida y su antigüedad.",
  doesNotProve:
    "Que esa ejecución escribiera datos, ni que el snapshot exista, ni que se pueda restaurar. EXIT 0 != BEHAVIOR EXERCISED.",
  required: true,
  async run(ctx: ReadinessContext) {
    const r = await ctx.probes.backupLastRun();
    if (!r.probed) {
      return {
        status: "not_exercised" as const,
        evidence: `no se pudo leer el resultado de la última copia${r.reason ? ` (${r.reason})` : ""}`,
        remedy: "Expón las métricas/registro de la última ejecución donde el motor pueda leerlos.",
      };
    }
    if (r.ranAt === null || r.exitCode === null) {
      return {
        status: "failed" as const,
        evidence: "se miró el registro de copias y NO consta ninguna ejecución",
        remedy: "El temporizador puede estar sano y no haber ejecutado nada nunca: eso no es una copia.",
      };
    }
    if (r.exitCode !== 0) {
      return {
        status: "failed" as const,
        evidence: `la última copia (${r.ranAt}) terminó con código ${r.exitCode}`,
        remedy: "Contenedor 'healthy' con su único trabajo fallando: el healthcheck no mira esto.",
      };
    }
    if (r.ageHours !== null && r.ageHours > BACKUP_MAX_AGE_HOURS) {
      return {
        status: "failed" as const,
        evidence: `la última copia con éxito tiene ${r.ageHours} h (> ${BACKUP_MAX_AGE_HOURS} h)`,
        remedy: "Copia rancia: existe, pero ya no representa el estado actual.",
      };
    }
    return {
      status: "verified" as const,
      evidence: `última copia ${r.ranAt}, código 0, ${r.ageHours ?? "?"} h de antigüedad`,
    };
  },
};

const backupLastSnapshotVerified: ReadinessCheck = {
  id: "backup.last_snapshot_verified",
  block: "copias",
  title: "La última copia dejó un snapshot reciente y con bytes en el repositorio",
  proves:
    "Que el repositorio de copias contiene un snapshot fechado dentro de la ventana y con tamaño mayor que cero, leído del propio repositorio y no del proceso que dijo haberlo creado.",
  doesNotProve:
    "Que el snapshot sea íntegro (eso sería una verificación de repositorio, que NO es de solo lectura), ni que su contenido sea el correcto, ni que se pueda restaurar.",
  required: true,
  async run(ctx: ReadinessContext) {
    const r = await ctx.probes.backupLastSnapshot();
    if (!r.probed) {
      return {
        status: "not_exercised" as const,
        evidence: `no se pudo consultar el repositorio de copias${r.reason ? ` (${r.reason})` : ""}`,
        remedy: "Sin mirar el repositorio, 'se creó un snapshot' es sólo lo que dice quien lo creó.",
      };
    }
    if (r.snapshotCount === 0 || r.latestSnapshotAt === null) {
      return {
        status: "failed" as const,
        evidence: "se consultó el repositorio de copias y no hay ningún snapshot",
        remedy: "La ejecución pudo salir con código 0 sin dejar nada: el repositorio es la fuente de verdad.",
      };
    }
    const empty = requireEffect(r.latestSnapshotBytes, {
      // Se leyó el repositorio y el snapshot mide cero: condición comprobada y
      // no cumplida. Una copia vacía no es una copia.
      status: "failed" as const,
      evidence: `el último snapshot (${r.latestSnapshotAt}) existe pero mide 0 bytes (${r.snapshotCount} snapshots)`,
      remedy: "EXIT 0 != BEHAVIOR EXERCISED: una copia vacía no es una copia.",
    });
    if (empty) return empty;
    if (r.ageHours !== null && r.ageHours > BACKUP_MAX_AGE_HOURS) {
      return {
        status: "failed" as const,
        evidence: `el último snapshot tiene ${r.ageHours} h (> ${BACKUP_MAX_AGE_HOURS} h)`,
        remedy: "Puede haber ejecuciones con código 0 que ya no añaden snapshots: mira el repositorio, no el proceso.",
      };
    }
    return {
      status: "verified" as const,
      evidence: `último snapshot ${r.latestSnapshotAt}, ${r.latestSnapshotBytes} B, ${r.snapshotCount} snapshots en el repositorio`,
    };
  },
};

const backupPgDumpChecksumVerified: ReadinessCheck = {
  id: "backup.pg_dump_checksum_verified",
  block: "copias",
  title: "El volcado de PostgreSQL guardado cuadra con su checksum",
  proves:
    "Que el volcado ALMACENADO se releyó y su hash coincide con el del manifest: la copia contiene el fichero que dice contener y no se ha corrompido en el camino.",
  doesNotProve:
    "Que el volcado sea restaurable ni que el esquema esté al día. Un dump íntegro de una base equivocada sigue siendo íntegro.",
  required: true,
  async run(ctx: ReadinessContext) {
    const r = await ctx.probes.backupPgDumpChecksum();
    if (!r.probed) {
      return {
        status: "not_exercised" as const,
        evidence: `no se releyó el volcado almacenado${r.reason ? ` (${r.reason})` : ""}`,
        remedy:
          "Que el productor anote 'pg_dump correcto' no es contrastarlo: hace falta releer el fichero de la copia y recalcular su hash.",
      };
    }
    const empty = requireEffect(r.dumpBytes, {
      status: "failed" as const,
      evidence: "se leyó el volcado almacenado y tiene 0 bytes",
      remedy: "Un dump vacío pasa cualquier 'pg_dump exit 0': exige bytes.",
    });
    if (empty) return empty;
    if (!r.checksumMatches) {
      return {
        status: "failed" as const,
        evidence: `el volcado almacenado (${r.dumpBytes} B) NO coincide con su checksum del manifest`,
        remedy: "La copia contiene algo distinto de lo que promete el manifest: no la des por buena.",
      };
    }
    return {
      status: "verified" as const,
      evidence: `volcado de ${r.dumpBytes} B releído y coincidente con su checksum`,
    };
  },
};

const backupRestoreVerified: ReadinessCheck = {
  id: "backup.restore_verified",
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
      // Se intentó restaurar y volvió la nada: fallo observado.
      status: "failed" as const,
      evidence: "la restauración se ejecutó y recuperó 0 bytes",
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
    const r = await ctx.probes.secretMounted("JWT_SECRET_FILE");
    if (!r.probed) {
      // FALSO FALLO CORREGIDO: la sonda que devuelve "no disponible en este
      // entorno" NO ha mirado el espacio de montaje. Decir `failed` ahí es
      // afirmar que el secreto no está montado habiendo mirado nada, y cuatro
      // falsos rojos entierran los rojos de verdad.
      return {
        status: "not_exercised" as const,
        evidence: `no se pudo mirar el espacio de montaje del proceso${r.reason ? ` (${r.reason})` : ""}`,
        remedy: "Ejecuta el motor dentro del proceso que monta el secreto: desde fuera no se observa su montaje.",
      };
    }
    if (!r.mountedInProcess) {
      return {
        status: "failed" as const,
        evidence: `se miró el proceso: el secreto ${r.existsOnHost ? "existe en el host pero" : "no existe y"} no está montado`,
        remedy: "Añade el montaje al servicio: el fichero en el host no viaja solo al contenedor.",
      };
    }
    const empty = requireEffect(r.readableBytes, {
      // Montado y con cero bytes: se miró y no se cumple.
      status: "failed" as const,
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
    if (r.tagResolvesToRunningId === false) {
      // La etiqueta se movió bajo los pies del contenedor: el proceso vivo y la
      // etiqueta con la que arrancó ya no son la misma imagen. Un restart
      // traería OTRA versión sin que nadie lo hubiera decidido.
      return {
        status: "failed" as const,
        evidence: `${r.imageTag} resuelve hoy a otra imagen distinta de la que corre el contenedor`,
        remedy: "Un restart cambiaría la versión sin decisión: fija la imagen por digest o retagea a la que está viva.",
      };
    }
    if (!r.builtFromCommit) {
      // La imagen no lleva el commit dentro (ADR-016): sin identidad embebida no
      // se ha OBSERVADO de qué árbol salió, sólo lo que dice la etiqueta — que es
      // exactamente lo que puede mentir. Aprobar aquí sería IMAGE TAG leído como
      // DEPLOYED VERSION.
      return {
        status: "not_exercised" as const,
        evidence: `la imagen ${r.imageTag} existe en el daemon pero no lleva identidad de build embebida: la procedencia no se ha comprobado`,
        remedy:
          "Reconstruye con BUILD_COMMIT/org.opencontainers.image.revision (ADR-016): sin commit dentro, la etiqueta es la única fuente y puede mentir.",
      };
    }
    if (r.taggedCommit && r.taggedCommit !== r.builtFromCommit) {
      return {
        status: "failed" as const,
        evidence: `la etiqueta dice ${r.taggedCommit} y la imagen se construyó desde ${r.builtFromCommit}`,
        remedy: "Etiqueta mentirosa: el despliegue no es el commit que crees.",
      };
    }
    return {
      status: "verified" as const,
      evidence: `imagen ${r.imageTag} presente en el daemon y construida desde ${r.builtFromCommit}`,
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
      // La consulta SÍ se ejecutó y el canario no apareció: se comprobó y no se
      // cumple. (Cuando ni siquiera se ejecuta, la rama de arriba ya devuelve
      // `not_exercised`.)
      status: "failed" as const,
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
      // Se generó y pesa cero: observado y no cumplido.
      status: "failed" as const,
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
  backupProcessAlive,
  backupLastRunSuccess,
  backupLastSnapshotVerified,
  backupPgDumpChecksumVerified,
  backupRestoreVerified,
  secretMounted,
  deployedVersionMatches,
  realBattleGate,
  spectateGate,
  dbCanaryCheck,
  diagnosticsRedacted,
];
