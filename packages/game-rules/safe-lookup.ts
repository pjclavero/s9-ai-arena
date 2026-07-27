/**
 * B2 (arena-engine) · Búsqueda segura en un diccionario (`Record<string, T>`) por
 * una clave que pueda venir de fuera del proceso (cuerpo de una petición HTTP,
 * `argv` de un CLI, etc.).
 *
 * `dict[key]` sin guarda es vulnerable a contaminación de prototipo: con
 * `key = "__proto__"` (o `"constructor"`/`"toString"`/`"hasOwnProperty"`/
 * cualquier otra propiedad heredada de `Object.prototype`), la indexación de un
 * objeto plano devuelve algo TRUTHY que no es una entrada real del diccionario
 * (`Object.prototype`, o peor, una función real como `Object.prototype.constructor`).
 * Una guarda del tipo `if (!dict[key]) throw ...` no se dispara, y quien controla
 * `key` cuela un valor que no debería existir.
 *
 * Se encontró y corrigió esta MISMA clase de fallo cuatro veces en un solo
 * bloque (B2, ejecución real de batallas): `FIXTURE_MAP_EQUIVALENTS`
 * (apps/api/.../battle-run-http-launcher.ts, ya resuelto con `Map`), `MAPS`
 * (mapName), `ARCHETYPES` (archetype) y `RULESETS` (rulesetId) — las tres
 * últimas todas indexadas como objeto plano en distintos ficheros de
 * apps/arena-engine y apps/bot-manager. Esta función es el punto ÚNICO de
 * lectura segura para esos diccionarios: `hasOwnProperty` descarta cualquier
 * clave heredada del prototipo, así que la clase de fallo se cierra de raíz en
 * cada punto que la usa, en vez de depender de un allowlist duplicado en cada
 * llamador (que es fácil de olvidar la próxima vez que se añada un consumidor).
 */
export function safeLookup<T>(dict: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : undefined;
}

/**
 * B8 · La otra mitad de la MISMA clase de fallo: el lado de ESCRITURA.
 *
 * `safeLookup` cubre `dict[key]` (lectura). Pero un acumulador construido con
 * `const out = {}` y rellenado con `out[key] = v` donde `key` viene de fuera
 * tiene un problema simétrico y menos evidente: con `key = "__proto__"`, la
 * asignación NO crea una propiedad propia — reemplaza el PROTOTIPO del objeto.
 * Consecuencias reales encontradas en el barrido de B8:
 *
 *  - `map-service/src/canonical.ts`: la clave desaparece del `JSON.stringify`,
 *    así que dos mapas DISTINTOS canonicalizaban igual ⇒ mismo checksum.
 *  - `arena-engine/src/match.ts`: `roundWins["__proto__"] = 1` no cuenta, y las
 *    lecturas posteriores devuelven basura heredada ⇒ `NaN` al ordenar.
 *
 * `Object.create(null)` no tiene prototipo, así que `"__proto__"` es una clave
 * normal y corriente: la asignación es una propiedad propia y todo (incluido
 * `JSON.stringify`) se comporta como el autor esperaba. Se usa como valor
 * inicial en vez de `{}` en cualquier acumulador con claves externas.
 */
export function emptyDict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}
