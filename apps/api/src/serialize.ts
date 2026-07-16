/** Proyecciones a los shapes del contrato de E1. Los campos x-private solo salen para el propio usuario/admin. */

export function userToJson(
  user: Record<string, unknown>,
  roles: string[],
  opts: { includePrivate: boolean },
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: user.id,
    displayName: user.display_name,
    createdAt: (user.created_at as Date).toISOString(),
  };
  if (opts.includePrivate) {
    base.email = user.email;
    base.roles = roles;
    base.twoFactorEnabled = user.totp_secret != null;
  }
  return base;
}

export function publicProfile(user: Record<string, unknown>): Record<string, unknown> {
  return {
    id: user.id,
    displayName: user.display_name,
    createdAt: (user.created_at as Date).toISOString(),
  };
}

export function sessionToJson(s: Record<string, unknown>): Record<string, unknown> {
  return {
    id: s.id,
    createdAt: (s.created_at as Date).toISOString(),
    lastSeenAt: (s.last_seen_at as Date).toISOString(),
    userAgent: s.user_agent ?? undefined,
  };
}

export function teamToJson(team: Record<string, unknown>, memberIds: string[]): Record<string, unknown> {
  return { id: team.id, name: team.name, captainId: team.captain_id, memberIds };
}

/** Cursor keyset opaco (el contrato prohíbe paginación por offset). */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");
}

export function decodeCursor(cursor: string | undefined): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const [createdAt, id] = Buffer.from(cursor, "base64url").toString().split("|");
    if (!createdAt || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export function parseLimit(raw: unknown): number {
  const n = Number(raw ?? 20);
  if (!Number.isInteger(n) || n < 1) return 20;
  return Math.min(n, 100);
}
