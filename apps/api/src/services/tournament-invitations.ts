/**
 * V1 · TORNEOS POR INVITACIÓN (D-OP-43) · modalidad de inscripción y enlace de invitación.
 *
 * Contrato (docs/technical/tournament-invitations.md):
 *  - `enrollment` = 'open' | 'invitation'. NO decide la visibilidad: todo torneo publicado se
 *    lista y se consulta igual; los directos y resultados públicos no dependen de ella.
 *  - En un torneo 'invitation' la API rechaza TODA alta (individual o de equipo) sin un token de
 *    invitación válido y no revocado. Cambiar la versión pendiente de una inscripción YA admitida
 *    (sólo su dueño, con todas las reglas) no es un alta y no lo exige (TI-02).
 *  - El token: 32 bytes de `randomBytes` (256 bits) en base64url. Sólo se guarda su sha256
 *    (hex); el token en claro se devuelve UNA vez, al generarlo, y sólo al organizador.
 *    No se puede volver a leer: «copiar otra vez» = generar uno nuevo, que revoca el anterior.
 *  - La comparación es en tiempo constante (`timingSafeEqual` de los dos sha256) contra la
 *    ÚNICA invitación activa del torneo (no se busca por hash: no hay oráculo de tiempo por índice).
 *  - El token nunca va a `audit_log` ni a ninguna respuesta pública (sólo `invitationId`).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../db/connection.js";
import { ApiError } from "../errors.js";

export const ENROLLMENT_MODES = ["open", "invitation"] as const;
export type EnrollmentMode = (typeof ENROLLMENT_MODES)[number];

/** Estados en los que se puede cambiar la modalidad o generar un enlace (aún sin calendario). */
export const ENROLLMENT_EDITABLE_STATES = ["draft", "open"] as const;

/** 32 bytes ⇒ 43 caracteres base64url sin relleno. */
export const INVITATION_TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function isEnrollmentMode(v: unknown): v is EnrollmentMode {
  return typeof v === "string" && (ENROLLMENT_MODES as readonly string[]).includes(v);
}

export function enrollmentOf(t: Record<string, unknown>): EnrollmentMode {
  return t.enrollment === "invitation" ? "invitation" : "open";
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newInvitationToken(): string {
  return randomBytes(INVITATION_TOKEN_BYTES).toString("base64url");
}

/** Comparación en tiempo constante de un token presentado con el sha256 guardado. */
export function invitationTokenMatches(token: unknown, storedSha256: string): boolean {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return false;
  const a = Buffer.from(hashInvitationToken(token), "hex");
  const b = Buffer.from(storedSha256, "hex");
  return a.length === b.length && a.length === 32 && timingSafeEqual(a, b);
}

/** Invitación ACTIVA del torneo (o undefined). */
export async function activeInvitation(db: Db, tournamentId: string): Promise<Record<string, unknown> | undefined> {
  return (await db("tournament_invitations").where({ tournament_id: tournamentId }).whereNull("revoked_at").first()) as
    Record<string, unknown> | undefined;
}

/** Id de la invitación activa que casa con el token, o null. */
export async function validInvitationId(db: Db, tournamentId: string, token: unknown): Promise<string | null> {
  const inv = await activeInvitation(db, tournamentId);
  if (!inv) return null;
  return invitationTokenMatches(token, String(inv.token_sha256)) ? String(inv.id) : null;
}

/**
 * Puerta de inscripción. Se llama DENTRO de la transacción de la inscripción, con el torneo
 * bloqueado `FOR UPDATE` (generar y revocar bloquean la misma fila): una revocación concurrente
 * espera o se ve, nunca hay una inscripción con un enlace ya revocado.
 *  - torneo 'open': no mira el token (comportamiento de siempre);
 *  - torneo 'invitation': 403 `invitation_required` sin token y 403 `invitation_invalid` con uno
 *    que no es el de la invitación activa (revocado, sustituido o inventado).
 */
export async function assertInvitationForEntry(
  db: Db,
  t: Record<string, unknown>,
  token: unknown,
): Promise<string | null> {
  if (enrollmentOf(t) !== "invitation") return null;
  if (token === undefined || token === null || token === "") {
    throw new ApiError(
      403,
      "invitation_required",
      "Este torneo es por invitación: sólo se inscribe con un enlace de invitación válido",
    );
  }
  const id = await validInvitationId(db, String(t.id), token);
  if (!id) {
    throw new ApiError(
      403,
      "invitation_invalid",
      "El enlace de invitación no es válido o ha sido revocado: pide uno nuevo a la organización",
    );
  }
  return id;
}

/** Revoca la invitación activa (si la hay). Devuelve cuántas filas revocó (0 o 1). */
export async function revokeActiveInvitation(db: Db, tournamentId: string, actorId: string | null): Promise<number> {
  const n = await db("tournament_invitations")
    .where({ tournament_id: tournamentId })
    .whereNull("revoked_at")
    .update({ revoked_at: db.fn.now(), revoked_by: actorId });
  return Number(n);
}
