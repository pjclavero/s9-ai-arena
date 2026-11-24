/**
 * TD-023 · Alta del PRIMER administrador sin SQL.
 *
 * Garantías (cada una tiene su test en `create-admin.test.ts`):
 *  - la contraseña pasa por la política única (`passwordPolicyViolation`);
 *  - si ya existe un admin se NIEGA, salvo `allowAdditionalAdmin` explícito;
 *  - el alta (y el uso del permiso extra) queda en `audit_log`, SIN la contraseña;
 *  - no promueve cuentas existentes (eso sigue siendo `PUT /users/{id}/roles`);
 *  - el recuento de admins y el alta van en UNA transacción bajo un cerrojo
 *    consultivo: dos altas simultáneas no producen dos «primeros» admins.
 *
 * No usa `seed`: ninguna contraseña viene del repositorio.
 */
import type { Db } from "../db/connection.js";
import { hashPassword, passwordPolicyViolation } from "../auth/passwords.js";
import { audit } from "../audit.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Clave fija del cerrojo consultivo del alta de administradores. */
const ADMIN_LOCK_KEY = 90230001;

export class CreateAdminError extends Error {
  constructor(
    readonly code: "invalid_input" | "admin_exists" | "email_taken" | "not_bootstrapped",
    message: string,
  ) {
    super(message);
  }
}

export interface CreateAdminInput {
  email: string;
  displayName: string;
  password: string;
  /** Permite crear un admin aunque ya exista otro. Queda auditado. */
  allowAdditionalAdmin?: boolean;
}

/** Puntos de inyección SÓLO para tests; no forman parte del contrato de `createAdmin` (H10). */
export interface CreateAdminTestHooks {
  /** Pausa entre el recuento y el alta, para ensanchar la ventana de carrera. */
  afterAdminCount?: () => Promise<void>;
}

export interface CreateAdminResult {
  userId: string;
  email: string;
  additional: boolean;
}

export function createAdmin(db: Db, input: CreateAdminInput): Promise<CreateAdminResult> {
  return createAdminWithHooks(db, input, {});
}

/** Implementación con hooks de test. Los llamadores de producción usan `createAdmin`. */
export async function createAdminWithHooks(
  db: Db,
  input: CreateAdminInput,
  hooks: CreateAdminTestHooks,
): Promise<CreateAdminResult> {
  if (typeof input.email !== "string" || !EMAIL_RE.test(input.email)) {
    throw new CreateAdminError("invalid_input", "email inválido");
  }
  if (typeof input.displayName !== "string" || !input.displayName || input.displayName.length > 48) {
    throw new CreateAdminError("invalid_input", "displayName obligatorio (máx. 48)");
  }
  const violation = passwordPolicyViolation(input.password, undefined, {
    email: input.email,
    displayName: input.displayName,
  });
  if (violation) throw new CreateAdminError("invalid_input", violation);

  const email = input.email.toLowerCase();
  const passwordHash = await hashPassword(input.password);

  return db.transaction(async (trx) => {
    await trx.raw("SELECT pg_advisory_xact_lock(?)", [ADMIN_LOCK_KEY]);

    const roles = await trx("roles").whereIn("name", ["user", "developer", "admin"]).select("name");
    if (roles.length < 3) {
      throw new CreateAdminError("not_bootstrapped", "Faltan los roles base: ejecuta antes `cli.ts bootstrap`");
    }
    const existing = await trx("user_roles").where({ role: "admin" }).count<{ count: string }[]>({ count: "*" });
    const adminCount = Number(existing[0].count);
    if (hooks.afterAdminCount) await hooks.afterAdminCount();
    if (adminCount > 0 && !input.allowAdditionalAdmin) {
      throw new CreateAdminError(
        "admin_exists",
        "Ya existe al menos un administrador: usa la web (roles de usuario) o --allow-additional-admin",
      );
    }
    if (await trx("users").where({ email }).first()) {
      throw new CreateAdminError("email_taken", "Ya existe una cuenta con ese email (no se promueve por esta vía)");
    }
    const [user] = await trx("users")
      .insert({ email, password_hash: passwordHash, display_name: input.displayName })
      .returning("*");
    await trx("user_roles").insert([
      { user_id: user.id, role: "user" },
      { user_id: user.id, role: "developer" },
      { user_id: user.id, role: "admin" },
    ]);
    await audit(trx, {
      action: "admin.create_cli",
      target: `user:${user.id}`,
      detail: { via: "cli", additional: adminCount > 0, existingAdmins: adminCount },
    });
    return { userId: String(user.id), email, additional: adminCount > 0 };
  });
}
