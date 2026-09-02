/**
 * R17 · Sonda REAL de "versión desplegada" (IMAGE TAG != DEPLOYED VERSION).
 *
 * Por qué esta y no otra: es la única de las ocho sondas pendientes que se
 * puede ejercer contra la instalación real SIN escribir nada — sólo
 * `docker inspect` / `docker images`, lectura pura — y ataca una de las siete
 * confusiones de R17 con dos incidentes reales detrás (ver ADR-016):
 *
 *   1. Un build del árbol VIEJO etiquetado con el commit NUEVO: la etiqueta
 *      miente y comparar "etiqueta declarada == etiqueta desplegada" es una
 *      tautología. Se resuelve leyendo el commit EMBEBIDO en la imagen
 *      (BUILD_COMMIT / org.opencontainers.image.revision) y contrastándolo con
 *      el que anuncia la etiqueta.
 *   2. Un contenedor corriendo sobre una image ID ya BORRADA del daemon: vivo,
 *      "healthy", y no reproducible tras un restart.
 *
 * Reglas que respeta:
 *  - Sólo lectura. Ningún comando de esta sonda modifica el daemon.
 *  - Además detecta un tercer caso visto en VM108: la ETIQUETA SE MOVIÓ y ya
 *    resuelve a otra imagen distinta de la que corre el contenedor, así que un
 *    restart cambiaría de versión sin que nadie lo decidiera.
 *  - Efecto observado, no exit code: si no se puede consultar al daemon se
 *    devuelve `reason` y la comprobación queda `not_exercised`, jamás verde.
 *  - Núcleo puro (`interpretarVersionDesplegada`) separado de la ejecución, para
 *    que los tests puedan ponerlo rojo sin daemon.
 */
import { spawnSync } from "node:child_process";
import {
  clasificarDrift,
  commitDeReferencia,
  commitEmbebido,
  mismoCommit,
  type Clasificacion,
  type EstadoDrift,
} from "../../infrastructure/scripts/lib/image-drift.mjs";

/** Ejecutor inyectable: devuelve rc EXPLÍCITO, nunca el `$?` de una tubería. */
export interface EjecutorComando {
  (cmd: string, args: string[]): { rc: number; out: string; err: string };
}

export interface DeployedVersionResult {
  imageTag: string | null;
  taggedCommit: string | null;
  builtFromCommit: string | null;
  runningImageId: string | null;
  imageIdPresentInDaemon: boolean;
  tagResolvesToRunningId?: boolean;
  /**
   * Estado explícito del modelo de drift de ADR-016. Los booleanos de arriba se
   * conservan como OBSERVACIONES separadas (existencia, resolución de la
   * referencia), pero la decisión se toma sobre el estado, no combinándolos a
   * mano en cada consumidor: eso es lo que mezclaba cosas distintas.
   */
  driftState: EstadoDrift | null;
  driftExplanation?: string;
  reason?: string;
}

/** Observaciones crudas que hace falta reunir del daemon. */
export interface ObservacionImagen {
  /** `.Image` del contenedor: la ID de contenido sobre la que corre AHORA. */
  runningImageId: string | null;
  /** `.Config.Image`: la etiqueta con la que se arrancó (puede mentir). */
  imageTag: string | null;
  /** ¿`docker image inspect <runningImageId>` la resuelve todavía? */
  imagenResoluble: boolean;
  /** ID a la que resuelve HOY la etiqueta, o null si ya no resuelve a nada. */
  idDeLaEtiqueta: string | null;
  /** Entorno embebido en la imagen (`.Config.Env` de `docker image inspect`). */
  envImagen: Readonly<Record<string, string>>;
  /** Etiquetas OCI de la imagen. */
  labelsImagen: Readonly<Record<string, string>>;
  /** Motivo por el que no se pudo observar (si aplica). */
  reason?: string;
}

// El modelo (qué es un commit de etiqueta, qué cuenta como identidad embebida,
// cómo se comparan dos commits) vive UNA sola vez, en el clasificador de
// ADR-016. Aquí sólo se reexporta: dos copias del mismo criterio es cómo se
// consigue que el gate y la sonda discrepen sin que nadie se entere.
export { mismoCommit, commitEmbebido };
export const commitDeEtiqueta = commitDeReferencia;

export function interpretarVersionDesplegada(obs: ObservacionImagen): DeployedVersionResult {
  const c: Clasificacion = clasificarDrift({
    nombre: obs.imageTag ?? "(contenedor)",
    runningImageId: obs.runningImageId,
    referencia: obs.imageTag,
    imagenResoluble: obs.imagenResoluble,
    idDeLaReferencia: obs.idDeLaEtiqueta,
    envImagen: obs.envImagen,
    labelsImagen: obs.labelsImagen,
    ...(obs.reason ? { reason: obs.reason } : {}),
  });

  return {
    imageTag: c.referencia,
    taggedCommit: c.commitEtiqueta,
    // `null` cuando la imagen no trae identidad embebida: la comprobación lo lee
    // como "no se puede afirmar", nunca como "coincide".
    builtFromCommit: c.procedencia === "verified" ? c.commitEmbebido : null,
    runningImageId: c.runningImageId,
    imageIdPresentInDaemon: c.runtimeImageExists,
    ...(c.tagPointsToRuntime === null ? {} : { tagResolvesToRunningId: c.tagPointsToRuntime }),
    driftState: c.estado,
    driftExplanation: c.explicacion,
    ...(c.reason ? { reason: c.reason } : {}),
  };
}

function ejecutorReal(): EjecutorComando {
  return (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    return { rc: r.status ?? 1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
  };
}

function parseKeyValueList(json: string): Record<string, string> {
  // `.Config.Env` es ["A=1","B=2"]; `.Config.Labels` es un objeto o `null`.
  let dato: unknown;
  try {
    dato = JSON.parse(json);
  } catch {
    return Object.create(null) as Record<string, string>;
  }
  const out = Object.create(null) as Record<string, string>;
  if (Array.isArray(dato)) {
    for (const linea of dato) {
      if (typeof linea !== "string") continue;
      const i = linea.indexOf("=");
      if (i > 0) out[linea.slice(0, i)] = linea.slice(i + 1);
    }
  } else if (dato && typeof dato === "object") {
    for (const [k, v] of Object.entries(dato as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
  }
  return out;
}

/**
 * Reúne del daemon lo que hace falta. SOLO LECTURA: `docker inspect` y
 * `docker image inspect`, nada más.
 *
 * La presencia se decide con `docker image inspect <id>`, NO con
 * `docker images -q`: ese listado omite las imágenes sin etiqueta de nivel
 * superior, así que un contenedor perfectamente reproducible aparecería como
 * huérfano (falso positivo observado en VM108 con postgres).
 */
export function observarImagen(contenedor: string, run: EjecutorComando = ejecutorReal()): ObservacionImagen {
  const vacio = Object.create(null) as Record<string, string>;
  const insp = run("docker", ["inspect", "-f", "{{.Image}}\t{{.Config.Image}}", contenedor]);
  if (insp.rc !== 0) {
    return {
      runningImageId: null,
      imageTag: null,
      imagenResoluble: false,
      idDeLaEtiqueta: null,
      envImagen: vacio,
      labelsImagen: vacio,
      reason: `docker inspect ${contenedor}: ${insp.err || "falló"}`,
    };
  }
  const [runningImageId, imageTag] = insp.out.split("\t").map((s) => s.trim());
  if (!runningImageId || !imageTag) {
    return {
      runningImageId: runningImageId || null,
      imageTag: imageTag || null,
      imagenResoluble: false,
      idDeLaEtiqueta: null,
      envImagen: vacio,
      labelsImagen: vacio,
      reason: "docker inspect no devolvió identidad de imagen",
    };
  }

  // La identidad se lee de la IMAGEN, no del contenedor: el entorno del
  // contenedor lo puede sobrescribir el compose, y entonces no diría de qué
  // árbol se construyó, sino qué le dijeron que dijera.
  const meta = run("docker", [
    "image",
    "inspect",
    runningImageId,
    "-f",
    "{{json .Config.Env}}\t{{json .Config.Labels}}",
  ]);
  if (meta.rc !== 0) {
    // La imagen ya no se resuelve: es el incidente 2, no un fallo de sonda.
    return {
      runningImageId,
      imageTag,
      imagenResoluble: false,
      idDeLaEtiqueta: null,
      envImagen: vacio,
      labelsImagen: vacio,
    };
  }
  const [envJson, labelsJson] = meta.out.split("\t");

  // ¿A qué imagen apunta HOY la etiqueta? Si ya no resuelve, no se afirma nada.
  const porEtiqueta = run("docker", ["image", "inspect", imageTag, "-f", "{{.Id}}"]);
  const idDeLaEtiqueta = porEtiqueta.rc === 0 && porEtiqueta.out.trim() !== "" ? porEtiqueta.out.trim() : null;

  return {
    runningImageId,
    imageTag,
    imagenResoluble: true,
    idDeLaEtiqueta,
    envImagen: parseKeyValueList(envJson ?? "[]"),
    labelsImagen: parseKeyValueList(labelsJson ?? "{}"),
  };
}

/**
 * Sonda lista para inyectar en `ReadinessProbes.deployedVersion`.
 * `contenedor` vacío ⇒ `not_exercised` con motivo: sin saber QUÉ contenedor
 * mirar no se ha observado nada, y eso no se aprueba por omisión.
 */
export function deployedVersionProbe(contenedor: string, run?: EjecutorComando) {
  return async (): Promise<DeployedVersionResult> => {
    const nombre = contenedor.trim();
    if (nombre === "") {
      return {
        imageTag: null,
        taggedCommit: null,
        builtFromCommit: null,
        runningImageId: null,
        imageIdPresentInDaemon: false,
        driftState: null,
        reason: "S9_READINESS_CONTAINER sin definir: no se ha mirado ningún contenedor",
      };
    }
    return interpretarVersionDesplegada(observarImagen(nombre, run ?? ejecutorReal()));
  };
}
