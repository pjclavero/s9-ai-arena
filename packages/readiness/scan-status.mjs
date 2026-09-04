/**
 * SEMÁNTICA DEL SCAN · contrato de estados de un escáner de seguridad.
 *
 * INCIDENTE QUE LO MOTIVA (medido en `main`): el endpoint de auditoría de npm
 * devolvió un error tras seis minutos de espera, el job `scan` salió en
 * `failure` y el semáforo lo tradujo a «FALLO DE SEGURIDAD ... bloquea la
 * promoción». Una reejecución del MISMO commit, sin cambiar una línea, salió
 * verde: 27 success. Ese día el gate mintió en la dirección ruidosa.
 *
 * EL FALLO PELIGROSO ES EL SIMÉTRICO, y con dos estados no se puede ver: si el
 * endpoint devolviera 200 con un cuerpo vacío o degradado, `npm audit` saldría
 * con 0 y el gate diría VERDE sin haber auditado nada. Un verde por no haber
 * mirado es hoy indistinguible de un verde por no haber encontrado nada.
 *
 * Precedente en este mismo repositorio: el gate de digest de #138 ya tuvo que
 * separar `N2_REGISTRO_INACCESIBLE` de `N2_DIGEST_NO_RESUELVE` porque Docker
 * Hub devolvió 429. El patrón se repite en CADA punto donde dependemos de un
 * servicio externo para afirmar algo, así que aquí se modela una vez y lo
 * consumen los tres escáneres (npm audit, Trivy, escáner de Compose).
 *
 * Módulo `.mjs` a propósito (mismo patrón que
 * `apps/bot-manager/src/compliance.mjs`): lo importan a la vez los tests en
 * TypeScript y los scripts que Node ejecuta en la CI sin transpilar.
 */

/**
 * Los CINCO estados. `CLEAN` y `FINDINGS` son los únicos que afirman algo
 * sobre las vulnerabilidades; los otros tres afirman algo sobre la
 * COMPROBACIÓN, que es un eje distinto y no se colapsa con el primero.
 */
export const ESTADO_SCAN = Object.freeze({
  /** El escáner corrió sobre el objetivo real y no encontró nada. */
  CLEAN: "CLEAN",
  /** El escáner corrió sobre el objetivo real y encontró hallazgos. */
  FINDINGS: "FINDINGS",
  /** No se ha comprobado (el paso no llegó a ejecutarse). */
  NOT_EXERCISED: "NOT_EXERCISED",
  /** La herramienta falló: crash, salida ilegible, respuesta degradada. */
  SCAN_ERROR: "SCAN_ERROR",
  /** La fuente de datos no estaba disponible: red, rate-limit, endpoint caído. */
  SOURCE_UNAVAILABLE: "SOURCE_UNAVAILABLE",
});

/**
 * Vocabulario de readiness. El MISMO que `packages/readiness/engine.ts`
 * (`CheckStatus`) y el que usa la tabla `ESTADO_DRIFT_A_READINESS` de
 * `checks.ts`: no se reimplementa una escala paralela, se reutiliza la que ya
 * existe. `scan-status.test.ts` comprueba a nivel de TIPO y de DATO que estos
 * tres valores son exactamente los de `CheckStatus`.
 */
export const READINESS = Object.freeze({
  VERIFIED: "verified",
  FAILED: "failed",
  NOT_EXERCISED: "not_exercised",
});

/**
 * Política declarada para `SCAN_ERROR`, el único estado cuyo destino el
 * operador dejó abierto («NOT_EXERCISED o FAILED según política declarada»).
 * Se declara como DATO, por herramienta, para que se lea de una pieza:
 *
 *   - `npm-audit` y `trivy`: `not_exercised`. Una herramienta que se rompe no
 *     ha encontrado nada; decir `failed` inventaría un hallazgo que nadie vio.
 *   - `compose`: `failed`. El escáner de Compose es local y determinista (no
 *     tiene red ni base de datos que se caiga): si él se rompe, lo que hay roto
 *     es el repositorio, y eso sí es un defecto del commit.
 *
 * Ninguna de las dos opciones es `verified`: la política elige QUÉ nombre lleva
 * el bloqueo, nunca si bloquea.
 */
export const POLITICA_SCAN_ERROR = Object.freeze({
  "npm-audit": READINESS.NOT_EXERCISED,
  trivy: READINESS.NOT_EXERCISED,
  compose: READINESS.FAILED,
});

/**
 * CONTRATO ESTADO DE SCAN → READINESS, declarado como DATO y no como las ramas
 * de un `switch` — mismo criterio que `ESTADO_DRIFT_A_READINESS` en
 * `packages/readiness/checks.ts`, y por la misma razón: un contrato que hay que
 * reconstruir siguiendo ramas no se puede leer, ni probar, ni mutar entero.
 *
 * `SCAN_ERROR` no lleva valor final aquí: lo pone la política declarada arriba.
 * El marcador está para que una lectura de la tabla no pueda confundir «depende
 * de una política» con «no está contemplado».
 */
export const ESTADO_SCAN_A_READINESS = Object.freeze({
  CLEAN: READINESS.VERIFIED,
  FINDINGS: READINESS.FAILED,
  NOT_EXERCISED: READINESS.NOT_EXERCISED,
  SCAN_ERROR: "segun_politica",
  SOURCE_UNAVAILABLE: READINESS.NOT_EXERCISED,
});

/**
 * Aplica el contrato.
 *
 * REGLA DURA DEL OPERADOR, y es lo que este código existe para impedir: un
 * fallo de red, de límite de tasa o de herramienta NUNCA se transforma en «0
 * vulnerabilidades». Por eso el ÚNICO camino que devuelve `verified` es la
 * entrada literal `CLEAN`; cualquier otra cosa —incluido un estado que no esté
 * en la tabla, una herramienta sin política declarada o `undefined`— cae a
 * `not_exercised`, que bloquea. No hay camino permisivo al que caer.
 *
 * @param {string|null|undefined} estado  uno de ESTADO_SCAN
 * @param {{herramienta?: string, politica?: Record<string,string>}} [opts]
 * @returns {"verified"|"failed"|"not_exercised"}
 */
export function readinessDeScan(estado, opts = {}) {
  const destino = ESTADO_SCAN_A_READINESS[estado];

  if (destino === "segun_politica") {
    const politica = opts.politica ?? POLITICA_SCAN_ERROR;
    const declarada = politica[opts.herramienta];
    // Sin política declarada para esa herramienta no se aprueba nada: cae al
    // lado que bloquea sin inventar un hallazgo.
    if (declarada !== READINESS.FAILED && declarada !== READINESS.NOT_EXERCISED) return READINESS.NOT_EXERCISED;
    return declarada;
  }

  // Fail-closed explícito: un estado fuera de la tabla NO cae al camino
  // permisivo. Se comprueba contra la lista de valores válidos en vez de
  // confiar en que la tabla no tenga agujeros.
  if (destino !== READINESS.VERIFIED && destino !== READINESS.FAILED && destino !== READINESS.NOT_EXERCISED) {
    return READINESS.NOT_EXERCISED;
  }
  return destino;
}

/**
 * ¿Bloquea la promoción? Sí en `failed` y en `not_exercised`: «encontré
 * hallazgos» y «no pude comprobar» bloquean los dos. Lo que cambia es el
 * NOMBRE, no el efecto — y el nombre es lo que el semáforo tiene que poder
 * decir para que un operador sepa si reintentar o arreglar código.
 */
export function bloquea(readiness) {
  return readiness !== READINESS.VERIFIED;
}

/**
 * Motivo con nombre propio: distingue hallazgo de no-comprobado y dice si
 * procede reintentar. Es lo que impide que el semáforo vuelva a llamar «fallo
 * de seguridad» a una caída del endpoint de npm.
 */
export function motivoDeScan(estado, detalle = "") {
  const sufijo = detalle ? ` — ${detalle}` : "";
  switch (estado) {
    case ESTADO_SCAN.CLEAN:
      return { clase: "aprobado", reintentable: false, texto: `escáner ejecutado, sin hallazgos${sufijo}` };
    case ESTADO_SCAN.FINDINGS:
      return {
        clase: "hallazgos",
        reintentable: false,
        texto: `HALLAZGOS DE SEGURIDAD: el escáner corrió y encontró vulnerabilidades${sufijo}`,
      };
    case ESTADO_SCAN.SOURCE_UNAVAILABLE:
      return {
        clase: "no-comprobado",
        reintentable: true,
        texto: `NO COMPROBADO · fuente de datos no disponible (red, rate-limit o endpoint caído)${sufijo}. NO significa 0 vulnerabilidades: procede reintentar`,
      };
    case ESTADO_SCAN.SCAN_ERROR:
      return {
        clase: "no-comprobado",
        reintentable: false,
        texto: `NO COMPROBADO · la herramienta falló${sufijo}. NO significa 0 vulnerabilidades: hay que arreglar el escáner`,
      };
    case ESTADO_SCAN.NOT_EXERCISED:
      return {
        clase: "no-comprobado",
        reintentable: false,
        texto: `NO COMPROBADO · el escaneo no se ejecutó${sufijo}`,
      };
    default:
      return {
        clase: "no-comprobado",
        reintentable: false,
        texto: `NO COMPROBADO · estado no contemplado ${JSON.stringify(estado ?? null)} (fail-closed)${sufijo}`,
      };
  }
}

// ── Clasificadores: de una OBSERVACIÓN de la herramienta a uno de los cinco ──
//
// Son funciones puras sobre lo observado (código de salida, stdout, stderr).
// Ninguna deduce el estado del código de salida a secas: ese atajo es
// exactamente el defecto — `npm audit` sale con 1 tanto si encontró una
// vulnerabilidad como si el endpoint se cayó.

/** Señales de que la FUENTE no estaba disponible (no de que haya hallazgos). */
const SENALES_FUENTE = [
  /audit endpoint returned an error/i,
  /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|ERR_SOCKET_TIMEOUT/,
  /\bnetwork\b|\boffline\b|getaddrinfo/i,
  /\b(429|502|503|504)\b/,
  /rate ?limit|too many requests|toomanyrequests/i,
  /registry[^\n]*(unavailable|error)/i,
  /request to [^\n]* failed/i,
  /certificate has expired|unable to verify the first certificate/i,
  /failed to download|failed to fetch|unable to fetch|db (download|update) (error|failed)/i,
];

export function pareceFuenteCaida(texto) {
  const t = String(texto ?? "");
  return SENALES_FUENTE.some((re) => re.test(t));
}

/** Aviso de retirada del endpoint de auditoría (punto 4 del encargo). */
export const AVISO_ENDPOINT_RETIRADO = /this endpoint is being retired|use the bulk advisory endpoint/i;

export function endpointRetirado(texto) {
  return AVISO_ENDPOINT_RETIRADO.test(String(texto ?? ""));
}

const SEVERIDADES = ["info", "low", "moderate", "high", "critical"];

/**
 * `npm audit --json`.
 *
 * Orden deliberado: primero se descarta que la fuente se haya caído, DESPUÉS se
 * mira el informe. Al revés, un cuerpo vacío devuelto con 200 pasaría por «cero
 * vulnerabilidades», que es el fallo silencioso que este carril ataca.
 *
 * @param {{exitCode?:number|null, stdout?:string, stderr?:string, timedOut?:boolean, umbral?:string}} obs
 */
export function clasificarNpmAudit(obs) {
  const stdout = String(obs?.stdout ?? "");
  const stderr = String(obs?.stderr ?? "");
  const umbral = obs?.umbral ?? "high";

  if (obs?.timedOut) {
    return res(ESTADO_SCAN.SOURCE_UNAVAILABLE, "npm audit agotó el tiempo de espera contra el registro");
  }
  if (pareceFuenteCaida(stderr) || pareceFuenteCaida(stdout)) {
    return res(ESTADO_SCAN.SOURCE_UNAVAILABLE, "el registro de npm no respondió una auditoría utilizable");
  }

  let informe;
  try {
    informe = JSON.parse(stdout);
  } catch {
    // Salida ilegible (incluye la cadena vacía): la herramienta falló. Y NO se
    // lee como limpio, que es la mutación que este carril tiene que matar.
    return res(ESTADO_SCAN.SCAN_ERROR, "npm audit no devolvió JSON interpretable");
  }
  if (informe === null || typeof informe !== "object" || Array.isArray(informe)) {
    return res(ESTADO_SCAN.SCAN_ERROR, "npm audit devolvió un JSON que no es un informe");
  }
  if (informe.error) {
    const detalle = String(informe.error?.summary ?? informe.error?.detail ?? "error declarado por npm");
    return res(
      pareceFuenteCaida(detalle) ? ESTADO_SCAN.SOURCE_UNAVAILABLE : ESTADO_SCAN.SCAN_ERROR,
      `npm audit declaró un error: ${detalle}`,
    );
  }

  // Un informe DEGRADADO (200 con cuerpo vacío o sin la sección de recuentos)
  // no es un árbol limpio: es un informe que no se puede leer.
  const recuentos = informe?.metadata?.vulnerabilities;
  if (informe.auditReportVersion === undefined || recuentos === null || typeof recuentos !== "object") {
    return res(ESTADO_SCAN.SCAN_ERROR, "informe de npm audit degradado: sin metadata.vulnerabilities ni versión");
  }
  // Y tampoco vale un recuento sin ninguna severidad conocida: eso es un objeto
  // vacío, no un cero medido.
  const conocidas = SEVERIDADES.filter((s) => typeof recuentos[s] === "number");
  if (conocidas.length === 0) {
    return res(ESTADO_SCAN.SCAN_ERROR, "informe de npm audit sin recuentos por severidad: no se ha medido nada");
  }

  const desde = SEVERIDADES.indexOf(umbral);
  const relevantes = SEVERIDADES.slice(desde < 0 ? 0 : desde).reduce((n, s) => n + (recuentos[s] ?? 0), 0);
  const total = SEVERIDADES.reduce((n, s) => n + (recuentos[s] ?? 0), 0);
  if (relevantes > 0) {
    return res(ESTADO_SCAN.FINDINGS, `npm audit: ${relevantes} vulnerabilidad(es) de severidad >= ${umbral}`);
  }
  return res(ESTADO_SCAN.CLEAN, `npm audit: 0 de severidad >= ${umbral} (${total} en total), informe completo leído`);
}

/**
 * Trivy (`--format json`). Mismo criterio: la fuente primero.
 *
 * Trivy descarga su base de datos de vulnerabilidades de un registro que aplica
 * límites de tasa. Un `Results` ausente o vacío significa que no escaneó ningún
 * objetivo, NO que el árbol esté limpio: sobre este repositorio siempre hay al
 * menos un objetivo (el lockfile). Por eso un informe sin objetivos es
 * degradado, no limpio.
 *
 * @param {{exitCode?:number|null, stdout?:string, stderr?:string, timedOut?:boolean, severidades?:string[]}} obs
 */
export function clasificarTrivy(obs) {
  const stdout = String(obs?.stdout ?? "");
  const stderr = String(obs?.stderr ?? "");
  const severidades = (obs?.severidades ?? ["CRITICAL", "HIGH"]).map((s) => s.toUpperCase());

  if (obs?.timedOut) return res(ESTADO_SCAN.SOURCE_UNAVAILABLE, "trivy agotó el tiempo de espera");
  if (pareceFuenteCaida(stderr) || pareceFuenteCaida(stdout)) {
    return res(ESTADO_SCAN.SOURCE_UNAVAILABLE, "trivy no pudo obtener la base de datos de vulnerabilidades");
  }

  let informe;
  try {
    informe = JSON.parse(stdout);
  } catch {
    return res(ESTADO_SCAN.SCAN_ERROR, "trivy no devolvió JSON interpretable");
  }
  if (informe === null || typeof informe !== "object" || Array.isArray(informe)) {
    return res(ESTADO_SCAN.SCAN_ERROR, "trivy devolvió un JSON que no es un informe");
  }
  if (informe.SchemaVersion === undefined) {
    return res(ESTADO_SCAN.SCAN_ERROR, "informe de trivy sin SchemaVersion: salida degradada");
  }
  const objetivos = Array.isArray(informe.Results) ? informe.Results : null;
  if (objetivos === null || objetivos.length === 0) {
    // El caso peligroso: exit 0 y un informe sin objetivos. No ha mirado nada.
    return res(ESTADO_SCAN.SCAN_ERROR, "informe de trivy sin objetivos escaneados: no se ha analizado nada");
  }

  let hallazgos = 0;
  for (const objetivo of objetivos) {
    const vulns = Array.isArray(objetivo?.Vulnerabilities) ? objetivo.Vulnerabilities : [];
    for (const v of vulns) if (severidades.includes(String(v?.Severity ?? "").toUpperCase())) hallazgos += 1;
  }
  if (hallazgos > 0) {
    return res(ESTADO_SCAN.FINDINGS, `trivy: ${hallazgos} vulnerabilidad(es) ${severidades.join("/")}`);
  }
  return res(ESTADO_SCAN.CLEAN, `trivy: ${objetivos.length} objetivo(s) analizados, 0 ${severidades.join("/")}`);
}

/**
 * Escáner de Compose (`infrastructure/scripts/scan-compose.mjs`). Es local y
 * determinista: no tiene fuente externa que pueda caerse, así que
 * `SOURCE_UNAVAILABLE` no es un desenlace posible. Lo que sí puede pasar —y
 * pasó antes en este repositorio con un `if: hashFiles(...)`— es que el escáner
 * no exista y el paso se salte en silencio; eso es `NOT_EXERCISED`, no verde.
 *
 * @param {{exitCode?:number|null, stdout?:string, stderr?:string, ejecutado?:boolean}} obs
 */
export function clasificarScanCompose(obs) {
  const stdout = String(obs?.stdout ?? "");
  const stderr = String(obs?.stderr ?? "");
  if (obs?.ejecutado === false) {
    return res(ESTADO_SCAN.NOT_EXERCISED, "el escáner de Compose no llegó a ejecutarse");
  }
  const junto = stdout + "\n" + stderr;
  if (obs?.exitCode === 1 && /^FALLO ·/m.test(junto)) {
    const n = junto.split("\n").filter((l) => l.startsWith("FALLO ·")).length;
    return res(ESTADO_SCAN.FINDINGS, `escáner de Compose: ${n} infracción(es) del cap. 28`);
  }
  if (obs?.exitCode !== 0) {
    return res(ESTADO_SCAN.SCAN_ERROR, `el escáner de Compose terminó con código ${obs?.exitCode} sin veredicto`);
  }
  if (!/^OK · /m.test(stdout)) {
    // exit 0 sin la línea de veredicto: no hay prueba de que mirara nada.
    return res(ESTADO_SCAN.SCAN_ERROR, "el escáner de Compose salió con 0 pero no declaró haber analizado nada");
  }
  const ficheros = stdout.split("\n").filter((l) => l.startsWith("OK · ")).length;
  return res(ESTADO_SCAN.CLEAN, `escáner de Compose: ${ficheros} fichero(s) conformes`);
}

function res(estado, detalle) {
  return { estado, detalle };
}

/**
 * Agrega los estados de varios escáneres en el veredicto del job `scan`.
 * El peor manda, y el orden de gravedad NO es «hallazgo peor que no
 * comprobado»: los dos bloquean. Se prioriza el hallazgo sólo para nombrar el
 * bloqueo por lo más accionable; si no hay hallazgos pero algo quedó sin
 * comprobar, el veredicto es «no comprobado» y también bloquea.
 */
export function agregarScans(resultados) {
  if (!Array.isArray(resultados) || resultados.length === 0) {
    return {
      estado: ESTADO_SCAN.NOT_EXERCISED,
      readiness: READINESS.NOT_EXERCISED,
      detalle: "ningún escáner declaró resultado (fail-closed)",
      partes: [],
    };
  }
  const partes = resultados.map((r) => ({
    herramienta: r.herramienta,
    estado: r.estado,
    readiness: readinessDeScan(r.estado, { herramienta: r.herramienta }),
    detalle: r.detalle ?? "",
  }));

  const conHallazgos = partes.find((p) => p.estado === ESTADO_SCAN.FINDINGS) ?? null;
  const noComprobado = partes.find((p) => p.readiness !== READINESS.VERIFIED && p.estado !== ESTADO_SCAN.FINDINGS);
  const peor = conHallazgos ?? noComprobado ?? null;

  if (peor === null) {
    return {
      estado: ESTADO_SCAN.CLEAN,
      readiness: READINESS.VERIFIED,
      detalle: partes.map((p) => `${p.herramienta}: ${p.detalle}`).join(" · "),
      partes,
    };
  }
  return {
    estado: peor.estado,
    readiness: peor.readiness,
    detalle: partes
      .filter((p) => p.readiness !== READINESS.VERIFIED)
      .map((p) => `${p.herramienta}: ${p.estado} (${p.detalle})`)
      .join(" · "),
    partes,
  };
}
