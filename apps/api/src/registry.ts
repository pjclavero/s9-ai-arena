/**
 * T7.2 · Registro de operaciones: cada endpoint implementado se declara por su
 * operationId del contrato de E1. El método, la ruta y el rol mínimo salen del
 * OpenAPI (x-min-role): imposible implementar una ruta que no esté en el contrato
 * y imposible olvidarse del RBAC. El test de matriz rol×endpoint itera este registro.
 */
import type { NextFunction, Request, RequestHandler, Response, Router } from "express";
import { loadContract, toExpressPath, ROLE_RANK, type ContractOperation } from "./openapi.js";
import { forbidden, unauthorized } from "./errors.js";
import type { RoleName } from "./db/migrations.js";

export interface RegisteredOperation extends ContractOperation {
  /** true si es una extensión documentada fuera del contrato (p. ej. recuperación de cuenta). */
  extension?: boolean;
}

export const implementedOperations: RegisteredOperation[] = [];

function rbacGuard(minRole: RoleName): RequestHandler {
  const required = ROLE_RANK[minRole];
  return (req: Request, _res: Response, next: NextFunction) => {
    if (required <= ROLE_RANK.visitor) return next();
    if (!req.auth) return next(unauthorized());
    if (req.auth.rank < required) return next(forbidden(`Requiere rol ${minRole}`));
    next();
  };
}

type Handler = (req: Request, res: Response) => Promise<void> | void;

function wrap(handler: Handler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res)).catch(next);
  };
}

/** Registra una operación DEL CONTRATO en el router. */
export function defineOperation(router: Router, operationId: string, handler: Handler, ...pre: RequestHandler[]): void {
  const op = loadContract().byOperationId.get(operationId);
  if (!op) throw new Error(`Operación fuera del contrato de E1: ${operationId}`);
  if (!implementedOperations.some((o) => o.operationId === operationId)) {
    implementedOperations.push(op);
  }
  (router as unknown as Record<string, (p: string, ...h: RequestHandler[]) => void>)[op.method](
    toExpressPath(op.path),
    rbacGuard(op.minRole),
    ...pre,
    wrap(handler),
  );
}

/** Registra una EXTENSIÓN documentada que no está en el contrato (se marca en la entrega). */
export function defineExtension(
  router: Router,
  spec: { operationId: string; method: string; path: string; minRole: RoleName },
  handler: Handler,
  ...pre: RequestHandler[]
): void {
  if (!implementedOperations.some((o) => o.operationId === spec.operationId)) {
    implementedOperations.push({
      ...spec,
      anonymous: spec.minRole === "visitor",
      reauth: false,
      tags: ["extension"],
      extension: true,
    });
  }
  (router as unknown as Record<string, (p: string, ...h: RequestHandler[]) => void>)[spec.method](
    toExpressPath(spec.path),
    rbacGuard(spec.minRole),
    ...pre,
    wrap(handler),
  );
}
