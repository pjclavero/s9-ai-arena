#!/usr/bin/env node
/**
 * CONTRATO DE LOS DOS BLOQUES · APP_STACK y BACKUP_STACK.
 *
 * Qué problema resuelve, medido y no supuesto:
 *
 *   El servicio `backup` lleva `profiles: [production, external-db]`. El bloque
 *   de aplicación se despliega con `development`. Medido hoy contra el compose
 *   real (`docker compose config --services`):
 *
 *       development   11 servicios   (sin backup)
 *       production    12 servicios   (con backup)
 *       external-db   11 servicios   (con backup, sin postgres)
 *       (sin perfil)   0 servicios
 *
 *   Es decir: **elegir un perfil un poco más ancho arranca la copia de
 *   seguridad**. `backup` corre cron dentro del contenedor, escribe en un
 *   repositorio restic remoto y tiene ventana propia (04:15 UTC); recrearlo de
 *   rebote durante un `up` rutinario del stack es un efecto que nadie decidió.
 *
 * Por eso el contrato declara DOS BLOQUES SEPARADOS y este gate los verifica:
 *
 *   APP_STACK     modo perfil              perfil `development`      11 servicios
 *   BACKUP_STACK  modo servicio explícito  `backup`, --no-deps        1 servicio
 *   TOTAL ESPERADO                                                   12
 *
 * Las cinco garantías, cada una con su código propio (nunca un booleano suelto:
 * "el conjunto no cuadra" y "el perfil elegido arrastra backup" son defectos
 * DISTINTOS y se informan por separado):
 *
 *   G1 APP_CONJUNTO      el perfil de APP_STACK renderiza EXACTAMENTE
 *                        `servicios_esperados` (igualdad de conjuntos, no
 *                        tamaño) y son `n_esperado`.
 *   G2 BACKUP_CONJUNTO   BACKUP_STACK es exactamente el conjunto de
 *                        `gestionados_aparte`, `n_esperado` servicios, y su
 *                        perfil de render lo renderiza de verdad (control
 *                        POSITIVO: un bloque que no renderiza nada no es un
 *                        bloque, es una declaración muerta).
 *   G3 TOTAL             total_esperado == |APP| + |BACKUP|, y los dos bloques
 *                        son DISJUNTOS.
 *   G4 CONTAMINACIÓN     ningún servicio de BACKUP_STACK aparece en el render
 *                        de APP_STACK, y **todo perfil del compose que
 *                        renderice un servicio de BACKUP_STACK está declarado
 *                        en `perfiles_rechazados`** (o es el propio perfil de
 *                        render del bloque de copia). Esta segunda mitad es la
 *                        que impide la regresión: añadir mañana `development` a
 *                        `profiles:` de `backup`, o inventar un perfil ancho
 *                        nuevo, pone el gate ROJO.
 *   G5 FLAGS             BACKUP_STACK declara `--no-build` y `--no-deps`.
 *                        `--no-build` porque `build.context: ..` se resuelve
 *                        contra `--project-directory`, y con el de producción
 *                        construye el ÁRBOL EQUIVOCADO (ADR-016, incidente 1).
 *                        `--no-deps` porque `depends_on` apunta a postgres, que
 *                        es NO RESTART.
 *
 * El renderizador NO se reimplementa aquí: se importa el de
 * `deploy-contract-gate.mjs` (#138), que ya está calibrado contra la salida
 * real de `docker compose config --services` por perfil. Dos renderizadores
 * serían dos verdades.
 *
 * Uso:
 *   node infrastructure/scripts/backup-stack-gate.mjs --self-test
 *       Controles positivos y negativos de las cinco garantías, offline.
 *   node infrastructure/scripts/backup-stack-gate.mjs [--contrato F] [--compose F] [--json]
 *   node infrastructure/scripts/backup-stack-gate.mjs --invocacion
 *       Imprime las DOS invocaciones (bloque de aplicación y bloque de copia).
 *
 * rc=0 todo verde · rc=1 alguna garantía roja · rc=2 no se pudo comprobar
 * (contrato o compose ausentes/ilegibles). La ausencia NUNCA es aprobado.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { renderizar } from "./deploy-contract-gate.mjs";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONTRATO_POR_DEFECTO = join(RAIZ, "infrastructure", "deploy-contract.json");
const COMPOSE_POR_DEFECTO = join(RAIZ, "infrastructure", "docker-compose.yml");

export const FLAGS_OBLIGATORIAS = Object.freeze(["--no-build", "--no-deps"]);

export const CODIGOS = Object.freeze({
  BLOQUES_NO_DECLARADOS: "BLOQUES_NO_DECLARADOS",
  APP_CONJUNTO_DISTINTO: "APP_CONJUNTO_DISTINTO",
  APP_VACIO: "APP_VACIO",
  APP_CARDINAL_DISTINTO: "APP_CARDINAL_DISTINTO",
  BACKUP_CONJUNTO_DISTINTO: "BACKUP_CONJUNTO_DISTINTO",
  BACKUP_CARDINAL_DISTINTO: "BACKUP_CARDINAL_DISTINTO",
  BACKUP_NO_RENDERIZA: "BACKUP_NO_RENDERIZA",
  BLOQUES_SOLAPAN: "BLOQUES_SOLAPAN",
  TOTAL_DISTINTO: "TOTAL_DISTINTO",
  CONTAMINACION_APP: "CONTAMINACION_APP",
  PERFIL_ANCHO_NO_DECLARADO: "PERFIL_ANCHO_NO_DECLARADO",
  FLAG_OBLIGATORIA_AUSENTE: "FLAG_OBLIGATORIA_AUSENTE",
});

const conjunto = (xs) => [...new Set(xs)].sort();
const mismoConjunto = (a, b) => {
  const A = conjunto(a);
  const B = conjunto(b);
  return A.length === B.length && A.every((x, i) => x === B[i]);
};

/** Servicios del bloque de aplicación: el render del perfil declarado. */
export function renderApp(contrato, doc) {
  const perfil = contrato?.bloques?.APP_STACK?.perfil;
  return conjunto(Object.keys(renderizar(doc, { perfiles: perfil ? [perfil] : [], vars: contrato?.entorno ?? {} })));
}

/** Servicios del bloque de copia: los DECLARADOS, no los que caigan de un perfil. */
export function serviciosBackup(contrato) {
  return conjunto(contrato?.bloques?.BACKUP_STACK?.servicios ?? []);
}

/** Todos los perfiles que menciona el compose, sin inventarse ninguno. */
export function perfilesDelCompose(doc) {
  const vistos = new Set();
  for (const def of Object.values(doc?.services ?? {}))
    for (const p of Array.isArray(def?.profiles) ? def.profiles : []) vistos.add(p);
  return conjunto(vistos);
}

/** G1 · el bloque de aplicación renderiza EXACTAMENTE lo esperado. */
export function verificarApp(contrato, doc) {
  const fallos = [];
  const app = contrato?.bloques?.APP_STACK ?? {};
  const esperados = contrato?.servicios_esperados ?? [];
  const obtenidos = renderApp(contrato, doc);
  if (obtenidos.length === 0)
    fallos.push({
      codigo: CODIGOS.APP_VACIO,
      detalle: `el perfil "${app.perfil ?? "(ninguno)"}" renderiza CERO servicios: comparar contra el conjunto vacío sería un falso verde`,
    });
  else if (!mismoConjunto(obtenidos, esperados))
    fallos.push({
      codigo: CODIGOS.APP_CONJUNTO_DISTINTO,
      detalle: `APP_STACK renderiza {${obtenidos.join(",")}} y el contrato espera {${conjunto(esperados).join(",")}}`,
    });
  if (app.n_esperado !== undefined && obtenidos.length !== app.n_esperado)
    fallos.push({
      codigo: CODIGOS.APP_CARDINAL_DISTINTO,
      detalle: `APP_STACK renderiza ${obtenidos.length} servicios y declara n_esperado=${app.n_esperado}`,
    });
  return { ok: fallos.length === 0, fallos, servicios: obtenidos };
}

/** G2 · el bloque de copia es el declarado, y su perfil lo renderiza de verdad. */
export function verificarBackup(contrato, doc) {
  const fallos = [];
  const bk = contrato?.bloques?.BACKUP_STACK ?? {};
  const declarados = serviciosBackup(contrato);
  const aparte = conjunto(Object.keys(contrato?.gestionados_aparte ?? {}));
  if (!mismoConjunto(declarados, aparte))
    fallos.push({
      codigo: CODIGOS.BACKUP_CONJUNTO_DISTINTO,
      detalle: `BACKUP_STACK declara {${declarados.join(",")}} y gestionados_aparte dice {${aparte.join(",")}}: dos verdades distintas sobre lo mismo`,
    });
  if (bk.n_esperado !== undefined && declarados.length !== bk.n_esperado)
    fallos.push({
      codigo: CODIGOS.BACKUP_CARDINAL_DISTINTO,
      detalle: `BACKUP_STACK tiene ${declarados.length} servicios y declara n_esperado=${bk.n_esperado}`,
    });

  // CONTROL POSITIVO: el perfil de render tiene que producir los servicios del
  // bloque. Un bloque que no renderiza nada no protege nada.
  const render = conjunto(
    Object.keys(
      renderizar(doc, { perfiles: bk.perfil_de_render ? [bk.perfil_de_render] : [], vars: contrato?.entorno ?? {} }),
    ),
  );
  for (const svc of declarados)
    if (!render.includes(svc))
      fallos.push({
        codigo: CODIGOS.BACKUP_NO_RENDERIZA,
        detalle: `el perfil de render "${bk.perfil_de_render ?? "(ninguno)"}" NO renderiza ${svc}: el bloque de copia no se podría desplegar con lo declarado`,
      });

  for (const flag of FLAGS_OBLIGATORIAS)
    if (!(bk.flags_obligatorias ?? []).includes(flag))
      fallos.push({
        codigo: CODIGOS.FLAG_OBLIGATORIA_AUSENTE,
        detalle: `BACKUP_STACK no declara ${flag} como obligatoria`,
      });

  return { ok: fallos.length === 0, fallos, servicios: declarados };
}

/** G3+G4 · total, disjunción y contaminación por perfil ancho. */
export function verificarSeparacion(contrato, doc) {
  const fallos = [];
  const app = renderApp(contrato, doc);
  const bk = serviciosBackup(contrato);
  const total = contrato?.bloques?.total_esperado;

  const solape = bk.filter((s) => app.includes(s));
  if (solape.length > 0)
    fallos.push({
      codigo: CODIGOS.CONTAMINACION_APP,
      detalle: `el perfil de APP_STACK ("${contrato?.bloques?.APP_STACK?.perfil}") arrastra {${solape.join(",")}}: un \`up\` rutinario del stack recrearía la copia fuera de su ventana`,
    });

  // La otra mitad de G4, la que impide la regresión: cualquier perfil del
  // compose que renderice un servicio del bloque de copia tiene que estar
  // DECLARADO como rechazado (o ser el perfil de render del propio bloque).
  const rechazados = new Set(Object.keys(contrato?.perfiles_rechazados ?? {}));
  const perfilDeRender = contrato?.bloques?.BACKUP_STACK?.perfil_de_render;
  for (const perfil of perfilesDelCompose(doc)) {
    if (perfil === perfilDeRender || rechazados.has(perfil)) continue;
    const r = Object.keys(renderizar(doc, { perfiles: [perfil], vars: contrato?.entorno ?? {} }));
    const arrastra = bk.filter((s) => r.includes(s));
    if (arrastra.length > 0)
      fallos.push({
        codigo: CODIGOS.PERFIL_ANCHO_NO_DECLARADO,
        detalle: `el perfil "${perfil}" renderiza {${arrastra.join(",")}} y no está declarado en perfiles_rechazados: elegirlo metería la copia en el bloque de aplicación sin que nadie lo hubiera decidido`,
      });
  }

  if (total !== app.length + bk.length)
    fallos.push({
      codigo: CODIGOS.TOTAL_DISTINTO,
      detalle: `total_esperado=${total} pero |APP_STACK|=${app.length} + |BACKUP_STACK|=${bk.length} = ${app.length + bk.length}`,
    });

  const duplicados = bk.filter((s) => (contrato?.servicios_esperados ?? []).includes(s));
  if (duplicados.length > 0)
    fallos.push({
      codigo: CODIGOS.BLOQUES_SOLAPAN,
      detalle: `{${duplicados.join(",")}} está en los dos bloques a la vez: los bloques deben ser disjuntos`,
    });

  return { ok: fallos.length === 0, fallos, app, backup: bk, total: app.length + bk.length };
}

/** Verificación completa. `bloques` ausente NO es aprobado. */
export function verificar(contrato, doc) {
  if (!contrato?.bloques)
    return {
      ok: false,
      fallos: [
        {
          codigo: CODIGOS.BLOQUES_NO_DECLARADOS,
          detalle:
            "el contrato no declara `bloques`: sin declaración no hay nada que comprobar, y no comprobado no es aprobado",
        },
      ],
      garantias: {},
    };
  const g1 = verificarApp(contrato, doc);
  const g2 = verificarBackup(contrato, doc);
  const g34 = verificarSeparacion(contrato, doc);
  const fallos = [...g1.fallos, ...g2.fallos, ...g34.fallos];
  return { ok: fallos.length === 0, fallos, garantias: { app: g1, backup: g2, separacion: g34 } };
}

// ── Envoltura: las DOS invocaciones ──────────────────────────────────────────

/**
 * Las dos invocaciones que fija el contrato, generadas DESDE el contrato que se
 * verifica (no pueden divergir de él). `directorioProyecto` es el
 * --project-directory de producción; nunca el árbol de construcción.
 */
export function invocaciones(contrato, { directorioProyecto = null, tagBackup = null } = {}) {
  const base = () => {
    const argv = ["docker", "compose"];
    for (const f of contrato.compose_files ?? []) argv.push("-f", f);
    for (const f of contrato.env_files ?? []) argv.push("--env-file", f);
    argv.push("-p", contrato.proyecto);
    if (directorioProyecto) argv.push("--project-directory", directorioProyecto);
    return argv;
  };
  const entornoApp = Object.entries(contrato.entorno ?? {}).map(([k, v]) => `${k}=${v}`);
  const app = [...base(), "--profile", contrato.bloques.APP_STACK.perfil, "up", "-d", "--no-build"];

  const bk = contrato.bloques.BACKUP_STACK;
  const entornoBk = Object.entries({ ...(contrato.entorno ?? {}), ...(tagBackup ? { TAG: tagBackup } : {}) }).map(
    ([k, v]) => `${k}=${v}`,
  );
  const backup = [
    ...base(),
    "--profile",
    bk.perfil_de_render,
    "up",
    "-d",
    ...FLAGS_OBLIGATORIAS,
    "--force-recreate",
    ...bk.servicios,
  ];
  return {
    app: { entorno: entornoApp, argv: app, linea: [...entornoApp, ...app].join(" ") },
    backup: { entorno: entornoBk, argv: backup, linea: [...entornoBk, ...backup].join(" ") },
  };
}

// ── Carga y CLI ──────────────────────────────────────────────────────────────

export function cargar(rutaContrato, rutaCompose) {
  if (!existsSync(rutaContrato)) {
    const e = new Error(`contrato ausente: ${rutaContrato}`);
    e.rc = 2;
    throw e;
  }
  if (!existsSync(rutaCompose)) {
    const e = new Error(`compose ausente: ${rutaCompose}`);
    e.rc = 2;
    throw e;
  }
  return {
    contrato: JSON.parse(readFileSync(rutaContrato, "utf8")),
    doc: parse(readFileSync(rutaCompose, "utf8"), { merge: true }),
  };
}

// ── Autoprueba: cada garantía, en verde y en rojo ────────────────────────────

const COMPOSE_FALSO = {
  services: {
    api: { profiles: ["development", "production"] },
    postgres: { profiles: ["development", "production"] },
    backup: { profiles: ["production", "external-db"] },
  },
};

const CONTRATO_FALSO = {
  proyecto: "infraestructura",
  compose_files: ["c.yml"],
  env_files: [".env"],
  servicios_esperados: ["api", "postgres"],
  perfiles_rechazados: { "": "cero servicios", "external-db": "excluye postgres" },
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
    },
  },
};

const clon = (x) => JSON.parse(JSON.stringify(x));

/** Casos negativos: cada uno DEBE producir su código. */
export const CASOS_NEGATIVOS = Object.freeze([
  {
    nombre: "APP_STACK con un perfil ancho (production) arrastra backup",
    codigo: CODIGOS.CONTAMINACION_APP,
    mutar: (c) => {
      c.bloques.APP_STACK.perfil = "production";
      return c;
    },
  },
  {
    nombre: "backup entra en servicios_esperados (bloques que se solapan)",
    codigo: CODIGOS.BLOQUES_SOLAPAN,
    mutar: (c) => {
      c.servicios_esperados.push("backup");
      return c;
    },
  },
  {
    nombre: "total_esperado deja de cuadrar",
    codigo: CODIGOS.TOTAL_DISTINTO,
    mutar: (c) => {
      c.bloques.total_esperado = 11;
      return c;
    },
  },
  {
    nombre: "APP_STACK sin perfil renderiza CERO servicios",
    codigo: CODIGOS.APP_VACIO,
    mutar: (c) => {
      c.bloques.APP_STACK.perfil = "";
      return c;
    },
  },
  {
    nombre: "BACKUP_STACK declara dos servicios",
    codigo: CODIGOS.BACKUP_CONJUNTO_DISTINTO,
    mutar: (c) => {
      c.bloques.BACKUP_STACK.servicios = ["backup", "postgres"];
      return c;
    },
  },
  {
    nombre: "el perfil de render del bloque de copia no renderiza backup",
    codigo: CODIGOS.BACKUP_NO_RENDERIZA,
    mutar: (c) => {
      c.bloques.BACKUP_STACK.perfil_de_render = "development";
      return c;
    },
  },
  {
    nombre: "BACKUP_STACK olvida --no-deps (postgres es NO RESTART)",
    codigo: CODIGOS.FLAG_OBLIGATORIA_AUSENTE,
    mutar: (c) => {
      c.bloques.BACKUP_STACK.flags_obligatorias = ["--no-build"];
      return c;
    },
  },
  {
    nombre: "el contrato no declara bloques",
    codigo: CODIGOS.BLOQUES_NO_DECLARADOS,
    mutar: (c) => {
      delete c.bloques;
      return c;
    },
  },
]);

/** Caso negativo que muta el COMPOSE, no el contrato: la regresión de verdad. */
export const CASOS_NEGATIVOS_COMPOSE = Object.freeze([
  {
    nombre: "alguien añade `development` a profiles: de backup",
    codigo: CODIGOS.CONTAMINACION_APP,
    mutar: (d) => {
      d.services.backup.profiles = ["development", "production", "external-db"];
      return d;
    },
  },
  {
    nombre: "aparece un perfil ancho nuevo, sin declarar, que incluye backup",
    codigo: CODIGOS.PERFIL_ANCHO_NO_DECLARADO,
    mutar: (d) => {
      for (const svc of Object.values(d.services)) svc.profiles = [...svc.profiles, "todo"];
      return d;
    },
  },
]);

export function autoprueba() {
  const lineas = [];
  let fallo = 0;
  const positivo = verificar(CONTRATO_FALSO, COMPOSE_FALSO);
  lineas.push(`POSITIVO  ${positivo.ok ? "VERDE" : "ROJO"} · contrato coherente (APP 2 + BACKUP 1 = 3)`);
  if (!positivo.ok) {
    fallo = 1;
    for (const f of positivo.fallos) lineas.push(`          ${f.codigo}: ${f.detalle}`);
  }
  for (const caso of CASOS_NEGATIVOS) {
    const r = verificar(caso.mutar(clon(CONTRATO_FALSO)), COMPOSE_FALSO);
    const cazado = r.fallos.some((f) => f.codigo === caso.codigo);
    lineas.push(`NEGATIVO  ${cazado ? "rojo OK" : "SOBREVIVE"} · ${caso.nombre} [${caso.codigo}]`);
    if (!cazado) fallo = 1;
  }
  for (const caso of CASOS_NEGATIVOS_COMPOSE) {
    const r = verificar(CONTRATO_FALSO, caso.mutar(clon(COMPOSE_FALSO)));
    const cazado = r.fallos.some((f) => f.codigo === caso.codigo);
    lineas.push(`NEGATIVO  ${cazado ? "rojo OK" : "SOBREVIVE"} · ${caso.nombre} [${caso.codigo}]`);
    if (!cazado) fallo = 1;
  }
  return { ok: fallo === 0, lineas };
}

function main(argv) {
  const arg = (nombre, def) => {
    const i = argv.indexOf(nombre);
    return i === -1 ? def : argv[i + 1];
  };
  if (argv.includes("--self-test")) {
    const r = autoprueba();
    for (const l of r.lineas) console.log(l);
    return r.ok ? 0 : 1;
  }
  const rutaContrato = arg("--contrato", CONTRATO_POR_DEFECTO);
  const rutaCompose = arg("--compose", COMPOSE_POR_DEFECTO);
  let cargado;
  try {
    cargado = cargar(rutaContrato, rutaCompose);
  } catch (e) {
    console.error(`NO COMPROBADO: ${e.message}`);
    return e.rc ?? 2;
  }
  const { contrato, doc } = cargado;
  if (argv.includes("--invocacion")) {
    const inv = invocaciones(contrato, {
      directorioProyecto: arg("--project-directory", null),
      tagBackup: arg("--tag-backup", null),
    });
    console.log(`APP_STACK     ${inv.app.linea}`);
    console.log(`BACKUP_STACK  ${inv.backup.linea}`);
    return 0;
  }
  const r = verificar(contrato, doc);
  if (argv.includes("--json")) {
    console.log(JSON.stringify(r, null, 2));
    return r.ok ? 0 : 1;
  }
  const g = r.garantias;
  if (g.app)
    console.log(`APP_STACK     perfil "${contrato.bloques.APP_STACK.perfil}" → ${g.app.servicios.length} servicios`);
  if (g.backup)
    console.log(
      `BACKUP_STACK  servicio explícito → ${g.backup.servicios.length} servicio(s): ${g.backup.servicios.join(",")}`,
    );
  if (g.separacion) console.log(`TOTAL         ${g.separacion.total} (esperado ${contrato.bloques.total_esperado})`);
  for (const f of r.fallos) console.log(`ROJO  ${f.codigo}: ${f.detalle}`);
  console.log(r.ok ? "VERDE · los dos bloques cuadran y están separados" : `ROJO · ${r.fallos.length} fallo(s)`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith("backup-stack-gate.mjs")) process.exit(main(process.argv.slice(2)));
