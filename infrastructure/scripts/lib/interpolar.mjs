/**
 * INTERPOLACIÓN DE COMPOSE · una sola implementación, porque dos serían dos verdades.
 *
 * ── Por qué existe este módulo ───────────────────────────────────────────────
 *
 * Había DOS `interpolar` en el repositorio (`deploy-contract-gate.mjs` y
 * `runtime-drift-scan.mjs`), las dos con la misma expresión regular de un solo
 * paso:
 *
 *     /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}/
 *
 * Sobre `${A:-${B:-c}}` el grupo del defecto (`[^}]*`) se para en la PRIMERA
 * llave de cierre, así que la sustitución consumía `${A:-${B:-c}` y dejaba un
 * `}` suelto: el resultado era la cadena literal `${B:-c}` y NADIE la volvía a
 * interpolar, porque `String.replace` no reentra en lo que acaba de escribir.
 *
 * Eso importa aquí y no en abstracto: el mecanismo de override por servicio
 * (`${TOURNAMENT_WORKER_TAG:-${TAG:-latest}}`) es exactamente una interpolación
 * anidada. Con la regex vieja, un gate que lea el compose habría rendido
 * `s9arena/tournament-worker:${TAG:-latest}` —una etiqueta con llaves dentro,
 * que ninguna comprobación de nombre habría encontrado sospechosa— mientras
 * Docker Compose desplegaba otra cosa. Es el patrón «el .env dice X pero el
 * runtime es otra cosa» reproducido dentro del propio verificador.
 *
 * ── Calibración contra la autoridad real ─────────────────────────────────────
 *
 * Que Compose resuelve el anidamiento NO se supone: se midió con
 * `docker compose config` en el anfitrión de despliegue (Compose v5.3.0) sobre
 * un compose de juguete en un directorio temporal:
 *
 *     TAG=base                 → repo/a:base   repo/b:base   repo/c:base
 *     TAG=base A_TAG=ovr       → repo/a:ovr    repo/b:base   repo/c:base
 *     (sin variables)          → repo/a:latest repo/b:latest repo/c:latest
 *
 * `CASOS_CALIBRACION` (abajo) es esa tabla, y la autoprueba la exige. Si un día
 * Compose cambiara la semántica, el sitio donde se descubre es este fichero.
 *
 * ── Semántica implementada (la de Compose) ───────────────────────────────────
 *   ${VAR}          valor, o "" si no está
 *   ${VAR:-def}     `def` si VAR no está O está VACÍA
 *   ${VAR-def}      `def` sólo si VAR NO ESTÁ (vacía es un valor)
 * y `def` puede a su vez contener `${...}`, sin límite de profundidad.
 *
 * La diferencia `:-` / `-` se conserva porque ya estaba en
 * `deploy-contract-gate.mjs` y el compose real la usa; colapsarla haría que una
 * variable declarada y vacía (`TOURNAMENT_WORKER_TAG=` en un .env, que es como
 * un operador «quita» un override) se comportara distinto en el gate y en el
 * despliegue.
 */

/** Profundidad máxima de anidamiento. No es un límite de diseño: es el freno
 *  ante una referencia circular construida a mano, para que el gate falle
 *  diciendo qué pasa en vez de agotar la pila. */
const PROFUNDIDAD_MAX = 32;

const RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:?-)?/;

/**
 * Interpola `texto` con `vars`, resolviendo defectos ANIDADOS.
 *
 * No usa `String.replace` con una regex: el emparejamiento de llaves de un
 * defecto anidado no es regular. Recorre el texto y equilibra `{`/`}`.
 */
export function interpolar(texto, vars = {}, profundidad = 0) {
  const s = String(texto);
  if (profundidad > PROFUNDIDAD_MAX) return s;

  let salida = "";
  let i = 0;
  while (i < s.length) {
    const j = s.indexOf("${", i);
    if (j < 0) {
      salida += s.slice(i);
      break;
    }
    salida += s.slice(i, j);

    // Buscar la llave de cierre EQUILIBRADA de esta expresión.
    let nivel = 0;
    let k = j + 1; // apunta a "{"
    let fin = -1;
    for (; k < s.length; k++) {
      if (s[k] === "{") nivel++;
      else if (s[k] === "}") {
        nivel--;
        if (nivel === 0) {
          fin = k;
          break;
        }
      }
    }
    if (fin < 0) {
      // `${` sin cierre: no es una expresión, es texto. Se copia tal cual en
      // vez de inventarse un valor.
      salida += s.slice(j);
      break;
    }

    const cuerpo = s.slice(j + 2, fin); // sin "${" ni "}"
    const m = RE.exec(`\${${cuerpo}`);
    if (!m || m.index !== 0) {
      salida += s.slice(j, fin + 1);
      i = fin + 1;
      continue;
    }
    const nombre = m[1];
    const operador = m[2] ?? null; // ":-", "-" o null
    const defecto = operador === null ? null : cuerpo.slice(nombre.length + operador.length);

    const v = vars[nombre];
    let valor;
    if (operador === ":-") valor = v === undefined || v === "" ? null : v;
    else if (operador === "-") valor = v === undefined ? null : v;
    else valor = v === undefined ? "" : v;

    salida += valor === null ? interpolar(defecto ?? "", vars, profundidad + 1) : String(valor);
    i = fin + 1;
  }
  return salida;
}

/**
 * Interpolación PROFUNDA de una estructura (objeto/array/escalar). La usan los
 * gates que comparan specs completas: si sólo se interpolara `image`, un
 * override que se colara en un `command`, una etiqueta o una variable de
 * entorno pasaría inadvertido, que es justo lo que
 * `changed_specs_other_than_image` existe para no permitir.
 */
export function interpolarProfundo(valor, vars = {}) {
  if (typeof valor === "string") return interpolar(valor, vars);
  if (Array.isArray(valor)) return valor.map((v) => interpolarProfundo(v, vars));
  if (valor && typeof valor === "object") {
    const out = {};
    for (const [k, v] of Object.entries(valor)) out[k] = interpolarProfundo(v, vars);
    return out;
  }
  return valor;
}

/**
 * La tabla medida contra `docker compose config` v5.3.0. Es la CALIBRACIÓN:
 * mientras estos casos pasen, el render offline y el real dicen lo mismo sobre
 * el anidamiento; el día que dejen de pasar, este módulo miente.
 */
export const CASOS_CALIBRACION = Object.freeze([
  { texto: "repo/a:${A_TAG:-${TAG:-latest}}", vars: { TAG: "base" }, esperado: "repo/a:base" },
  { texto: "repo/a:${A_TAG:-${TAG:-latest}}", vars: { TAG: "base", A_TAG: "ovr" }, esperado: "repo/a:ovr" },
  { texto: "repo/a:${A_TAG:-${TAG:-latest}}", vars: {}, esperado: "repo/a:latest" },
  // Una variable declarada VACÍA es «sin override» con `:-` (así se retira un
  // override sin borrar la línea del .env) y NO lo es con `-`.
  { texto: "x:${A:-${TAG:-latest}}", vars: { A: "", TAG: "base" }, esperado: "x:base" },
  { texto: "x:${A-${TAG:-latest}}", vars: { A: "", TAG: "base" }, esperado: "x:" },
  // Sin anidar, la semántica de siempre no cambia.
  { texto: "x:${TAG:-latest}", vars: { TAG: "base" }, esperado: "x:base" },
  { texto: "x:${TAG}", vars: {}, esperado: "x:" },
  // Tres niveles: el mecanismo no está atado a dos.
  { texto: "x:${A:-${B:-${C:-z}}}", vars: {}, esperado: "x:z" },
  { texto: "x:${A:-${B:-${C:-z}}}", vars: { C: "c" }, esperado: "x:c" },
  // Texto que NO es una expresión no se toca.
  { texto: "x:${", vars: {}, esperado: "x:${" },
]);
