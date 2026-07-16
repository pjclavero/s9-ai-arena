import { describe, it, expect } from "vitest";
import { AuditLog } from "../src/audit.js";
import { SuspensionRegistry, SuspensionForbidden, administrativeDisqualifications } from "../src/suspension.js";
import { LaunchAuthority, LaunchDenied } from "../src/launch-guard.js";

const admin = { id: "u_admin", role: "admin" as const };
const moderator = { id: "u_mod", role: "moderator" as const };
const user = { id: "u_user", role: "web" as const };
const internal = { id: "svc_bm", role: "bot-manager-internal" as const };

describe("T6.4 · suspensión de bots", () => {
  it("solo moderador/admin pueden suspender, con motivo obligatorio", () => {
    const reg = new SuspensionRegistry(new AuditLog());
    expect(() => reg.suspend(user, "bot_x", 1, "abuso")).toThrow(SuspensionForbidden);
    expect(() => reg.suspend(moderator, "bot_x", 1, "")).toThrow(/motivo/);
    expect(() => reg.suspend(moderator, "bot_x", 1, "trampa detectada")).not.toThrow();
    expect(reg.isSuspended("bot_x", 1)).toBe(true);
  });

  it("la suspensión queda en el audit_log", () => {
    const log = new AuditLog();
    const reg = new SuspensionRegistry(log);
    reg.suspend(admin, "bot_y", 3, "explotó el sandbox");
    const entries = log.queryAudit(admin, { botId: "bot_y" });
    expect(entries.some((e) => e.type === "bot.suspended")).toBe(true);
  });

  it("el bot-manager rehúsa lanzar un bot suspendido aunque esté inscrito", () => {
    const reg = new SuspensionRegistry(new AuditLog());
    reg.registerEnrollment("entry_1", "bot_z", 1);
    const auth = new LaunchAuthority(reg);
    // antes de suspender: se puede lanzar
    expect(auth.canLaunch(internal, "bot_z", 1)).toBe(true);
    reg.suspend(moderator, "bot_z", 1, "sospecha");
    // después: rehúsa, y la inscripción queda marcada
    expect(() => auth.authorize(internal, "bot_z", 1)).toThrow(LaunchDenied);
    expect(reg.markedEnrollments()).toContain("entry_1");
  });

  it("la batalla descalifica administrativamente a los suspendidos inscritos", () => {
    const reg = new SuspensionRegistry(new AuditLog());
    reg.suspend(admin, "bot_bad", 2, "cheating");
    const entries = [
      { entryId: "e1", botId: "bot_good", version: 1 },
      { entryId: "e2", botId: "bot_bad", version: 2 },
    ];
    const dq = administrativeDisqualifications(entries, reg);
    expect(dq.map((d) => d.entryId)).toEqual(["e2"]);
  });

  it("suspender todas las versiones (version undefined) cubre cualquier versión", () => {
    const reg = new SuspensionRegistry(new AuditLog());
    reg.suspend(admin, "bot_all", undefined, "ban total");
    expect(reg.isSuspended("bot_all", 1)).toBe(true);
    expect(reg.isSuspended("bot_all", 99)).toBe(true);
  });
});
