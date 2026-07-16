/** Helpers de test: emitir tokens para usuarios semilla sin pasar por /auth/login. */
import type { Db } from "../db/connection.js";
import { newRefreshToken, signAccessToken, REFRESH_TOKEN_TTL_S } from "../auth/tokens.js";

export async function tokenFor(db: Db, email: string): Promise<string> {
  const user = await db("users").where({ email }).first();
  if (!user) throw new Error(`Usuario de test no encontrado: ${email}`);
  const { hash } = newRefreshToken();
  const [session] = await db("sessions")
    .insert({
      user_id: user.id,
      refresh_token_hash: hash,
      expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL_S * 1000),
    })
    .returning("*");
  return signAccessToken({ sub: user.id, sid: session.id });
}
