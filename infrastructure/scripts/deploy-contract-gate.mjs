#!/usr/bin/env node
/**
 * CONTRATO DE DESPLIEGUE REPRODUCIBLE · gate ejecutable.
 *
 * Cuatro garantías, cada una con su control positivo y su control negativo:
 *
 *   B · REFERENCIA DE IMAGEN, en TRES niveles distintos y separados
 *   C · TAG (por EFECTO, no por cadena)
 *   D · PERFIL (conjunto EXACTO de servicios renderizado)
 *   E · SERVICIOS CON ESTADO (postgres y queue)
 *
 * ── B · los tres niveles, y por qué son tres ────────────────────────────────
 *
 *   1 SINTAXIS   la referencia contiene @sha256:<64 hex válidos>
 *   2 REGISTRO   ese digest RESUELVE EN EL REGISTRO, y la etiqueta que lo
 *                acompaña resuelve AL MISMO digest (coherencia declarativa)
 *   3 VERSIÓN    el artefacto resuelto contiene la versión esperada
 *                (para postgres: PG_VERSION=16.14 en la plataforma esperada)
 *
 * Un nivel 1 verde no dice nada del nivel 2, y un nivel 2 verde no dice nada
 * del nivel 3: un digest perfectamente resoluble puede ser el de OTRA versión.
 * Por eso se informan por separado y ninguno absorbe al siguiente.
 *
 * ── LA AUTORIDAD DEL NIVEL 2 NO PUEDE SER EL ALMACÉN LOCAL DE DOCKER ────────
 *
 * Error real cometido durante este mismo análisis, y la razón de que esta regla
 * esté escrita en el código y no sólo en un documento:
 *
 *     docker image inspect postgres:16-alpine@sha256:57c72fd2a128…
 *       → Error response from daemon: No such image
 *
 * De ahí se concluyó —mal— que el digest «no existía» y que era un image ID
 * local. Falso: el digest existe y resuelve sin problema en el registro; es el
 * índice OCI publicado de `postgres:16.14-alpine`. Lo que ocurre es que la
 * imagen del almacén local NO tiene `RepoDigests` (se quedó sin etiquetas
 * cuando `postgres:16-alpine` se movió a 16.15), y `docker image inspect` sólo
 * sabe de lo que hay en el daemon. El almacén local responde por lo que se
 * descargó, no por lo que el registro publica: usarlo como autoridad da
 * FALSOS NEGATIVOS (digest real declarado inexistente) y también podría dar
 * falsos positivos (un image ID casualmente presente aceptado como digest).
 *
 * La autoridad es el REGISTRO:
 *     docker buildx imagetools inspect <ref>      (consulta, no descarga)
 *     docker manifest inspect <ref>               (idem; además VERIFICA que
 *                                                  la etiqueta y el digest de
 *                                                  la misma referencia cuadran)
 *
 * Por eso todo resolvedor debe declarar `fuente: "registro"`. Un resolvedor que
 * declare `almacen-local` (o que no lo declare) se rechaza con
 * FUENTE_NO_AUTORIZADA aunque sus datos fueran correctos: la garantía es de
 * dónde viene el hecho, no de que el hecho parezca bueno.
 *
 * ── C · el gate de TAG piensa en el EFECTO ──────────────────────────────────
 *
 * `TAG=local` en producción es el síntoma medido (las etiquetas `:local`
 * apuntaban a las imágenes ANTERIORES al rollout), pero prohibir la palabra
 * «local» no arregla nada: otra variable —IMAGE_PREFIX, un default `:latest`,
 * una interpolación— produce exactamente el mismo drift. El gate NO busca
 * cadenas: RENDERIZA el compose con el entorno declarado y compara la
 * referencia resultante de CADA servicio con el artefacto que el contrato dice
 * desplegar. Cualquier causa que mueva el efecto se caza igual.
 *
 * ── D · el gate de PERFIL comprueba el CONJUNTO, no el nombre ───────────────
 *
 * Todos los servicios llevan `profiles:`, así que sin perfil el compose
 * renderiza CERO servicios y `--services` sale vacío. Comprobar «el perfil se
 * llama development» no impide desplegar el conjunto equivocado. Se comprueba
 * IGUALDAD DE CONJUNTOS contra `servicios_esperados`, y se exige además que
 * cada perfil de `perfiles_rechazados` NO produzca ese conjunto.
 *
 * ── Uso ─────────────────────────────────────────────────────────────────────
 *   node infrastructure/scripts/deploy-contract-gate.mjs --self-test
 *       Offline: controles positivos y negativos de las cuatro garantías.
 *   node infrastructure/scripts/deploy-contract-gate.mjs [--contrato F] [--json]
 *       Comprueba C, D y E (offline) y B en modo sintaxis; añade --registro
 *       para consultar de verdad el registro (necesita docker buildx).
 *   node infrastructure/scripts/deploy-contract-gate.mjs --invocacion
 *       Imprime la ENVOLTURA: la invocación exacta de docker compose que el
 *       contrato fija (proyecto, ficheros, perfiles, env-file, TAG…), para no
 *       depender de que alguien recuerde cinco flags.
 *
 * rc=0 todo verde · rc=1 alguna garantía roja · rc=2 no se pudo comprobar
 * (contrato o compose ausentes/ilegibles). La ausencia NUNCA es aprobado.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONTRATO_POR_DEFECTO = join(RAIZ, "infrastructure", "deploy-contract.json");

/** Clase operativa: servicios con estado durable. `queue` entra aquí a propósito. */
export const STATEFUL_SERVICES = Object.freeze(["postgres", "queue"]);

export const CODIGOS = Object.freeze({
  N1_SIN_DIGEST: "N1_SIN_DIGEST",
  N1_DIGEST_MALFORMADO: "N1_DIGEST_MALFORMADO",
  N2_FUENTE_NO_AUTORIZADA: "N2_FUENTE_NO_AUTORIZADA",
  N2_DIGEST_NO_RESUELVE: "N2_DIGEST_NO_RESUELVE",
  N2_REGISTRO_INACCESIBLE: "N2_REGISTRO_INACCESIBLE",
  N2_ETIQUETA_INCOHERENTE: "N2_ETIQUETA_INCOHERENTE",
  N2_PLATAFORMA_AUSENTE: "N2_PLATAFORMA_AUSENTE",
  N3_VERSION_DISTINTA: "N3_VERSION_DISTINTA",
  N3_VERSION_NO_OBSERVABLE: "N3_VERSION_NO_OBSERVABLE",
  TAG_DERIVA: "TAG_DERIVA",
  TAG_SERVICIO_AUSENTE: "TAG_SERVICIO_AUSENTE",
  PERFIL_CONJUNTO_DISTINTO: "PERFIL_CONJUNTO_DISTINTO",
  PERFIL_VACIO: "PERFIL_VACIO",
  PERFIL_RECHAZADO_EQUIVALE: "PERFIL_RECHAZADO_EQUIVALE",
  ESTADO_NO_DECLARADO: "ESTADO_NO_DECLARADO",
  ESTADO_SIN_POLITICA: "ESTADO_SIN_POLITICA",
  ESTADO_VOLUMEN_AUSENTE: "ESTADO_VOLUMEN_AUSENTE",
  ESTADO_SIN_MONTAJE: "ESTADO_SIN_MONTAJE",
  ESTADO_DEUDA_SIN_DECLARAR: "ESTADO_DEUDA_SIN_DECLARAR",
});

// ── Referencias de imagen ────────────────────────────────────────────────────

const RE_DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Parte una referencia en repo / etiqueta / digest sin normalizar el registro. */
export function analizarReferencia(ref) {
  const texto = String(ref ?? "");
  const corte = texto.indexOf("@");
  const sinDigest = corte === -1 ? texto : texto.slice(0, corte);
  const digest = corte === -1 ? null : texto.slice(corte + 1);
  // El ':' de un puerto (registro:5000/repo) no es una etiqueta.
  const ultimoDosPuntos = sinDigest.lastIndexOf(":");
  const ultimaBarra = sinDigest.lastIndexOf("/");
  const tieneEtiqueta = ultimoDosPuntos > ultimaBarra;
  return {
    repo: tieneEtiqueta ? sinDigest.slice(0, ultimoDosPuntos) : sinDigest,
    etiqueta: tieneEtiqueta ? sinDigest.slice(ultimoDosPuntos + 1) : null,
    digest,
    sinDigest,
  };
}

/** NIVEL 1 · sintaxis. No consulta nada: sólo mira la cadena. */
export function nivel1Sintaxis(ref) {
  const { digest } = analizarReferencia(ref);
  if (digest === null) return { ok: false, codigo: CODIGOS.N1_SIN_DIGEST, detalle: `${ref}: sin @sha256:` };
  if (!RE_DIGEST.test(digest))
    return { ok: false, codigo: CODIGOS.N1_DIGEST_MALFORMADO, detalle: `${ref}: digest no es sha256:<64 hex>` };
  return { ok: true };
}

/**
 * NIVEL 2 · registro. `resolver(referencia)` debe devolver
 *   { fuente: "registro", digest, plataformas: [{ plataforma, env: {…} }] }
 * o { fuente: "registro", error } si el registro no la resuelve.
 * Cualquier `fuente` distinta de "registro" se rechaza: ver cabecera.
 */
/**
 * ÚNICA puerta de autoridad del nivel 2, en un solo sitio a propósito: si
 * estuviera duplicada, estropear una copia dejaría la otra tapando el agujero
 * y la mutación sobreviviría sin que nadie se enterara.
 */
/**
 * ¿El error es «no pude preguntar» y no «el registro dice que no»?
 *
 * ENOENT / «command not found» entran aquí desde 2026-09-04, y no por teoría:
 * ejecutando este mismo gate con `--registro` y sin `docker` en el PATH, el
 * resolvedor devolvió `spawnSync docker ENOENT` y el nivel 2 lo clasificó como
 * N2_DIGEST_NO_RESUELVE, es decir «ese digest no existe en el registro». Falso:
 * el digest está perfectamente publicado; lo que faltaba era el CLIENTE. Es
 * exactamente la confusión que ADR-018 corrige en `scan` —fuente caída leída
 * como veredicto— aplicada a la herramienta en vez de a la red. Las dos siguen
 * siendo ROJAS (no comprobado no es aprobado), pero confundirlas haría creer
 * que un artefacto bueno se ha esfumado, y mandaría a alguien a reconstruir una
 * imagen que no tiene nada de malo.
 */
export function registroInaccesible(error) {
  return /429|too many requests|timeout|temporary failure|connection refused|no such host|i\/o timeout|EAI_AGAIN|ENOENT|command not found|no such file or directory/i.test(
    String(error ?? ""),
  );
}

export function fuenteAutorizada(respuesta) {
  return respuesta?.fuente === "registro";
}

export function nivel2Registro(ref, resolver, { plataformas = [] } = {}) {
  const { sinDigest, digest, repo, etiqueta } = analizarReferencia(ref);
  const porDigest = resolver(`${repo}@${digest}`);
  if (!fuenteAutorizada(porDigest))
    return {
      ok: false,
      codigo: CODIGOS.N2_FUENTE_NO_AUTORIZADA,
      detalle: `${ref}: la resolución vino de "${porDigest?.fuente ?? "(sin declarar)"}" y no del registro; el almacén local de Docker NO es autoridad (ver cabecera del gate)`,
    };
  // «No pude preguntar» y «el registro dice que no existe» son cosas distintas.
  // Medido de verdad: Docker Hub devolvió 429 Too Many Requests a mitad de esta
  // comprobación. Ambas son ROJAS (no comprobado ≠ aprobado), pero confundirlas
  // haría creer que un digest bueno se ha esfumado.
  if (registroInaccesible(porDigest.error))
    return {
      ok: false,
      codigo: CODIGOS.N2_REGISTRO_INACCESIBLE,
      detalle: `${ref}: no se pudo consultar el registro (${porDigest.error}); NO comprobado, y no comprobado no es aprobado`,
    };
  if (porDigest.error || !porDigest.digest)
    return {
      ok: false,
      codigo: CODIGOS.N2_DIGEST_NO_RESUELVE,
      detalle: `${ref}: el digest no resuelve en el registro (${porDigest.error ?? "sin digest"})`,
    };

  if (etiqueta !== null) {
    const porEtiqueta = resolver(sinDigest);
    if (!fuenteAutorizada(porEtiqueta))
      return {
        ok: false,
        codigo: CODIGOS.N2_FUENTE_NO_AUTORIZADA,
        detalle: `${sinDigest}: la resolución de la etiqueta no vino del registro`,
      };
    if (porEtiqueta.error || porEtiqueta.digest !== porDigest.digest)
      return {
        ok: false,
        codigo: CODIGOS.N2_ETIQUETA_INCOHERENTE,
        detalle: `${ref}: la etiqueta ${sinDigest} resuelve a ${porEtiqueta.digest ?? porEtiqueta.error} y el digest declarado es ${porDigest.digest}`,
      };
  }

  const presentes = new Set((porDigest.plataformas ?? []).map((p) => p.plataforma));
  for (const p of plataformas)
    if (!presentes.has(p))
      return {
        ok: false,
        codigo: CODIGOS.N2_PLATAFORMA_AUSENTE,
        detalle: `${ref}: el índice resuelto no publica ${p}`,
      };

  return { ok: true, artefacto: porDigest };
}

/** NIVEL 3 · versión: el artefacto YA RESUELTO contiene la versión esperada. */
export function nivel3Version(ref, artefacto, { variable, valor }, { plataformas = [] } = {}) {
  const objetivo = plataformas.length > 0 ? plataformas : (artefacto.plataformas ?? []).map((p) => p.plataforma);
  for (const nombre of objetivo) {
    const plat = (artefacto.plataformas ?? []).find((p) => p.plataforma === nombre);
    const visto = plat?.env?.[variable];
    if (visto === undefined)
      return {
        ok: false,
        codigo: CODIGOS.N3_VERSION_NO_OBSERVABLE,
        detalle: `${ref}: ${variable} no observable en ${nombre}; la ausencia no es aprobado`,
      };
    if (visto !== valor)
      return {
        ok: false,
        codigo: CODIGOS.N3_VERSION_DISTINTA,
        detalle: `${ref}: ${nombre} trae ${variable}=${visto} y el contrato espera ${valor}`,
      };
  }
  return { ok: true };
}

/** B completo, con los tres niveles informados por separado. */
export function verificarPin(pin, resolver) {
  const niveles = {};
  niveles.sintaxis = nivel1Sintaxis(pin.ref);
  if (!niveles.sintaxis.ok) return { servicio: pin.servicio, ok: false, niveles, fallo: niveles.sintaxis };
  niveles.registro = nivel2Registro(pin.ref, resolver, { plataformas: pin.plataformas ?? [] });
  if (!niveles.registro.ok) return { servicio: pin.servicio, ok: false, niveles, fallo: niveles.registro };
  niveles.version = pin.version_esperada
    ? nivel3Version(pin.ref, niveles.registro.artefacto, pin.version_esperada, { plataformas: pin.plataformas ?? [] })
    : {
        ok: false,
        codigo: CODIGOS.N3_VERSION_NO_OBSERVABLE,
        detalle: `${pin.ref}: el contrato no declara versión esperada; no comprobado ≠ aprobado`,
      };
  return {
    servicio: pin.servicio,
    ok: niveles.version.ok,
    niveles,
    fallo: niveles.version.ok ? null : niveles.version,
  };
}

// ── Render del compose (offline, sin daemon) ─────────────────────────────────

/** Interpolación de ${VAR}, ${VAR:-def} y ${VAR-def}, como hace Compose. */
export function interpolar(texto, vars = {}) {
  return String(texto).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}/g, (_, nombre, def) => {
    const v = vars[nombre];
    if (v === undefined || v === "") return def ?? "";
    return v;
  });
}

/** Servicios que un conjunto de perfiles selecciona, con su imagen renderizada. */
export function renderizar(doc, { perfiles = [], vars = {} } = {}) {
  const activos = new Set(perfiles.filter((p) => p !== ""));
  const salida = {};
  for (const [svc, def] of Object.entries(doc?.services ?? {})) {
    const suyos = Array.isArray(def?.profiles) ? def.profiles : [];
    // Sin `profiles:` el servicio es incondicional; con ellos hace falta uno activo.
    const seleccionado = suyos.length === 0 ? true : suyos.some((p) => activos.has(p));
    if (!seleccionado) continue;
    salida[svc] = { imagen: def?.image === undefined ? null : interpolar(def.image, vars) };
  }
  return salida;
}

// ── C · gate de TAG, por efecto ──────────────────────────────────────────────

export function verificarTag(contrato, doc) {
  const fallos = [];
  const render = renderizar(doc, { perfiles: contrato.perfiles, vars: contrato.entorno ?? {} });
  for (const [svc, esperada] of Object.entries(contrato.imagenes_esperadas ?? {})) {
    const real = render[svc]?.imagen;
    if (real === undefined)
      fallos.push({
        codigo: CODIGOS.TAG_SERVICIO_AUSENTE,
        detalle: `${svc}: el contrato declara imagen pero el perfil no lo renderiza`,
      });
    else if (real !== esperada)
      fallos.push({
        codigo: CODIGOS.TAG_DERIVA,
        detalle: `${svc}: se desplegaría ${real} y el contrato fija ${esperada}`,
      });
  }
  return { ok: fallos.length === 0, fallos, render };
}

// ── D · gate de PERFIL, por conjunto exacto ──────────────────────────────────

const mismoConjunto = (a, b) => {
  const A = [...new Set(a)].sort();
  const B = [...new Set(b)].sort();
  return A.length === B.length && A.every((x, i) => x === B[i]);
};

export function verificarPerfil(contrato, doc) {
  const fallos = [];
  const esperados = contrato.servicios_esperados ?? [];
  const obtenidos = Object.keys(renderizar(doc, { perfiles: contrato.perfiles, vars: contrato.entorno ?? {} }));
  if (obtenidos.length === 0)
    fallos.push({
      codigo: CODIGOS.PERFIL_VACIO,
      detalle: `perfiles [${contrato.perfiles.join(",")}] renderizan CERO servicios`,
    });
  else if (!mismoConjunto(obtenidos, esperados))
    fallos.push({
      codigo: CODIGOS.PERFIL_CONJUNTO_DISTINTO,
      detalle: `perfiles [${contrato.perfiles.join(",")}] renderizan {${[...obtenidos].sort().join(",")}} y el contrato espera {${[...esperados].sort().join(",")}}`,
    });

  // Cada perfil declarado inaceptable tiene que producir OTRO conjunto: si
  // produjera el canónico, la declaración sería falsa y el gate mentiría.
  for (const [perfil, motivo] of Object.entries(contrato.perfiles_rechazados ?? {})) {
    const r = Object.keys(renderizar(doc, { perfiles: perfil === "" ? [] : [perfil], vars: contrato.entorno ?? {} }));
    if (mismoConjunto(r, esperados))
      fallos.push({
        codigo: CODIGOS.PERFIL_RECHAZADO_EQUIVALE,
        detalle: `el perfil "${perfil}" se declara inaceptable (${motivo}) pero renderiza el conjunto canónico: la declaración es falsa`,
      });
  }
  return { ok: fallos.length === 0, fallos, obtenidos };
}

// ── E · servicios con estado ─────────────────────────────────────────────────

export function verificarEstado(contrato, doc) {
  const fallos = [];
  const declarados = contrato.servicios_con_estado ?? {};
  for (const svc of STATEFUL_SERVICES) {
    const d = declarados[svc];
    if (!d) {
      fallos.push({ codigo: CODIGOS.ESTADO_NO_DECLARADO, detalle: `${svc}: no declarado como servicio con estado` });
      continue;
    }
    for (const campo of ["politica_persistencia", "politica_recreacion", "durabilidad", "volumen", "destino"])
      if (!d[campo] || String(d[campo]).trim() === "")
        fallos.push({ codigo: CODIGOS.ESTADO_SIN_POLITICA, detalle: `${svc}: sin ${campo} explícita` });
    // Sin copia verificada, la deuda se DECLARA; callarla sí es aprobar por omisión.
    if (d.copia_verificada !== true && !d.deuda)
      fallos.push({
        codigo: CODIGOS.ESTADO_DEUDA_SIN_DECLARAR,
        detalle: `${svc}: sin copia verificada y sin deuda declarada`,
      });

    const volumenes = doc?.volumes ?? {};
    if (d.volumen && !(d.volumen in volumenes))
      fallos.push({
        codigo: CODIGOS.ESTADO_VOLUMEN_AUSENTE,
        detalle: `${svc}: el volumen ${d.volumen} no está declarado en el compose`,
      });
    const montajes = doc?.services?.[svc]?.volumes ?? [];
    const montado = montajes.some((m) => {
      if (typeof m === "string") {
        const [origen, destino] = m.split(":");
        return origen === d.volumen && destino === d.destino;
      }
      return m?.source === d.volumen && m?.target === d.destino;
    });
    if (!montado)
      fallos.push({
        codigo: CODIGOS.ESTADO_SIN_MONTAJE,
        detalle: `${svc}: ${d.volumen} no está montado en ${d.destino}`,
      });
  }
  return { ok: fallos.length === 0, fallos };
}

// ── Envoltura ────────────────────────────────────────────────────────────────

/**
 * La invocación EXACTA que fija el contrato. Es la envoltura que sustituye a
 * «recordar cinco flags», y es inspeccionable: el propio gate la genera desde
 * el contrato, así que no puede divergir de lo que se verifica.
 */
export function invocacion(contrato, { accion = "up" } = {}) {
  const argv = ["docker", "compose"];
  for (const f of contrato.compose_files ?? []) argv.push("-f", f);
  for (const f of contrato.env_files ?? []) argv.push("--env-file", f);
  argv.push("-p", contrato.proyecto);
  for (const p of contrato.perfiles ?? []) argv.push("--profile", p);
  if (accion === "up") argv.push("up", "-d", "--no-build");
  else argv.push(accion);
  const entorno = Object.entries(contrato.entorno ?? {}).map(([k, v]) => `${k}=${v}`);
  return { entorno, argv, linea: [...entorno, ...argv].join(" ") };
}

// ── Resolvedor real (registro) ───────────────────────────────────────────────

/**
 * Único resolvedor autorizado: consulta el REGISTRO con buildx imagetools.
 * No descarga la imagen y no mira el almacén local. Declara `fuente:"registro"`.
 */
export function resolvedorRegistro(ejecutar = (args) => execFileSync("docker", args, { encoding: "utf8" })) {
  return (ref) => {
    try {
      const digest = ejecutar(["buildx", "imagetools", "inspect", ref, "--format", "{{.Manifest.Digest}}"]).trim();
      let plataformas = [];
      try {
        const crudo = ejecutar([
          "buildx",
          "imagetools",
          "inspect",
          ref,
          "--format",
          "{{range $p,$i := .Image}}{{$p}}\t{{range $i.Config.Env}}{{.}} {{end}}\n{{end}}",
        ]);
        plataformas = crudo
          .split("\n")
          .filter((l) => l.includes("\t"))
          .map((l) => {
            const [plataforma, env] = l.split("\t");
            const vars = {};
            for (const par of env.trim().split(/\s+/)) {
              const i = par.indexOf("=");
              if (i > 0) vars[par.slice(0, i)] = par.slice(i + 1);
            }
            return { plataforma: plataforma.trim(), env: vars };
          });
      } catch {
        plataformas = [];
      }
      return { fuente: "registro", digest, plataformas };
    } catch (e) {
      return { fuente: "registro", error: String(e?.message ?? e).split("\n")[0] };
    }
  };
}

// ── Self-test: controles positivos y negativos, offline ──────────────────────

const DIGEST_1614 = "sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777";
const DIGEST_1615 = "sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685";

/** Registro simulado con los HECHOS medidos contra el registro real. */
export function resolvedorFalso({ fuente = "registro" } = {}) {
  const indice = {
    [`postgres@${DIGEST_1614}`]: {
      digest: DIGEST_1614,
      plataformas: [{ plataforma: "linux/amd64", env: { PG_VERSION: "16.14" } }],
    },
    [`postgres@${DIGEST_1615}`]: {
      digest: DIGEST_1615,
      plataformas: [{ plataforma: "linux/amd64", env: { PG_VERSION: "16.15" } }],
    },
    "postgres:16.14-alpine": {
      digest: DIGEST_1614,
      plataformas: [{ plataforma: "linux/amd64", env: { PG_VERSION: "16.14" } }],
    },
    "postgres:16.15-alpine": {
      digest: DIGEST_1615,
      plataformas: [{ plataforma: "linux/amd64", env: { PG_VERSION: "16.15" } }],
    },
    "postgres:16-alpine": {
      digest: DIGEST_1615,
      plataformas: [{ plataforma: "linux/amd64", env: { PG_VERSION: "16.15" } }],
    },
  };
  return (ref) => {
    const hit = indice[ref];
    return hit ? { fuente, ...hit } : { fuente, error: "manifest unknown" };
  };
}

export const CASOS_AUTOPRUEBA = [
  {
    nombre: "PASS · tag 16.14-alpine + digest de 16.14",
    pin: {
      servicio: "postgres",
      ref: `postgres:16.14-alpine@${DIGEST_1614}`,
      plataformas: ["linux/amd64"],
      version_esperada: { variable: "PG_VERSION", valor: "16.14" },
    },
    esperado: null,
  },
  {
    nombre: "FAIL · digest inexistente",
    pin: {
      servicio: "postgres",
      ref: "postgres:16.14-alpine@sha256:" + "0".repeat(64),
      plataformas: ["linux/amd64"],
      version_esperada: { variable: "PG_VERSION", valor: "16.14" },
    },
    esperado: CODIGOS.N2_DIGEST_NO_RESUELVE,
  },
  {
    nombre: "FAIL · digest válido de OTRA versión (nivel 3)",
    pin: {
      servicio: "postgres",
      ref: `postgres:16.15-alpine@${DIGEST_1615}`,
      plataformas: ["linux/amd64"],
      version_esperada: { variable: "PG_VERSION", valor: "16.14" },
    },
    esperado: CODIGOS.N3_VERSION_DISTINTA,
  },
  {
    nombre: "FAIL · tag 16.15-alpine + digest de 16.14 (incoherencia declarativa)",
    pin: {
      servicio: "postgres",
      ref: `postgres:16.15-alpine@${DIGEST_1614}`,
      plataformas: ["linux/amd64"],
      version_esperada: { variable: "PG_VERSION", valor: "16.14" },
    },
    esperado: CODIGOS.N2_ETIQUETA_INCOHERENTE,
  },
  {
    nombre: "FAIL · referencia sin digest (nivel 1)",
    pin: {
      servicio: "postgres",
      ref: "postgres:16.14-alpine",
      plataformas: ["linux/amd64"],
      version_esperada: { variable: "PG_VERSION", valor: "16.14" },
    },
    esperado: CODIGOS.N1_SIN_DIGEST,
  },
];

export function autoprueba() {
  const lineas = [];
  let fallo = 0;
  const anota = (ok, txt) => {
    lineas.push(`${ok ? "OK  " : "MAL "} ${txt}`);
    if (!ok) fallo = 1;
  };

  const resolver = resolvedorFalso();
  for (const caso of CASOS_AUTOPRUEBA) {
    const r = verificarPin(caso.pin, resolver);
    const codigo = r.ok ? null : r.fallo.codigo;
    anota(codigo === caso.esperado, `${caso.nombre} → ${codigo ?? "PASS"}`);
  }

  // El control que da nombre a este gate: resolver contra el ALMACÉN LOCAL.
  const local = verificarPin(CASOS_AUTOPRUEBA[0].pin, resolvedorFalso({ fuente: "almacen-local" }));
  anota(
    !local.ok && local.fallo.codigo === CODIGOS.N2_FUENTE_NO_AUTORIZADA,
    `el mismo pin BUENO resuelto contra el almacén local → ${local.ok ? "PASS (¡no lo caza!)" : local.fallo.codigo}`,
  );

  // C, D y E contra el compose y el contrato reales.
  const { contrato, doc } = cargar(CONTRATO_POR_DEFECTO);
  const tag = verificarTag(contrato, doc);
  anota(tag.ok, `TAG · el contrato y el compose real coinciden ${tag.ok ? "" : JSON.stringify(tag.fallos)}`);
  const conTagLocal = verificarTag({ ...contrato, entorno: { ...contrato.entorno, TAG: "local" } }, doc);
  anota(!conTagLocal.ok, `TAG=local en producción → ${conTagLocal.ok ? "PASS (¡no lo caza!)" : "FAIL"}`);
  const otraVariable = verificarTag({ ...contrato, entorno: { ...contrato.entorno, IMAGE_PREFIX: "otro" } }, doc);
  anota(
    !otraVariable.ok,
    `deriva causada por OTRA variable (IMAGE_PREFIX) → ${otraVariable.ok ? "PASS (¡no lo caza!)" : "FAIL"}`,
  );

  const perfil = verificarPerfil(contrato, doc);
  anota(perfil.ok, `PERFIL · conjunto exacto ${perfil.ok ? "" : JSON.stringify(perfil.fallos)}`);
  const sinPerfil = verificarPerfil({ ...contrato, perfiles: [] }, doc);
  anota(!sinPerfil.ok, `sin perfil → ${sinPerfil.ok ? "PASS (¡no lo caza!)" : sinPerfil.fallos[0].codigo}`);
  for (const p of ["nucleo", "production", "external-db"]) {
    const r = verificarPerfil({ ...contrato, perfiles: [p] }, doc);
    anota(!r.ok, `perfil ${p} → ${r.ok ? "PASS (¡no lo caza!)" : r.fallos[0].codigo}`);
  }

  const estado = verificarEstado(contrato, doc);
  anota(
    estado.ok,
    `ESTADO · postgres y queue con política explícita ${estado.ok ? "" : JSON.stringify(estado.fallos)}`,
  );
  const sinQueue = verificarEstado(
    { ...contrato, servicios_con_estado: { postgres: contrato.servicios_con_estado.postgres } },
    doc,
  );
  anota(
    !sinQueue.ok,
    `queue sin declarar como STATEFUL → ${sinQueue.ok ? "PASS (¡no lo caza!)" : sinQueue.fallos[0].codigo}`,
  );

  return { rc: fallo, lineas };
}

// ── Carga y CLI ──────────────────────────────────────────────────────────────

export function cargar(ruta) {
  if (!existsSync(ruta)) {
    const e = new Error(`contrato ausente: ${ruta}`);
    e.rc = 2;
    throw e;
  }
  const contrato = JSON.parse(readFileSync(ruta, "utf8"));
  const ficheros = (contrato.compose_files ?? []).map((f) => join(RAIZ, f));
  for (const f of ficheros)
    if (!existsSync(f)) {
      const e = new Error(`compose ausente: ${f}`);
      e.rc = 2;
      throw e;
    }
  // Un solo compose hoy; si hubiera varios se fusionarían en orden.
  const doc = ficheros.reduce((acc, f) => {
    const d = parse(readFileSync(f, "utf8"), { merge: true });
    return {
      ...acc,
      ...d,
      services: { ...(acc.services ?? {}), ...(d.services ?? {}) },
      volumes: { ...(acc.volumes ?? {}), ...(d.volumes ?? {}) },
    };
  }, {});
  return { contrato, doc };
}

export function main(argv) {
  if (argv.includes("--self-test")) {
    const { rc, lineas } = autoprueba();
    for (const l of lineas) console.log(l);
    console.log(rc === 0 ? "AUTOPRUEBA VERDE · las cuatro garantías saben ponerse rojas" : "AUTOPRUEBA ROJA");
    return rc;
  }

  const i = argv.indexOf("--contrato");
  const ruta = i >= 0 ? argv[i + 1] : CONTRATO_POR_DEFECTO;
  let contrato, doc;
  try {
    ({ contrato, doc } = cargar(ruta));
  } catch (e) {
    console.error(`NO COMPROBADO · ${e.message}`);
    return e.rc ?? 2;
  }

  if (argv.includes("--invocacion")) {
    console.log(invocacion(contrato).linea);
    return 0;
  }

  const resolver = argv.includes("--registro") ? resolvedorRegistro() : null;
  const informe = {
    imagenes: (contrato.imagenes_pinneadas ?? []).map((p) =>
      resolver
        ? verificarPin(p, resolver)
        : {
            servicio: p.servicio,
            ok: nivel1Sintaxis(p.ref).ok,
            niveles: {
              sintaxis: nivel1Sintaxis(p.ref),
              registro: { ok: false, codigo: "NO_EJERCIDO", detalle: "sin --registro: nivel 2 NO comprobado" },
              version: { ok: false, codigo: "NO_EJERCIDO", detalle: "sin --registro: nivel 3 NO comprobado" },
            },
            no_ejercido: true,
            fallo: nivel1Sintaxis(p.ref).ok ? null : nivel1Sintaxis(p.ref),
          },
    ),
    tag: verificarTag(contrato, doc),
    perfil: verificarPerfil(contrato, doc),
    estado: verificarEstado(contrato, doc),
    invocacion: invocacion(contrato).linea,
  };

  if (argv.includes("--json")) {
    console.log(JSON.stringify(informe, null, 2));
  } else {
    for (const r of informe.imagenes) {
      console.log(`IMAGEN ${r.servicio}:`);
      for (const [nivel, v] of Object.entries(r.niveles))
        console.log(`  ${nivel.padEnd(9)} ${v.ok ? "OK" : `${v.codigo} · ${v.detalle}`}`);
    }
    for (const [nombre, r] of [
      ["TAG", informe.tag],
      ["PERFIL", informe.perfil],
      ["ESTADO", informe.estado],
    ]) {
      console.log(`${nombre}: ${r.ok ? "OK" : "FALLO"}`);
      for (const f of r.fallos ?? []) console.log(`  ${f.codigo} · ${f.detalle}`);
    }
    console.log(`INVOCACIÓN CANÓNICA: ${informe.invocacion}`);
  }

  const rojo =
    informe.imagenes.some((r) => !r.ok || r.no_ejercido) || !informe.tag.ok || !informe.perfil.ok || !informe.estado.ok;
  return rojo ? 1 : 0;
}

const esCli = process.argv[1] && process.argv[1].endsWith("deploy-contract-gate.mjs");
if (esCli) process.exit(main(process.argv.slice(2)));
