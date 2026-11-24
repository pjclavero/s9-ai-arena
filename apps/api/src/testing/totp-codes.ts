/**
 * ACC-2FA · Códigos TOTP para tests contra una API que consume cada paso de 30 s (anti-replay).
 *
 * La API acepta el paso anterior, el actual y el siguiente (±30 s), pero cada paso UNA vez por usuario. Un
 * test que se autentica varias veces seguidas con la misma cuenta necesita códigos de pasos distintos. Este
 * helper recuerda el último paso entregado por secreto y da el siguiente que el servidor aún aceptará:
 *  - el paso anterior sólo si quedan ≥ 5 s del actual (si no, caducaría antes de llegar);
 *  - el actual y el siguiente siempre (valen ≥ 30 s más).
 * Si los tres ya se gastaron, espera al siguiente paso en vez de entregar un código que fallaría.
 * Es determinista respecto al reloj: nunca entrega un código que pueda caducar durante la petición.
 */
import * as otplib from "otplib";
import request from "supertest";
import type { Express } from "express";
import { TOTP_PERIOD_SECONDS } from "../auth/totp.js";

const lastStep = new Map<string, number>();
const MARGIN_S = 5;

export function secretFromUri(otpauthUrl: string): string {
  const s = new URL(otpauthUrl).searchParams.get("secret");
  if (!s) throw new Error("otpauthUrl sin secret");
  return s;
}

async function codeForStep(secret: string, step: number): Promise<string> {
  const r = (await otplib.generate({
    secret,
    period: TOTP_PERIOD_SECONDS,
    epoch: step * TOTP_PERIOD_SECONDS,
  })) as unknown;
  return typeof r === "string" ? r : String((r as { otp: string }).otp);
}

/** Código que el servidor aceptará y que no se ha entregado antes para este secreto (o URI otpauth). */
export async function freshTotp(secretOrUri: string): Promise<string> {
  const secret = secretOrUri.startsWith("otpauth://") ? secretFromUri(secretOrUri) : secretOrUri;
  for (;;) {
    const nowS = Date.now() / 1000;
    const cur = Math.floor(nowS / TOTP_PERIOD_SECONDS);
    const remaining = (cur + 1) * TOTP_PERIOD_SECONDS - nowS;
    const candidates = [...(remaining >= MARGIN_S ? [cur - 1] : []), cur, cur + 1];
    const last = lastStep.get(secret) ?? -Infinity;
    const step = candidates.find((s) => s > last);
    if (step !== undefined) {
      lastStep.set(secret, step);
      return codeForStep(secret, step);
    }
    await new Promise((r) => setTimeout(r, Math.ceil(remaining * 1000) + 50));
  }
}

/** Código del paso actual SIN reservarlo (para peticiones que deben fallar antes de mirar el código). */
export async function anyTotp(secretOrUri: string): Promise<string> {
  const secret = secretOrUri.startsWith("otpauth://") ? secretFromUri(secretOrUri) : secretOrUri;
  return codeForStep(secret, Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS));
}

/**
 * ACC-2FA · Activa la 2FA por el flujo de V1 (setup con contraseña + confirm con un código) y devuelve la
 * misma forma que daba el alta directa retirada: `{ status, body: { otpauthUrl, recoveryCodes } }`.
 */
export async function enable2faFor(
  app: Express,
  accessToken: string,
  password: string,
): Promise<{ status: number; body: { otpauthUrl: string; secret: string; recoveryCodes: string[] } }> {
  const auth = { Authorization: `Bearer ${accessToken}` };
  const s = await request(app).post("/auth/2fa/setup").set(auth).send({ password });
  if (s.status !== 200) return { status: s.status, body: s.body };
  const c = await request(app)
    .post("/auth/2fa/confirm")
    .set(auth)
    .send({ enrollmentToken: s.body.enrollmentToken, totp: await freshTotp(s.body.secret) });
  return {
    status: c.status,
    body: { otpauthUrl: s.body.otpauthUrl, secret: s.body.secret, recoveryCodes: c.body.recoveryCodes },
  };
}
