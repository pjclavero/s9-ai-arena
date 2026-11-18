/**
 * #291 · Regla ÚNICA de gestión de un torneo: quien lo creó (`created_by`) o el staff
 * (moderator+). Se aplica ENCIMA del rol mínimo del contrato (`x-min-role`), que sigue
 * siendo el RBAC de la ruta. No cubre las acciones del participante (inscribir o retirar
 * su propio bot), que tienen su propia regla (dueño del bot).
 *
 * Mismo predicado que `canManageTournament` del PR #289 (cancelación): al integrarlo,
 * ese PR importa éste en vez de definir el suyo.
 */
import { forbidden } from "../errors.js";
import { isStaff, type Auth } from "./bots.js";

/** Dueño del torneo o staff. Un torneo sin `created_by` (creador borrado) sólo lo gestiona el staff. */
export function canManageTournament(
  auth: Pick<NonNullable<Auth>, "userId" | "rank"> | undefined,
  t: Record<string, unknown>,
): boolean {
  return !!auth && (auth.userId === t.created_by || isStaff(auth as Auth));
}

/** 403 si quien llama no gestiona el torneo. Va antes de cualquier efecto. */
export function assertCanManageTournament(
  auth: Pick<NonNullable<Auth>, "userId" | "rank"> | undefined,
  t: Record<string, unknown>,
): void {
  if (!canManageTournament(auth, t)) {
    throw forbidden("Sólo quien creó el torneo o el staff pueden gestionarlo");
  }
}
