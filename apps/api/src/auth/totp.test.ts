/**
 * R-DEPLOY · R4 — TOTP estable bajo carga (ventana ±1) con reloj CONTROLADO.
 *
 * Nada aquí usa Date.now(): se inyecta el instante Unix (segundos) en generación
 * y verificación, de modo que los tests de borde son deterministas y no flaky.
 */
import { describe, expect, it } from "vitest";
import * as otplib from "otplib";
import {
  TOTP_PERIOD_SECONDS,
  generateTotpSecret,
  verifyTotp,
  verifyTotpDetailed,
} from "./totp.js";

const P = TOTP_PERIOD_SECONDS;
// Instante fijo alineado al inicio de un período (múltiplo de 30) para razonar
// con claridad sobre los bordes.
const T0 = 1_700_000_010; // segundos Unix; 1_700_000_010 % 30 === 0
const secret = generateTotpSecret();

/** Genera el código del período que contiene `epoch` (segundos). */
async function codeAt(epoch: number): Promise<string> {
  return otplib.generate({ secret, period: P, epoch });
}

describe("TOTP · ventana de aceptación ±1 con reloj fake (R4)", () => {
  it("acepta el código del período ACTUAL (delta 0)", async () => {
    const token = await codeAt(T0);
    const r = await verifyTotpDetailed(token, secret, { epoch: T0 });
    expect(r.valid).toBe(true);
    expect(r.delta).toBe(0);
    expect(typeof r.timeStep).toBe("number");
  });

  it("acepta un código del período ANTERIOR (llega tarde: delta -1)", async () => {
    const token = await codeAt(T0); // generado en el período actual…
    const r = await verifyTotpDetailed(token, secret, { epoch: T0 + P }); // …verificado un período después
    expect(r.valid).toBe(true);
    expect(r.delta).toBe(-1);
  });

  it("acepta un código del período SIGUIENTE (reloj adelantado: delta +1)", async () => {
    const token = await codeAt(T0 + P); // código del período siguiente…
    const r = await verifyTotpDetailed(token, secret, { epoch: T0 }); // …verificado ahora
    expect(r.valid).toBe(true);
    expect(r.delta).toBe(1);
  });

  it("RECHAZA un código a dos períodos de distancia (fuera de ventana)", async () => {
    const token = await codeAt(T0);
    expect((await verifyTotpDetailed(token, secret, { epoch: T0 + 2 * P })).valid).toBe(false);
    expect((await verifyTotpDetailed(token, secret, { epoch: T0 - 2 * P })).valid).toBe(false);
  });

  it("estabilidad en el BORDE del período: t=29 s validado a t=31 s sigue valiendo", async () => {
    const token = await codeAt(T0 + 29); // generado casi al final del período
    const r = await verifyTotpDetailed(token, secret, { epoch: T0 + 31 }); // 2 s después, ya en el siguiente
    expect(r.valid).toBe(true); // con tolerancia 0 esto fallaría (el bug flaky)
  });

  it("RECHAZA un token malformado sin lanzar", async () => {
    expect(await verifyTotp("no-numerico", secret, { epoch: T0 })).toBe(false);
    expect(await verifyTotp("000000", secret, { epoch: T0 })).toBe(false);
  });
});

describe("TOTP · protección anti-replay por timeStep (R4)", () => {
  it("un código aceptado no se reutiliza si se pasa su timeStep como afterTimeStep", async () => {
    const token = await codeAt(T0);
    const first = await verifyTotpDetailed(token, secret, { epoch: T0 });
    expect(first.valid).toBe(true);
    const step = first.timeStep!;
    // Reutilizar el MISMO código con afterTimeStep = paso ya consumido ⇒ rechazado.
    const replay = await verifyTotpDetailed(token, secret, { epoch: T0, afterTimeStep: step });
    expect(replay.valid).toBe(false);
  });

  it("un código de un período POSTERIOR sí pasa aunque afterTimeStep bloquee el anterior", async () => {
    const prev = await verifyTotpDetailed(await codeAt(T0), secret, { epoch: T0 });
    const usedStep = prev.timeStep!;
    const nextToken = await codeAt(T0 + P);
    const r = await verifyTotpDetailed(nextToken, secret, { epoch: T0 + P, afterTimeStep: usedStep });
    expect(r.valid).toBe(true);
    expect(r.timeStep!).toBeGreaterThan(usedStep);
  });
});
