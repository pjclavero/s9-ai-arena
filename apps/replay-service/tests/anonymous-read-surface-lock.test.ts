/**
 * Carril REPLAY ACCESS GOVERNANCE · Lock de la superficie de LECTURA del
 * replay-service y de lo que el gateway publica hacia él.
 *
 * Por qué existe: el agujero que motiva este carril (`GET /replays/*` servido
 * anónimo a través del gateway, sin que ninguna capability lo gobierne) nació
 * porque nadie tenía INVENTARIADA la superficie del servicio. B8 autenticó la
 * ESCRITURA y dejó la lectura abierta a propósito; el `location /replays/` del
 * gateway convirtió esa decisión interna en superficie pública. Ninguna de las
 * dos partes era visible desde la otra.
 *
 * Qué hace, y qué NO hace:
 *
 *  - NO cuenta apariciones de texto en el código ni hace grep sobre el fuente:
 *    INSTANCIA el servicio por el mismo camino que producción
 *    (`resolveIngestSecretFromEnv` sobre un entorno LIMPIO ⇒ `undefined`, que es
 *    el valor por defecto y el que decide) y ENUMERA su router real.
 *  - Clasifica cada ruta por su EFECTO OBSERVABLE: se le hace la petición HTTP
 *    de verdad sin credencial y se mira si responde 401 ("guardada") o no
 *    ("abierta"). Un guard que estuviera montado pero no cortase se clasifica
 *    como abierto, que es lo que importa.
 *  - NO afirma que la lectura abierta esté bien. Congela el estado MEDIDO para
 *    que ningún cambio lo amplíe en silencio, y para que el día que se
 *    implemente el contrato (docs/CARRIL_REPLAY_ACCESS_GOVERNANCE.md) haya que
 *    actualizar este inventario a conciencia.
 *
 * Este fichero es también el control que faltaba para la lección del carril J:
 * la instancia bajo prueba se construye con el DEFECTO de producción, no con un
 * valor inyectado cómodo.
 */
import { describe, expect, it } from "vitest";
import express, { type Express } from "express";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { createReplayServer } from "../src/server.js";
import { resolveIngestSecretFromEnv } from "../src/auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..", "..");

/** Ruta enumerada del router real: método + patrón Express. */
interface RouteRef {
  method: string;
  path: string;
}

/** Enumera el router REAL de una app Express (Express 5: `app.router.stack`). */
function enumerateRoutes(app: Express): RouteRef[] {
  const stack = ((app as unknown as { router?: { stack?: unknown[] } }).router?.stack ??
    (app as unknown as { _router?: { stack?: unknown[] } })._router?.stack ??
    []) as Array<{ route?: { path: unknown; methods?: Record<string, boolean> } }>;
  const out: RouteRef[] = [];
  for (const layer of stack) {
    const route = layer.route;
    if (!route) continue;
    const paths = Array.isArray(route.path) ? route.path : [route.path];
    for (const p of paths) {
      for (const [method, on] of Object.entries(route.methods ?? {})) {
        if (on) out.push({ method: method.toUpperCase(), path: String(p) });
      }
    }
  }
  return out.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}

/** Sustituye los parámetros del patrón por un id inexistente: no se toca disco. */
function concreteUrl(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, "id-que-no-existe");
}

/**
 * Clasificación por EFECTO: se hace la petición sin ninguna credencial.
 * 401 ⇒ la ruta está guardada; cualquier otra cosa (200/404/400/416…) ⇒ la ruta
 * atendió a un anónimo, aunque el recurso no existiera.
 */
async function classify(app: Express, r: RouteRef): Promise<"guardada" | "abierta"> {
  const agent = request(app) as unknown as Record<string, (u: string) => Promise<{ status: number }>>;
  const res = await agent[r.method.toLowerCase()](concreteUrl(r.path));
  return res.status === 401 ? "guardada" : "abierta";
}

async function surfaceOf(app: Express): Promise<Record<string, "guardada" | "abierta">> {
  const out: Record<string, "guardada" | "abierta"> = Object.create(null);
  for (const r of enumerateRoutes(app)) out[`${r.method} ${r.path}`] = await classify(app, r);
  return out;
}

/**
 * Construcción COMO PRODUCCIÓN: `apps/replay-service/src/main.ts` resuelve el
 * secreto del entorno y monta `createReplayServer`. Aquí el entorno va VACÍO a
 * propósito — es el defecto, y el defecto es lo que decide.
 */
function appComoProduccion(): Express {
  const dir = mkdtempSync(join(tmpdir(), "replay-surface-lock-"));
  const internalSecret = resolveIngestSecretFromEnv({} as NodeJS.ProcessEnv);
  expect(internalSecret).toBeUndefined(); // sin configurar ⇒ fail-closed en escritura
  // `main.ts` monta esta misma app en la raíz (`app.use(createReplayServer(...))`),
  // así que enumerar y pedir sobre ella es exactamente la superficie servida.
  return createReplayServer({ dir, internalSecret });
}

/**
 * INVENTARIO DECLARADO. Estado MEDIDO hoy, no estado deseado.
 * Cambiar el servicio sin actualizar esta tabla pone el test en rojo.
 */
const INVENTARIO_ESPERADO: Record<string, "guardada" | "abierta"> = {
  // Lectura: anónima hoy — es justo el hallazgo de este carril.
  "GET /replays": "abierta",
  "GET /replays/:battleId": "abierta",
  "GET /replays/:battleId/index": "abierta",
  "GET /replays/:battleId/segment": "abierta",
  "POST /replays/:battleId/verify": "abierta",
  // Escritura: autenticada desde B8, fail-closed sin secreto configurado.
  "POST /replays/:battleId": "guardada",
  "POST /retention/sweep": "guardada",
};

describe("Lock de superficie · replay-service instanciado como producción", () => {
  it("el router real no tiene más rutas que las inventariadas", async () => {
    const rutas = enumerateRoutes(appComoProduccion()).map((r) => `${r.method} ${r.path}`);
    expect(new Set(rutas)).toEqual(new Set(Object.keys(INVENTARIO_ESPERADO)));
  });

  it("cada ruta se comporta ante un anónimo como declara el inventario", async () => {
    expect({ ...(await surfaceOf(appComoProduccion())) }).toEqual(INVENTARIO_ESPERADO);
  });

  it("sin secreto configurado (el DEFECTO de producción) ninguna escritura pasa", async () => {
    const superficie = await surfaceOf(appComoProduccion());
    const escrituras = Object.entries(superficie).filter(([k]) => k.startsWith("POST") && !k.endsWith("/verify"));
    expect(escrituras.length).toBeGreaterThan(0);
    for (const [ruta, estado] of escrituras) expect([ruta, estado]).toEqual([ruta, "guardada"]);
  });

  // ------------------------------------------------------------- MUTACIONES
  // El clasificador tiene que ser capaz de PONERSE ROJO. Se mutan copias de la
  // app (nunca el fuente) y se comprueba que el inventario deja de cuadrar.

  it("MUTACIÓN · una ruta de lectura NUEVA sin guard rompe el inventario", async () => {
    const app = appComoProduccion();
    app.get("/replays/:battleId/raw", (_req, res) => {
      res.status(200).send("bytes");
    });
    const superficie = await surfaceOf(app);
    expect(superficie["GET /replays/:battleId/raw"]).toBe("abierta");
    expect(superficie).not.toEqual(INVENTARIO_ESPERADO);
  });

  it("MUTACIÓN · una escritura montada SIN guard se detecta como abierta", async () => {
    const app = appComoProduccion();
    app.post("/retention/sweep-sin-guard", (_req, res) => {
      res.json({ borrados: 0 });
    });
    const superficie = await surfaceOf(app);
    expect(superficie["POST /retention/sweep-sin-guard"]).toBe("abierta");
    expect(superficie).not.toEqual(INVENTARIO_ESPERADO);
  });

  it("MUTACIÓN · un guard que responde 200 en vez de 401 se clasifica como abierto", async () => {
    const app = express();
    // Guard invertido (el fallo clásico: fail-OPEN sin secreto configurado).
    app.post(
      "/replays/:battleId",
      (_req, _res, next) => next(),
      (_req, res) => res.status(201).json({ ok: true }),
    );
    const superficie = await surfaceOf(app);
    expect(superficie["POST /replays/:battleId"]).toBe("abierta");
    expect(superficie["POST /replays/:battleId"]).not.toBe(INVENTARIO_ESPERADO["POST /replays/:battleId"]);
  });
});

/**
 * Segundo control, en OTRO proceso: qué publica el gateway hacia el servicio.
 * El agujero solo es visible cruzando ambos lados, así que ambos se inventarían.
 */
function locationsHacia(conf: string, upstream: string): string[] {
  const out: string[] = [];
  const re = /location\s+([^\s{]+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(conf))) {
    // Recorte por emparejamiento de llaves: nada de expresiones regulares
    // "adivinando" dónde acaba el bloque.
    let depth = 1;
    let i = re.lastIndex;
    for (; i < conf.length && depth > 0; i++) {
      if (conf[i] === "{") depth++;
      else if (conf[i] === "}") depth--;
    }
    const cuerpo = conf.slice(re.lastIndex, i);
    if (cuerpo.includes(upstream)) out.push(m[1]);
  }
  return out.sort();
}

describe("Lock de superficie · lo que el gateway publica hacia replay-service", () => {
  const confs = ["infrastructure/gateway/nginx.conf", "infrastructure/gateway/nginx-behind-proxy.conf"];

  for (const rel of confs) {
    it(`${rel} publica exactamente el prefijo inventariado`, () => {
      const conf = readFileSync(join(REPO, rel), "utf8");
      expect(locationsHacia(conf, "replay-service")).toEqual(["/replays/"]);
    });
  }

  it("MUTACIÓN · un location NUEVO hacia replay-service rompe el inventario", () => {
    const conf = readFileSync(join(REPO, confs[0]), "utf8").replace(
      "    location /replays/ {",
      "    location /retention/ {\n      proxy_pass http://replay-service:8083;\n    }\n\n    location /replays/ {",
    );
    expect(locationsHacia(conf, "replay-service")).toEqual(["/replays/", "/retention/"]);
  });
});
