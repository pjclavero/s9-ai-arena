#!/usr/bin/env node
/**
 * CARRIL COMPOSE CANÓNICO · ¿es el stack vivo REPRODUCIBLE desde un único compose?
 *
 * ── El incidente que existe para no repetir ─────────────────────────────────
 *
 * En VM108, los 12 contenedores del MISMO proyecto Compose (`infrastructure`)
 * declaran TRES `com.docker.compose.project.config_files` distintos: dos árboles
 * de construcción temporales, ya divergentes entre sí, y el directorio de
 * producción. Cada servicio se desplegó desde el árbol de SU versión con
 * `--project-directory` de producción y `--no-build`. Servicio a servicio
 * funcionó; el conjunto quedó irreproducible: NINGÚN `docker compose` de la
 * máquina rehace hoy lo que está corriendo. No hay fuente única de verdad.
 *
 * Esa deriva es invisible para un escáner de imágenes —todas las imágenes
 * existen y las etiquetas cuadran— y también para `docker ps`. Vive
 * exclusivamente en la etiqueta de procedencia, que nadie miraba.
 *
 * ── Qué comprueba, y con qué criterio ───────────────────────────────────────
 *
 *  1. PROCEDENCIA ÚNICA. Todo servicio gestionado por Compose debe declarar el
 *     MISMO `config_files`, y ese debe ser el canónico. Dos servicios coherentes
 *     entre sí pero levantados desde árboles distintos son un FALLO aunque su
 *     spec coincida: la coincidencia de hoy no es una garantía, es una
 *     casualidad que el próximo `up` deshace.
 *
 *  2. COBERTURA. El conjunto de servicios vivos y el que renderiza el compose
 *     canónico (con su perfil) deben coincidir exactamente. Un servicio vivo que
 *     el compose no renderiza no lo recrearía nadie; uno renderizado que no vive
 *     es un `up` a medias.
 *
 *  3. SPEC POR SERVICIO. Montajes (por DESTINO + origen lógico + rw/ro + tipo),
 *     secretos, variables de entorno exigidas, puertos PUBLICADOS, command,
 *     entrypoint, healthcheck e imagen declarada. Cada divergencia se emite con
 *     su código y significa una cosa concreta: al recrear ese servicio desde el
 *     compose canónico, ESO cambiaría.
 *
 * ── Reutilización, no reimplementación ──────────────────────────────────────
 * La adquisición de hechos, el saneamiento de topología y la comparación de
 * montajes/secretos/entorno son del CARRIL G y se IMPORTAN de
 * `runtime-drift-scan.mjs`. Aquí sólo vive lo que aquel no puede saber: la
 * procedencia declarada, la cobertura del perfil y la parte de la spec que
 * decide una recreación (puertos, command, entrypoint, healthcheck).
 *
 * ── Topología ───────────────────────────────────────────────────────────────
 * Este comprobador NUNCA emite una ruta de anfitrión. El `config_files` no
 * canónico sale como `ruta-no-canonica:#<sha256[0..11]>`, estable entre
 * ejecuciones y suficiente para agrupar servicios por procedencia.
 *
 * ── Uso ─────────────────────────────────────────────────────────────────────
 *   node infrastructure/scripts/runtime-drift-scan.mjs --collect > hechos.json
 *   node infrastructure/scripts/compose-canonical-check.mjs \
 *        --facts hechos.json \
 *        --compose infrastructure/docker-compose.yml \
 *        --canonical-config-files /ruta/de/produccion/infrastructure/docker-compose.yml \
 *        --profile production --compose-env TAG=… [--json]
 *
 * rc=0 sólo si el stack es REPRODUCIBLE desde el compose canónico.
 * rc=1 si NO lo es (procedencia divergente, cobertura o spec).
 * rc=2 error de adquisición o de argumentos. La ausencia de comprobación NUNCA
 * es un aprobado: sin `--compose` no se puede concluir y se sale con rc=2.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  driftDeEntorno,
  driftDeMontajes,
  driftDeSecretos,
  interpolar,
  huella,
  ipLogica,
  montajeDesdeCompose,
  normalizarMontaje,
} from "./runtime-drift-scan.mjs";

/** Códigos de hallazgo. Cada uno es una razón distinta para NO ser reproducible. */
export const CODIGOS = {
  CONFIG_FILES_DIVERGENTE: "CONFIG_FILES_DIVERGENTE",
  CONFIG_FILES_MULTIPLE: "CONFIG_FILES_MULTIPLE",
  CONFIG_FILES_AUSENTE: "CONFIG_FILES_AUSENTE",
  SERVICIO_NO_RENDERIZADO: "SERVICIO_NO_RENDERIZADO",
  SERVICIO_NO_DESPLEGADO: "SERVICIO_NO_DESPLEGADO",
  IMAGEN_DIVERGENTE: "IMAGEN_DIVERGENTE",
  MONTAJE_FALTA: "MONTAJE_FALTA",
  MONTAJE_SOBRA: "MONTAJE_SOBRA",
  MONTAJE_INCORRECTO: "MONTAJE_INCORRECTO",
  SECRETO_FALTA: "SECRETO_FALTA",
  SECRETO_INESPERADO: "SECRETO_INESPERADO",
  ENV_FALTA: "ENV_FALTA",
  PUERTOS_DIVERGENTES: "PUERTOS_DIVERGENTES",
  COMMAND_DIVERGENTE: "COMMAND_DIVERGENTE",
  ENTRYPOINT_DIVERGENTE: "ENTRYPOINT_DIVERGENTE",
  HEALTHCHECK_DIVERGENTE: "HEALTHCHECK_DIVERGENTE",
};

const hash = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 12);

/**
 * Etiqueta pública de una procedencia. Nunca es una ruta: los hechos ya llegan
 * con la huella, y la canónica se reconoce por vivir DENTRO del directorio de
 * despliegue — que es la definición operativa de fuente única de verdad aquí.
 */
export function etiquetaProcedencia(hecho) {
  if (!hecho.compose_config_files_hash) return "sin-etiqueta";
  const marca = hecho.compose_config_files_hash;
  return hecho.compose_config_en_working_dir === true ? `despliegue:${marca}` : `arbol-ajeno:${marca}`;
}

/** Huella de una ruta canónica que declare el operador, para compararla. */
export function huellaDeRuta(ruta) {
  return ruta ? `#${hash(ruta)}` : null;
}

// ── Especificación derivada del compose canónico ─────────────────────────────

/** `["8080:80"]` / forma larga → `"8080->80/tcp"`, ya comparable con el daemon. */
export function puertoDesdeCompose(p, vars = {}) {
  if (typeof p === "string" || typeof p === "number") {
    const partes = interpolar(String(p), vars).split(":");
    const ultimo = partes[partes.length - 1];
    const [contenedor, proto = "tcp"] = ultimo.split("/");
    // "3000" a secas (sin anfitrión) es publicación en un puerto EFÍMERO: no es
    // comparable con nada estable, así que se marca como tal y no se finge.
    if (partes.length === 1) return `efimero->${contenedor}/${proto}`;
    // Una IP de anfitrión se opaca igual que en los hechos, para que las dos
    // caras de la comparación hablen el mismo idioma y ninguna la publique.
    const puerto = partes[partes.length - 2];
    const ip = partes.length >= 3 ? ipLogica(partes.slice(0, -2).join(":")) : "";
    return `${ip}${puerto}->${contenedor}/${proto}`;
  }
  const proto = p.protocol ?? "tcp";
  const publicado = interpolar(String(p.published ?? ""), vars);
  return publicado ? `${ipLogica(p.host_ip)}${publicado}->${p.target}/${proto}` : `efimero->${p.target}/${proto}`;
}

/** `healthcheck.test` de Compose → la forma que devuelve `docker inspect`. */
export function healthcheckDesdeCompose(hc) {
  if (!hc || hc.disable) return null;
  const t = hc.test;
  if (t === undefined || t === null) return null;
  return typeof t === "string" ? ["CMD-SHELL", t] : t;
}

function comoLista(x) {
  if (x === undefined || x === null) return null;
  return Array.isArray(x) ? x.map(String) : [String(x)];
}

/**
 * Spec de cada servicio del compose canónico, filtrada por perfil.
 *
 * El filtro por perfil NO es un detalle: en este stack TODOS los servicios
 * llevan `profiles:`, así que un compose sin perfil seleccionado renderiza CERO
 * servicios. Un comprobador que no lo exigiera daría verde comparando el stack
 * vivo contra el conjunto vacío — el peor falso negativo posible.
 */
export function specDesdeCompose(doc, { vars = {}, profile = null } = {}) {
  const out = {};
  for (const [nombre, s] of Object.entries(doc?.services ?? {})) {
    const perfiles = s.profiles ?? [];
    if (profile !== null && perfiles.length > 0 && !perfiles.includes(profile)) continue;
    out[nombre] = {
      image: s.image ? interpolar(s.image, vars) : null,
      mounts: (s.volumes ?? []).map((v) => montajeDesdeCompose(v, { vars })),
      secrets: (s.secrets ?? []).map((x) => (typeof x === "string" ? x : x.source)).sort(),
      env_required: Object.keys(s.environment ?? {}).sort(),
      ports: (s.ports ?? []).map((p) => puertoDesdeCompose(p, vars)).sort(),
      // Se guardan las dos formas: la huella COMPARA (misma función que usan los
      // hechos, así que las dos caras hablan el mismo idioma) y el literal, que
      // sale del compose PÚBLICO, es lo que se le enseña al operador. El literal
      // del contenedor vivo no se enseña nunca: viene del anfitrión.
      command: comoLista(s.command),
      command_hash: huella(comoLista(s.command)),
      entrypoint: comoLista(s.entrypoint),
      entrypoint_hash: huella(comoLista(s.entrypoint)),
      healthcheck_test: healthcheckDesdeCompose(s.healthcheck),
      healthcheck_test_hash: huella(healthcheckDesdeCompose(s.healthcheck)),
      depends_on: Object.keys(s.depends_on ?? {}).sort(),
    };
  }
  return out;
}

// ── Comprobaciones ───────────────────────────────────────────────────────────

/**
 * Procedencia. Devuelve hallazgos y el reparto de servicios por origen.
 * `canonica` es la ruta que el despliegue declara como fuente única de verdad.
 */
export function comprobarProcedencia(hechos, { canonica = null } = {}) {
  const servicios = (hechos.services ?? []).filter((h) => h.compose_managed !== false);
  const esperada = huellaDeRuta(canonica);
  const hallazgos = [];
  const porOrigen = new Map();
  for (const h of servicios) {
    const cf = h.compose_config_files_hash ?? null;
    const etiqueta = etiquetaProcedencia(h);
    if (!porOrigen.has(etiqueta)) porOrigen.set(etiqueta, []);
    porOrigen.get(etiqueta).push(h.service);
    if (!cf) {
      hallazgos.push({
        service: h.service,
        code: CODIGOS.CONFIG_FILES_AUSENTE,
        detail: "el contenedor no declara com.docker.compose.project.config_files: su procedencia no consta",
      });
      continue;
    }
    // Dos criterios, y basta con que falle uno. El primero no necesita que el
    // operador acierte a escribir la ruta: un compose que no vive en el
    // directorio de despliegue no es la fuente única de verdad, se llame como se
    // llame. El segundo lo ata a una ruta concreta cuando el operador la declara.
    if (h.compose_config_en_working_dir === false) {
      hallazgos.push({
        service: h.service,
        code: CODIGOS.CONFIG_FILES_DIVERGENTE,
        detail: `procedencia ${etiqueta}: se levantó desde un árbol ajeno al directorio de despliegue`,
      });
    } else if (esperada && cf !== esperada) {
      hallazgos.push({
        service: h.service,
        code: CODIGOS.CONFIG_FILES_DIVERGENTE,
        detail: `procedencia ${etiqueta}: no es el compose canónico declarado`,
      });
    }
  }
  const origenes = [...porOrigen.keys()].sort();
  if (origenes.length > 1) {
    hallazgos.push({
      service: "(stack)",
      code: CODIGOS.CONFIG_FILES_MULTIPLE,
      detail: `${origenes.length} procedencias distintas en un mismo proyecto Compose: ${origenes.join(", ")}`,
    });
  }
  return { hallazgos, origenes, porOrigen: Object.fromEntries([...porOrigen].map(([k, v]) => [k, v.sort()])) };
}

const igual = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Spec de UN servicio: lo vivo contra lo renderizado. Cada hallazgo es un
 * cambio que un `up` desde el compose canónico APLICARÍA a ese contenedor.
 */
export function comprobarServicio(hecho, spec) {
  const h = [];
  const add = (code, detail) => h.push({ service: hecho.service, code, detail });

  if (spec.image && hecho.declared_ref && spec.image !== hecho.declared_ref) {
    add(CODIGOS.IMAGEN_DIVERGENTE, `canónico=${spec.image} vivo=${hecho.declared_ref}`);
  }

  const m = driftDeMontajes(hecho.mounts ?? [], { mounts: spec.mounts ?? [] });
  for (const d of m.faltan) add(CODIGOS.MONTAJE_FALTA, `el canónico monta ${d} y el contenedor vivo no`);
  for (const d of m.sobran) add(CODIGOS.MONTAJE_SOBRA, `el contenedor vivo monta ${d} y el canónico no`);
  for (const d of m.incorrectos) {
    add(CODIGOS.MONTAJE_INCORRECTO, `${d.destino}: canónico=${d.esperado} vivo=${d.encontrado}`);
  }

  const s = driftDeSecretos(hecho.secrets ?? [], spec.secrets ?? []);
  for (const x of s.faltan) add(CODIGOS.SECRETO_FALTA, `el canónico monta el secreto ${x} y el contenedor vivo no`);
  for (const x of s.inesperados)
    add(CODIGOS.SECRETO_INESPERADO, `el contenedor vivo monta el secreto ${x} y el canónico no`);

  const e = driftDeEntorno(hecho.env_names ?? [], { required: spec.env_required ?? [] });
  for (const x of e.faltan) add(CODIGOS.ENV_FALTA, `el canónico define ${x} y el contenedor vivo no la tiene`);

  if (!igual((hecho.ports ?? []).slice().sort(), (spec.ports ?? []).slice().sort())) {
    add(
      CODIGOS.PUERTOS_DIVERGENTES,
      `canónico=${JSON.stringify(spec.ports ?? [])} vivo=${JSON.stringify(hecho.ports ?? [])}`,
    );
  }

  // command / entrypoint / healthcheck: si el compose NO los declara, el valor
  // vivo lo pone la IMAGEN y no hay divergencia que reprochar. Sólo se comparan
  // cuando el canónico los declara — comparar contra `null` marcaría drift en
  // todo servicio que hereda de su imagen, que es casi todo el stack.
  const literal = (x) => JSON.stringify(x);
  if (spec.command_hash && spec.command_hash !== hecho.command_hash) {
    add(
      CODIGOS.COMMAND_DIVERGENTE,
      `canónico=${literal(spec.command)} vivo=huella ${hecho.command_hash ?? "(ninguno)"}`,
    );
  }
  if (spec.entrypoint_hash && spec.entrypoint_hash !== hecho.entrypoint_hash) {
    add(
      CODIGOS.ENTRYPOINT_DIVERGENTE,
      `canónico=${literal(spec.entrypoint)} vivo=huella ${hecho.entrypoint_hash ?? "(ninguno)"}`,
    );
  }
  if (spec.healthcheck_test_hash && spec.healthcheck_test_hash !== hecho.healthcheck_test_hash) {
    add(
      CODIGOS.HEALTHCHECK_DIVERGENTE,
      `canónico=${literal(spec.healthcheck_test)} vivo=huella ${hecho.healthcheck_test_hash ?? "(ninguno)"}`,
    );
  }
  return h;
}

/** Comprobación completa: procedencia + cobertura + spec. */
export function comprobar(hechos, specs, { canonica = null } = {}) {
  const servicios = (hechos.services ?? []).filter((h) => h.compose_managed !== false);
  const proc = comprobarProcedencia(hechos, { canonica });
  const hallazgos = [...proc.hallazgos];

  const vivos = new Map(servicios.map((h) => [h.service, h]));
  for (const nombre of vivos.keys()) {
    if (!specs[nombre]) {
      hallazgos.push({
        service: nombre,
        code: CODIGOS.SERVICIO_NO_RENDERIZADO,
        detail: "servicio vivo que el compose canónico no renderiza con este perfil: nadie lo reproduce",
      });
    }
  }
  for (const nombre of Object.keys(specs)) {
    if (!vivos.has(nombre)) {
      hallazgos.push({
        service: nombre,
        code: CODIGOS.SERVICIO_NO_DESPLEGADO,
        detail: "el compose canónico lo renderiza pero no está desplegado",
      });
    }
  }
  for (const [nombre, hecho] of vivos) {
    if (specs[nombre]) hallazgos.push(...comprobarServicio(hecho, specs[nombre]));
  }

  const porServicio = new Map();
  for (const x of hallazgos) porServicio.set(x.service, (porServicio.get(x.service) ?? 0) + 1);
  return {
    reproducible: hallazgos.length === 0,
    procedencias: proc.porOrigen,
    hallazgos,
    // Plan de recreación: qué servicios cambiarían si se aplicara el canónico.
    // Un servicio que sólo diverge en PROCEDENCIA no cambia de spec: se puede
    // reetiquetar sin tocar el contenedor. Uno con spec divergente, no.
    recrear: [...porServicio.keys()]
      .filter((s) => s !== "(stack)" && hallazgos.some((x) => x.service === s && !ES_SOLO_PROCEDENCIA.has(x.code)))
      .sort(),
    reetiquetar: [...porServicio.keys()]
      .filter((s) => s !== "(stack)" && hallazgos.every((x) => x.service !== s || ES_SOLO_PROCEDENCIA.has(x.code)))
      .sort(),
  };
}

const ES_SOLO_PROCEDENCIA = new Set([CODIGOS.CONFIG_FILES_DIVERGENTE, CODIGOS.CONFIG_FILES_AUSENTE]);

export function informeTexto(r) {
  const l = [];
  l.push(r.reproducible ? "REPRODUCIBLE desde el compose canónico" : "NO REPRODUCIBLE desde el compose canónico");
  l.push("");
  l.push("Procedencias declaradas:");
  for (const [origen, servicios] of Object.entries(r.procedencias)) l.push(`  ${origen}: ${servicios.join(", ")}`);
  if (r.hallazgos.length) {
    l.push("");
    l.push(`Hallazgos (${r.hallazgos.length}):`);
    for (const x of r.hallazgos) l.push(`  [${x.code}] ${x.service}: ${x.detail}`);
  }
  l.push("");
  l.push(`Recrear al canonizar: ${r.recrear.length ? r.recrear.join(", ") : "(ninguno)"}`);
  l.push(`Sólo reetiquetar procedencia: ${r.reetiquetar.length ? r.reetiquetar.join(", ") : "(ninguno)"}`);
  return l.join("\n");
}

function parseYaml(texto) {
  return createRequire(import.meta.url)("yaml").parse(texto, { merge: true });
}

function arg(argv, nombre) {
  const i = argv.indexOf(nombre);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv) {
  const ficheroHechos = arg(argv, "--facts");
  const ficheroCompose = arg(argv, "--compose");
  if (!ficheroHechos || !ficheroCompose) {
    console.error(
      "uso: --facts <hechos.json> --compose <docker-compose.yml> [--canonical-config-files <ruta>] [--profile <p>] [--compose-env K=V]… [--json]",
    );
    return 2;
  }
  let hechos;
  let doc;
  try {
    hechos = JSON.parse(readFileSync(ficheroHechos, "utf8"));
    doc = parseYaml(readFileSync(ficheroCompose, "utf8"));
  } catch (e) {
    console.error(`adquisición: ${e.message}`);
    return 2;
  }
  const vars = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--compose-env") continue;
    const v = String(argv[i + 1] ?? "");
    const j = v.indexOf("=");
    if (j > 0) vars[v.slice(0, j)] = v.slice(j + 1);
  }
  const specs = specDesdeCompose(doc, { vars, profile: arg(argv, "--profile") ?? null });
  const r = comprobar(hechos, specs, { canonica: arg(argv, "--canonical-config-files") ?? null });
  console.log(argv.includes("--json") ? JSON.stringify(r, null, 2) : informeTexto(r));
  return r.reproducible ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}

export { normalizarMontaje };
