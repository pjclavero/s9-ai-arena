/**
 * R17 · Calibración de la sonda REAL de versión desplegada.
 *
 * La regla del bloque: una comprobación que no puede ponerse roja no cuenta.
 * Aquí el control POSITIVO (despliegue coherente) tiene que quedar `verified` y
 * cada control NEGATIVO — los dos incidentes reales del ADR-016, más la
 * ausencia de daemon — tiene que sacar la comprobación de `verified`.
 *
 * No se toca ningún daemon: el ejecutor está inyectado, así que lo que se
 * calibra es la interpretación, que es donde vivían los dos fallos.
 */
import { describe, expect, it } from "vitest";

import { READINESS_CHECKS } from "./checks.ts";
import type { CheckStatus } from "./engine.ts";
import { nominalContext } from "./mutations.ts";
import {
  commitDeEtiqueta,
  commitEmbebido,
  deployedVersionProbe,
  interpretarVersionDesplegada,
  mismoCommit,
  observarImagen,
  type EjecutorComando,
} from "./probes-docker.ts";

const CHECK = READINESS_CHECKS.find((c) => c.id === "security.deployed_version")!;

const ID_VIVA = "sha256:" + "a".repeat(64);
const ID_BORRADA = "sha256:" + "b".repeat(64);

/** Daemon falso. `env`/`labels` son los de la IMAGEN, no los del contenedor. */
function daemon(opts: {
  imageId?: string;
  tag?: string;
  env?: string[];
  labels?: Record<string, string> | null;
  inspectFalla?: boolean;
  imagenAusente?: boolean;
  /** ID a la que resuelve HOY la etiqueta; null = la etiqueta ya no resuelve. */
  idDeLaEtiqueta?: string | null;
}): EjecutorComando {
  const imageId = opts.imageId ?? ID_VIVA;
  const tag = opts.tag ?? "s9arena/api:4d469dc";
  const idEtiqueta = opts.idDeLaEtiqueta === undefined ? imageId : opts.idDeLaEtiqueta;
  return (cmd, args) => {
    expect(cmd).toBe("docker");
    // Ningún comando de la sonda puede modificar el daemon.
    expect(["inspect", "image"]).toContain(args[0]);
    if (args[0] === "inspect") {
      return opts.inspectFalla
        ? { rc: 1, out: "", err: "No such object" }
        : { rc: 0, out: `${imageId}\t${tag}`, err: "" };
    }
    // `docker image inspect <ref> -f ...`
    const ref = args[2];
    if (ref === tag) {
      return idEtiqueta === null ? { rc: 1, out: "", err: "No such image" } : { rc: 0, out: idEtiqueta, err: "" };
    }
    if (opts.imagenAusente) return { rc: 1, out: "", err: "No such image" };
    return {
      rc: 0,
      out: `${JSON.stringify(opts.env ?? ["BUILD_COMMIT=4d469dc"])}\t${JSON.stringify(opts.labels ?? {})}`,
      err: "",
    };
  };
}

/** Estado de la comprobación real con la sonda inyectada. */
async function estado(run: EjecutorComando, contenedor = "infrastructure-api-1"): Promise<CheckStatus> {
  const ctx = nominalContext();
  ctx.probes.deployedVersion = deployedVersionProbe(contenedor, run);
  return (await CHECK.run(ctx)).status;
}

describe("lectura de commits", () => {
  it("sólo acepta como commit un sufijo hexadecimal de 7 a 40", () => {
    expect(commitDeEtiqueta("s9arena/api:4d469dc")).toBe("4d469dc");
    expect(commitDeEtiqueta("s9arena/api:latest")).toBeNull();
    expect(commitDeEtiqueta("s9arena/api:v1.2.3")).toBeNull();
    expect(commitDeEtiqueta(null)).toBeNull();
  });

  it("'unknown' no es identidad embebida: es ausencia de identidad", () => {
    const vacio = {};
    expect(commitEmbebido({ BUILD_COMMIT: "unknown" }, vacio)).toBeNull();
    expect(commitEmbebido({ BUILD_COMMIT: "  " }, vacio)).toBeNull();
    expect(commitEmbebido(vacio, { "org.opencontainers.image.revision": "0badc0d" })).toBe("0badc0d");
    expect(commitEmbebido({ BUILD_COMMIT: "4d469dc" }, { "org.opencontainers.image.revision": "0badc0d" })).toBe(
      "4d469dc",
    );
  });

  it("un short sha y su sha completo son el mismo commit", () => {
    expect(mismoCommit("4d469dc", "4d469dc1122334455")).toBe(true);
    expect(mismoCommit("4d469dc", "0badc0d")).toBe(false);
    expect(mismoCommit(null, "4d469dc")).toBe(false);
  });
});

describe("sonda de versión desplegada · control POSITIVO", () => {
  it("despliegue coherente (imagen viva, commit embebido = etiqueta) queda verified", async () => {
    expect(await estado(daemon({}))).toBe("verified");
  });

  it("etiqueta con short sha e imagen con sha completo NO es discrepancia", async () => {
    const run = daemon({ tag: "s9arena/api:4d469dc", env: ["BUILD_COMMIT=4d469dc1122334455667788"] });
    expect(await estado(run)).toBe("verified");
  });

  it("la sonda sólo ejecuta comandos de LECTURA sobre el daemon", async () => {
    const vistos: string[][] = [];
    const base = daemon({});
    const espia: EjecutorComando = (cmd, args) => {
      vistos.push(args);
      return base(cmd, args);
    };
    await estado(espia);
    expect(vistos.length).toBeGreaterThan(0);
    for (const args of vistos) {
      expect(args.join(" ")).not.toMatch(/\b(run|rm|rmi|stop|start|restart|pull|push|build|prune|exec|kill)\b/);
    }
  });
});

describe("sonda de versión desplegada · controles NEGATIVOS (se pone ROJA)", () => {
  it("incidente 1 · la etiqueta dice un commit y la imagen se construyó desde otro", async () => {
    const run = daemon({ tag: "s9arena/api:4d469dc", env: ["BUILD_COMMIT=0badc0d"] });
    const r = interpretarVersionDesplegada(observarImagen("c", run));
    expect(r.taggedCommit).toBe("4d469dc");
    expect(r.builtFromCommit).toBe("0badc0d");
    expect(await estado(run)).toBe("failed");
  });

  it("incidente 1 bis · la revisión OCI delata el árbol viejo aunque no haya BUILD_COMMIT", async () => {
    const run = daemon({
      tag: "s9arena/api:4d469dc",
      env: [],
      labels: { "org.opencontainers.image.revision": "0badc0d" },
    });
    expect(await estado(run)).toBe("failed");
  });

  it("incidente 2 · el contenedor corre una image ID que ya no existe en el daemon", async () => {
    const run = daemon({ imageId: ID_BORRADA, imagenAusente: true });
    const r = interpretarVersionDesplegada(observarImagen("c", run));
    expect(r.imageIdPresentInDaemon).toBe(false);
    expect(await estado(run)).toBe("failed");
  });

  it("sin daemon accesible NO se aprueba por omisión: queda no ejercida con motivo", async () => {
    const run = daemon({ inspectFalla: true });
    const obs = observarImagen("c", run);
    expect(obs.reason).toContain("docker inspect");
    expect(await estado(run)).toBe("not_exercised");
  });

  it("incidente 3 · la etiqueta se movió y resuelve a otra imagen distinta de la que corre", async () => {
    // Caso REAL observado en VM108: la etiqueta se repobló con una imagen nueva
    // y el contenedor sigue sobre la vieja. Un restart cambiaría de versión.
    const run = daemon({ imageId: ID_VIVA, idDeLaEtiqueta: ID_BORRADA });
    const r = interpretarVersionDesplegada(observarImagen("c", run));
    expect(r.imageIdPresentInDaemon).toBe(true);
    expect(r.tagResolvesToRunningId).toBe(false);
    expect(await estado(run)).toBe("failed");
  });

  it("si la etiqueta ya no resuelve, no se AFIRMA nada sobre ella", async () => {
    const run = daemon({ idDeLaEtiqueta: null });
    const r = interpretarVersionDesplegada(observarImagen("c", run));
    expect(r.tagResolvesToRunningId).toBeUndefined();
    expect(await estado(run)).toBe("verified");
  });

  it("sin contenedor declarado no se ha mirado nada: no ejercida", async () => {
    const r = await deployedVersionProbe("   ")();
    expect(r.reason).toContain("S9_READINESS_CONTAINER");
    expect(await estado(daemon({}), "  ")).toBe("not_exercised");
  });

  it("una imagen sin identidad embebida no puede AFIRMAR procedencia: no ejercida", async () => {
    // Caso REAL de VM108 hoy: imágenes construidas antes del ADR-016. La image
    // ID existe y el contenedor está sano, pero nadie ha observado de qué árbol
    // salió. Aprobar esto sería leer la etiqueta como versión desplegada.
    const run = daemon({ env: [], labels: {} });
    const r = interpretarVersionDesplegada(observarImagen("c", run));
    expect(r.builtFromCommit).toBeNull();
    expect(r.taggedCommit).toBe("4d469dc");
    expect(await estado(run)).toBe("not_exercised");
  });
});
