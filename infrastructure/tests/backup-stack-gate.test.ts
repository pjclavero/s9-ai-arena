// CONTRATO DE LOS DOS BLOQUES · suite del gate.
//
// Lo que esta suite tiene que ser capaz de demostrar, y por qué cada cosa:
//
//   · APP_STACK renderiza EXACTAMENTE 11 servicios, BACKUP_STACK exactamente 1,
//     y el total esperado es 12 — contra el contrato y el compose REALES del
//     repositorio, no contra un ejemplo de juguete.
//   · Elegir un perfil más ancho NO mete `backup` en el bloque de aplicación:
//     se prueba mutando el contrato (perfil `production`) y mutando el COMPOSE
//     (añadir `development` a `profiles:` de backup), que es la regresión que
//     de verdad puede ocurrir en un PR futuro.
//   · El renderizador se calibra contra la salida REAL de
//     `docker compose config --services` por perfil (fixture medida): si el
//     renderizador se apartara de lo que Docker hace, el gate compararía el
//     stack contra una ficción. Re-medido sobre VM108 el 2026-09-04 con el
//     árbol en ad0a42b: development 11, production 12, external-db 11, sin
//     perfil 0.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
// @ts-expect-error módulo .mjs sin tipos
import {
  CASOS_NEGATIVOS,
  CASOS_NEGATIVOS_COMPOSE,
  CODIGOS,
  FLAGS_OBLIGATORIAS,
  autoprueba,
  invocaciones,
  perfilesDelCompose,
  renderApp,
  serviciosBackup,
  verificar,
  verificarApp,
  verificarBackup,
  verificarSeparacion,
} from "../scripts/backup-stack-gate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(here, "..", "..");
const GATE = join(here, "..", "scripts", "backup-stack-gate.mjs");
const CONTRATO = join(here, "..", "deploy-contract.json");
const COMPOSE = join(here, "..", "docker-compose.yml");

const contrato = JSON.parse(readFileSync(CONTRATO, "utf8"));
const doc = parse(readFileSync(COMPOSE, "utf8"), { merge: true });
const medido = JSON.parse(readFileSync(join(here, "fixtures", "compose-profiles-medido.json"), "utf8"))
  .servicios_por_perfil as Record<string, string[]>;

const clon = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const correrGate = (args: string[]) => {
  try {
    const salida = execFileSync("node", [GATE, ...args], { cwd: RAIZ, encoding: "utf8" });
    return { rc: 0, salida };
  } catch (e: any) {
    // rc EXPLÍCITO: nunca el $? implícito.
    return { rc: e.status ?? 1, salida: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
};

describe("los dos bloques, sobre el contrato y el compose reales", () => {
  it("APP_STACK renderiza EXACTAMENTE 11 servicios, y son los de servicios_esperados", () => {
    const r = verificarApp(contrato, doc);
    expect(r.fallos).toEqual([]);
    expect(r.servicios).toHaveLength(11);
    expect(r.servicios).toEqual([...contrato.servicios_esperados].sort());
  });

  it("BACKUP_STACK es EXACTAMENTE 1 servicio: backup", () => {
    const r = verificarBackup(contrato, doc);
    expect(r.fallos).toEqual([]);
    expect(r.servicios).toEqual(["backup"]);
  });

  it("el total esperado es 12 = 11 + 1, y los bloques son disjuntos", () => {
    const r = verificarSeparacion(contrato, doc);
    expect(r.fallos).toEqual([]);
    expect(r.app).toHaveLength(11);
    expect(r.backup).toHaveLength(1);
    expect(r.total).toBe(12);
    expect(contrato.bloques.total_esperado).toBe(12);
  });

  it("el gate completo sale VERDE y su CLI devuelve rc=0", () => {
    expect(verificar(contrato, doc).ok).toBe(true);
    expect(correrGate([]).rc).toBe(0);
  });
});

describe("calibración: el renderizador coincide con `docker compose config --services` medido", () => {
  it("el perfil de APP_STACK renderiza lo medido para ese perfil", () => {
    const perfil: string = contrato.bloques.APP_STACK.perfil;
    expect(renderApp(contrato, doc)).toEqual([...medido[perfil]].sort());
  });

  it("los perfiles anchos medidos SÍ traen backup (por eso el bloque va aparte)", () => {
    expect(medido.production).toContain("backup");
    expect(medido["external-db"]).toContain("backup");
    expect(medido.development).not.toContain("backup");
    expect(medido[""]).toHaveLength(0);
  });

  it("el compose no esconde perfiles que la fixture no haya medido", () => {
    for (const p of perfilesDelCompose(doc)) expect(Object.keys(medido)).toContain(p);
  });
});

describe("elegir un perfil más ancho NO mete backup en el bloque de aplicación", () => {
  it("con perfil `production` en APP_STACK, el gate se pone ROJO por contaminación", () => {
    const c = clon(contrato);
    c.bloques.APP_STACK.perfil = "production";
    const r = verificar(c, doc);
    expect(r.ok).toBe(false);
    expect(r.fallos.map((f: any) => f.codigo)).toContain(CODIGOS.CONTAMINACION_APP);
  });

  it("con perfil `external-db` en APP_STACK, también (y por el mismo código)", () => {
    const c = clon(contrato);
    c.bloques.APP_STACK.perfil = "external-db";
    const r = verificar(c, doc);
    expect(r.fallos.map((f: any) => f.codigo)).toContain(CODIGOS.CONTAMINACION_APP);
  });

  it("si un PR añade `development` a profiles: de backup, el gate se pone ROJO", () => {
    const d = clon(doc);
    d.services.backup.profiles = ["development", "production", "external-db"];
    const r = verificar(contrato, d);
    expect(r.ok).toBe(false);
    expect(r.fallos.map((f: any) => f.codigo)).toContain(CODIGOS.CONTAMINACION_APP);
  });

  it("si aparece un perfil ancho NUEVO sin declarar que incluye backup, el gate se pone ROJO", () => {
    const d = clon(doc);
    for (const svc of Object.values<any>(d.services)) svc.profiles = [...(svc.profiles ?? []), "todo-junto"];
    const r = verificar(contrato, d);
    expect(r.fallos.map((f: any) => f.codigo)).toContain(CODIGOS.PERFIL_ANCHO_NO_DECLARADO);
  });

  it("añadir backup a servicios_esperados no cuela: los bloques dejan de ser disjuntos", () => {
    const c = clon(contrato);
    c.servicios_esperados.push("backup");
    const r = verificar(c, doc);
    expect(r.fallos.map((f: any) => f.codigo)).toContain(CODIGOS.BLOQUES_SOLAPAN);
  });
});

describe("controles negativos por garantía (cada uno con su código propio)", () => {
  for (const caso of CASOS_NEGATIVOS as any[]) {
    it(`${caso.nombre} → ${caso.codigo}`, () => {
      const r = verificar(caso.mutar(clon(contrato)), doc);
      expect(r.ok).toBe(false);
      expect(r.fallos.map((f: any) => f.codigo)).toContain(caso.codigo);
    });
  }
  for (const caso of CASOS_NEGATIVOS_COMPOSE as any[]) {
    it(`(compose) ${caso.nombre} → ${caso.codigo}`, () => {
      const r = verificar(contrato, caso.mutar(clon(doc)));
      expect(r.fallos.map((f: any) => f.codigo)).toContain(caso.codigo);
    });
  }

  it("once servicios DISTINTOS no cuelan por ser once (igualdad de conjuntos, no tamaño)", () => {
    const c = clon(contrato);
    // Mismo cardinal, conjunto distinto: sustituimos un servicio real por uno
    // inventado. Un gate que compare TAMAÑOS aprobaría esto tan tranquilo.
    c.servicios_esperados = [...contrato.servicios_esperados.slice(0, 10), "servicio-fantasma"];
    const r = verificar(c, doc);
    expect(r.ok).toBe(false);
    expect(r.fallos.map((f: any) => f.codigo)).toContain(CODIGOS.APP_CONJUNTO_DISTINTO);
  });

  it("un n_esperado que no cuadra con lo renderizado es ROJO aunque el conjunto sea el bueno", () => {
    const c = clon(contrato);
    c.bloques.APP_STACK.n_esperado = 12; // el conjunto sigue siendo el correcto (11)
    const r = verificar(c, doc);
    expect(r.ok).toBe(false);
    expect(r.fallos.map((f: any) => f.codigo)).toContain(CODIGOS.APP_CARDINAL_DISTINTO);
  });

  it("un n_esperado que no cuadra en el bloque de copia también es ROJO", () => {
    const c = clon(contrato);
    c.bloques.BACKUP_STACK.n_esperado = 2;
    const r = verificar(c, doc);
    expect(r.fallos.map((f: any) => f.codigo)).toContain(CODIGOS.BACKUP_CARDINAL_DISTINTO);
  });

  it("un contrato SIN `bloques` no se aprueba por omisión", () => {
    const c = clon(contrato);
    delete c.bloques;
    const r = verificar(c, doc);
    expect(r.ok).toBe(false);
    expect(r.fallos[0].codigo).toBe(CODIGOS.BLOQUES_NO_DECLARADOS);
  });

  it("un contrato ausente es rc=2 (no comprobado), nunca rc=0", () => {
    const r = correrGate(["--contrato", "/no/existe.json"]);
    expect(r.rc).toBe(2);
    expect(r.salida).toContain("NO COMPROBADO");
  });

  it("la autoprueba del gate pasa y su CLI devuelve rc=0", () => {
    expect(autoprueba().ok).toBe(true);
    expect(correrGate(["--self-test"]).rc).toBe(0);
  });
});

describe("la envoltura: dos invocaciones, no una", () => {
  const inv = invocaciones(contrato, { directorioProyecto: "/opt/s9-ai-arena", tagBackup: "ad0a42b" });

  it("la del bloque de aplicación NO nombra backup", () => {
    expect(inv.app.linea).not.toContain("backup");
    expect(inv.app.argv).toContain("--no-build");
    expect(inv.app.linea).toContain("--profile development");
  });

  it("la del bloque de copia nombra backup explícitamente y lleva --no-build y --no-deps", () => {
    for (const flag of FLAGS_OBLIGATORIAS as string[]) expect(inv.backup.argv).toContain(flag);
    expect(inv.backup.argv[inv.backup.argv.length - 1]).toBe("backup");
    expect(inv.backup.linea).toContain("TAG=ad0a42b");
  });

  it("la del bloque de copia NO nombra postgres (depends_on no debe arrastrarlo)", () => {
    expect(inv.backup.argv).not.toContain("postgres");
  });

  it("ambas usan --project-directory de producción (build.context resolvería mal si no)", () => {
    expect(inv.app.linea).toContain("--project-directory /opt/s9-ai-arena");
    expect(inv.backup.linea).toContain("--project-directory /opt/s9-ai-arena");
  });

  it("los servicios del bloque de copia salen del contrato, no de una constante", () => {
    expect(serviciosBackup(contrato)).toEqual(Object.keys(contrato.gestionados_aparte).sort());
  });
});
