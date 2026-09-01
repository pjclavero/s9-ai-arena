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

/** Un sufijo de etiqueta que parece un commit: hex de 7 a 40, nada más. */
const RE_COMMIT = /^[0-9a-f]{7,40}$/;

/** Commit que ANUNCIA la etiqueta, si es que anuncia alguno. */
export function commitDeEtiqueta(tag: string | null): string | null {
  if (!tag) return null;
  const sufijo = tag
    .slice(tag.lastIndexOf(":") + 1)
    .trim()
    .toLowerCase();
  return RE_COMMIT.test(sufijo) ? sufijo : null;
}

/** Commit EMBEBIDO en la imagen. `unknown` no es un commit: es ausencia. */
export function commitEmbebido(
  env: Readonly<Record<string, string>>,
  labels: Readonly<Record<string, string>>,
): string | null {
  const candidatos = [env.BUILD_COMMIT, labels["org.opencontainers.image.revision"]];
  for (const c of candidatos) {
    const v = (c ?? "").trim().toLowerCase();
    if (v !== "" && v !== "unknown") return v;
  }
  return null;
}

/**
 * Núcleo puro. Compara sólo commits COMPARABLES: si uno es prefijo del otro
 * (short sha frente a sha completo) no hay discrepancia, y si la imagen no trae
 * identidad embebida se devuelve `builtFromCommit: null` — que la comprobación
 * lee como "no se puede afirmar", no como "coincide".
 */
export function interpretarVersionDesplegada(obs: ObservacionImagen): DeployedVersionResult {
  if (!obs.runningImageId || !obs.imageTag) {
    return {
      imageTag: obs.imageTag,
      taggedCommit: commitDeEtiqueta(obs.imageTag),
      builtFromCommit: null,
      runningImageId: obs.runningImageId,
      imageIdPresentInDaemon: false,
      reason: obs.reason ?? "no se pudo leer la identidad de imagen del contenedor",
    };
  }

  const taggedCommit = commitDeEtiqueta(obs.imageTag);
  const embebido = commitEmbebido(obs.envImagen, obs.labelsImagen);
  const builtFromCommit = embebido === null ? null : mismoCommit(embebido, taggedCommit) ? taggedCommit : embebido;

  return {
    imageTag: obs.imageTag,
    taggedCommit,
    builtFromCommit,
    runningImageId: obs.runningImageId,
    imageIdPresentInDaemon: obs.imagenResoluble,
    // Sólo se afirma si se pudo resolver la etiqueta; si no, se deja sin mirar.
    ...(obs.idDeLaEtiqueta === null ? {} : { tagResolvesToRunningId: obs.idDeLaEtiqueta === obs.runningImageId }),
    ...(obs.reason ? { reason: obs.reason } : {}),
  };
}

/** Dos commits son el mismo si uno es prefijo del otro (short sha vs completo). */
export function mismoCommit(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a.startsWith(b) || b.startsWith(a);
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
        reason: "S9_READINESS_CONTAINER sin definir: no se ha mirado ningún contenedor",
      };
    }
    return interpretarVersionDesplegada(observarImagen(nombre, run ?? ejecutorReal()));
  };
}
