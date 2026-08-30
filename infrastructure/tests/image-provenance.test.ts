/**
 * ADR-016 · Identidad de build: contrato de /version y calibración del gate.
 *
 * Esta suite no comprueba "que el código compila": comprueba que el gate SABE
 * PONERSE ROJO. Cada garantía se prueba con su control positivo (coherente →
 * verde) y su control negativo (mutado → rojo con un motivo concreto). Un
 * verificador que solo se ha visto en verde no es evidencia de nada: fue
 * exactamente un gate tautológico ("imagen declarada == imagen desplegada") el
 * que dejó pasar cuatro servicios construidos del árbol viejo.
 */
import { describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — script .mjs sin tipos, se consume solo desde tests y CI.
import { comprobarCoherencia, LABEL_REVISION, LABEL_TITULO } from "../scripts/verify-image-provenance.mjs";
import { mountVersionEndpoint, readBuildInfo, versionPayload } from "../../packages/build-info/index.js";
// @ts-expect-error — script .mjs sin tipos.
import { huerfanos } from "../scripts/check-running-image-id.mjs";
import { createMapServiceApp } from "../../apps/map-service/src/main.js";
import { createBotManagerApp } from "../../apps/bot-manager/src/main.js";
import { createArenaEngineService } from "../../apps/arena-engine/src/service.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..");

const COMMIT = "4d469dc0000000000000000000000000000000aa";
const OTRO = "98f381ec00000000000000000000000000000bb";

function coherente(extra: Record<string, unknown> = {}) {
  return {
    tag: `sha-${COMMIT}`,
    labels: { [LABEL_REVISION]: COMMIT, [LABEL_TITULO]: "replay-service" },
    runtime: { service: "replay-service", commit: COMMIT },
    commit: COMMIT,
    service: "replay-service",
    ...extra,
  };
}

describe("ADR-016 · /version sirve el commit EMBEBIDO en la imagen", () => {
  it("devuelve el contrato {service, commit} con lo que trae el entorno de la imagen", async () => {
    const app = express();
    mountVersionEndpoint(app, "replay-service", { SERVICE_NAME: "replay-service", BUILD_COMMIT: COMMIT });
    const res = await request(app).get("/version");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ service: "replay-service", commit: COMMIT });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("MUTACIÓN · si la imagen embebe OTRO commit, /version lo delata (no dice el esperado)", async () => {
    // Es la mutación que reproduce el incidente: la etiqueta dice 4d469dc y el
    // contenido es 98f381ec. Si este test no se pusiera rojo al mutar el
    // commit embebido, /version no estaría midiendo nada.
    const app = express();
    mountVersionEndpoint(app, "replay-service", { SERVICE_NAME: "replay-service", BUILD_COMMIT: OTRO });
    const res = await request(app).get("/version");
    expect(res.body.commit).not.toBe(COMMIT);
    expect(res.body.commit).toBe(OTRO);
    expect(comprobarCoherencia(coherente({ runtime: res.body })).join(" ")).toMatch(/runtime: \/version dice commit/);
  });

  it("una imagen construida SIN identidad reporta 'unknown' en vez de mentir", () => {
    expect(readBuildInfo({}, "map-service")).toEqual({ service: "map-service", commit: "unknown" });
  });

  it("incluye builtAt solo si se embebió", () => {
    expect(versionPayload({ BUILD_COMMIT: COMMIT, BUILD_DATE: "2026-08-30T10:00:00Z" }, "api")).toEqual({
      service: "api",
      commit: COMMIT,
      builtAt: "2026-08-30T10:00:00Z",
    });
    expect(versionPayload({ BUILD_COMMIT: COMMIT, BUILD_DATE: "  " }, "api")).toEqual({
      service: "api",
      commit: COMMIT,
    });
  });

  it("NO expone secretos, hostname, IP ni rutas: el cuerpo tiene exactamente las claves del contrato", () => {
    const cuerpo = versionPayload(
      { SERVICE_NAME: "api", BUILD_COMMIT: COMMIT, HOSTNAME: "vm108", JWT_SECRET: "x", PGPASSWORD: "y", HOME: "/root" },
      "api",
    );
    expect(Object.keys(cuerpo).sort()).toEqual(["commit", "service"]);
  });
});

describe("ADR-016 · el verificador se pone ROJO (controles negativos)", () => {
  it("control positivo: todo coherente → cero fallos", () => {
    expect(comprobarCoherencia(coherente())).toEqual([]);
  });

  it("etiqueta correcta + contenido equivocado (el incidente literal) → rojo por metadata", () => {
    const fallos = comprobarCoherencia(
      coherente({ labels: { [LABEL_REVISION]: OTRO, [LABEL_TITULO]: "replay-service" } }),
    );
    expect(fallos.join(" ")).toMatch(/metadata: org\.opencontainers\.image\.revision/);
  });

  it("imagen sin LABEL de revisión (construida sin identidad) → rojo", () => {
    expect(comprobarCoherencia(coherente({ labels: {} })).join(" ")).toMatch(/no trae org\.opencontainers/);
  });

  it("tag que no nombra el commit (p. ej. :latest) → rojo", () => {
    expect(comprobarCoherencia(coherente({ tag: "latest" })).join(" ")).toMatch(/etiqueta: el tag "latest"/);
  });

  it("el servicio embebido no es el que se creía → rojo", () => {
    const fallos = comprobarCoherencia(coherente({ labels: { [LABEL_REVISION]: COMMIT, [LABEL_TITULO]: "api" } }));
    expect(fallos.join(" ")).toMatch(/image\.title="api"/);
  });

  it("un /version que filtrara entorno → rojo (el contrato prohíbe esos campos)", () => {
    const fallos = comprobarCoherencia(
      coherente({ runtime: { service: "replay-service", commit: COMMIT, hostname: "vm108" } }),
    );
    expect(fallos.join(" ")).toMatch(/expone el campo "hostname"/);
  });

  it("commit esperado 'unknown' NO se acepta como comodín", () => {
    expect(comprobarCoherencia(coherente({ commit: "unknown" })).join(" ")).toMatch(/vacío o 'unknown'/);
  });
});

describe("ADR-016 · los Dockerfile embeben la identidad", () => {
  const dockerfiles = [
    "infrastructure/docker/node-service/Dockerfile",
    "infrastructure/docker/bot-manager/Dockerfile",
    "infrastructure/docker/arena-engine/Dockerfile",
    "infrastructure/docker/web/Dockerfile",
    "infrastructure/docker/gateway/Dockerfile",
    "infrastructure/docker/streamer/Dockerfile",
    "infrastructure/docker/backup/Dockerfile",
    "infrastructure/docker/bot-runtime/Dockerfile",
  ];

  it.each(dockerfiles)("%s declara ARG+ENV+LABEL OCI", (ruta) => {
    const texto = readFileSync(join(REPO, ruta), "utf8");
    for (const arg of ["BUILD_COMMIT", "BUILD_DATE", "SERVICE_NAME"]) {
      expect(texto, `${ruta}: falta ARG ${arg}`).toMatch(new RegExp(`^ARG ${arg}`, "m"));
      expect(texto, `${ruta}: falta ENV ${arg}`).toMatch(new RegExp(`${arg}=\\$\\{${arg}\\}`));
    }
    expect(texto, `${ruta}: falta ${LABEL_REVISION}`).toContain(`${LABEL_REVISION}="\${BUILD_COMMIT}"`);
    expect(texto, `${ruta}: falta ${LABEL_TITULO}`).toContain(`${LABEL_TITULO}="\${SERVICE_NAME}"`);
  });
});

describe("ADR-016 · los servicios reales del monorepo sirven /version", () => {
  const apps: [string, () => express.Express][] = [
    ["map-service", () => createMapServiceApp()],
    ["bot-manager", () => createBotManagerApp("http://docker-proxy.internal:2375")],
    ["arena-engine", () => createArenaEngineService()],
  ];

  it.each(apps)("%s expone /version con su nombre y el commit embebido", async (nombre, crear) => {
    // El commit REAL lo pone la imagen (BUILD_COMMIT); aquí, sin imagen, el
    // contrato debe seguir cumpliéndose y reportar "unknown" en vez de mentir.
    const res = await request(crear()).get("/version");
    expect(res.status).toBe(200);
    expect(res.body.service).toBe(nombre);
    expect(res.body.commit).toBe(process.env.BUILD_COMMIT ?? "unknown");
    expect(Object.keys(res.body).sort()).toEqual(
      process.env.BUILD_DATE ? ["builtAt", "commit", "service"] : ["commit", "service"],
    );
  });
});

describe("ADR-016 · DRIFT CRÍTICO: image ID en ejecución que ya no existe", () => {
  const idViva = "sha256:" + "a".repeat(64);
  const idBorrada = "sha256:" + "b".repeat(64);
  const contenedores = [
    { nombre: "/api", imageId: idViva, etiqueta: "s9-ai-arena/api:sha-nuevo" },
    { nombre: "/replay-service", imageId: idBorrada, etiqueta: "s9-ai-arena/replay-service:sha-nuevo" },
  ];

  it("control positivo: todas las imágenes existen → no hay huérfanos", () => {
    expect(huerfanos([contenedores[0]], [idViva])).toEqual([]);
  });

  it("MUTACIÓN · la imagen del contenedor se borró del daemon → se detecta", () => {
    // Es el segundo incidente literal: `docker inspect` del contenedor la
    // reporta, `docker image inspect` dice "No such image". Ese estado no es
    // reproducible tras un restart y el baseline no sirve para rollback.
    const sueltos = huerfanos(contenedores, [idViva]);
    expect(sueltos.map((c: { nombre: string }) => c.nombre)).toEqual(["/replay-service"]);
  });
});
