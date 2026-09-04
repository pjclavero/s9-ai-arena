/**
 * B13 · La CI construye TODAS las imágenes del Compose, y las construye IGUAL.
 *
 * Defecto real encontrado por supervisión independiente el 2026-07-27: la
 * matriz `build-images` de .github/workflows/ci.yml listaba ocho imágenes a
 * mano y el Compose construye once. Consecuencias medidas sobre main (98f381e):
 *
 *   - `streamer`, `backup` y `bot-runtime-python` NO las construía ningún job:
 *     un cambio que rompiese esos Dockerfile pasaba la CI en verde y reventaba
 *     en el `docker compose build` del despliegue.
 *   - `web` sí estaba en la matriz, pero construida desde
 *     infrastructure/docker/node-service/Dockerfile, mientras el Compose la
 *     construye desde infrastructure/docker/web/Dockerfile (SPA compilada y
 *     servida por nginx). La CI validaba —y publicaba en GHCR con la etiqueta
 *     `web`— una imagen que NO es la de producción.
 *
 * Este test no compara textos sueltos: resuelve las dos fuentes (Compose y
 * workflow), las empareja por IMAGEN y compara Dockerfile y build-args. Añadir
 * un servicio con build al Compose sin añadirlo a la matriz vuelve a poner esta
 * suite en rojo, que es justo lo que no pasó en su día.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..");
const COMPOSE_PATH = join(REPO, "infrastructure", "docker-compose.yml");

/** ADR-016 · build-args de identidad, exigidos a todas las imágenes. */
const ARGS_IDENTIDAD = ["BUILD_COMMIT", "BUILD_DATE", "SERVICE_NAME"];
const CI_PATH = join(REPO, ".github", "workflows", "ci.yml");

interface Construccion {
  /** Nombre de la imagen sin prefijo de registro ni etiqueta (p. ej. "streamer"). */
  imagen: string;
  dockerfile: string;
  /** build-args normalizados a "CLAVE=valor", ordenados. */
  args: string[];
  /** Nombres de los build-args de identidad declarados (ADR-016). */
  identidad: string[];
  /** Servicios del Compose que comparten esta construcción. */
  servicios: string[];
}

/** Servicios del Compose que construyen imagen (los que solo la descargan, no). */
export function construccionesDelCompose(compose: string): Construccion[] {
  const doc = parse(compose, { merge: true }) as { services: Record<string, any> };
  const porImagen = new Map<string, Construccion>();

  for (const [nombre, def] of Object.entries(doc.services ?? {})) {
    if (!def?.build) continue;
    const dockerfile = String(def.build.dockerfile ?? "");
    // ADR-016 · los tres args de identidad de build (BUILD_COMMIT, BUILD_DATE,
    // SERVICE_NAME) se comparan APARTE: en el Compose son ${BUILD_COMMIT:-...}
    // y en la CI son expresiones de Actions (github.sha), así que compararlos
    // literalmente solo mediría que dos textos distintos son distintos. Lo que
    // sí se exige, más abajo, es que AMBAS fuentes los pasen SIEMPRE.
    const todos = Object.entries(def.build.args ?? {}).map(([k, v]) => [k, String(v)] as const);
    const args = todos
      .filter(([k]) => !ARGS_IDENTIDAD.includes(k))
      .map(([k, v]) => `${k}=${v}`)
      .sort();
    const identidad = todos.filter(([k]) => ARGS_IDENTIDAD.includes(k)).map(([k]) => k);
    // `image:` es del tipo ${IMAGE_PREFIX:-...}/<imagen>:${<VAR>:-latest}.
    // La variable de versión NO es siempre TAG: `backup` se versiona con
    // BACKUP_TAG porque es un bloque de despliegue aparte (ver deploy-contract.json,
    // clave `bloques`, y backup-stack-gate.mjs). Lo que aquí importa es el
    // NOMBRE de la imagen, no de qué variable cuelga su etiqueta; atar el
    // extractor a TAG hacía que dar a un servicio su propia variable rompiera
    // esta comprobación por un motivo que no es el suyo.
    const m = /\/([a-z0-9][a-z0-9._-]*):\$\{[A-Z_]*TAG/.exec(String(def.image ?? ""));
    expect(m, `${nombre}: no se pudo extraer el nombre de imagen de "${def.image}"`).not.toBeNull();
    const imagen = m![1];

    const previo = porImagen.get(imagen);
    if (previo) {
      // Dos servicios (p. ej. bot-manager y bot-build-worker) comparten imagen:
      // exigimos que la construyan igual, o el nombre estaría mintiendo.
      expect(previo.dockerfile, `servicios con la imagen ${imagen} y Dockerfile distinto`).toBe(dockerfile);
      expect(previo.args, `servicios con la imagen ${imagen} y build-args distintos`).toEqual(args);
      previo.servicios.push(nombre);
      continue;
    }
    porImagen.set(imagen, { imagen, dockerfile, args, identidad, servicios: [nombre] });
  }
  return [...porImagen.values()].sort((a, b) => a.imagen.localeCompare(b.imagen));
}

/** Entradas de la matriz `build-images` del workflow de CI. */
export function matrizDeLaCi(ci: string): Construccion[] {
  const doc = parse(ci) as any;
  const include = doc?.jobs?.["build-images"]?.strategy?.matrix?.include;
  expect(Array.isArray(include), "la CI ya no tiene matriz build-images.include").toBe(true);
  return (include as any[])
    .map((e) => ({
      imagen: String(e.service),
      dockerfile: String(e.dockerfile),
      args: String(e.build_args ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .sort(),
      identidad: [],
      servicios: [],
    }))
    .sort((a, b) => a.imagen.localeCompare(b.imagen));
}

const compose = readFileSync(COMPOSE_PATH, "utf8");
const ci = readFileSync(CI_PATH, "utf8");
const delCompose = construccionesDelCompose(compose);
const deLaCi = matrizDeLaCi(ci);

describe("B13 · matriz de imágenes de la CI vs Compose", () => {
  it("la CI construye exactamente las mismas imágenes que el Compose", () => {
    expect(deLaCi.map((c) => c.imagen)).toEqual(delCompose.map((c) => c.imagen));
  });

  it("cada imagen se construye con el MISMO Dockerfile en la CI y en el Compose", () => {
    for (const esperado of delCompose) {
      const enCi = deLaCi.find((c) => c.imagen === esperado.imagen);
      expect(enCi, `la CI no construye la imagen ${esperado.imagen}`).toBeDefined();
      expect(
        enCi!.dockerfile,
        `${esperado.imagen}: la CI valida ${enCi!.dockerfile} pero el despliegue construye ${esperado.dockerfile}`,
      ).toBe(esperado.dockerfile);
    }
  });

  it("cada imagen se construye con los MISMOS build-args (APP_PATH incluido)", () => {
    for (const esperado of delCompose) {
      const enCi = deLaCi.find((c) => c.imagen === esperado.imagen)!;
      expect(enCi.args, `${esperado.imagen}: build-args distintos entre CI y Compose`).toEqual(esperado.args);
    }
  });

  it("las dos imágenes que no construía nadie (streamer y backup) están cubiertas", () => {
    // Guardia explícita del encargo B13: si alguien las vuelve a sacar de la
    // matriz, este test lo dice con su nombre y no solo con un diff de listas.
    for (const imagen of ["streamer", "backup"]) {
      const enCi = deLaCi.find((c) => c.imagen === imagen);
      expect(
        enCi,
        `la CI dejó de construir ${imagen}: sus cambios volverían a validarse solo en producción`,
      ).toBeDefined();
    }
  });

  it("los Dockerfile que la matriz nombra existen de verdad en el repo", () => {
    for (const c of deLaCi) {
      expect(
        () => readFileSync(join(REPO, c.dockerfile), "utf8"),
        `${c.imagen}: ${c.dockerfile} no existe`,
      ).not.toThrow();
    }
  });
});

describe("B13 · el emparejador detecta los desajustes que se le escaparon a la CI", () => {
  // No-vacuidad: el emparejador reacciona a un Compose/CI manipulados, no
  // aprueba por construcción.
  it("detecta una imagen del Compose que la matriz no construye", () => {
    const recortada = ci.replace(/          - service: streamer\n(            .*\n)+/, "");
    expect(recortada).not.toBe(ci);
    const sinStreamer = matrizDeLaCi(recortada).map((c) => c.imagen);
    expect(sinStreamer).not.toContain("streamer");
    expect(delCompose.map((c) => c.imagen)).toContain("streamer");
  });

  it("detecta que la CI construya una imagen con otro Dockerfile (el caso `web`)", () => {
    const desviada = ci.replace(
      "          - service: web\n            dockerfile: infrastructure/docker/web/Dockerfile",
      "          - service: web\n            dockerfile: infrastructure/docker/node-service/Dockerfile",
    );
    expect(desviada).not.toBe(ci);
    const web = matrizDeLaCi(desviada).find((c) => c.imagen === "web")!;
    const webCompose = delCompose.find((c) => c.imagen === "web")!;
    expect(web.dockerfile).not.toBe(webCompose.dockerfile);
  });

  it("detecta un servicio nuevo del Compose con build sin entrada en la matriz", () => {
    const nuevo =
      "  servicio-nuevo:\n" +
      "    build:\n" +
      "      context: ..\n" +
      "      dockerfile: infrastructure/docker/node-service/Dockerfile\n" +
      "      args: { APP_PATH: apps/nuevo }\n" +
      "    image: ${IMAGE_PREFIX:-ghcr.io/pjclavero/s9-ai-arena}/servicio-nuevo:${TAG:-latest}\n";
    const ampliado = compose.replace("  gateway:\n", `${nuevo}  gateway:\n`);
    expect(ampliado).not.toBe(compose);
    const imagenes = construccionesDelCompose(ampliado).map((c) => c.imagen);
    expect(imagenes).toContain("servicio-nuevo");
    expect(deLaCi.map((c) => c.imagen)).not.toContain("servicio-nuevo");
  });
  it("ADR-016 · TODA imagen del Compose recibe los tres build-args de identidad", () => {
    // El incidente que motiva esto (build del árbol viejo etiquetado con el
    // commit nuevo) fue invisible porque NADA dentro de la imagen decía de qué
    // código salió. Si alguien añade una imagen sin estos args, su /version y
    // su LABEL dirán "unknown" y el gate la rechazará: mejor verlo aquí.
    for (const c of delCompose) {
      expect([...c.identidad].sort(), `${c.imagen}: le faltan build-args de identidad`).toEqual(
        [...ARGS_IDENTIDAD].sort(),
      );
    }
  });

  it("ADR-016 · el paso de build de la CI pasa los tres build-args de identidad", () => {
    const doc = parse(ci) as any;
    const pasos: any[] = doc?.jobs?.["build-images"]?.steps ?? [];
    const build = pasos.find((p) => String(p?.uses ?? "").startsWith("docker/build-push-action"));
    expect(build, "la CI ya no tiene un paso docker/build-push-action en build-images").toBeDefined();
    const buildArgs = String(build.with?.["build-args"] ?? "");
    for (const arg of ARGS_IDENTIDAD) {
      expect(buildArgs, `la CI no pasa ${arg}: publicaría imágenes sin procedencia`).toContain(`${arg}=`);
    }
    // Y el commit tiene que ser el del run, no un literal escrito a mano.
    expect(buildArgs).toContain("github.sha");
  });
});
