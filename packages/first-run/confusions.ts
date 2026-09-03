/**
 * R17 · Las SIETE CONFUSIONES, como registro ejecutable.
 *
 * Cada una se observó de verdad en este proyecto. No están aquí como prosa:
 * son entradas con identidad, con la pregunta que hay que responder con
 * EVIDENCIA y con la trampa concreta que hace que una respuesta ingenua salga
 * verde. El asistente de primer arranque exige que cada dominio que las
 * declara tenga al menos una comprobación VERIFICADA que las cubra; si no la
 * tiene, el dominio queda `unknown` con la laguna nombrada — nunca aprobado
 * por omisión.
 */

export type ConfusionId =
  | "healthy_vs_ready"
  | "backed_up_vs_recovery_verified"
  | "tag_vs_deployed_version"
  | "secret_exists_vs_mounted"
  | "storage_exists_vs_writable"
  | "process_alive_vs_job_success"
  | "exit_zero_vs_effect_verified";

export interface Confusion {
  id: ConfusionId;
  /** Enunciado corto, tal y como se dice en el proyecto. */
  statement: string;
  /** Caso real que la originó. */
  observed: string;
  /** Pregunta que la comprobación debe responder con efecto observado. */
  question: string;
  /** Por qué una comprobación ingenua saldría verde igualmente. */
  naiveGreen: string;
}

export const CONFUSIONS: readonly Confusion[] = [
  {
    id: "healthy_vs_ready",
    statement: "HEALTHY != READY",
    observed: "Un contenedor marcado sano cuyo único trabajo fallaba cada noche.",
    question: "¿El trabajo que justifica el servicio se ejecutó y produjo su efecto?",
    naiveGreen: "El healthcheck mira el proceso, no el trabajo; siempre dice sano.",
  },
  {
    id: "backed_up_vs_recovery_verified",
    statement: "BACKED_UP != RECOVERY_VERIFIED",
    observed: "Existir una copia se leyó como poder restaurarla.",
    question: "¿Una restauración a destino desechable devolvió bytes y el canario sembrado?",
    naiveGreen: "Listar snapshots tiene éxito aunque ninguno sea restaurable.",
  },
  {
    id: "tag_vs_deployed_version",
    statement: "TAG != DEPLOYED VERSION",
    observed: "Etiqueta que miente, image ID borrada del daemon, etiqueta movida bajo los pies.",
    question: "¿La image ID en ejecución sigue existiendo y se construyó del commit que declara?",
    naiveGreen: "`docker ps` muestra la etiqueta que se pidió, no la que realmente corre.",
  },
  {
    id: "secret_exists_vs_mounted",
    statement: "SECRET EXISTS != SECRET MOUNTED",
    observed: "Fichero de secreto presente en el host y ausente dentro del proceso.",
    question: "¿El proceso lee bytes del secreto en su propio espacio de montaje?",
    naiveGreen: "Un `test -f` en el host aprueba sin que el contenedor lo vea.",
  },
  {
    id: "storage_exists_vs_writable",
    statement: "STORAGE EXISTS != STORAGE WRITABLE",
    observed: "Volumen existente y no escribible por el uid del proceso.",
    question: "¿Qué PROCESO (uid/gid) escribió, releyó y obtuvo el mismo contenido?",
    naiveGreen: "Comprobar que el directorio existe, o escribir como root, aprueba siempre.",
  },
  {
    id: "process_alive_vs_job_success",
    statement: "PROCESS ALIVE != JOB SUCCESS",
    observed: "El healthcheck de la copia era `pgrep crond`.",
    question: "¿Cuál fue el código de salida y el efecto de la ÚLTIMA ejecución del trabajo?",
    naiveGreen: "El planificador está vivo aunque no haya lanzado nada nunca.",
  },
  {
    id: "exit_zero_vs_effect_verified",
    statement: "COMMAND EXIT 0 != EFFECT VERIFIED",
    observed: "Un `UPDATE 0` se leyó como aceptación con la tabla vacía.",
    question: "¿Cuál fue la MAGNITUD del efecto (filas, bytes) y se distingue de cero?",
    naiveGreen: "El comando termina con código 0 sin haber tocado nada.",
  },
];

export const CONFUSION_BY_ID: ReadonlyMap<ConfusionId, Confusion> = new Map(CONFUSIONS.map((c) => [c.id, c]));
