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
  // Cierre funcional 2026-10 (integración REVIEW): 65 de R11 (contrato 0.8.0)
  // + 5 de versionado de bots (DEV-A: getBotVersion, getBotVersionFiles,
  // getBotVersionArtifact, diffBotVersions, cloneBotVersion)
  // + 7 de contenido (DEV-C: listRulesets, getMapVersionContent, getTeam,
  // updateTeam, deleteTeam, addTeamBot, removeTeamBot)
  // + 3 de autorización de replays (PRC TD-004, contrato 0.9.0: listReplays,
  // getReplayIndex, getReplaySegment)
  // + 2 de elegibilidad histórica (ELIG, contratos 0.10.0-0.11.0: getBotVersionEligibilityInventory, excludeTournamentEntry)
  // + 1 de reglas de batalla (R-RULES, contrato 0.12.0: checkBattleRules)
  // + 12 de Administración → Streaming (EQ5b, contrato 0.13.0, tag streaming).
  // + 1 de equipos (#255, contrato 0.17.0: publishTeamBots).
  // + 2 de ajustes de runtime (MG, contrato 0.18.0: getPublicAccessSettings, updatePublicAccessSettings).
  // + 4 de torneos por equipos (#290, contrato 0.24.0: enterTournamentTeam, listTeamEntryConsents,
  //   putTeamEntryConsent, deleteTeamEntryConsent).
  // + 1 de cancelación de torneos (#289, contrato 0.23.0: cancelTournament).
  // + 7 de administración web (ADM-1, contrato 0.26.0: listSystemSettings, updateSystemSettings, createAdminOperation,
  //   listAdminOperations, getAdminOperation, confirmAdminOperation, cancelAdminOperation).
  // + 3 de usuarios y recuperación (ADM-3, contrato 0.27.0: listAdminUsers, setUserStatus, issueUserRecoveryToken) + getAdminUser.
  // Contrato 0.25.0 (B/0.5.0): sólo documenta el 409 not_enough_participants de closeEntries; no añade operaciones.
  it("el contrato tiene 117 operaciones (65 de R11 + 5 de versionado A9 + 7 de contenido FC-C + 3 de replays TD-004 + 2 ELIG + 1 R-RULES + 14 streaming + 1 VISIBILIDAD + 1 #255 + 2 MG + 1 #289 + 4 #290 + 7 ADM-1 + 4 ADM-3)", () => {
    expect(loadContract().operations.length).toBe(117);
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
    // resetPassword: canje del token de recuperación (T7.2). `recoverAccount` (POST /auth/recover) se RETIRÓ en ADM-3:
    // creaba el token y lo descartaba; ahora lo emite un admin desde la web (issueUserRecoveryToken, contrato 0.27.0).
    // getSigningPublicKey: clave pública de firma de artefactos (R2.5, ERR-SEC-15).
    // getTournament/listTournamentBattles/listBotLoadouts/logout: lecturas y
    // sesión que el panel necesita (R3.7, ERR-VIS-02/03/04); documentadas en
    // docs/ronda2/reportes/R3.7-panel.md y candidatas a entrar en el contrato 0.3.
    // listBotVersionBuilds: builds de una versión (B11) — sin esto el panel no
    // puede saber cómo terminó el pipeline tras recargar la página.
    // changePassword: cambio de contraseña del usuario autenticado (V1-B).
    expect(extensions.sort()).toEqual([
      "changePassword",
      "getSigningPublicKey",
      "getTournament",
      "listBotLoadouts",
      "listBotVersionBuilds",
      "listTournamentBattles",
      "logout",
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
