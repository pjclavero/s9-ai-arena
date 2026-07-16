import { describe, it, expect } from "vitest";
import { AuditLog, Forbidden, AUDIT_PERMISSIONS } from "../src/audit.js";
import { reportSandboxEscape } from "../src/security-events.js";
import { BuildPipeline } from "../src/pipeline.js";
import { InMemoryBuildStore } from "../src/store.js";
import { generateServiceKeypair } from "../src/signing.js";
import { withConfig } from "../src/config.js";
import { submission, pySecretFiles } from "./fixtures.js";

const admin = { id: "u_admin", role: "admin" as const };
const moderator = { id: "u_mod", role: "moderator" as const };
const web = { id: "svc_web", role: "web" as const };

describe("T6.4 · audit_log y security_findings con RBAC", () => {
  it("un security_finding es consultable por admins y SOLO por ellos", () => {
    const log = new AuditLog();
    reportSandboxEscape(log, { botId: "bot_x", version: 1, userId: "u1", correlationId: "c1", vector: "docker_sock" });
    // admin: lo ve
    const findings = log.queryFindings(admin);
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe("sandbox_escape");
    // moderador y web: prohibido
    expect(() => log.queryFindings(moderator)).toThrow(Forbidden);
    expect(() => log.queryFindings(web)).toThrow(Forbidden);
  });

  it("el audit_log es de SOLO INSERCIÓN: no hay método ni permiso de borrado/edición", () => {
    const log = new AuditLog() as any;
    expect(typeof log.delete).toBe("undefined");
    expect(typeof log.update).toBe("undefined");
    expect(typeof log.remove).toBe("undefined");
    // ningún rol tiene permiso de borrado (no existe la clave siquiera)
    for (const role of Object.keys(AUDIT_PERMISSIONS)) {
      expect((AUDIT_PERMISSIONS as any)[role].delete).toBeUndefined();
    }
  });

  it("un intento de escape queda en el audit_log correlacionado (no solo en findings)", () => {
    const log = new AuditLog();
    reportSandboxEscape(log, { botId: "bot_x", version: 2, userId: "u1", correlationId: "corr9", vector: "fork_bomb" });
    const audit = log.queryAudit(admin, { correlationId: "corr9" });
    expect(audit.some((e) => e.type === "security.finding")).toBe(true);
    expect(audit[0].botId).toBe("bot_x");
    expect(audit[0].version).toBe(2);
  });

  it("la web/API pública no pueden leer el audit_log", () => {
    const log = new AuditLog();
    log.record({ type: "build.started", botId: "b", version: 1, userId: "u", correlationId: "c" });
    expect(() => log.queryAudit(web)).toThrow(Forbidden);
    expect(log.queryAudit(moderator)).toHaveLength(1); // moderador sí
  });

  it("código con clave AWS de ejemplo se bloquea y deja finding admin-only registrado", async () => {
    const log = new AuditLog();
    const pipe = new BuildPipeline({
      store: new InMemoryBuildStore(),
      config: withConfig(),
      signer: generateServiceKeypair(),
      audit: log,
      agentResolver: undefined, // el secret_scan no necesita ejecución
      referenceAgent: undefined,
    });
    const build = await pipe.run(submission(pySecretFiles()));
    expect(build.botVersionState).toBe("rejected");
    const findings = log.queryFindings(admin, { category: "secret_leak" });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].severity).toBe("critical");
    // el dueño (rol user vía web) no puede ver el finding
    expect(() => log.queryFindings(web)).toThrow(Forbidden);
  });
});
