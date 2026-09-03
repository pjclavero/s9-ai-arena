/**
 * ADR-016 · Los CUATRO estados de drift de imagen.
 *
 * Esta suite no comprueba que el clasificador compile: comprueba que SABE
 * PONERSE ROJO. Cada estado tiene su prueba y cada prueba se ha visto fallar
 * bajo una mutación del código de producción (ver la tabla del PR).
 *
 * La mutación que más importa está abajo del todo: reintroducir
 * `docker images -q` como prueba de existencia. Ese listado omite las imágenes
 * sin etiqueta de nivel superior, y en VM108 hay una exactamente así. Sin esta
 * prueba, el arreglo no está probado: sólo escrito.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error — script .mjs sin tipos, se consume desde tests y CI.
import {
  clasificarDrift,
  lineasInforme,
  IMAGE_MISSING,
  TAG_CONTENT_MISMATCH,
  TAG_MOVED,
  RUNTIME_MATCH,
} from "../scripts/lib/image-drift.mjs";
// @ts-expect-error — script .mjs sin tipos.
import { observarContenedor, clasificarDaemon, resumen } from "../scripts/check-running-image-id.mjs";

const ID_A = "sha256:" + "a".repeat(64);
const ID_B = "sha256:" + "b".repeat(64);
const COMMIT = "4d469dc0000000000000000000000000000000aa";
const OTRO = "98f381ec00000000000000000000000000000bbb";

// ── Los cuatro estados, sobre el núcleo puro ────────────────────────────────

describe("ADR-016 · cuatro estados de drift", () => {
  it("RUNTIME_MATCH · la image ID en ejecución es a la que resuelve la referencia", () => {
    const c = clasificarDrift({
      nombre: "api",
      runningImageId: ID_A,
      referencia: `s9arena/api:${COMMIT.slice(0, 7)}`,
      imagenResoluble: true,
      idDeLaReferencia: ID_A,
    });
    expect(c.estado).toBe(RUNTIME_MATCH);
    expect(c.runtimeImageExists).toBe(true);
    expect(c.tagPointsToRuntime).toBe(true);
  });

  it("RUNTIME_MATCH · con pin (d) que coincide con la image ID en ejecución", () => {
    const c = clasificarDrift({
      nombre: "api",
      runningImageId: ID_A,
      referencia: "s9arena/api@sha256:pinned",
      imagenResoluble: true,
      idDeLaReferencia: ID_A,
      digestEsperado: ID_A,
    });
    expect(c.estado).toBe(RUNTIME_MATCH);
    expect(c.pinMatchesRuntime).toBe(true);
  });

  it("IMAGE_MISSING · el contenedor corre una image ID que ya no existe", () => {
    const c = clasificarDrift({
      nombre: "replay-service",
      runningImageId: ID_B,
      referencia: `s9arena/replay-service:${COMMIT.slice(0, 7)}`,
      imagenResoluble: false,
      idDeLaReferencia: null,
    });
    expect(c.estado).toBe(IMAGE_MISSING);
    expect(c.runtimeImageExists).toBe(false);
    expect(c.explicacion).toMatch(/no es reproducible/);
  });

  it("TAG_MOVED · la imagen que corre existe, pero la referencia resuelve hoy a otra", () => {
    const c = clasificarDrift({
      nombre: "postgres",
      runningImageId: ID_A,
      referencia: "postgres:16-alpine",
      imagenResoluble: true,
      idDeLaReferencia: ID_B,
    });
    expect(c.estado).toBe(TAG_MOVED);
    expect(c.runtimeImageExists).toBe(true);
    expect(c.tagPointsToRuntime).toBe(false);
  });

  it("TAG_MOVED · el pin esperado no es la image ID en ejecución", () => {
    const c = clasificarDrift({
      nombre: "api",
      runningImageId: ID_A,
      referencia: "s9arena/api@sha256:pinned",
      imagenResoluble: true,
      idDeLaReferencia: ID_A,
      digestEsperado: ID_B,
    });
    expect(c.estado).toBe(TAG_MOVED);
    expect(c.pinMatchesRuntime).toBe(false);
  });

  it("TAG_CONTENT_MISMATCH · la etiqueta existe pero contiene código distinto", () => {
    const c = clasificarDrift({
      nombre: "web",
      runningImageId: ID_A,
      referencia: `s9arena/web:${COMMIT.slice(0, 7)}`,
      imagenResoluble: true,
      idDeLaReferencia: ID_A,
      envImagen: { BUILD_COMMIT: OTRO },
      labelsImagen: { "org.opencontainers.image.revision": OTRO },
    });
    expect(c.estado).toBe(TAG_CONTENT_MISMATCH);
    expect(c.procedencia).toBe("verified");
  });

  it("el contenido pesa más que la referencia: mentira de contenido Y etiqueta movida ⇒ TAG_CONTENT_MISMATCH", () => {
    const c = clasificarDrift({
      nombre: "web",
      runningImageId: ID_A,
      referencia: `s9arena/web:${COMMIT.slice(0, 7)}`,
      imagenResoluble: true,
      idDeLaReferencia: ID_B,
      envImagen: { BUILD_COMMIT: OTRO },
    });
    expect(c.estado).toBe(TAG_CONTENT_MISMATCH);
  });

  it("una image ID inexistente no se clasifica por su etiqueta: IMAGE_MISSING gana", () => {
    const c = clasificarDrift({
      nombre: "x",
      runningImageId: ID_B,
      referencia: "postgres:16-alpine",
      imagenResoluble: false,
      idDeLaReferencia: ID_A,
    });
    expect(c.estado).toBe(IMAGE_MISSING);
  });
});

// ── Procedencia: jamás "verificada" sin identidad embebida ──────────────────

describe("ADR-016 · procedencia no se aprueba por omisión", () => {
  it("imagen anterior a ADR-016 (sin identidad embebida) ⇒ not_exercised, no 'verificada'", () => {
    const c = clasificarDrift({
      nombre: "api",
      runningImageId: ID_A,
      referencia: `s9arena/api:${COMMIT.slice(0, 7)}`,
      imagenResoluble: true,
      idDeLaReferencia: ID_A,
    });
    expect(c.estado).toBe(RUNTIME_MATCH);
    expect(c.procedencia).toBe("not_exercised");
    expect(c.commitEmbebido).toBeNull();
  });

  it("BUILD_COMMIT='unknown' es AUSENCIA de identidad, no una identidad", () => {
    const c = clasificarDrift({
      nombre: "api",
      runningImageId: ID_A,
      referencia: `s9arena/api:${COMMIT.slice(0, 7)}`,
      imagenResoluble: true,
      idDeLaReferencia: ID_A,
      envImagen: { BUILD_COMMIT: "unknown" },
    });
    expect(c.procedencia).toBe("not_exercised");
    expect(c.estado).toBe(RUNTIME_MATCH);
  });

  it("una referencia que no anuncia commit (postgres:16-alpine) no genera falso TAG_CONTENT_MISMATCH", () => {
    const c = clasificarDrift({
      nombre: "postgres",
      runningImageId: ID_A,
      referencia: "postgres:16-alpine",
      imagenResoluble: true,
      idDeLaReferencia: ID_A,
      envImagen: { BUILD_COMMIT: OTRO },
    });
    expect(c.estado).toBe(RUNTIME_MATCH);
  });

  it("s9arena/backup:11b36a7 es baseline legítimo, no drift", () => {
    const c = clasificarDrift({
      nombre: "backup",
      runningImageId: ID_A,
      referencia: "s9arena/backup:11b36a7",
      imagenResoluble: true,
      idDeLaReferencia: ID_A,
    });
    expect(c.estado).toBe(RUNTIME_MATCH);
  });
});

// ── El informe tiene que poder decir la verdad del caso postgres ────────────

describe("ADR-016 · el informe dice la verdad literal del caso de VM108", () => {
  it("runtime image exists = YES, tag still points to runtime image = NO, drift = TAG_MOVED", () => {
    const c = clasificarDrift({
      nombre: "infrastructure-postgres-1",
      runningImageId: "sha256:57c72fd2a128" + "0".repeat(52),
      referencia: "postgres:16-alpine",
      imagenResoluble: true,
      idDeLaReferencia: "sha256:cf78e76683b9" + "0".repeat(52),
    });
    const texto = lineasInforme(c).join("\n");
    expect(texto).toContain("runtime image exists      = YES");
    expect(texto).toContain("tag still points to runtime image = NO");
    expect(texto).toContain("drift = TAG_MOVED");
    expect(texto).toContain("embedded build identity   = not_exercised");
  });
});

// ── Daemon simulado: la observación, no sólo el núcleo puro ─────────────────

/**
 * Ejecutor falso que reproduce el daemon de VM108 en el punto que importa:
 * la image ID de postgres EXISTE (`docker image inspect` la resuelve) pero NO
 * aparece en `docker images -q` porque se quedó sin RepoTags.
 */
function daemonDeVM108() {
  const running: Record<string, [string, string, string]> = {
    c1: ["/infrastructure-api-1", ID_A, "s9arena/api:4d469dc"],
    c2: ["/infrastructure-postgres-1", ID_B, "postgres:16-alpine"],
  };
  const idsResolubles = new Set([ID_A, ID_B]);
  const refs: Record<string, string> = {
    "s9arena/api:4d469dc": ID_A,
    // la etiqueta se movió: ya no apunta a la imagen que corre postgres
    "postgres:16-alpine": "sha256:" + "c".repeat(64),
  };
  // `docker images -q` NO incluye ID_B: sin RepoTags, no sale en el listado.
  const listadoImagesQ = [ID_A, refs["postgres:16-alpine"]];

  return (cmd: string, args: string[]) => {
    const ok = (out: string) => ({ rc: 0, out, err: "" });
    const ko = (err: string) => ({ rc: 1, out: "", err });
    if (cmd !== "docker") return ko("no es docker");
    if (args[0] === "ps") return ok(Object.keys(running).join("\n"));
    if (args[0] === "inspect") {
      const id = args[args.length - 1];
      const c = running[id];
      return c ? ok(c.join("\t")) : ko("No such container");
    }
    if (args[0] === "image" && args[1] === "inspect") {
      const ref = args[2];
      if (args.includes("{{.Id}}")) {
        const resuelto = refs[ref] ?? (idsResolubles.has(ref) ? ref : null);
        return resuelto ? ok(resuelto) : ko("No such image");
      }
      if (idsResolubles.has(ref) || refs[ref]) return ok("[]\t{}");
      return ko("No such image");
    }
    if (args[0] === "images") return ok(listadoImagesQ.join("\n"));
    return ko(`comando no simulado: ${args.join(" ")}`);
  };
}

describe("ADR-016 · observación contra un daemon simulado como el de VM108", () => {
  it("MUTACIÓN GUARDA · la existencia se prueba con `docker image inspect`, no con `docker images -q`", () => {
    // Éste es EL test del defecto corregido. La image ID de postgres no está en
    // `docker images -q` pero sí existe. Si alguien reintroduce ese listado como
    // prueba de existencia, `runtimeImageExists` pasa a false y este test se
    // pone rojo con IMAGE_MISSING en vez de TAG_MOVED.
    const obs = observarContenedor("c2", daemonDeVM108());
    expect(obs.imagenResoluble).toBe(true);

    const c = clasificarDrift(obs);
    expect(c.runtimeImageExists).toBe(true);
    expect(c.estado).toBe(TAG_MOVED);
    expect(c.estado).not.toBe(IMAGE_MISSING);
  });

  it("la observación NO ejecuta ningún comando que modifique el daemon", () => {
    const ejecutados: string[][] = [];
    const base = daemonDeVM108();
    clasificarDaemon((cmd: string, args: string[]) => {
      ejecutados.push([cmd, ...args]);
      return base(cmd, args);
    });
    const prohibidos =
      /^(run|start|stop|restart|rm|rmi|pull|push|create|kill|exec|prune|build|compose|tag|load|import|update|commit)$/;
    for (const [, sub, sub2] of ejecutados) {
      expect(sub).not.toMatch(prohibidos);
      if (sub === "image") expect(sub2).toBe("inspect");
    }
    expect(ejecutados.length).toBeGreaterThan(0);
  });

  it("clasifica el daemon entero y resume por estado", () => {
    const cs = clasificarDaemon(daemonDeVM108());
    expect(cs.map((c: { nombre: string }) => c.nombre)).toEqual(["infrastructure-api-1", "infrastructure-postgres-1"]);
    expect(cs.map((c: { estado: string }) => c.estado)).toEqual([RUNTIME_MATCH, TAG_MOVED]);
    expect(resumen(cs)).toContain("TAG_MOVED=1");
  });

  it("un pin declarado por el operador se compara contra la image ID en ejecución", () => {
    const cs = clasificarDaemon(daemonDeVM108(), { "infrastructure-api-1": ID_B });
    const api = cs.find((c: { nombre: string }) => c.nombre === "infrastructure-api-1");
    expect(api.pinMatchesRuntime).toBe(false);
    expect(api.estado).toBe(TAG_MOVED);
  });
});
