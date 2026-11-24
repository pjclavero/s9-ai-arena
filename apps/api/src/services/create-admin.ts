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
 *
 * V1 ADM-SETUP (D-OP-44) · El MISMO servicio da de alta el primer admin desde el asistente web
 * (`via: "web"`, `POST /setup/admin`). Dentro del cerrojo, la vía web vuelve a comprobar que la
 * instalación no está completada (`install_state`) y que hay 0 admins, y emite el kit de
 * recuperación. Las DOS vías marcan `install_state` como completada en la misma transacción:
 * crear el admin por consola también cierra el asistente para siempre.
 */
import type { Db } from "../db/connection.js";
import { hashPassword, passwordPolicyViolation } from "../auth/passwords.js";
import { audit } from "../audit.js";
import { markSetupCompleted } from "./install-state.js";
import { issueRecoveryKit } from "./recovery-kit.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Clave fija del cerrojo consultivo del alta de administradores. */
const ADMIN_LOCK_KEY = 90230001;

export class CreateAdminError extends Error {
  constructor(
    readonly code: "invalid_input" | "admin_exists" | "email_taken" | "not_bootstrapped" | "setup_closed",
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
  /** V1 ADM-SETUP · vía del alta (por defecto `cli`). `web` = asistente de primer arranque. */
  via?: "cli" | "web";
  /** V1 ADM-SETUP · contexto que se audita en el alta web (sin contraseña ni token). */
  webContext?: { ip?: string | null; userAgent?: string | null; tokenFingerprint: string; correlationId?: string };
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
  /** V1 ADM-SETUP · kit de recuperación EN CLARO (sólo en el alta web; se muestra una vez). */
  recoveryKit?: string;
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
  const via = input.via ?? "cli";
  if (via === "web" && input.allowAdditionalAdmin) {
    throw new CreateAdminError("invalid_input", "el asistente web sólo crea el PRIMER administrador");
  }
  // PUNTO DE INTEGRACIÓN con #348: la política es la de `passwordPolicyViolation` (fuente única).
  // Cuando #348 entre en main, pasar aquí el contexto `{ email, displayName }` como hace su versión.
  const violation = passwordPolicyViolation(input.password);
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
    // V1 ADM-SETUP · la vía web exige además la instalación SIN completar (cierre para siempre).
    const state = via === "web" ? await trx("install_state").where({ id: true }).first() : null;
    if (hooks.afterAdminCount) await hooks.afterAdminCount();
    if (via === "web" && (!state || state.setup_completed_at || adminCount > 0)) {
      throw new CreateAdminError("setup_closed", "El asistente de primer arranque está cerrado");
    }
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
    // Las dos vías cierran el asistente (idempotente: si ya estaba completada no cambia nada).
    await markSetupCompleted(trx, String(user.id), via);
    if (via === "web") {
      const recoveryKit = await issueRecoveryKit(trx, String(user.id));
      await audit(trx, {
        actorId: user.id,
        action: "admin.create_web_setup",
        target: `user:${user.id}`,
        detail: {
          via: "web",
          ip: input.webContext?.ip ?? null,
          userAgent: input.webContext?.userAgent ?? null,
          tokenFingerprint: input.webContext?.tokenFingerprint ?? null,
          recoveryKitIssued: true,
        },
        correlationId: input.webContext?.correlationId,
      });
      return { userId: String(user.id), email, additional: false, recoveryKit };
    }
    await audit(trx, {
      action: "admin.create_cli",
      target: `user:${user.id}`,
      detail: { via: "cli", additional: adminCount > 0, existingAdmins: adminCount },
    });
    return { userId: String(user.id), email, additional: adminCount > 0 };
  });
}
