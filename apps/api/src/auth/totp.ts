/** T7.2 · 2FA TOTP opcional (otplib v13) + códigos de recuperación. */
import { randomBytes } from "node:crypto";
import * as otplib from "otplib";
import { hashToken } from "./tokens.js";

export function generateTotpSecret(): string {
  return otplib.generateSecret();
}

export function totpUri(secret: string, email: string): string {
  return otplib.generateURI({ secret, issuer: "S9 AI Arena", label: email });
}

export async function verifyTotp(token: string, secret: string): Promise<boolean> {
  try {
    const r = await otplib.verify({ token, secret });
    return typeof r === "boolean" ? r : r.valid === true;
  } catch {
    return false;
  }
}

/** Devuelve códigos en claro (se muestran UNA vez) y sus hashes para la BD. */
export function generateRecoveryCodes(n = 8): { plain: string[]; hashes: string[] } {
  const plain = Array.from({ length: n }, () => randomBytes(6).toString("hex"));
  return { plain, hashes: plain.map(hashToken) };
}
