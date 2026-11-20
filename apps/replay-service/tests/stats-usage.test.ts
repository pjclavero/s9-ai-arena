/**
 * UX-D · Estadísticas que no engañan: uso de módulos que no son armas,
 * decisiones, rechazos por motivo y distancia recorrida.
 *
 * Antes `perModule.uses` sólo contaba armas y minas: un bot que se movía toda la
 * batalla salía con `drive.uses = 0` y la web no podía distinguir «no se usó» de
 * «no se mide». Batallas reales del motor (E2) con stubs deterministas.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { record } from "../../arena-engine/src/replay.js";
import { emptyArena, gunnerLoadout, sandbagLoadout, scoutLoadout } from "../../arena-engine/src/fixtures.js";
import { HunterBot, IdleBot } from "../../arena-engine/src/stubs.js";
import { computeBattleStats } from "../src/stats.js";

beforeAll(async () => {
  await initPhysics();
});

describe("UX-D · perModule.uses dice qué mide, y el movimiento se cuenta", () => {
  it("un cazador que se mueve tiene drive.uses > 0 y distancia > 0; un bot quieto, 0 y 0", async () => {
    const replay = await record(
      {
        battleId: "stats-usage-1",
        seed: "stats-usage",
        ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 600 }),
        map: emptyArena(),
        participants: [
          { id: "v_hunter", botId: "bot_hunter", team: "red", spec: gunnerLoadout() },
          { id: "v_idle", botId: "bot_idle", team: "blue", spec: sandbagLoadout() },
        ],
      },
      (b) => {
        b.attachBot("v_hunter", new HunterBot("bot_hunter"));
        b.attachBot("v_idle", new IdleBot("bot_idle"));
      },
    );
    const s = await computeBattleStats(replay);
    const hunter = s.perBot["v_hunter"];
    const idle = s.perBot["v_idle"];

    // Movimiento: antes drive.uses era 0 SIEMPRE.
    expect(hunter.perModule["drive"].usesKind).toBe("move_commands");
    expect(hunter.perModule["drive"].uses).toBeGreaterThan(0);
    expect(hunter.distanceM).toBeGreaterThan(1);
    expect(idle.perModule["drive"].uses).toBe(0);
    expect(idle.distanceM).toBe(0);

    // Decisiones aplicadas: una por ciclo con comando (el cazador responde siempre).
    const cmds = replay.commands.filter((c) => c.vehicleId === "v_hunter").length;
    expect(hunter.decisions).toBe(cmds);
    expect(hunter.decisions).toBeGreaterThan(0);

    // Los pasivos lo DECLARAN en vez de fingir un 0 medido.
    expect(hunter.perModule["power"].usesKind).toBe("passive");
    const weaponSlots = Object.entries(hunter.perModule).filter(([, m]) => m.usesKind === "shots");
    expect(weaponSlots.length).toBeGreaterThan(0);
    expect(weaponSlots.reduce((a, [, m]) => a + m.uses, 0)).toBe(hunter.shotsFired);
  });

  it("los rechazos se desglosan por motivo y cuadran con los rechazos por módulo", async () => {
    const replay = await record(
      {
        battleId: "stats-usage-2",
        seed: "stats-usage-rej",
        ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 900 }),
        map: emptyArena(),
        participants: [
          { id: "v_red", botId: "bot_red", team: "red", spec: gunnerLoadout() },
          { id: "v_blue", botId: "bot_blue", team: "blue", spec: scoutLoadout() },
        ],
      },
      (b) => {
        b.attachBot("v_red", new HunterBot("bot_red"));
        b.attachBot("v_blue", new HunterBot("bot_blue"));
      },
    );
    const s = await computeBattleStats(replay);
    let anyRejection = false;
    for (const bot of Object.values(s.perBot)) {
      const byReason = Object.values(bot.rejectionsByReason).reduce((a, n) => a + n, 0);
      const byModule = Object.values(bot.perModule).reduce((a, m) => a + m.rejections, 0);
      // Todo rechazo con slot cuenta en los dos sitios; por motivo puede haber más (sin slot).
      expect(byReason).toBeGreaterThanOrEqual(byModule);
      if (byReason > 0) anyRejection = true;
      for (const k of Object.keys(bot.rejectionsByReason)) expect(k).toMatch(/^[a-z_]+$/);
    }
    // Dos cazadores disparando sin parar acaban chocando con la cadencia.
    expect(anyRejection).toBe(true);
  });
});
