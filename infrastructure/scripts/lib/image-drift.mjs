/**
 * ADR-016 · Modelo de drift de imagen: CUATRO estados explícitos.
 *
 * Antes había booleanos sueltos ("¿existe la imagen?", "¿coincide el tag?") y
 * eso mezclaba cosas que no son la misma: que una imagen EXISTA no dice que sea
 * la que la etiqueta nombra hoy, y que la etiqueta nombre un commit no dice que
 * la imagen contenga ese commit. Los tres incidentes reales del proyecto son
 * tres modos de fallo distintos, así que se modelan como estados, no como
 * flags:
 *
 *   TAG_CONTENT_MISMATCH  la etiqueta existe pero contiene código distinto
 *                         (incidente 1: árbol viejo etiquetado como nuevo).
 *   IMAGE_MISSING         el contenedor corre una image ID ya inexistente
 *                         (incidente 2: estado no reproducible tras restart).
 *   TAG_MOVED             la image ID que corre es válida, pero la referencia
 *                         declarada resuelve HOY a otra (incidente 3, VM108:
 *                         upstream republicó `postgres:16-alpine`; un restart
 *                         cambiaría de versión sin decisión de nadie).
 *   RUNTIME_MATCH         la image ID en ejecución es la esperada/pinchada.
 *
 * Las cuatro observaciones que se comparan POR SEPARADO, sin mezclarlas:
 *   (a) image ID que corre                → `.Image` del contenedor
 *   (b) referencia/etiqueta declarada     → `.Config.Image` del contenedor
 *   (c) image ID a la que resuelve HOY (b)→ `docker image inspect <ref> -f {{.Id}}`
 *   (d) digest esperado si hay pin        → dato del despliegue, opcional
 *
 * REGLA DURA: la EXISTENCIA de (a) se comprueba con `docker image inspect <id>`,
 * NUNCA con `docker images -q`. Ese listado omite las imágenes sin etiqueta de
 * nivel superior; medido en VM108, `postgres` corre una image ID que existe y
 * que `docker image inspect` resuelve, pero que NO aparece en `docker images -q`
 * por haberse quedado sin RepoTags. Usar ese listado como prueba de existencia
 * produce a la vez un DRIFT CRÍTICO falso y la ceguera al drift verdadero.
 */

/** @typedef {"TAG_CONTENT_MISMATCH"|"IMAGE_MISSING"|"TAG_MOVED"|"RUNTIME_MATCH"} EstadoDrift */

export const TAG_CONTENT_MISMATCH = "TAG_CONTENT_MISMATCH";
export const IMAGE_MISSING = "IMAGE_MISSING";
export const TAG_MOVED = "TAG_MOVED";
export const RUNTIME_MATCH = "RUNTIME_MATCH";

/** Los cuatro estados del modelo, en orden de severidad decreciente. */
export const ESTADOS = [IMAGE_MISSING, TAG_CONTENT_MISMATCH, TAG_MOVED, RUNTIME_MATCH];

/** Estados que NO son un despliegue sano. */
export const ESTADOS_DE_DRIFT = [IMAGE_MISSING, TAG_CONTENT_MISMATCH, TAG_MOVED];

/** Un sufijo de referencia que parece un commit: hex de 7 a 40, nada más. */
const RE_COMMIT = /^[0-9a-f]{7,40}$/;

/**
 * Commit que ANUNCIA la referencia, si es que anuncia alguno.
 * `postgres:16-alpine` no anuncia ninguno; `s9arena/api:4d469dc` sí.
 * @param {string|null|undefined} referencia
 * @returns {string|null}
 */
export function commitDeReferencia(referencia) {
  if (!referencia) return null;
  const sufijo = String(referencia)
    .slice(String(referencia).lastIndexOf(":") + 1)
    .trim()
    .toLowerCase();
  return RE_COMMIT.test(sufijo) ? sufijo : null;
}

/**
 * Commit EMBEBIDO en la imagen. `unknown` no es un commit: es ausencia, y por
 * contrato de ADR-016 una imagen sin build-args queda marcada así a propósito.
 * @param {Readonly<Record<string,string>>} env
 * @param {Readonly<Record<string,string>>} labels
 * @returns {string|null}
 */
export function commitEmbebido(env, labels) {
  const candidatos = [env?.BUILD_COMMIT, labels?.["org.opencontainers.image.revision"]];
  for (const c of candidatos) {
    const v = String(c ?? "")
      .trim()
      .toLowerCase();
    if (v !== "" && v !== "unknown") return v;
  }
  return null;
}

/** Dos commits son el mismo si uno es prefijo del otro (short sha vs completo). */
export function mismoCommit(a, b) {
  if (!a || !b) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * @typedef {object} Observacion
 * @property {string} nombre                  nombre del contenedor
 * @property {string|null} runningImageId     (a) image ID que corre
 * @property {string|null} referencia         (b) referencia/etiqueta declarada
 * @property {boolean} imagenResoluble        `docker image inspect <a>` resuelve
 * @property {string|null} idDeLaReferencia   (c) a qué ID resuelve HOY (b); null = no resuelve
 * @property {string|null} [digestEsperado]   (d) pin del despliegue, si lo hay
 * @property {Readonly<Record<string,string>>} [envImagen]
 * @property {Readonly<Record<string,string>>} [labelsImagen]
 * @property {string} [reason]
 */

/**
 * @typedef {object} Clasificacion
 * @property {string} nombre
 * @property {EstadoDrift|null} estado          null = no se pudo observar
 * @property {boolean} runtimeImageExists       (a) existe en el daemon
 * @property {boolean|null} tagPointsToRuntime  (c) === (a); null = (b) no resuelve
 * @property {boolean|null} pinMatchesRuntime   (d) === (a); null = no hay pin
 * @property {string|null} runningImageId
 * @property {string|null} referencia
 * @property {string|null} idDeLaReferencia
 * @property {string|null} commitEtiqueta
 * @property {string|null} commitEmbebido
 * @property {"verified"|"not_exercised"} procedencia
 * @property {string} explicacion
 * @property {string} [reason]
 */

/**
 * Núcleo PURO: ninguna E/S. Clasifica una observación en uno de los cuatro
 * estados. Se puede probar (y MUTAR) sin daemon.
 *
 * Orden de decisión, y por qué:
 *  1. IMAGE_MISSING primero: si (a) no existe no hay contenido que comparar, y
 *     el estado no es reproducible pase lo que pase con la etiqueta.
 *  2. TAG_CONTENT_MISMATCH después: es el fallo de CONTENIDO (la etiqueta
 *     miente sobre el código), y eso pesa más que a dónde apunte hoy.
 *  3. TAG_MOVED: la identidad de contenido está bien, lo que se movió es la
 *     referencia. Un restart cambiaría de versión.
 *  4. RUNTIME_MATCH: lo que corre es lo esperado.
 *
 * `procedencia` NUNCA es "verified" sin identidad embebida: sin ella lo único
 * mirado sería la etiqueta, que es exactamente lo que puede mentir. Las
 * imágenes anteriores a ADR-016 salen `not_exercised`, no aprobadas.
 *
 * @param {Observacion} obs
 * @returns {Clasificacion}
 */
export function clasificarDrift(obs) {
  const env = obs.envImagen ?? {};
  const labels = obs.labelsImagen ?? {};
  const commitEtiqueta = commitDeReferencia(obs.referencia);
  const embebido = commitEmbebido(env, labels);
  const pin = obs.digestEsperado ?? null;

  const base = {
    nombre: obs.nombre,
    runningImageId: obs.runningImageId ?? null,
    referencia: obs.referencia ?? null,
    idDeLaReferencia: obs.idDeLaReferencia ?? null,
    commitEtiqueta,
    commitEmbebido: embebido,
    procedencia: /** @type {"verified"|"not_exercised"} */ (embebido === null ? "not_exercised" : "verified"),
  };

  if (!obs.runningImageId || !obs.referencia) {
    return {
      ...base,
      estado: null,
      runtimeImageExists: false,
      tagPointsToRuntime: null,
      pinMatchesRuntime: null,
      procedencia: "not_exercised",
      reason: obs.reason ?? "no se pudo leer la identidad de imagen del contenedor",
      explicacion: "no observado: sin identidad de imagen no se clasifica nada (y eso no se aprueba por omisión)",
    };
  }

  // (a) EXISTENCIA — `docker image inspect`, jamás `docker images -q`.
  const runtimeImageExists = obs.imagenResoluble === true;
  // (c) frente a (a) — comparación SEPARADA de la anterior.
  const tagPointsToRuntime = obs.idDeLaReferencia === null ? null : obs.idDeLaReferencia === obs.runningImageId;
  // (d) frente a (a) — sólo si hay pin.
  const pinMatchesRuntime = pin === null ? null : pin === obs.runningImageId;

  const comun = { ...base, runtimeImageExists, tagPointsToRuntime, pinMatchesRuntime };

  if (!runtimeImageExists) {
    return {
      ...comun,
      estado: IMAGE_MISSING,
      procedencia: "not_exercised",
      commitEmbebido: null,
      explicacion:
        "la image ID en ejecución ya NO existe en el daemon: el estado no es reproducible, " +
        "un restart no lo recupera y el baseline no sirve para rollback",
    };
  }

  // Contenido frente a etiqueta: sólo se puede afirmar si la imagen trae
  // identidad embebida Y la referencia anuncia un commit.
  if (embebido !== null && commitEtiqueta !== null && !mismoCommit(embebido, commitEtiqueta)) {
    return {
      ...comun,
      estado: TAG_CONTENT_MISMATCH,
      explicacion:
        `la etiqueta anuncia ${commitEtiqueta} pero la imagen se construyó desde ${embebido}: ` +
        "la etiqueta existe y contiene código distinto",
    };
  }

  if (tagPointsToRuntime === false || pinMatchesRuntime === false) {
    const motivo =
      tagPointsToRuntime === false
        ? `la referencia "${obs.referencia}" resuelve hoy a ${corto(obs.idDeLaReferencia)} y el contenedor corre ${corto(obs.runningImageId)}`
        : `el pin esperado ${corto(pin)} no es la image ID en ejecución ${corto(obs.runningImageId)}`;
    return {
      ...comun,
      estado: TAG_MOVED,
      explicacion: `${motivo}: la imagen que corre existe, pero un restart cambiaría de versión sin decisión de nadie`,
    };
  }

  return {
    ...comun,
    estado: RUNTIME_MATCH,
    explicacion: "la image ID en ejecución es la que la referencia (o el pin) resuelve",
  };
}

/** @param {string|null} s */
export function corto(s) {
  return String(s ?? "")
    .replace(/^sha256:/, "")
    .slice(0, 12);
}

/**
 * Informe legible de una clasificación. La salida tiene que poder decir
 * literalmente la verdad del caso de postgres.
 * @param {Clasificacion} c
 */
export function lineasInforme(c) {
  const si = (v) => (v === null ? "not_exercised" : v ? "YES" : "NO");
  return [
    `container                 = ${c.nombre}`,
    `running image id          = ${corto(c.runningImageId)}`,
    `declared reference        = ${c.referencia ?? "(desconocida)"}`,
    `reference resolves to     = ${c.idDeLaReferencia === null ? "not_exercised (no resuelve)" : corto(c.idDeLaReferencia)}`,
    `runtime image exists      = ${si(c.runtimeImageExists)}`,
    `tag still points to runtime image = ${si(c.tagPointsToRuntime)}`,
    `pin matches runtime image = ${si(c.pinMatchesRuntime)}`,
    `embedded build identity   = ${c.procedencia === "verified" ? corto(c.commitEmbebido) : "not_exercised (imagen sin identidad embebida)"}`,
    `drift = ${c.estado ?? "not_exercised"}`,
  ];
}
