/**
 * T7.2 · Lectura del contrato OpenAPI de E1 (apps/api/openapi.yaml).
 *
 * El middleware RBAC lee la matriz x-min-role de aquí: la fuente de autorización
 * es el CONTRATO, no la interfaz web (que solo oculta, nunca autoriza). El test de
 * fuga de T7.5 usa privateFieldNames() (extensión x-private).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { ROLES, type RoleName } from "./db/migrations.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ContractOperation {
  operationId: string;
  method: string; // get/post/patch/put/delete
  path: string; // estilo OpenAPI: /bots/{botId}
  minRole: RoleName;
  /** true si la operación lleva `security: []` (accesible sin token). */
  anonymous: boolean;
  tags: string[];
}

export interface Contract {
  raw: Record<string, unknown>;
  operations: ContractOperation[];
  byOperationId: Map<string, ContractOperation>;
  privateFieldNames: Set<string>;
}

export const ROLE_RANK: Record<RoleName, number> = Object.fromEntries(ROLES.map((r, i) => [r, i])) as Record<
  RoleName,
  number
>;

let cached: Contract | undefined;

export function loadContract(): Contract {
  if (cached) return cached;
  const doc = parse(readFileSync(join(__dirname, "..", "openapi.yaml"), "utf8"));

  const operations: ContractOperation[] = [];
  for (const [path, methods] of Object.entries(doc.paths as Record<string, Record<string, unknown>>)) {
    for (const [method, op] of Object.entries(methods)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      const o = op as Record<string, unknown>;
      operations.push({
        operationId: String(o.operationId),
        method,
        path,
        minRole: (o["x-min-role"] as RoleName) ?? "user",
        anonymous: Array.isArray(o.security) && o.security.length === 0,
        tags: (o.tags as string[]) ?? [],
      });
    }
  }

  // Nombres de campo marcados x-private en cualquier esquema del contrato.
  const privateFields = new Set<string>();
  (function walk(node: unknown): void {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (obj.properties && typeof obj.properties === "object") {
      for (const [name, schema] of Object.entries(obj.properties as Record<string, unknown>)) {
        if (schema && typeof schema === "object" && (schema as Record<string, unknown>)["x-private"] === true) {
          privateFields.add(name);
        }
      }
    }
    Object.values(obj).forEach(walk);
  })(doc);

  cached = {
    raw: doc,
    operations,
    byOperationId: new Map(operations.map((o) => [o.operationId, o])),
    privateFieldNames: privateFields,
  };
  return cached;
}

/** /bots/{botId} → /bots/:botId (ruta Express). */
export function toExpressPath(openapiPath: string): string {
  return openapiPath.replace(/\{([^}]+)\}/g, ":$1");
}
