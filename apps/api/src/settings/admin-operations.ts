/**
 * ADM-1 · Marco de ÓRDENES ADMINISTRATIVAS (`admin_operations`) y confirmación en dos pasos.
 *
 * MODELO DE AMENAZA. La API es lo más atacable y NO gana privilegios: aquí sólo se INSERTAN
 * órdenes de una lista CERRADA de tipos (`OPERATION_KINDS`, además del CHECK de la BD), con
 * parámetros validados por el esquema estricto de cada tipo (nunca rutas ni comandos). La
 * ejecuta el servicio que ya posee el privilegio (`operations-consumer.ts`), con su rol de BD.
 *
 * FLUJO (acciones destructivas):
 *  1. `createOperation`: el SERVIDOR calcula el resumen de impacto y devuelve un token de
 *     confirmación de UN SOLO USO (sólo se guarda su hash) con caducidad (`CONFIRM_TTL_MS`) y
 *     la FRASE LITERAL que debe teclear quien confirma. `dryRun` termina aquí: no crea orden.
 *  2. `confirmOperation`: token + frase + reautenticación fuerte (la hace la ruta). El token se
 *     consume con un UPDATE atómico condicionado a estado, hash y caducidad ⇒ un solo uso
 *     aunque haya dos confirmaciones simultáneas. Las IRREVERSIBLES exigen un SEGUNDO admin
 *     (distinto del solicitante).
 *  Una orden activa como máximo por tipo (índice único parcial): freno al abuso.
 *  Cada transición queda en `audit_log` en la misma transacción.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db/connection.js";
import { audit } from "../audit.js";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../errors.js";

/** Caducidad del token de confirmación. */
export const CONFIRM_TTL_MS = 120_000;

export type ImpactClass = "none" | "destructive" | "irreversible";
export type OperationStatus =
  "awaiting_confirmation" | "pending" | "running" | "done" | "failed" | "expired" | "cancelled";

export interface Impact {
  /** Resumen legible calculado por el servidor. */
  summary: string;
  counts: Record<string, number>;
}

export interface OperationKindDef {
  kind: string;
  /** Valida y normaliza los parámetros: sólo valores de un conjunto cerrado, UUID o enteros con rango. */
  parseParams(
    raw: unknown,
  ):
    { ok: true; params: Record<string, unknown>; error?: undefined } | { ok: false; error: string; params?: undefined };
  classify(params: Record<string, unknown>): ImpactClass;
  impact(db: Db, params: Record<string, unknown>): Promise<Impact>;
  /** Frase literal que se teclea para confirmar (la fija el servidor, no el cliente). */
  phrase(params: Record<string, unknown>, impact: Impact): string;
}

const NOOP_CLASSES: readonly ImpactClass[] = ["none", "destructive", "irreversible"];

/**
 * Tipo de PRUEBA inocuo: no hace nada. Su parámetro `impactClass` es un enumerado cerrado que
 * sólo elige qué camino del marco se recorre (sin confirmación, con ella, o con segundo admin).
 */
const SYSTEM_NOOP: OperationKindDef = {
  kind: "system.noop",
  parseParams(raw) {
    const o = raw === undefined || raw === null ? {} : raw;
    if (typeof o !== "object" || Array.isArray(o)) return { ok: false, error: "params debe ser un objeto" };
    for (const k of Object.keys(o)) if (k !== "impactClass") return { ok: false, error: `parámetro no admitido: ${k}` };
    const c = (o as { impactClass?: unknown }).impactClass ?? "none";
    if (typeof c !== "string" || !NOOP_CLASSES.includes(c as ImpactClass)) {
      return { ok: false, error: `impactClass debe ser uno de: ${NOOP_CLASSES.join(", ")}` };
    }
    return { ok: true, params: { impactClass: c } };
  },
  classify: (p) => p.impactClass as ImpactClass,
  async impact(db) {
    const r = await db("admin_operations")
      .whereIn("status", ["awaiting_confirmation", "pending", "running"])
      .count({ n: "*" })
      .first();
    const active = Number((r as { n: string | number }).n);
    return { summary: "Operación de prueba: no modifica nada.", counts: { affected: 0, activeOperations: active } };
  },
  phrase: (p) => `EJECUTAR system.noop ${String(p.impactClass)}`,
};

/**
 * Registro CERRADO de tipos de PRODUCCIÓN. ADM-4/6/7 añaden los suyos aquí (y amplían el CHECK de `kind`).
 * `system.noop` es un tipo de PRUEBA: sólo se registra en tests (NODE_ENV=test) o si se activa
 * expresamente con `S9_ADMIN_OPS_NOOP=1`; en producción la API no acepta ningún tipo todavía.
 */
export function buildOperationKinds(env: NodeJS.ProcessEnv = process.env): Readonly<Record<string, OperationKindDef>> {
  const kinds: Record<string, OperationKindDef> = {};
  if (env.NODE_ENV === "test" || env.S9_ADMIN_OPS_NOOP === "1") kinds[SYSTEM_NOOP.kind] = SYSTEM_NOOP;
  return Object.freeze(kinds);
}

export const OPERATION_KINDS: Readonly<Record<string, OperationKindDef>> = buildOperationKinds();

function kindDef(kind: unknown): OperationKindDef {
  if (typeof kind !== "string" || !Object.prototype.hasOwnProperty.call(OPERATION_KINDS, kind)) {
    throw badRequest(`tipo de operación no admitido: ${JSON.stringify(kind)}`);
  }
  return OPERATION_KINDS[kind];
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

interface OpRow {
  id: string;
  kind: string;
  params: Record<string, unknown>;
  status: OperationStatus;
  requested_by: string | null;
  confirmed_by: string | null;
  impact: Impact;
  confirm_phrase: string | null;
  confirm_expires_at: Date | null;
  requires_second_admin: boolean;
  result: unknown;
  attempts: number;
  created_at: Date;
  confirmed_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
}

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

/** Vista pública de una orden: nunca el hash del token ni el lease. */
export function operationView(r: OpRow) {
  return {
    id: r.id,
    kind: r.kind,
    params: r.params,
    status: r.status,
    impact: r.impact,
    confirmPhrase: r.status === "awaiting_confirmation" ? r.confirm_phrase : null,
    requiresSecondAdmin: r.requires_second_admin,
    requestedBy: r.requested_by,
    confirmedBy: r.confirmed_by,
    result: r.result ?? null,
    attempts: r.attempts,
    createdAt: iso(r.created_at),
    confirmExpiresAt: r.status === "awaiting_confirmation" ? iso(r.confirm_expires_at) : null,
    confirmedAt: iso(r.confirmed_at),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
  };
}

export interface Ctx {
  actorId: string | null;
  correlationId?: string;
}

const OP_AUDIT = (what: string) => `admin.op.${what}`;

async function countAdmins(db: Db): Promise<number> {
  const r = await db("user_roles").where({ role: "admin" }).countDistinct({ n: "user_id" }).first();
  return Number((r as { n: string | number }).n);
}

export async function createOperation(
  db: Db,
  ctx: Ctx,
  body: unknown,
): Promise<
  | {
      dryRun: true;
      kind: string;
      impactClass: ImpactClass;
      impact: Impact;
      requiresSecondAdmin: boolean;
      confirmPhrase: string;
    }
  | { dryRun: false; operation: ReturnType<typeof operationView>; confirmToken: string | null }
> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("el cuerpo debe ser un objeto JSON");
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b))
    if (!["kind", "params", "dryRun"].includes(k)) throw badRequest(`campo no admitido: ${k}`);
  if (b.dryRun !== undefined && typeof b.dryRun !== "boolean") throw badRequest("dryRun debe ser booleano");
  const def = kindDef(b.kind);
  const parsed = def.parseParams(b.params);
  if (!parsed.ok) throw badRequest(parsed.error);
  const params = parsed.params;
  const cls = def.classify(params);
  const impact = await def.impact(db, params);
  const requiresSecondAdmin = cls === "irreversible";
  const phrase = def.phrase(params, impact);

  if (requiresSecondAdmin && (await countAdmins(db)) < 2) {
    throw conflict(
      "second_admin_unavailable",
      "Esta acción irreversible exige un segundo administrador y sólo hay uno: hazla por consola",
    );
  }

  if (b.dryRun === true) {
    await audit(db, {
      actorId: ctx.actorId,
      action: OP_AUDIT("dry_run"),
      target: `operation:${def.kind}`,
      detail: { kind: def.kind, params, impact },
      correlationId: ctx.correlationId,
    });
    return { dryRun: true, kind: def.kind, impactClass: cls, impact, requiresSecondAdmin, confirmPhrase: phrase };
  }

  const needsConfirm = cls !== "none";
  // El segundo admin NO recibe ni comparte ningún token: aprueba desde su propia sesión (reautenticado).
  const token = needsConfirm && !requiresSecondAdmin ? randomBytes(32).toString("base64url") : null;
  let row: OpRow;
  try {
    row = await db.transaction(async (trx) => {
      const t = trx as unknown as Db;
      // Las confirmaciones caducadas de este tipo dejan de ocupar el hueco.
      const expired: { id: string }[] = await t("admin_operations")
        .where({ kind: def.kind, status: "awaiting_confirmation" })
        .where("confirm_expires_at", "<=", t.fn.now())
        .update({ status: "expired", confirm_token_hash: null, finished_at: t.fn.now() })
        .returning("id");
      for (const e of expired) {
        await audit(t, {
          actorId: null,
          action: OP_AUDIT("expired"),
          target: `operation:${e.id}`,
          detail: { kind: def.kind },
          correlationId: ctx.correlationId,
        });
      }
      const [inserted]: OpRow[] = await t("admin_operations")
        .insert({
          kind: def.kind,
          params: JSON.stringify(params),
          status: needsConfirm ? "awaiting_confirmation" : "pending",
          requested_by: ctx.actorId,
          impact: JSON.stringify(impact),
          confirm_phrase: needsConfirm ? phrase : null,
          confirm_token_hash: token ? sha256(token) : null,
          confirm_expires_at: needsConfirm ? new Date(Date.now() + CONFIRM_TTL_MS) : null,
          requires_second_admin: requiresSecondAdmin,
          confirmed_at: needsConfirm ? null : t.fn.now(),
          confirmed_by: null,
        })
        .returning("*");
      await audit(t, {
        actorId: ctx.actorId,
        action: OP_AUDIT("requested"),
        target: `operation:${inserted.id}`,
        detail: { kind: def.kind, params, impactClass: cls, impact, requiresSecondAdmin },
        correlationId: ctx.correlationId,
      });
      return inserted;
    });
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      throw conflict(
        "operation_in_progress",
        `Ya hay una operación ${def.kind} activa: espera a que termine o cancélala`,
      );
    }
    throw e;
  }
  return { dryRun: false, operation: operationView(row), confirmToken: token };
}

export async function confirmOperation(
  db: Db,
  ctx: Ctx,
  id: string,
  body: unknown,
): Promise<ReturnType<typeof operationView>> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("el cuerpo debe ser un objeto JSON");
  const b = body as Record<string, unknown>;
  if (b.confirmToken !== undefined && typeof b.confirmToken !== "string") throw badRequest("confirmToken inválido");
  if (typeof b.phrase !== "string") throw badRequest("phrase es obligatoria");
  const confirmToken: string | undefined = b.confirmToken as string | undefined;
  const phrase: string = b.phrase;

  const outcome = await db.transaction(async (trx): Promise<ReturnType<typeof operationView> | "expired"> => {
    const t = trx as unknown as Db;
    const row: OpRow | undefined = await t("admin_operations").where({ id }).forUpdate().first();
    if (!row) throw notFound();
    if (row.status !== "awaiting_confirmation") {
      throw conflict("not_awaiting_confirmation", `La operación está en estado ${row.status}`, { status: row.status });
    }
    const live = await t("admin_operations").where({ id }).where("confirm_expires_at", ">", t.fn.now()).first("id");
    if (!live) {
      await t("admin_operations")
        .where({ id })
        .update({ status: "expired", confirm_token_hash: null, finished_at: t.fn.now() });
      await audit(t, {
        actorId: ctx.actorId,
        action: OP_AUDIT("expired"),
        target: `operation:${id}`,
        detail: { kind: row.kind },
        correlationId: ctx.correlationId,
      });
      // La transacción se confirma para que la caducidad quede registrada; el 409 se lanza fuera.
      return "expired";
    }
    if (row.requires_second_admin && row.requested_by === ctx.actorId) {
      throw forbidden("Esta acción irreversible exige confirmarla un segundo administrador, distinto del solicitante");
    }
    if (phrase.trim() !== row.confirm_phrase) throw badRequest("La frase de confirmación no coincide");

    // Con segundo admin no hay token: la aprobación es la sesión reautenticada de OTRO admin.
    if (!row.requires_second_admin && !confirmToken) throw badRequest("confirmToken es obligatorio");
    // Consumo ATÓMICO: un solo uso aunque haya dos confirmaciones a la vez.
    const consume = t("admin_operations").where({ id, status: "awaiting_confirmation" });
    if (!row.requires_second_admin) consume.where({ confirm_token_hash: sha256(confirmToken!) });
    const [done]: OpRow[] = await consume
      .where("confirm_expires_at", ">", t.fn.now())
      .update({
        status: "pending",
        confirmed_by: ctx.actorId,
        confirmed_at: t.fn.now(),
        confirm_token_hash: null,
        confirm_expires_at: null,
      })
      .returning("*");
    if (!done)
      throw new ApiError(409, "confirmation_token_invalid", "El token de confirmación no es válido o ya se usó");
    await audit(t, {
      actorId: ctx.actorId,
      action: OP_AUDIT("confirmed"),
      target: `operation:${id}`,
      detail: { kind: row.kind, requestedBy: row.requested_by, secondAdmin: row.requires_second_admin },
      correlationId: ctx.correlationId,
    });
    return operationView(done);
  });
  if (outcome === "expired") {
    throw new ApiError(409, "confirmation_expired", "El token de confirmación caducó: solicita la operación de nuevo");
  }
  return outcome;
}

export async function cancelOperation(db: Db, ctx: Ctx, id: string): Promise<ReturnType<typeof operationView>> {
  return db.transaction(async (trx) => {
    const t = trx as unknown as Db;
    const [row]: OpRow[] = await t("admin_operations")
      .where({ id })
      .whereIn("status", ["awaiting_confirmation", "pending"])
      .update({ status: "cancelled", confirm_token_hash: null, finished_at: t.fn.now() })
      .returning("*");
    if (!row) {
      const exists = await t("admin_operations").where({ id }).first("status");
      if (!exists) throw notFound();
      throw conflict("not_cancellable", `La operación está en estado ${exists.status}`, { status: exists.status });
    }
    await audit(t, {
      actorId: ctx.actorId,
      action: OP_AUDIT("cancelled"),
      target: `operation:${id}`,
      detail: { kind: row.kind },
      correlationId: ctx.correlationId,
    });
    return operationView(row);
  });
}

export async function getOperation(db: Db, id: string): Promise<ReturnType<typeof operationView>> {
  const row: OpRow | undefined = await db("admin_operations").where({ id }).first();
  if (!row) throw notFound();
  return operationView(row);
}

export async function listOperations(db: Db, limit: number): Promise<ReturnType<typeof operationView>[]> {
  const rows: OpRow[] = await db("admin_operations").orderBy("created_at", "desc").limit(limit);
  return rows.map(operationView);
}
