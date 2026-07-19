/**
 * T7.5 · Conformidad con el contrato OpenAPI de E1: cada una de las 55
 * operaciones (53 originales + getBotRatingHistory/getTeamStandings, H6 issue
 * #10, contrato 0.2.0) está IMPLEMENTADA (método+ruta+x-min-role derivados del contrato
 * por construcción, ver registry.ts) o declarada PENDIENTE con su motivo.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createApp } from "./app.js";
import { createDb } from "./db/connection.js";
import { loadContract } from "./openapi.js";
import { implementedOperations } from "./registry.js";
import { StubBotManager } from "./services/bot-manager.js";

/**
 * Operaciones del contrato aún no implementadas, con el motivo.
 * `verifyReplay` era la única pendiente de E7: la implementó E8 (T8.1) sobre el
 * replay-service real. Con esto, las 53 operaciones del contrato están implementadas.
 */
export const PENDING_OPERATIONS: Record<string, string> = {};

beforeAll(() => {
  // Registrar rutas sin tocar la BD (knex es perezoso: no conecta hasta la primera query)
  const db = createDb("postgres://unused:unused@localhost:1/unused");
  createApp({ db, botManager: new StubBotManager(db) });
});

describe("T7.5 conformidad con el contrato de E1", () => {
  it("el contrato tiene 58 operaciones (57 + runBattle de R6.2/R9-B, contrato 0.3.0)", () => {
    expect(loadContract().operations.length).toBe(58);
  });

  it("toda operación del contrato está implementada o declarada pendiente con motivo", () => {
    const implemented = new Set(implementedOperations.filter((o) => !o.extension).map((o) => o.operationId));
    const missing: string[] = [];
    for (const op of loadContract().operations) {
      if (!implemented.has(op.operationId) && !PENDING_OPERATIONS[op.operationId]) {
        missing.push(op.operationId);
      }
    }
    expect(missing, `operaciones sin implementar ni declarar: ${missing.join(", ")}`).toEqual([]);
  });

  it("no hay operaciones 'pendientes' que en realidad estén implementadas", () => {
    const implemented = new Set(implementedOperations.map((o) => o.operationId));
    for (const id of Object.keys(PENDING_OPERATIONS)) {
      expect(implemented.has(id), `${id} está implementada: quitarla de PENDING_OPERATIONS`).toBe(false);
    }
  });

  it("las extensiones fuera de contrato están documentadas y son EXACTAMENTE las conocidas", () => {
    const extensions = implementedOperations.filter((o) => o.extension).map((o) => o.operationId);
    // recoverAccount/resetPassword: recuperación de cuenta (T7.2).
    // getSigningPublicKey: clave pública de firma de artefactos (R2.5, ERR-SEC-15).
    // getTournament/listTournamentBattles/listBotLoadouts/logout: lecturas y
    // sesión que el panel necesita (R3.7, ERR-VIS-02/03/04); documentadas en
    // docs/ronda2/reportes/R3.7-panel.md y candidatas a entrar en el contrato 0.3.
    expect(extensions.sort()).toEqual([
      "getSigningPublicKey",
      "getTournament",
      "listBotLoadouts",
      "listTournamentBattles",
      "logout",
      "recoverAccount",
      "resetPassword",
    ]);
  });

  it("cada operación implementada usa el x-min-role del contrato (por construcción)", () => {
    const contract = loadContract();
    for (const op of implementedOperations) {
      if (op.extension) continue;
      const c = contract.byOperationId.get(op.operationId)!;
      expect(op.minRole).toBe(c.minRole);
      expect(op.method).toBe(c.method);
      expect(op.path).toBe(c.path);
    }
  });
});
