/**
 * T5.4 · DoD del artillero:
 *  - Gana ≥95% de 20 batallas contra un stub inmóvil (winrate exacto, sin redondear).
 *  - Acierta ≥60% de al menos 30 disparos a un blanco en movimiento rectilíneo
 *    constante (ForwardBot) a media distancia, con disparo predictivo.
 */
import { describe, expect, it } from "vitest";
import { startLocalBattle } from "../../sdks/javascript/tests/helpers.js";
import { GunnerBot } from "./gunner.js";
import { Battle } from "../../apps/arena-engine/src/sim/battle.js";
import { initPhysics } from "../../apps/arena-engine/src/sim/physics.js";
import { loadRuleset } from "../../packages/game-rules/index.js";
import { loadCatalog } from "../../packages/module-catalog/loadCatalog.js";
import { resolveVehicle } from "../../packages/module-catalog/resolve/index.js";
import { ARCHETYPES } from "../../packages/module-catalog/resolve/archetypes.js";
import { emptyArena } from "../../apps/arena-engine/src/fixtures.js";
import { ForwardBot } from "../../apps/arena-engine/src/stubs.js";

// El winrate son 20 batallas reales (~90 s): demasiado lento para el `npm test` por
// defecto. Se ejecuta con RUN_SLOW=1 (igual que E2 separó sus 1000 batallas nightly).
// La prueba de PRECISIÓN (síncrona, <1 s) sí corre siempre.
const slow = process.env.RUN_SLOW === "1" ? describe : describe.skip;

slow("T5.4 · GunnerBot vs stub inmóvil (winrate)", () => {
  it("gana al menos el 95% de 20 batallas, seed distinta cada vez", async () => {
    const N = 20;
    let wins = 0;
    for (let i = 0; i < N; i++) {
      // botId debe cumplir hello.schema.json: ^bot_[0-9a-zA-Z]{1,24}$ (sin guion bajo tras el prefijo).
      const bot = new GunnerBot(`bot_gunnerwr${i}`);
      const battle = await startLocalBattle({
        externalBots: [{ botId: bot.botId, archetype: "gunner" }],
        stubBots: [{ botId: `bot_immobile${i}`, archetype: "scout", kind: "idle" }],
        ticks: 900,
        seed: `gunner-winrate-${i}`,
      });
      await bot.run(`ws://127.0.0.1:${battle.port}`, battle.battleTokenFor.get(bot.botId)!);
      const result = await battle.waitForResult();
      if (result.winner === "red" && !result.disqualified.includes("veh_1")) wins++;
      battle.free();
    }
    const winrate = wins / N;
    console.log(`GunnerBot vs inmóvil: ${wins}/${N} = ${(winrate * 100).toFixed(1)}%`);
    expect(winrate).toBeGreaterThanOrEqual(0.95);
  }, 400000);
});

describe("T5.4 · GunnerBot: disparo predictivo contra un blanco en movimiento", () => {
  it("acierta al menos el 60% de >=30 disparos a un ForwardBot a media distancia", async () => {
    await initPhysics();
    const catalog = loadCatalog();
    // Esta prueba mide la PUNTERÍA del artillero (su disparo predictivo), no el
    // transporte —eso ya lo cubre protocol-server.test.ts—. Por eso conduce la
    // batalla de forma SÍNCRONA llamando directamente a la lógica real del bot
    // (GunnerBot.onObservation es una función pura de la observación), envuelta en
    // un BotAgent en proceso. Así puede medir >=30 disparos de forma determinista y
    // rápida, reposicionando el blanco cuando sale del rango de radar (el blanco se
    // mueve en línea recta y un ForwardBot abandona un radio de 50 m en pocos ticks).
    const ruleset = loadRuleset("dm_practice@1", { timeLimitTicks: 100000, friendlyFire: true, scoreToWin: 999999 });

    const targetSpec = resolveVehicle(ARCHETYPES.scout, catalog);
    targetSpec.hullHp = 1_000_000; // aguanta todos los impactos sin morir: medimos puntería, no matar

    const gunner = new GunnerBot("bot_gunneracc");
    let hits = 0;

    // BotAgent en proceso que delega en la lógica real del GunnerBot y cuenta hit_dealt.
    const inProcessAgent = {
      botId: "bot_gunneracc",
      welcomeSent: false,
      decide(observation: any) {
        if (!this.welcomeSent) {
          gunner.onWelcome({ map: { widthM: 120, heightM: 80 }, vehicle: { modules: gunnerModules } } as any);
          this.welcomeSent = true;
        }
        const intent = gunner.onObservation(observation) ?? {};
        return { ...intent, forTick: observation.tick + 3 };
      },
      onEvent(event: any) {
        if (event.kind === "hit_dealt" && settled()) hits++;
      },
    };

    const battle = await Battle.create({
      battleId: "gunner_accuracy_test",
      seed: "gunner-accuracy",
      ruleset,
      map: emptyArena(),
      participants: [
        { id: "veh_1", botId: "bot_gunneracc", team: "red", spec: resolveVehicle(ARCHETYPES.gunner, catalog) },
        { id: "veh_2", botId: "bot_target", team: "blue", spec: targetSpec },
      ],
    });
    const gunnerModules = battle
      .getVehicle("veh_1")!
      .spec.modules.map((m) => ({ slot: m.slot, moduleId: m.moduleId, category: m.category, specs: m }));
    battle.attachBot("veh_1", inProcessAgent);
    battle.attachBot("veh_2", new ForwardBot("bot_target"));

    const phys = battle.getPhysics();
    const START = { x: 40, y: 40 };
    const TARGET_START = { x: 68, y: 40 };
    phys.get("veh_1")!.rb.setTranslation(START, true);

    // Ventana de adquisición: tras reposicionar el blanco, la torreta tarda unos
    // ticks en reorientarse (turretRateRads finito). Medir el disparo predictivo en
    // ese transitorio mediría la reorientación, no la predicción; se excluye. Fuera de
    // esa ventana, el blanco lleva velocidad constante y la predicción es lo único que
    // cuenta. El reposicionamiento PRESERVA la velocidad (no la pone a 0) para no
    // introducir un arranque desde parado ajeno al escenario "movimiento constante".
    let lastResetTick = 0;
    const SETTLE_TICKS = 24;
    const settled = () => battle.tick - lastResetTick > SETTLE_TICKS;
    const resetTarget = () => {
      phys.get("veh_2")!.rb.setTranslation(TARGET_START, true);
      phys.get("veh_2")!.rb.setRotation(Math.PI / 2, true); // se mueve +y, cruzando la vista del artillero
      phys.get("veh_2")!.rb.setLinvel({ x: 0, y: 9 }, true); // velocidad de crucero del scout, preservada
      lastResetTick = battle.tick;
    };
    resetTarget();

    const ammoModule = [...battle.getVehicle("veh_1")!.modules.values()].find((m) => m.spec.category === "ammo")!;
    let shotsFired = 0;

    // Corre acumulando >=40 disparos EN RÉGIMEN PERMANENTE (fuera de la ventana de
    // adquisición), reposicionando el blanco cuando se aleja del rango de radar.
    for (let i = 0; i < 40000; i++) {
      const ammoBefore = ammoModule.ammo;
      battle.step();
      if (settled() && ammoModule.ammo < ammoBefore) shotsFired += ammoBefore - ammoModule.ammo;
      const g = phys.get("veh_1")!.rb.translation();
      const t = phys.get("veh_2")!.rb.translation();
      if (Math.hypot(g.x - t.x, g.y - t.y) > 45) resetTarget();
      if (shotsFired >= 40) break;
    }

    battle.free();

    console.log(
      `GunnerBot precisión (régimen permanente): ${hits}/${shotsFired} disparos = ${shotsFired > 0 ? ((hits / shotsFired) * 100).toFixed(1) : "0"}%`,
    );
    expect(shotsFired).toBeGreaterThanOrEqual(30);
    expect(hits / shotsFired).toBeGreaterThanOrEqual(0.6);
  }, 60000);
});
