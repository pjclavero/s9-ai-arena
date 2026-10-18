/**
 * REVIEW (cierre funcional, R9) · TD-030 — CONTRATO process.env ↔ compose ↔ .env.example.
 *
 * Para cada servicio Node del stack (api, tournament-worker, bot-build-worker) se
 * recorre el GRAFO DE IMPORTS real desde su entrypoint (AST: imports estáticos y
 * `import()` literales, resueltos a ficheros del repo) y se recogen las lecturas de
 * entorno (`process.env.X`, `process.env["X"]` y `env.X` sobre un parámetro `env`
 * que por defecto es `process.env`). Cada variable leída tiene que estar:
 *   - declarada en el bloque `environment` del servicio en el compose, o
 *   - en la lista INTERNA de abajo, con su motivo (identidad de build que pone el
 *     Dockerfile, alternativas en claro de un *_FILE, variables sólo de dev/test,
 *     o las que el código recibe por otra vía).
 * Y cada `${VAR…}` que el compose interpola en esos servicios tiene que estar
 * documentada en infrastructure/.env.example (comentada o no).
 *
 * Techo declarado (lo que esta red NO ve): lecturas con nombre calculado
 * (`process.env[nombre]`), desestructuración de `process.env`, y entorno leído por
 * dependencias de node_modules. Controles positivos al final: el extractor ve
 * lecturas conocidas y una variable inventada se detecta como no declarada.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import * as acorn from "acorn";
import { parseDocument } from "yaml";

const AQUI = dirname(fileURLToPath(import.meta.url));
const REPO = join(AQUI, "..", "..");

type AnyNode = { type: string; [k: string]: unknown };

function parseFile(file: string): AnyNode {
  let src = readFileSync(file, "utf8");
  if (file.endsWith(".ts")) src = stripTypeScriptTypes(src, { mode: "transform" });
  return acorn.parse(src, { ecmaVersion: "latest", sourceType: "module" }) as unknown as AnyNode;
}

function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec);
  for (const cand of [base, base.replace(/\.js$/, ".ts"), base.replace(/\.mjs$/, ".mts"), `${base}.ts`]) {
    if (existsSync(cand) && /\.(ts|mjs|js)$/.test(cand)) return cand;
  }
  return null;
}

/** Lecturas de entorno en el grafo de imports alcanzable desde `entry`. */
export function envReadsFrom(entry: string): Map<string, string> {
  const reads = new Map<string, string>();
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const ast = parseFile(file);
    const visit = (n: unknown): void => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach(visit);
      const node = n as AnyNode;
      const src = node.source as AnyNode | undefined;
      if (
        (node.type === "ImportDeclaration" ||
          node.type === "ExportNamedDeclaration" ||
          node.type === "ExportAllDeclaration" ||
          node.type === "ImportExpression") &&
        src?.type === "Literal" &&
        typeof src.value === "string"
      ) {
        const r = resolveImport(file, src.value);
        if (r) queue.push(r);
      }
      if (node.type === "MemberExpression") {
        const obj = node.object as AnyNode;
        const prop = node.property as AnyNode;
        const isProcessEnv =
          obj.type === "MemberExpression" &&
          (obj.object as AnyNode).type === "Identifier" &&
          (obj.object as AnyNode).name === "process" &&
          (obj.property as AnyNode).name === "env";
        const isEnvParam = obj.type === "Identifier" && obj.name === "env";
        if (isProcessEnv || isEnvParam) {
          const name =
            !node.computed && prop.type === "Identifier"
              ? String(prop.name)
              : prop.type === "Literal" && typeof prop.value === "string"
                ? prop.value
                : null;
          if (name && /^[A-Z][A-Z0-9_]+$/.test(name) && !reads.has(name)) {
            reads.set(name, file.slice(REPO.length + 1));
          }
        }
      }
      for (const [k, v] of Object.entries(node)) if (k !== "type") visit(v);
    };
    visit(ast);
  }
  return reads;
}

const composeDoc = parseDocument(readFileSync(join(REPO, "infrastructure", "docker-compose.yml"), "utf8"), {
  merge: true,
}).toJS({ maxAliasCount: 1000 }) as { services: Record<string, { environment?: Record<string, unknown> }> };
const COMPOSE_TEXT = readFileSync(join(REPO, "infrastructure", "docker-compose.yml"), "utf8");
const ENV_EXAMPLE = readFileSync(join(REPO, "infrastructure", ".env.example"), "utf8");

/** Variables leídas que NO deben/necesitan ir en `environment`, con su motivo. */
const INTERNAS: Record<string, string> = {
  // identidad de build: la fija el Dockerfile (ARG → ENV), no el compose
  GIT_COMMIT: "identidad de build (Dockerfile)",
  COMMIT_SHA: "identidad de build (Dockerfile)",
  BUILD_COMMIT: "identidad de build (Dockerfile)",
  BUILD_DATE: "identidad de build (Dockerfile)",
  SERVICE_NAME: "identidad de build (Dockerfile)",
  // alternativas en claro de un *_FILE que sí se declara (nunca secretos en claro)
  PGPASSWORD: "alternativa en claro de PGPASSWORD_FILE",
  JWT_SECRET: "alternativa en claro de JWT_SECRET_FILE",
  ARTIFACT_SIGNING_KEY: "alternativa en claro de ARTIFACT_SIGNING_KEY_FILE",
  ARENA_ENGINE_SHARED_SECRET: "alternativa en claro (camino legado /run)",
  REPLAY_INGEST_SECRET: "alternativa en claro de REPLAY_INGEST_SECRET_FILE",
  PGPORT: "defecto 5432 del cliente; el DSN interno no lo cambia",
  // sólo desarrollo/tests: NO deben aparecer en el compose
  ARENA_DEV_INSECURE_SECRETS: "sólo dev/tests (par efímero); prohibido en el stack",
  NODE_ENV: "no se fija en las imágenes; deuda registrada (guard de wss inactivo, ver informe REVIEW)",
  // con defecto correcto en la imagen o en el código, documentadas en configuration.md
  HEARTBEAT_PATH: "defecto /tmp/heartbeat = contrato del healthcheck del compose",
  VERSION_PATH: "defecto /tmp/version.json = contrato ADR-016",
  RUNTIME_DIGESTS_LOCK: "defecto runtimes/DIGESTS.lock copiado en la imagen",
  BUILD_SANDBOX_BIND: "defecto 0.0.0.0 dentro del contenedor",
  BOT_SOURCES_DIR: "defecto = volumen arena_bot_sources montado en /data/bot-sources",
  ARENA_REPLAYS_DIR: "alias heredado de REPLAYS_DIR (se declara REPLAYS_DIR)",
  REPLAY_INGEST_TIMEOUT_MS: "ajuste opcional del camino legado /run",
  ARENA_ENGINE_RUN_TIMEOUT_MS: "ajuste opcional del camino legado /run",
  REPLAY_INGEST_REQUIRED: "ajuste opcional del camino legado /run",
  S9_READINESS_REPO: "readiness operativo: lo fija el operador al lanzarlo a mano",
  S9_READINESS_CONTAINER: "readiness operativo: lo fija el operador al lanzarlo a mano",
  S9_READINESS_BACKUP_CONTAINER: "readiness operativo: lo fija el operador al lanzarlo a mano",
  RESTIC_HOSTNAME: "sólo el servicio backup",
  S9_RUN_REAL_DOCKER_E2E: "bandera de arnés de operación; /system/status sólo publica si está",
  SMOKE_BOT_DIGEST: "bandera de arnés de operación; /system/status sólo publica si está",
  PATH: "entorno del sistema",
};

const SERVICIOS: Record<string, string> = {
  api: "apps/api/src/server.ts",
  "tournament-worker": "apps/tournament-worker/src/main.ts",
  "bot-build-worker": "apps/bot-manager/src/build-worker-main.ts",
};

function declaradas(servicio: string): Set<string> {
  return new Set(Object.keys(composeDoc.services[servicio]?.environment ?? {}));
}

/** Internas POR SERVICIO: la lectura está en el grafo pero ese servicio no la usa. */
const INTERNAS_POR_SERVICIO: Record<string, Record<string, string>> = {
  api: {
    ARTIFACT_SIGNING_KEY_FILE: "sólo si falta ARTIFACT_VERIFY_KEY_FILE (que sí se declara): la API no firma",
    ARENA_NETWORK: "createBattleLaunchHost (bot-launch.ts) está en el grafo pero la API no lanza bots",
  },
  "tournament-worker": {
    ARTIFACT_SIGNING_KEY_FILE: "sólo si falta ARTIFACT_VERIFY_KEY_FILE (que sí se declara): el worker no firma",
  },
  "bot-build-worker": {
    ARTIFACT_VERIFY_KEY_FILE: "lanzamiento en batalla (bot-launch.ts); el build no verifica, firma",
  },
};

function noDeclaradas(servicio: string, reads: Map<string, string>): string[] {
  const decl = declaradas(servicio);
  const extra = INTERNAS_POR_SERVICIO[servicio] ?? {};
  return [...reads.keys()].filter((v) => !decl.has(v) && !(v in INTERNAS) && !(v in extra)).sort();
}

describe("TD-030 · lo que cada servicio LEE está en su bloque environment (o es interno con motivo)", () => {
  for (const [servicio, entry] of Object.entries(SERVICIOS)) {
    it(`${servicio}: toda lectura de entorno está declarada`, () => {
      const reads = envReadsFrom(join(REPO, entry));
      const faltan = noDeclaradas(servicio, reads).map((v) => `${v} (${reads.get(v)})`);
      expect(faltan, `leídas y NO pasadas por el compose a ${servicio}`).toEqual([]);
    });
  }

  it("ninguna variable sólo-dev llega al stack", () => {
    for (const s of Object.keys(SERVICIOS)) expect(declaradas(s).has("ARENA_DEV_INSECURE_SECRETS")).toBe(false);
  });

  it("todo `${VAR}` que el compose interpola está documentado en infrastructure/.env.example", () => {
    const interpoladas = new Set<string>();
    const sinComentarios = COMPOSE_TEXT.split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    for (const m of sinComentarios.matchAll(/\$\{([A-Z][A-Z0-9_]*)(?::?[-?][^}]*)?\}/g)) interpoladas.add(m[1]);
    const documentadas = new Set<string>();
    for (const linea of ENV_EXAMPLE.split("\n")) {
      const m = /^\s*#?\s*([A-Z][A-Z0-9_]*)=/.exec(linea);
      if (m) documentadas.add(m[1]);
    }
    const faltan = [...interpoladas].filter((v) => !documentadas.has(v)).sort();
    expect(faltan, "interpoladas en el compose y sin documentar en .env.example").toEqual([]);
  });
});

describe("controles del extractor (si fallan, los verdes de arriba no valen)", () => {
  it("control positivo: ve lecturas conocidas del grafo de la API y del worker", () => {
    const api = envReadsFrom(join(REPO, SERVICIOS.api));
    // JWT_SECRET_FILE NO está aquí a propósito: se lee con nombre calculado
    // (resolveSecret("JWT_SECRET_FILE", …)), fuera del techo de este extractor.
    for (const v of ["SPECTATE_WS_URL", "TRUST_PROXY_HOPS", "S9_PUBLIC_REPLAYS_ENABLED", "CORS_ORIGIN"]) {
      expect(api.has(v), v).toBe(true);
    }
    const worker = envReadsFrom(join(REPO, SERVICIOS["tournament-worker"]));
    for (const v of ["DOCKER_PROXY_URL", "ARENA_ENGINE_HOST", "ARTIFACT_VERIFY_KEY_FILE", "SPECTATE_PORT"]) {
      expect(worker.has(v), v).toBe(true);
    }
  });

  it("control negativo: una lectura inventada se detecta como NO declarada", () => {
    const reads = new Map([["S9_VARIABLE_INVENTADA", "x.ts"]]);
    expect(noDeclaradas("api", reads)).toEqual(["S9_VARIABLE_INVENTADA"]);
  });
});
