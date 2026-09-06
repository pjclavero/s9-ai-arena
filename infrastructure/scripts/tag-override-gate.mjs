#!/usr/bin/env node
/**
 * OVERRIDE SELECTIVO POR SERVICIO · el mecanismo, y el gate que lo vigila.
 *
 * ── El problema ─────────────────────────────────────────────────────────────
 *
 * `tournament-worker` corre en producción el código de `4d469dc`, que se
 * PARALIZA EN SILENCIO si Redis muere después de arrancar: el waiter nunca se
 * rechaza y el healthcheck sigue verde porque es un `setInterval` ajeno al
 * bucle de trabajo. El arreglo (#142) ya está en `main`. Hace falta adelantar
 * ESE servicio sin mover los otros diez, que están validados en `4d469dc`.
 *
 * Con un único `TAG` eso no se puede expresar: la única forma de desplegar una
 * versión distinta era pasar `TAG` en la línea de comandos, lo que mueve la
 * referencia de TODOS. De ahí el patrón, uniforme para los servicios de
 * aplicación:
 *
 *     TAG=4d469dc                                  # línea base general
 *     TOURNAMENT_WORKER_TAG=82c74a8                # override explícito
 *     image: ...:${TOURNAMENT_WORKER_TAG:-${TAG:-latest}}
 *
 * ── La tensión que este fichero resuelve, y no unifica ──────────────────────
 *
 * `backup` (#139) usa `${BACKUP_TAG:-latest}`, SIN anidar, y su gate exige POR
 * EFECTO que mover `TAG` global NO lo arrastre. Es la semántica CONTRARIA a la
 * de los servicios de aplicación, que SÍ siguen a `TAG` por defecto. No es una
 * inconsistencia que haya que limar: son dos bloques con ciclos de vida
 * distintos (`backup` tiene ventana propia). Este gate comprueba las DOS
 * direcciones —que `backup` no siga a `TAG` y que los de aplicación sí— para
 * que un futuro "voy a unificar esto" se ponga rojo diga hacia dónde unifique.
 *
 * ── Requisito literal del operador ──────────────────────────────────────────
 *
 *   «no volver a caer en "el .env dice X pero el runtime es otra cosa" sin que
 *    el sistema lo declare»
 *
 * Un override es estado que cambia lo que se despliega. Si vive sólo en un
 * `.env` es INVISIBLE. Aquí es visible en tres sitios: se declara en el
 * contrato (`overrides_de_version.activos`), se IMPRIME en el informe de este
 * gate, y lo emiten el escáner de deriva y R17. El destino declarado es volver
 * a un único `TAG` común: el override es herramienta de transición, no régimen.
 *
 * ── Las SEIS garantías, cada una con su código ──────────────────────────────
 *
 *   G1 PATRON_UNIFORME   todo servicio de aplicación declarado en
 *                        `variables_por_servicio` obedece a su variable Y sigue
 *                        a `TAG` cuando la variable no está. Se comprueba POR
 *                        EFECTO, con valores centinela: leer del YAML que pone
 *                        `${API_TAG:-${TAG:-latest}}` no vale, porque el texto
 *                        puede ser cierto y el render falso — que es
 *                        exactamente lo que pasaba con la interpolación de una
 *                        sola pasada que este carril tuvo que arreglar.
 *   G2 AISLAMIENTO       activar UN override cambia la imagen de ESE servicio y
 *                        de ninguno más, salvo los que comparten variable y
 *                        están declarados en `variables_compartidas`.
 *   G3 SOLO_IMAGEN       el override no cambia NADA de la spec que no sea
 *                        `image`. Se compara la spec ENTERA renderizada, no
 *                        sólo el campo `image`: un override que se colara en un
 *                        `command`, una etiqueta o una variable de entorno
 *                        pasaría inadvertido si sólo se mirase la imagen.
 *   G4 VISIBLE           todo override con EFECTO en el render está declarado
 *                        en `activos`, y todo `activos` tiene efecto. Las dos
 *                        mitades: un override no declarado es estado invisible;
 *                        un declarado sin efecto es una declaración muerta que
 *                        haría creer que se desplegó algo que no se desplegó.
 *   G5 SEPARACION        `backup` NO sigue a `TAG` (se delega en
 *                        `backup-stack-gate.mjs`, que ya lo comprueba por
 *                        efecto: no se duplica) y, la mitad simétrica que allí
 *                        no existe, `BACKUP_TAG` NO mueve a los de aplicación.
 *   G6 OBJETIVO          la imagen que el contrato declara para cada servicio
 *                        (`imagenes_esperadas`) es la que el render produce con
 *                        el entorno del contrato. Esto ata el override a un
 *                        artefacto concreto en vez de a una intención.
 *
 * ── El GATE de recreación (`--gate`) ────────────────────────────────────────
 *
 * Antes de tocar producción: renderizar la línea base (`TAG` solo) y el
 * objetivo (`TAG` + overrides) y exigir
 *
 *     changed_images = 1   ·   service = tournament-worker
 *     changed_specs_other_than_image = 0
 *
 * Cualquier otra diferencia es STOP. El servicio y el número esperados NO están
 * cableados: salen de `overrides_de_version.activos`, de modo que el gate no
 * puede aprobar un override distinto del declarado.
 *
 * ── Reutilización ───────────────────────────────────────────────────────────
 * El render de perfiles es `renderizar` de `deploy-contract-gate.mjs`; la
 * interpolación es `lib/interpolar.mjs`; la separación de `backup` es
 * `backup-stack-gate.mjs`. Nada de eso se reimplementa: dos renderizadores
 * serían dos verdades.
 *
 * ── Uso ─────────────────────────────────────────────────────────────────────
 *   node infrastructure/scripts/tag-override-gate.mjs              informe + 6 garantías
 *   node infrastructure/scripts/tag-override-gate.mjs --gate       gate de recreación
 *   node infrastructure/scripts/tag-override-gate.mjs --invocacion  comando de recreación
 *   node infrastructure/scripts/tag-override-gate.mjs --self-test   controles + y -
 *   [--contrato F] [--compose F] [--json]
 *
 * rc=0 verde · rc=1 alguna garantía roja · rc=2 no se pudo comprobar. La
 * ausencia NUNCA es aprobado.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { verificarBackup } from "./backup-stack-gate.mjs";
import { renderizar } from "./deploy-contract-gate.mjs";
import { CASOS_CALIBRACION, interpolar, interpolarProfundo } from "./lib/interpolar.mjs";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONTRATO_POR_DEFECTO = join(RAIZ, "infrastructure", "deploy-contract.json");
const COMPOSE_POR_DEFECTO = join(RAIZ, "infrastructure", "docker-compose.yml");

/** Valores centinela: improbables por accidente, y distintos entre sí para que
 *  confundir dos de ellos no pueda pasar desapercibido. */
const CENTINELA_GLOBAL = "ZZ-centinela-global";
const CENTINELA_SERVICIO = "ZZ-centinela-servicio";

export const CODIGOS = Object.freeze({
  OVERRIDES_NO_DECLARADOS: "OVERRIDES_NO_DECLARADOS",
  SERVICIO_NO_RENDERIZA: "SERVICIO_NO_RENDERIZA",
  NO_SIGUE_A_TAG: "NO_SIGUE_A_TAG",
  NO_OBEDECE_A_SU_VARIABLE: "NO_OBEDECE_A_SU_VARIABLE",
  ARRASTRA_A_OTRO_SERVICIO: "ARRASTRA_A_OTRO_SERVICIO",
  CAMBIA_SPEC_NO_IMAGEN: "CAMBIA_SPEC_NO_IMAGEN",
  OVERRIDE_NO_DECLARADO: "OVERRIDE_NO_DECLARADO",
  OVERRIDE_DECLARADO_SIN_EFECTO: "OVERRIDE_DECLARADO_SIN_EFECTO",
  OVERRIDE_TAG_DISTINTO: "OVERRIDE_TAG_DISTINTO",
  BACKUP_SIGUE_A_TAG: "BACKUP_SIGUE_A_TAG",
  BACKUP_TAG_ARRASTRA_APP: "BACKUP_TAG_ARRASTRA_APP",
  IMAGEN_OBJETIVO_DISTINTA: "IMAGEN_OBJETIVO_DISTINTA",
  GATE_IMAGENES_CAMBIADAS: "GATE_IMAGENES_CAMBIADAS",
  GATE_SERVICIO_INESPERADO: "GATE_SERVICIO_INESPERADO",
  GATE_SPEC_NO_IMAGEN: "GATE_SPEC_NO_IMAGEN",
});

// ── Render de la spec COMPLETA ───────────────────────────────────────────────

/**
 * Servicios seleccionados por el perfil, con su definición ENTERA interpolada.
 *
 * La SELECCIÓN se delega en `renderizar` (una sola regla de perfiles en el
 * repositorio); lo que se añade aquí es interpolar el resto de la definición,
 * que `renderizar` no necesita y este gate sí: `changed_specs_other_than_image`
 * no se puede afirmar mirando sólo `image`.
 */
export function renderizarSpecs(doc, { perfiles = [], vars = {} } = {}) {
  const seleccionados = renderizar(doc, { perfiles, vars });
  const salida = {};
  for (const nombre of Object.keys(seleccionados)) {
    const def = doc?.services?.[nombre] ?? {};
    const spec = interpolarProfundo(def, vars);
    const { image, ...resto } = spec;
    salida[nombre] = { imagen: image ?? null, resto };
  }
  return salida;
}

const perfilesDe = (contrato) => contrato?.perfiles ?? [];

/** Entorno del contrato SIN ninguna variable de override: la línea base. */
export function varsBaseline(contrato) {
  const vars = { ...(contrato?.entorno ?? {}) };
  for (const v of new Set(Object.values(contrato?.overrides_de_version?.variables_por_servicio ?? {}))) {
    delete vars[v];
  }
  return vars;
}

/** Entorno del contrato TAL CUAL: línea base más los overrides declarados. */
export function varsEfectivas(contrato) {
  return { ...(contrato?.entorno ?? {}) };
}

/** Etiqueta de una referencia `repo/nombre:etiqueta`. */
export function etiquetaDe(ref) {
  const s = String(ref ?? "");
  const i = s.lastIndexOf(":");
  return i > s.lastIndexOf("/") ? s.slice(i + 1) : "";
}

/**
 * Overrides con EFECTO, calculados comparando dos renders — nunca leyendo qué
 * variables hay puestas. Una variable puesta al mismo valor que `TAG` no es un
 * override (no cambia nada) y una variable que el compose ignorase tampoco lo
 * sería aunque estuviera en el `.env`: lo que cuenta es el efecto.
 */
export function overridesConEfecto(contrato, doc) {
  const base = renderizarSpecs(doc, { perfiles: perfilesDe(contrato), vars: varsBaseline(contrato) });
  const efe = renderizarSpecs(doc, { perfiles: perfilesDe(contrato), vars: varsEfectivas(contrato) });
  const out = {};
  for (const [svc, r] of Object.entries(efe)) {
    if (base[svc]?.imagen !== r.imagen) out[svc] = { imagen: r.imagen, tag: etiquetaDe(r.imagen) };
  }
  return { base, efectivo: efe, overrides: out };
}

// ── Informe VISIBLE ──────────────────────────────────────────────────────────

/**
 * El formato es literal y no se adorna: es el que el operador lee para
 * responder «¿qué se va a desplegar de verdad?». `EFFECTIVE` lista TODOS los
 * servicios de aplicación, con override y sin él, porque un listado que sólo
 * enseñara las excepciones obligaría a deducir el resto — y deducir es
 * exactamente donde se cuela «el .env dice X pero el runtime es otra cosa».
 */
export function informe(contrato, doc) {
  const { efectivo, overrides } = overridesConEfecto(contrato, doc);
  const tagGlobal = contrato?.entorno?.[contrato?.overrides_de_version?.variable_global ?? "TAG"] ?? "(sin declarar)";
  const declarados = Object.keys(contrato?.overrides_de_version?.variables_por_servicio ?? {}).filter(
    (s) => efectivo[s],
  );
  const ancho = Math.max(20, ...declarados.map((s) => s.length + 2));
  const fila = (s, v) => `  ${s.padEnd(ancho - 2)}  ${v}`;

  const out = [`GLOBAL TAG        ${tagGlobal}`];
  out.push("OVERRIDES:");
  const conOverride = Object.keys(overrides).sort();
  if (conOverride.length === 0) out.push("  (ninguno · el stack corre un único TAG)");
  for (const s of conOverride) out.push(fila(s, overrides[s].tag));
  out.push("EFFECTIVE:");
  for (const s of declarados.sort()) out.push(fila(s, etiquetaDe(efectivo[s].imagen)));
  return out.join("\n");
}

// ── G1 · patrón uniforme, por efecto ─────────────────────────────────────────

export function verificarPatron(contrato, doc) {
  const fallos = [];
  const mapa = contrato?.overrides_de_version?.variables_por_servicio ?? {};
  const global = contrato?.overrides_de_version?.variable_global ?? "TAG";
  if (Object.keys(mapa).length === 0)
    return {
      ok: false,
      fallos: [
        {
          codigo: CODIGOS.OVERRIDES_NO_DECLARADOS,
          detalle:
            "el contrato no declara `overrides_de_version.variables_por_servicio`: sin declaración no hay nada que comprobar, y no comprobado no es aprobado",
        },
      ],
    };

  const varsBase = { ...varsBaseline(contrato), [global]: CENTINELA_GLOBAL };
  const conGlobal = renderizarSpecs(doc, { perfiles: perfilesDe(contrato), vars: varsBase });

  for (const [svc, variable] of Object.entries(mapa)) {
    if (!conGlobal[svc]) {
      fallos.push({
        codigo: CODIGOS.SERVICIO_NO_RENDERIZA,
        detalle: `${svc}: declarado en variables_por_servicio pero el perfil no lo renderiza; una declaración que no se puede ejercer no es una garantía`,
      });
      continue;
    }
    // Mitad A · sin su variable, SIGUE A TAG. Es la que distingue a los de
    // aplicación de `backup`, y la que se rompería al "unificar" hacia el
    // patrón del bloque de copia.
    if (etiquetaDe(conGlobal[svc].imagen) !== CENTINELA_GLOBAL)
      fallos.push({
        codigo: CODIGOS.NO_SIGUE_A_TAG,
        detalle: `${svc}: con ${global}=${CENTINELA_GLOBAL} y sin ${variable} renderiza "${conGlobal[svc].imagen}"; un servicio de aplicación DEBE seguir al TAG global (es «backup», y sólo «backup», el que no lo sigue)`,
      });

    // Mitad B · con su variable, la obedece. Sin esta mitad, un servicio
    // cableado a `${TAG}` pasaría la mitad A y el override sería mentira.
    const conSuya = renderizarSpecs(doc, {
      perfiles: perfilesDe(contrato),
      vars: { ...varsBase, [variable]: CENTINELA_SERVICIO },
    });
    if (etiquetaDe(conSuya[svc].imagen) !== CENTINELA_SERVICIO)
      fallos.push({
        codigo: CODIGOS.NO_OBEDECE_A_SU_VARIABLE,
        detalle: `${svc}: con ${variable}=${CENTINELA_SERVICIO} renderiza "${conSuya[svc].imagen}": la variable no tiene efecto, el override sería una creencia`,
      });
  }
  return { ok: fallos.length === 0, fallos };
}

// ── G2 y G3 · aislamiento y "sólo la imagen" ─────────────────────────────────

/**
 * Diferencias entre dos renders, separadas en DOS ejes que nunca se colapsan:
 * imágenes cambiadas y specs cambiadas en algo que NO es la imagen. Colapsarlos
 * en un "cambió algo" haría indistinguible el override que queremos del
 * override que arrastra media configuración.
 */
export function compararRenders(a, b) {
  const servicios = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const imagenes = [];
  const specs = [];
  const soloEnUno = [];
  for (const s of servicios) {
    if (!a[s] || !b[s]) {
      soloEnUno.push(s);
      continue;
    }
    if (a[s].imagen !== b[s].imagen) imagenes.push({ service: s, de: a[s].imagen, a: b[s].imagen });
    const ja = JSON.stringify(a[s].resto);
    const jb = JSON.stringify(b[s].resto);
    if (ja !== jb) specs.push({ service: s, de: ja, a: jb });
  }
  return {
    changed_images: imagenes.length,
    imagenes,
    changed_specs_other_than_image: specs.length,
    specs,
    conjunto_distinto: soloEnUno,
  };
}

export function verificarAislamiento(contrato, doc) {
  const fallos = [];
  const mapa = contrato?.overrides_de_version?.variables_por_servicio ?? {};
  const compartidas = contrato?.overrides_de_version?.variables_compartidas ?? {};
  const global = contrato?.overrides_de_version?.variable_global ?? "TAG";
  const varsBase = { ...varsBaseline(contrato), [global]: CENTINELA_GLOBAL };
  const base = renderizarSpecs(doc, { perfiles: perfilesDe(contrato), vars: varsBase });

  for (const [svc, variable] of Object.entries(mapa)) {
    if (!base[svc]) continue;
    // Compañeros LEGÍTIMOS: los que comparten variable Y están declarados como
    // tal. Sin la segunda condición, cualquier arrastre podría justificarse a
    // posteriori diciendo "es que comparten variable".
    const compañeros = compartidas[variable]
      ? Object.entries(mapa)
          .filter(([o, v]) => v === variable && o !== svc)
          .map(([o]) => o)
      : [];
    const con = renderizarSpecs(doc, {
      perfiles: perfilesDe(contrato),
      vars: { ...varsBase, [variable]: CENTINELA_SERVICIO },
    });
    const d = compararRenders(base, con);
    const esperados = new Set([svc, ...compañeros]);
    for (const cambio of d.imagenes) {
      if (esperados.has(cambio.service)) continue;
      fallos.push({
        codigo: CODIGOS.ARRASTRA_A_OTRO_SERVICIO,
        detalle: `${variable} (override de ${svc}) también cambia la imagen de ${cambio.service}: ${cambio.de} → ${cambio.a}. Un override que arrastra a otro servicio no es selectivo`,
      });
    }
    for (const cambio of d.specs) {
      fallos.push({
        codigo: CODIGOS.CAMBIA_SPEC_NO_IMAGEN,
        detalle: `${variable} (override de ${svc}) cambia algo de la spec de ${cambio.service} que NO es la imagen: una recreación cambiaría más de lo que nadie decidió`,
      });
    }
  }
  return { ok: fallos.length === 0, fallos };
}

// ── G4 · visibilidad ─────────────────────────────────────────────────────────

export function verificarVisibilidad(contrato, doc) {
  const fallos = [];
  const { overrides } = overridesConEfecto(contrato, doc);
  const activos = contrato?.overrides_de_version?.activos ?? {};

  for (const [svc, info] of Object.entries(overrides)) {
    const decl = activos[svc];
    if (!decl) {
      fallos.push({
        codigo: CODIGOS.OVERRIDE_NO_DECLARADO,
        detalle: `${svc}: el entorno del contrato lo desplaza a "${info.tag}" y «overrides_de_version.activos» no lo declara. Esto es exactamente «el .env dice X pero el runtime es otra cosa»: un override sin declarar es estado invisible`,
      });
      continue;
    }
    if (decl.tag !== info.tag)
      fallos.push({
        codigo: CODIGOS.OVERRIDE_TAG_DISTINTO,
        detalle: `${svc}: declarado como "${decl.tag}" y el render produce "${info.tag}"; la declaración describe otro despliegue`,
      });
  }

  // Mitad simétrica: un override DECLARADO que no tiene efecto haría creer que
  // se desplegó algo que no se desplegó. La ausencia de efecto es tan grave
  // como el efecto no declarado, y por eso tiene código propio.
  for (const svc of Object.keys(activos)) {
    if (!overrides[svc])
      fallos.push({
        codigo: CODIGOS.OVERRIDE_DECLARADO_SIN_EFECTO,
        detalle: `${svc}: declarado en activos pero el render no lo desplaza de la línea base; la declaración es falsa`,
      });
  }
  return { ok: fallos.length === 0, fallos, overrides };
}

// ── G5 · separación semántica con `backup` ───────────────────────────────────

/**
 * Las dos direcciones. La primera NO se reimplementa: es la garantía G6 de
 * `backup-stack-gate.mjs` (`TAG_GLOBAL_ARRASTRA_BACKUP`), que ya la comprueba
 * por efecto con un TAG centinela; se invoca y se traduce su fallo. La segunda
 * es la simétrica, que allí no existe porque allí no había overrides.
 */
export function verificarSeparacion(contrato, doc) {
  const fallos = [];

  const bk = verificarBackup(contrato, doc);
  for (const f of bk.fallos ?? []) {
    if (f.codigo !== "TAG_GLOBAL_ARRASTRA_BACKUP") continue;
    fallos.push({
      codigo: CODIGOS.BACKUP_SIGUE_A_TAG,
      detalle: `${f.detalle} — «backup» es un bloque APARTE: no anida «TAG» a propósito (#139). Si alguien lo "unificó" con los de aplicación, deshágalo`,
    });
  }

  // Simétrica: mover BACKUP_TAG no puede mover a los de aplicación.
  const varBackup = contrato?.bloques?.BACKUP_STACK?.variable_de_version ?? "BACKUP_TAG";
  const base = renderizarSpecs(doc, { perfiles: perfilesDe(contrato), vars: varsEfectivas(contrato) });
  const con = renderizarSpecs(doc, {
    perfiles: perfilesDe(contrato),
    vars: { ...varsEfectivas(contrato), [varBackup]: CENTINELA_SERVICIO },
  });
  const d = compararRenders(base, con);
  for (const cambio of d.imagenes)
    fallos.push({
      codigo: CODIGOS.BACKUP_TAG_ARRASTRA_APP,
      detalle: `mover ${varBackup} cambia la imagen de ${cambio.service} (${cambio.de} → ${cambio.a}): alinear la copia recrearía servicios de aplicación`,
    });

  return { ok: fallos.length === 0, fallos };
}

// ── G6 · el objetivo declarado es el que sale del render ─────────────────────

export function verificarObjetivo(contrato, doc) {
  const fallos = [];
  const efe = renderizarSpecs(doc, { perfiles: perfilesDe(contrato), vars: varsEfectivas(contrato) });
  for (const [svc, esperada] of Object.entries(contrato?.imagenes_esperadas ?? {})) {
    if (!efe[svc]) continue;
    if (efe[svc].imagen !== esperada)
      fallos.push({
        codigo: CODIGOS.IMAGEN_OBJETIVO_DISTINTA,
        detalle: `${svc}: el render produce "${efe[svc].imagen}" y el contrato declara "${esperada}"`,
      });
  }
  return { ok: fallos.length === 0, fallos };
}

// ── Verificación completa ────────────────────────────────────────────────────

export function verificar(contrato, doc) {
  if (!contrato?.overrides_de_version)
    return {
      ok: false,
      fallos: [
        {
          codigo: CODIGOS.OVERRIDES_NO_DECLARADOS,
          detalle: "el contrato no declara `overrides_de_version`: no comprobado no es aprobado",
        },
      ],
      garantias: {},
    };
  const g1 = verificarPatron(contrato, doc);
  const g23 = verificarAislamiento(contrato, doc);
  const g4 = verificarVisibilidad(contrato, doc);
  const g5 = verificarSeparacion(contrato, doc);
  const g6 = verificarObjetivo(contrato, doc);
  const fallos = [...g1.fallos, ...g23.fallos, ...g4.fallos, ...g5.fallos, ...g6.fallos];
  return {
    ok: fallos.length === 0,
    fallos,
    garantias: { patron: g1, aislamiento: g23, visibilidad: g4, separacion: g5, objetivo: g6 },
  };
}

// ── GATE de recreación ───────────────────────────────────────────────────────

/**
 * Línea base contra objetivo, con el criterio de parada del encargo. Lo
 * esperado NO está cableado: sale de `activos`, así que un override distinto
 * del declarado no puede pasar por aquí.
 */
export function gateRecreacion(contrato, doc) {
  const activos = contrato?.overrides_de_version?.activos ?? {};
  const compartidas = contrato?.overrides_de_version?.variables_compartidas ?? {};
  const mapa = contrato?.overrides_de_version?.variables_por_servicio ?? {};

  // Servicios que el contrato dice que van a cambiar: los declarados, más los
  // que comparten variable con alguno de ellos (declarado en
  // `variables_compartidas`). Si `bot-manager` se adelantara, `bot-build-worker`
  // cambia también y el gate lo espera; no se le cuela por ser "el mismo".
  const esperados = new Set();
  for (const svc of Object.keys(activos)) {
    esperados.add(svc);
    const v = mapa[svc];
    if (!v || !compartidas[v]) continue;
    for (const [o, vo] of Object.entries(mapa)) if (vo === v) esperados.add(o);
  }

  const base = renderizarSpecs(doc, { perfiles: perfilesDe(contrato), vars: varsBaseline(contrato) });
  const objetivo = renderizarSpecs(doc, { perfiles: perfilesDe(contrato), vars: varsEfectivas(contrato) });
  const d = compararRenders(base, objetivo);

  const fallos = [];
  if (d.changed_images !== esperados.size)
    fallos.push({
      codigo: CODIGOS.GATE_IMAGENES_CAMBIADAS,
      detalle: `changed_images=${d.changed_images} y el contrato declara ${esperados.size} (${[...esperados].sort().join(",")})`,
    });
  for (const c of d.imagenes) {
    if (esperados.has(c.service)) continue;
    fallos.push({
      codigo: CODIGOS.GATE_SERVICIO_INESPERADO,
      detalle: `cambia ${c.service} (${c.de} → ${c.a}) y no está declarado: STOP`,
    });
  }
  for (const c of d.specs)
    fallos.push({
      codigo: CODIGOS.GATE_SPEC_NO_IMAGEN,
      detalle: `${c.service}: cambia la spec en algo que NO es la imagen. Sólo es admisible si viene de «main» y está AUDITADO uno a uno; agrupado, no`,
    });
  if (d.conjunto_distinto.length > 0)
    fallos.push({
      codigo: CODIGOS.GATE_SERVICIO_INESPERADO,
      detalle: `el conjunto de servicios difiere entre los dos renders: {${d.conjunto_distinto.join(",")}}`,
    });

  return { ok: fallos.length === 0, fallos, diff: d, esperados: [...esperados].sort() };
}

/**
 * El comando de recreación, generado DESDE el contrato (no puede divergir de
 * él). `--no-build` porque `build.context: ..` se resuelve contra
 * `--project-directory` y con el de producción construiría el ÁRBOL
 * EQUIVOCADO —el incidente original del proyecto—; `--no-deps` porque
 * `depends_on` alcanza a `postgres`, que es NO RESTART, y a `queue`, que este
 * carril no toca.
 */
export function invocacion(contrato, { directorioProyecto = null } = {}) {
  const svcs = Object.keys(contrato?.overrides_de_version?.activos ?? {}).sort();
  const entorno = Object.entries(contrato?.entorno ?? {})
    .filter(([k]) => k !== (contrato?.bloques?.BACKUP_STACK?.variable_de_version ?? "BACKUP_TAG"))
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  const argv = ["docker", "compose"];
  if (directorioProyecto) argv.push("--project-directory", directorioProyecto);
  argv.push("-p", contrato?.proyecto ?? "infrastructure");
  for (const f of contrato?.compose_files ?? []) argv.push("-f", f);
  argv.push("--profile", ...(contrato?.perfiles ?? []));
  argv.push("up", "-d", "--no-build", "--no-deps", ...svcs);
  return `${entorno.join(" ")} ${argv.join(" ")}`.trim();
}

// ── Carga ────────────────────────────────────────────────────────────────────

export function cargar(rutaContrato, rutaCompose) {
  for (const [r, q] of [
    [rutaContrato, "contrato"],
    [rutaCompose, "compose"],
  ]) {
    if (!existsSync(r)) {
      const e = new Error(`${q} ausente: ${r}`);
      e.rc = 2;
      throw e;
    }
  }
  return {
    contrato: JSON.parse(readFileSync(rutaContrato, "utf8")),
    doc: parse(readFileSync(rutaCompose, "utf8"), { merge: true }),
  };
}

// ── Autoprueba ───────────────────────────────────────────────────────────────

const COMPOSE_FALSO = () => ({
  services: {
    api: {
      profiles: ["development", "production"],
      image: "s9arena/api:${API_TAG:-${TAG:-latest}}",
      environment: { PORT: "3000" },
    },
    worker: {
      profiles: ["development", "production"],
      image: "s9arena/worker:${WORKER_TAG:-${TAG:-latest}}",
      environment: { PORT: "3001" },
    },
    backup: { profiles: ["production"], image: "s9arena/backup:${BACKUP_TAG:-latest}" },
  },
});

const CONTRATO_FALSO = () => ({
  proyecto: "infra",
  compose_files: ["c.yml"],
  perfiles: ["development"],
  perfiles_rechazados: { production: "arrastra backup" },
  entorno: { TAG: "base", WORKER_TAG: "nueva", BACKUP_TAG: "bk" },
  servicios_esperados: ["api", "worker"],
  gestionados_aparte: { backup: "ventana propia" },
  bloques: {
    total_esperado: 3,
    APP_STACK: { modo: "perfil", perfil: "development", n_esperado: 2 },
    BACKUP_STACK: {
      modo: "servicio_explicito",
      servicios: ["backup"],
      n_esperado: 1,
      perfil_de_render: "production",
      flags_obligatorias: ["--no-build", "--no-deps"],
      variable_de_version: "BACKUP_TAG",
      imagen_esperada: "s9arena/backup:bk",
    },
  },
  overrides_de_version: {
    variable_global: "TAG",
    variables_por_servicio: { api: "API_TAG", worker: "WORKER_TAG" },
    variables_compartidas: {},
    activos: { worker: { variable: "WORKER_TAG", tag: "nueva" } },
  },
  imagenes_esperadas: { api: "s9arena/api:base", worker: "s9arena/worker:nueva" },
});

/**
 * Cada caso es una MUTACIÓN de lo sano que tiene que morir. Un gate cuyas
 * garantías no se han visto rojas no es un gate, es una afirmación.
 */
export const CASOS_NEGATIVOS = Object.freeze([
  {
    nombre: "un override que ARRASTRA a otro servicio",
    mutar: ({ doc }) => {
      doc.services.api.image = "s9arena/api:${WORKER_TAG:-${TAG:-latest}}";
    },
    codigo: CODIGOS.ARRASTRA_A_OTRO_SERVICIO,
  },
  {
    nombre: "un override INVISIBLE para el verificador (con efecto, sin declarar)",
    mutar: ({ contrato }) => {
      delete contrato.overrides_de_version.activos.worker;
    },
    codigo: CODIGOS.OVERRIDE_NO_DECLARADO,
  },
  {
    nombre: "un override declarado SIN efecto (declaración muerta)",
    mutar: ({ contrato }) => {
      contrato.entorno.WORKER_TAG = contrato.entorno.TAG;
      contrato.imagenes_esperadas.worker = "s9arena/worker:base";
    },
    codigo: CODIGOS.OVERRIDE_DECLARADO_SIN_EFECTO,
  },
  {
    nombre: "el override cambia algo de la spec que NO es la imagen",
    mutar: ({ doc }) => {
      doc.services.worker.environment.PORT = "${WORKER_TAG:-3001}";
    },
    codigo: CODIGOS.CAMBIA_SPEC_NO_IMAGEN,
  },
  {
    nombre: "un servicio de aplicación que deja de seguir a TAG (unificado hacia `backup`)",
    mutar: ({ doc }) => {
      doc.services.api.image = "s9arena/api:${API_TAG:-latest}";
    },
    codigo: CODIGOS.NO_SIGUE_A_TAG,
  },
  {
    nombre: "`backup` unificado hacia los de aplicación (pasa a seguir a TAG)",
    mutar: ({ doc }) => {
      doc.services.backup.image = "s9arena/backup:${BACKUP_TAG:-${TAG:-latest}}";
    },
    codigo: CODIGOS.BACKUP_SIGUE_A_TAG,
  },
  {
    nombre: "BACKUP_TAG arrastrando a un servicio de aplicación",
    mutar: ({ doc }) => {
      doc.services.api.image = "s9arena/api:${BACKUP_TAG:-${TAG:-latest}}";
    },
    codigo: CODIGOS.BACKUP_TAG_ARRASTRA_APP,
  },
  {
    nombre: "una variable de override sin efecto (el compose la ignora)",
    mutar: ({ doc }) => {
      doc.services.api.image = "s9arena/api:${TAG:-latest}";
    },
    codigo: CODIGOS.NO_OBEDECE_A_SU_VARIABLE,
  },
  {
    nombre: "el objetivo declarado no es el que sale del render",
    mutar: ({ contrato }) => {
      contrato.imagenes_esperadas.worker = "s9arena/worker:otra";
    },
    codigo: CODIGOS.IMAGEN_OBJETIVO_DISTINTA,
  },
]);

export function autoprueba() {
  const fallos = [];
  const ok = (cond, msg) => {
    if (!cond) fallos.push(msg);
  };

  // Calibración de la interpolación anidada contra la tabla medida en el
  // anfitrión real. Si esto se rompe, todo lo demás mide otra cosa.
  for (const c of CASOS_CALIBRACION) {
    const r = interpolar(c.texto, c.vars);
    ok(r === c.esperado, `CALIBRACIÓN: ${c.texto} con ${JSON.stringify(c.vars)} → "${r}" (esperado "${c.esperado}")`);
  }
  console.log(`OK   calibración de la interpolación anidada (${CASOS_CALIBRACION.length} casos)`);

  // CONTROL POSITIVO: lo sano sale verde. Sin él, un gate que dijera "rojo"
  // siempre pasaría todas las mutaciones sin comprobar nada.
  const sano = verificar(CONTRATO_FALSO(), COMPOSE_FALSO());
  ok(sano.ok, `control POSITIVO falló: ${sano.fallos.map((f) => f.codigo).join(",")}`);
  console.log(`OK   control POSITIVO · el mecanismo sano sale verde`);

  const g = gateRecreacion(CONTRATO_FALSO(), COMPOSE_FALSO());
  ok(g.ok, `gate sobre lo sano falló: ${g.fallos.map((f) => f.codigo).join(",")}`);
  ok(g.diff.changed_images === 1, `gate: changed_images=${g.diff.changed_images}, esperado 1`);
  ok(
    g.diff.changed_specs_other_than_image === 0,
    `gate: changed_specs_other_than_image=${g.diff.changed_specs_other_than_image}, esperado 0`,
  );
  console.log("OK   control POSITIVO · gate: changed_images=1 · changed_specs_other_than_image=0");

  // El informe tiene que ENSEÑAR el override: un verificador que no lo imprime
  // deja el estado invisible aunque el gate esté verde.
  const txt = informe(CONTRATO_FALSO(), COMPOSE_FALSO());
  ok(/^GLOBAL TAG\s+base$/m.test(txt), "el informe no declara el TAG global");
  ok(/^OVERRIDES:$/m.test(txt) && /worker\s+nueva/.test(txt), "el informe no enseña el override activo");
  ok(/^EFFECTIVE:$/m.test(txt) && /api\s+base/.test(txt), "el informe no enseña la etiqueta efectiva de cada servicio");
  console.log("OK   control POSITIVO · el informe hace VISIBLE el override");

  // CONTROLES NEGATIVOS.
  for (const caso of CASOS_NEGATIVOS) {
    const contrato = CONTRATO_FALSO();
    const doc = COMPOSE_FALSO();
    caso.mutar({ contrato, doc });
    const r = verificar(contrato, doc);
    const codigos = r.fallos.map((f) => f.codigo);
    const cazado = codigos.includes(caso.codigo);
    ok(
      cazado,
      `control NEGATIVO NO cazado (${caso.nombre}): se esperaba ${caso.codigo} y salió [${codigos.join(",")}]`,
    );
    console.log(`${cazado ? "OK  " : "FALLO"} ${caso.nombre} → ${caso.codigo}`);
  }

  // El gate de recreación también tiene que saber ponerse rojo, y por su propio
  // código: que `verificar` cace algo no significa que el gate pare.
  const c2 = CONTRATO_FALSO();
  const d2 = COMPOSE_FALSO();
  d2.services.api.image = "s9arena/api:${WORKER_TAG:-${TAG:-latest}}";
  const g2 = gateRecreacion(c2, d2);
  ok(
    !g2.ok && g2.fallos.some((f) => f.codigo === CODIGOS.GATE_SERVICIO_INESPERADO),
    "el gate NO para ante un segundo servicio cambiado",
  );
  console.log("OK   el gate para ante un servicio inesperado → GATE_SERVICIO_INESPERADO");

  const c3 = CONTRATO_FALSO();
  const d3 = COMPOSE_FALSO();
  d3.services.worker.environment.PORT = "${WORKER_TAG:-3001}";
  const g3 = gateRecreacion(c3, d3);
  ok(
    !g3.ok && g3.fallos.some((f) => f.codigo === CODIGOS.GATE_SPEC_NO_IMAGEN),
    "el gate NO para ante un cambio de spec que no es la imagen",
  );
  console.log("OK   el gate para ante spec != imagen → GATE_SPEC_NO_IMAGEN");

  // MUTACIÓN DEL PROPIO MÉTODO: comparar imágenes por NOMBRE en vez de por
  // efecto del render. Se simula un gate que sólo mira el texto del YAML;
  // tiene que dar un resultado DISTINTO del real, o el método no aporta nada.
  const cN = CONTRATO_FALSO();
  const dN = COMPOSE_FALSO();
  const porTexto = new Set(Object.values(dN.services).map((s) => s.image));
  ok(
    porTexto.size === 3 && [...porTexto].every((s) => s.includes("${")),
    "la mutación por nombre no está construida como se cree",
  );
  const porEfecto = renderizarSpecs(dN, { perfiles: ["development"], vars: varsEfectivas(cN) });
  ok(
    Object.values(porEfecto).every((s) => !String(s.imagen).includes("${")),
    "comparar por EFECTO del render no resuelve las interpolaciones: el método no distingue del de texto",
  );
  console.log("OK   comparar por EFECTO del render != comparar por nombre en el YAML");

  if (fallos.length > 0) {
    console.error("\nAUTOPRUEBA ROJA");
    for (const f of fallos) console.error(`  · ${f}`);
    return 1;
  }
  console.log("\nAUTOPRUEBA VERDE · las seis garantías y el gate saben ponerse rojos");
  return 0;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function arg(argv, nombre, porDefecto) {
  const i = argv.indexOf(nombre);
  return i >= 0 ? argv[i + 1] : porDefecto;
}

export function main(argv) {
  if (argv.includes("--self-test")) return autoprueba();

  let contrato;
  let doc;
  try {
    ({ contrato, doc } = cargar(
      arg(argv, "--contrato", CONTRATO_POR_DEFECTO),
      arg(argv, "--compose", COMPOSE_POR_DEFECTO),
    ));
  } catch (e) {
    console.error(`NO COMPROBADO · ${e.message}`);
    return e.rc ?? 2;
  }

  if (argv.includes("--invocacion")) {
    console.log(invocacion(contrato, { directorioProyecto: arg(argv, "--project-directory", null) }));
    return 0;
  }

  const r = verificar(contrato, doc);
  const g = argv.includes("--gate") ? gateRecreacion(contrato, doc) : null;

  if (argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          schema: "s9-ai-arena/tag-override-gate/v1",
          global_tag: contrato?.entorno?.[contrato?.overrides_de_version?.variable_global ?? "TAG"] ?? null,
          overrides: r.garantias?.visibilidad?.overrides ?? {},
          ok: r.ok && (g ? g.ok : true),
          fallos: [...r.fallos, ...(g?.fallos ?? [])],
          gate: g
            ? {
                changed_images: g.diff.changed_images,
                changed_specs_other_than_image: g.diff.changed_specs_other_than_image,
                servicios: g.diff.imagenes.map((x) => x.service),
                esperados: g.esperados,
              }
            : null,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(informe(contrato, doc));
    console.log("");
    if (g) {
      console.log("GATE DE RECREACIÓN (línea base vs objetivo)");
      console.log(`  changed_images                  ${g.diff.changed_images}`);
      for (const c of g.diff.imagenes) console.log(`    service                       ${c.service}  ${c.de} → ${c.a}`);
      console.log(`  changed_specs_other_than_image  ${g.diff.changed_specs_other_than_image}`);
      for (const c of g.diff.specs) console.log(`    spec                          ${c.service}`);
      console.log("");
    }
    const todos = [...r.fallos, ...(g?.fallos ?? [])];
    if (todos.length === 0) {
      console.log("VERDE · el override es selectivo, visible y no toca nada más");
    } else {
      console.log("ROJO");
      for (const f of todos) console.log(`  · ${f.codigo}: ${f.detalle}`);
    }
  }
  return r.ok && (g ? g.ok : true) ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
