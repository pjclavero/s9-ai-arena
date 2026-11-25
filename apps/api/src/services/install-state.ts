/**
 * V1 ADM-SETUP (D-OP-44) · Estado del primer arranque (`install_state`, migración 027).
 *
 * El asistente web está ABIERTO sólo si se cumplen LAS TRES condiciones:
 *  1. la fila de `install_state` existe y `setup_completed_at IS NULL`;
 *  2. no hay ninguna fila `user_roles.role = 'admin'`;
 *  3. el token de instalación está presente.
 * Si falta cualquiera, está CERRADO (fallo cerrado). Una vez completada la instalación
 * (`setup_completed_at` fijado), queda cerrada PARA SIEMPRE: el cierre lo dice esta fila,
 * no el recuento de admins.
 */
import type { Knex } from "knex";
import { setupBannerLines, type SetupTokenSource } from "./setup-token.js";

export type SetupClosedReason = "completed" | "admin_exists" | "no_token" | "no_state";

export interface SetupState {
  open: boolean;
  /** Motivo interno del cierre; NUNCA se expone en `GET /setup/status`. */
  reason: SetupClosedReason | null;
}

/** Lee el estado con el conector dado (la conexión normal o una transacción con el cerrojo). */
export async function readSetupState(db: Knex, tokenPresent: boolean): Promise<SetupState> {
  const row = await db("install_state").where({ id: true }).first();
  if (!row) return { open: false, reason: "no_state" };
  if (row.setup_completed_at) return { open: false, reason: "completed" };
  const admin = await db("user_roles").where({ role: "admin" }).first();
  if (admin) return { open: false, reason: "admin_exists" };
  if (!tokenPresent) return { open: false, reason: "no_token" };
  return { open: true, reason: null };
}

/**
 * Marca la instalación como completada si aún no lo estaba. Idempotente: si ya estaba
 * completada no toca nada (el trigger de la 027 lo impediría igualmente). Si la fila no
 * existe (BD manipulada), la crea ya completada.
 */
export async function markSetupCompleted(trx: Knex, userId: string, via: "web" | "cli"): Promise<void> {
  await trx.raw(
    `INSERT INTO install_state (id, setup_completed_at, setup_completed_by, via)
       VALUES (true, now(), ?, ?)
     ON CONFLICT (id) DO UPDATE
       SET setup_completed_at = EXCLUDED.setup_completed_at,
           setup_completed_by = EXCLUDED.setup_completed_by,
           via = EXCLUDED.via
       WHERE install_state.setup_completed_at IS NULL`,
    [userId, via],
  );
}

/**
 * Aviso de arranque (server.ts): con el asistente abierto escribe en el log dónde abrirlo y la
 * HUELLA del token, NUNCA el token. Devuelve si estaba abierto. Un fallo (p. ej. BD sin migrar)
 * no tumba la API: se avisa sin datos sensibles y se sigue.
 */
export async function announceSetupIfOpen(
  db: Knex,
  tokenSource: SetupTokenSource,
  log: (line: string) => void = (l) => console.log(l),
  publicUrl?: string,
): Promise<boolean> {
  try {
    const token = tokenSource();
    const state = await readSetupState(db, token !== null);
    if (!state.open || token === null) return false;
    for (const line of setupBannerLines(token, publicUrl)) log(line);
    return true;
  } catch (e) {
    log(`[setup] no se pudo comprobar el estado del primer arranque (${(e as Error)?.name ?? "Error"})`);
    return false;
  }
}
