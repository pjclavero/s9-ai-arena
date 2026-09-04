// CONTRATO DE DESPLIEGUE REPRODUCIBLE · suite del gate.
//
// Cada garantía se prueba con control POSITIVO y control NEGATIVO, y el
// renderizador offline se CALIBRA contra la salida real de
// `docker compose config --services` medida por perfil (fixture): si el
// renderizador se apartara de lo que Docker hace, el gate de perfil compararía
// el stack contra una ficción.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
// @ts-expect-error módulo .mjs sin tipos
import {
  CODIGOS,
  STATEFUL_SERVICES,
  analizarReferencia,
  autoprueba,
  cargar,
  interpolar,
  invocacion,
  nivel1Sintaxis,
  nivel2Registro,
  nivel3Version,
  registroInaccesible,
  renderizar,
  resolvedorFalso,
  verificarEstado,
  verificarPerfil,
  verificarPin,
  verificarTag,
} from "../scripts/deploy-contract-gate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(here, "..", "..");
const GATE = join(here, "..", "scripts", "deploy-contract-gate.mjs");
const CONTRATO = join(here, "..", "deploy-contract.json");
const COMPOSE = join(here, "..", "docker-compose.yml");
const medido = JSON.parse(readFileSync(join(here, "fixtures", "compose-profiles-medido.json"), "utf8"));

const DIGEST_1614 = "sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777";
const DIGEST_1615 = "sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685";

const contrato = JSON.parse(readFileSync(CONTRATO, "utf8"));
const doc = parse(readFileSync(COMPOSE, "utf8"), { merge: true });
const pinBueno = {
  servicio: "postgres",
  ref: `postgres:16.14-alpine@${DIGEST_1614}`,
  plataformas: ["linux/amd64"],
  version_esperada: { variable: "PG_VERSION", valor: "16.14" },
};

describe("herramienta ausente != el registro dice que no (ADR-018 aplicado al cliente)", () => {
  // Medido: `node deploy-contract-gate.mjs --registro` sin docker en el PATH
  // devolvía `spawnSync docker ENOENT` y el nivel 2 lo llamaba
  // N2_DIGEST_NO_RESUELVE — «ese digest no existe». Falso: el digest existe y
  // lo que faltaba era el cliente. Las dos siguen bloqueando; confundirlas
  // manda a reconstruir una imagen que no tiene nada malo.
  const ausencias = [
    "spawnSync docker ENOENT",
    "docker: command not found",
    "spawn docker ENOENT: no such file or directory",
  ];
  const negativas = ["manifest unknown", "not found", "unauthorized", "denied"];

  for (const e of ausencias) {
    it(`"${e}" es NO PUDE PREGUNTAR`, () => {
      expect(registroInaccesible(e)).toBe(true);
    });
  }

  for (const e of negativas) {
    it(`"${e}" sigue siendo EL REGISTRO DICE QUE NO`, () => {
      expect(registroInaccesible(e)).toBe(false);
    });
  }

  it("con la herramienta ausente el nivel 2 da N2_REGISTRO_INACCESIBLE, y bloquea igual", () => {
    const resolver = () => ({ fuente: "registro", error: "spawnSync docker ENOENT" });
    const r = nivel2Registro(`postgres:16.14-alpine@${DIGEST_1614}`, resolver);
    expect(r.ok).toBe(false);
    expect(r.codigo).toBe(CODIGOS.N2_REGISTRO_INACCESIBLE);
  });
});

describe("B · gate de referencia de imagen · NIVEL 1 sintaxis", () => {
  it("acepta una referencia con @sha256:<64 hex>", () => {
    expect(nivel1Sintaxis(pinBueno.ref).ok).toBe(true);
  });

  it("rechaza una referencia sin digest", () => {
    const r = nivel1Sintaxis("postgres:16.14-alpine");
    expect(r.ok).toBe(false);
    expect(r.codigo).toBe(CODIGOS.N1_SIN_DIGEST);
  });

  it("rechaza un digest malformado (63 hex, mayúsculas, o no-hex)", () => {
    for (const malo of ["sha256:" + "a".repeat(63), "sha256:" + "A".repeat(64), "sha256:" + "z".repeat(64)]) {
      const r = nivel1Sintaxis(`postgres:16.14-alpine@${malo}`);
      expect(r.ok).toBe(false);
      expect(r.codigo).toBe(CODIGOS.N1_DIGEST_MALFORMADO);
    }
  });

  it("separa repo/etiqueta/digest sin confundir el puerto de un registro con una etiqueta", () => {
    const a = analizarReferencia(`registro.interno:5000/x/y@${DIGEST_1614}`);
    expect(a.repo).toBe("registro.interno:5000/x/y");
    expect(a.etiqueta).toBe(null);
    expect(a.digest).toBe(DIGEST_1614);
  });
});

describe("B · NIVEL 2 registro · la autoridad NO es el almacén local", () => {
  it("un pin correcto pasa cuando la fuente es el registro", () => {
    expect(nivel2Registro(pinBueno.ref, resolvedorFalso(), { plataformas: ["linux/amd64"] }).ok).toBe(true);
  });

  // ESTE es el test que caza el error real: el mismo pin BUENO, con los mismos
  // datos, resuelto contra el almacén local en vez del registro. El almacén
  // local dijo "No such image" para un digest que existe perfectamente.
  it("CAZA la resolución contra el almacén LOCAL aunque los datos sean correctos", () => {
    const r = verificarPin(pinBueno, resolvedorFalso({ fuente: "almacen-local" }));
    expect(r.ok).toBe(false);
    expect(r.fallo.codigo).toBe(CODIGOS.N2_FUENTE_NO_AUTORIZADA);
  });

  it("CAZA un resolvedor que no declara fuente en absoluto", () => {
    const r = verificarPin(pinBueno, () => ({ digest: DIGEST_1614, plataformas: [] }));
    expect(r.ok).toBe(false);
    expect(r.fallo.codigo).toBe(CODIGOS.N2_FUENTE_NO_AUTORIZADA);
  });

  it("rechaza un digest inexistente", () => {
    const r = verificarPin({ ...pinBueno, ref: `postgres:16.14-alpine@sha256:${"0".repeat(64)}` }, resolvedorFalso());
    expect(r.ok).toBe(false);
    expect(r.fallo.codigo).toBe(CODIGOS.N2_DIGEST_NO_RESUELVE);
  });

  it("rechaza la INCOHERENCIA DECLARATIVA: tag 16.15-alpine con digest de 16.14", () => {
    const r = verificarPin({ ...pinBueno, ref: `postgres:16.15-alpine@${DIGEST_1614}` }, resolvedorFalso());
    expect(r.ok).toBe(false);
    expect(r.fallo.codigo).toBe(CODIGOS.N2_ETIQUETA_INCOHERENTE);
  });

  it("rechaza el defecto histórico exacto: tag 16-alpine (hoy 16.15) con digest de 16.14", () => {
    const r = verificarPin({ ...pinBueno, ref: `postgres:16-alpine@${DIGEST_1614}` }, resolvedorFalso());
    expect(r.ok).toBe(false);
    expect(r.fallo.codigo).toBe(CODIGOS.N2_ETIQUETA_INCOHERENTE);
  });

  it("distingue «no pude preguntar» (429 real de Docker Hub) de «no existe», y ninguna de las dos aprueba", () => {
    const resolver = () => ({
      fuente: "registro",
      error: "ERROR: unexpected status from HEAD request ...: 429 Too Many Requests",
    });
    const r = verificarPin(pinBueno, resolver);
    expect(r.ok).toBe(false);
    expect(r.fallo.codigo).toBe(CODIGOS.N2_REGISTRO_INACCESIBLE);
    expect(r.fallo.codigo).not.toBe(CODIGOS.N2_DIGEST_NO_RESUELVE);
  });

  it("rechaza un índice que no publica la plataforma esperada", () => {
    const resolver = () => ({
      fuente: "registro",
      digest: DIGEST_1614,
      plataformas: [{ plataforma: "linux/s390x", env: {} }],
    });
    const r = verificarPin(pinBueno, resolver);
    expect(r.ok).toBe(false);
    expect(r.fallo.codigo).toBe(CODIGOS.N2_PLATAFORMA_AUSENTE);
  });
});

describe("B · NIVEL 3 versión", () => {
  it("acepta el artefacto con PG_VERSION=16.14", () => {
    expect(verificarPin(pinBueno, resolvedorFalso()).ok).toBe(true);
  });

  it("rechaza un digest válido de OTRA versión (resuelve bien, contiene 16.15)", () => {
    const r = verificarPin({ ...pinBueno, ref: `postgres:16.15-alpine@${DIGEST_1615}` }, resolvedorFalso());
    expect(r.ok).toBe(false);
    expect(r.fallo.codigo).toBe(CODIGOS.N3_VERSION_DISTINTA);
  });

  it("la versión NO OBSERVABLE no es aprobado", () => {
    const artefacto = { plataformas: [{ plataforma: "linux/amd64", env: {} }] };
    const r = nivel3Version(
      "x",
      artefacto,
      { variable: "PG_VERSION", valor: "16.14" },
      { plataformas: ["linux/amd64"] },
    );
    expect(r.ok).toBe(false);
    expect(r.codigo).toBe(CODIGOS.N3_VERSION_NO_OBSERVABLE);
  });

  it("un pin sin versión esperada tampoco aprueba (no comprobado ≠ verde)", () => {
    const r = verificarPin({ ...pinBueno, version_esperada: undefined }, resolvedorFalso());
    expect(r.ok).toBe(false);
    expect(r.fallo.codigo).toBe(CODIGOS.N3_VERSION_NO_OBSERVABLE);
  });

  it("los tres niveles se informan por separado: el nivel 2 verde no tapa el nivel 3 rojo", () => {
    const r = verificarPin({ ...pinBueno, ref: `postgres:16.15-alpine@${DIGEST_1615}` }, resolvedorFalso());
    expect(r.niveles.sintaxis.ok).toBe(true);
    expect(r.niveles.registro.ok).toBe(true);
    expect(r.niveles.version.ok).toBe(false);
  });
});

describe("el compose real cumple el contrato de referencia", () => {
  it("postgres está anclado por digest y la etiqueta nombra la versión que el digest es", () => {
    const ref = doc.services.postgres.image;
    expect(nivel1Sintaxis(ref).ok).toBe(true);
    expect(ref).toBe(`postgres:16.14-alpine@${DIGEST_1614}`);
    expect(verificarPin({ ...pinBueno, ref }, resolvedorFalso()).ok).toBe(true);
  });

  it("la referencia anterior (16-alpine + digest de 16.14) habría fallado este gate", () => {
    const anterior = `postgres:16-alpine@${DIGEST_1614}`;
    expect(verificarPin({ ...pinBueno, ref: anterior }, resolvedorFalso()).ok).toBe(false);
  });
});

describe("calibración del renderizador contra `docker compose config` real", () => {
  for (const [perfil, esperados] of Object.entries(medido.servicios_por_perfil as Record<string, string[]>)) {
    it(`perfil "${perfil || "(ninguno)"}" renderiza exactamente lo medido (${esperados.length} servicios)`, () => {
      const r = Object.keys(renderizar(doc, { perfiles: perfil === "" ? [] : [perfil], vars: contrato.entorno }));
      expect(r.sort()).toEqual([...esperados].sort());
    });
  }

  it("interpola ${VAR}, ${VAR:-def} y ${VAR-def} como Compose", () => {
    expect(interpolar("${A}/x:${TAG:-latest}", { A: "p", TAG: "" })).toBe("p/x:latest");
    expect(interpolar("${A}/x:${TAG:-latest}", { A: "p", TAG: "4d469dc" })).toBe("p/x:4d469dc");
  });
});

describe("C · gate de TAG · por EFECTO, no por cadena", () => {
  it("control positivo: el entorno del contrato produce las imágenes del contrato", () => {
    expect(verificarTag(contrato, doc).ok).toBe(true);
  });

  it("TAG=local en producción falla (el incidente medido)", () => {
    const r = verificarTag({ ...contrato, entorno: { ...contrato.entorno, TAG: "local" } }, doc);
    expect(r.ok).toBe(false);
    expect(r.fallos.every((f: any) => f.codigo === CODIGOS.TAG_DERIVA)).toBe(true);
    expect(r.fallos.length).toBeGreaterThanOrEqual(9);
  });

  it("OTRA variable que produce el mismo drift también falla (no se prohíbe una palabra)", () => {
    const r = verificarTag({ ...contrato, entorno: { ...contrato.entorno, IMAGE_PREFIX: "otro" } }, doc);
    expect(r.ok).toBe(false);
    expect(r.fallos.some((f: any) => f.codigo === CODIGOS.TAG_DERIVA)).toBe(true);
  });

  it("TAG ausente cae al default :latest del compose y también falla", () => {
    const { TAG, ...sinTag } = contrato.entorno;
    const r = verificarTag({ ...contrato, entorno: sinTag }, doc);
    expect(r.ok).toBe(false);
    expect(r.fallos.some((f: any) => f.detalle.includes(":latest"))).toBe(true);
  });

  it("no basta con que la cadena `local` no aparezca: un TAG distinto y plausible falla igual", () => {
    const r = verificarTag({ ...contrato, entorno: { ...contrato.entorno, TAG: "98f381e" } }, doc);
    expect(r.ok).toBe(false);
  });
});

describe("D · gate de PERFIL · conjunto exacto de servicios", () => {
  it("control positivo: el perfil del contrato renderiza el conjunto esperado", () => {
    expect(verificarPerfil(contrato, doc).ok).toBe(true);
  });

  it("sin perfil no es aceptable: renderiza CERO servicios", () => {
    const r = verificarPerfil({ ...contrato, perfiles: [] }, doc);
    expect(r.ok).toBe(false);
    expect(r.fallos[0].codigo).toBe(CODIGOS.PERFIL_VACIO);
  });

  it("external-db no es aceptable (excluye postgres)", () => {
    const r = verificarPerfil({ ...contrato, perfiles: ["external-db"] }, doc);
    expect(r.ok).toBe(false);
    expect(r.fallos[0].codigo).toBe(CODIGOS.PERFIL_CONJUNTO_DISTINTO);
  });

  it("production no es aceptable: arrastra backup, gestionado aparte", () => {
    const r = verificarPerfil({ ...contrato, perfiles: ["production"] }, doc);
    expect(r.ok).toBe(false);
    expect(r.fallos[0].detalle).toContain("backup");
    expect(contrato.gestionados_aparte.backup).toBeTruthy();
  });

  it("nucleo no es aceptable (conjunto incompleto)", () => {
    expect(verificarPerfil({ ...contrato, perfiles: ["nucleo"] }, doc).ok).toBe(false);
  });

  it("comprobar sólo el NOMBRE del perfil no bastaría: un servicio de más rompe la igualdad", () => {
    const conDeMas = { ...contrato, servicios_esperados: [...contrato.servicios_esperados, "backup"] };
    expect(verificarPerfil(conDeMas, doc).ok).toBe(false);
  });

  it("una declaración falsa de perfil rechazado se caza (si el rechazado diera el conjunto canónico)", () => {
    const mentira = { ...contrato, perfiles_rechazados: { ...contrato.perfiles_rechazados, development: "mentira" } };
    const r = verificarPerfil(mentira, doc);
    expect(r.ok).toBe(false);
    expect(r.fallos.some((f: any) => f.codigo === CODIGOS.PERFIL_RECHAZADO_EQUIVALE)).toBe(true);
  });
});

describe("E · servicios con estado", () => {
  it("postgres y queue son la clase operativa STATEFUL_SERVICES", () => {
    expect([...STATEFUL_SERVICES].sort()).toEqual(["postgres", "queue"]);
  });

  it("control positivo: ambos tienen política explícita de persistencia y recreación", () => {
    expect(verificarEstado(contrato, doc).ok).toBe(true);
    for (const s of STATEFUL_SERVICES) {
      expect(contrato.servicios_con_estado[s].politica_persistencia).toBeTruthy();
      expect(contrato.servicios_con_estado[s].politica_recreacion).toBeTruthy();
    }
  });

  it("queue es Redis con appendonly yes sobre queue_data: estado durable, no infraestructura inocua", () => {
    expect(doc.services.queue.command.join(" ")).toContain("--appendonly yes");
    expect(doc.services.queue.volumes).toContain("queue_data:/data");
    expect(contrato.servicios_con_estado.queue.deuda).toMatch(/DEUDA-QUEUE-BACKUP/);
  });

  it("omitir queue de la declaración falla", () => {
    const r = verificarEstado(
      { ...contrato, servicios_con_estado: { postgres: contrato.servicios_con_estado.postgres } },
      doc,
    );
    expect(r.ok).toBe(false);
    expect(r.fallos[0].codigo).toBe(CODIGOS.ESTADO_NO_DECLARADO);
  });

  it("una política vacía falla (no basta con que el campo exista)", () => {
    const roto = JSON.parse(JSON.stringify(contrato));
    roto.servicios_con_estado.queue.politica_recreacion = "  ";
    const r = verificarEstado(roto, doc);
    expect(r.ok).toBe(false);
    expect(r.fallos.some((f: any) => f.codigo === CODIGOS.ESTADO_SIN_POLITICA)).toBe(true);
  });

  it("sin copia verificada y SIN deuda declarada falla: callar la deuda es aprobar por omisión", () => {
    const roto = JSON.parse(JSON.stringify(contrato));
    delete roto.servicios_con_estado.queue.deuda;
    const r = verificarEstado(roto, doc);
    expect(r.ok).toBe(false);
    expect(r.fallos.some((f: any) => f.codigo === CODIGOS.ESTADO_DEUDA_SIN_DECLARAR)).toBe(true);
  });

  it("un volumen declarado pero no montado en su destino falla", () => {
    const roto = JSON.parse(JSON.stringify(contrato));
    roto.servicios_con_estado.postgres.destino = "/otro/sitio";
    const r = verificarEstado(roto, doc);
    expect(r.ok).toBe(false);
    expect(r.fallos.some((f: any) => f.codigo === CODIGOS.ESTADO_SIN_MONTAJE)).toBe(true);
  });

  it("un volumen que no existe en el compose falla", () => {
    const roto = JSON.parse(JSON.stringify(contrato));
    roto.servicios_con_estado.queue.volumen = "no_existe";
    const r = verificarEstado(roto, doc);
    expect(r.ok).toBe(false);
    expect(r.fallos.some((f: any) => f.codigo === CODIGOS.ESTADO_VOLUMEN_AUSENTE)).toBe(true);
  });
});

describe("envoltura ejecutable/declarativa", () => {
  it("la invocación canónica fija proyecto, ficheros, perfil, env-file y --no-build", () => {
    const inv = invocacion(contrato);
    expect(inv.argv).toContain("--no-build");
    expect(inv.argv).toContain("-p");
    expect(inv.argv).toContain(contrato.proyecto);
    expect(inv.linea).toContain("--profile development");
    expect(inv.linea).toContain("--env-file infrastructure/.env");
    expect(inv.entorno).toContain("TAG=4d469dc");
  });

  it("la envoltura es inspeccionable por el gate: sale del MISMO contrato que se verifica", () => {
    const salida = execFileSync("node", [GATE, "--invocacion"], { cwd: RAIZ, encoding: "utf8" }).trim();
    expect(salida).toBe(invocacion(contrato).linea);
  });

  it("no publica topología: ni IPs ni rutas de anfitrión en el contrato", () => {
    const crudo = readFileSync(CONTRATO, "utf8");
    expect(crudo).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    expect(crudo).not.toMatch(/\/opt\//);
    expect(crudo).toContain("/run/secrets/<secret-name>");
  });
});

describe("CLI del gate", () => {
  it("--self-test sale en verde y ejerce los controles negativos", () => {
    const r = execFileSync("node", [GATE, "--self-test"], { cwd: RAIZ, encoding: "utf8" });
    expect(r).toContain("AUTOPRUEBA VERDE");
    expect(autoprueba().rc).toBe(0);
  });

  it("sin --registro los niveles 2 y 3 se declaran NO EJERCIDO y el gate NO aprueba", () => {
    let rc = 0;
    let salida = "";
    try {
      salida = execFileSync("node", [GATE], { cwd: RAIZ, encoding: "utf8" });
    } catch (e: any) {
      rc = e.status;
      salida = `${e.stdout ?? ""}`;
    }
    expect(rc).toBe(1);
    expect(salida).toContain("NO_EJERCIDO");
  });

  it("un contrato ausente sale rc=2 (no comprobado), nunca rc=0", () => {
    let rc = 0;
    try {
      execFileSync("node", [GATE, "--contrato", join(RAIZ, "no-existe.json")], { cwd: RAIZ, encoding: "utf8" });
    } catch (e: any) {
      rc = e.status;
    }
    expect(rc).toBe(2);
  });

  it("cargar() lee el contrato y el compose reales", () => {
    const { contrato: c, doc: d } = cargar(CONTRATO);
    expect(c.proyecto).toBe("infrastructure");
    expect(Object.keys(d.services).length).toBeGreaterThan(11);
  });
});
