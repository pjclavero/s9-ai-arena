/**
 * OLA 2 · G3.5 · TDM_NO_CONTACT_STALEMATE: traza POR TICK de tdm_4v4_norespawn (diagnóstico).
 *
 * Uso (laboratorio, bajo flock):  npx tsx scripts/hardening/g3-tdm-trace.ts <trace.csv> <resumen.json>
 *
 * Misma batalla que el ancla `tdm_4v4_norespawn` (rules-respawn-tiebreak) y que el test de
 * diagnóstico de respawn-rearm.test.ts: tdm_mvp@1 sin respawn, scoreToWin 99, semilla
 * `rules-seed`, emptyArena, 4v4 de HunterBot con el reparto artillero/explorador.
 *
 * SÓLO OBSERVA: no llama a canFire() (consume el flujo `combat` del RNG) ni a nada que mute el
 * estado. La disponibilidad de disparo se recalcula leyendo el estado (módulo, cooldown,
 * munición, energía). El hash a 6000 ticks se compara con el ancla para demostrar que observar
 * no altera la simulación. No implementa ni propone reglas nuevas.
 */
import { writeFileSync } from "node:fs";
import { loadRuleset } from "../../packages/game-rules/index.js";
import { Battle, type Participant } from "../../apps/arena-engine/src/sim/battle.js";
import { initPhysics } from "../../apps/arena-engine/src/sim/physics.js";
import { emptyArena, gunnerLoadout, scoutLoadout } from "../../apps/arena-engine/src/fixtures.js";
import { HunterBot } from "../../apps/arena-engine/src/stubs.js";
import { ammoFor } from "../../apps/arena-engine/src/sim/combat.js";

const ANCHOR_6000 = "86544a85f9a0ae80752970b3fcaafb18a9e8a6b2295059db6734b14574092b98";
const [csvPath, summaryPath] = process.argv.slice(2);
if (!csvPath || !summaryPath) throw new Error("uso: g3-tdm-trace.ts <trace.csv> <resumen.json>");

await initPhysics();
const parts: Participant[] = [];
for (let i = 0; i < 8; i++)
  parts.push({
    id: `veh_${i + 1}`,
    botId: `b${i + 1}`,
    team: i % 2 === 0 ? "red" : "blue",
    spec: i % 3 === 2 ? scoutLoadout() : gunnerLoadout(),
  });
const ruleset = loadRuleset("tdm_mvp@1", { respawn: { enabled: false, delayTicks: 0 }, scoreToWin: 99 });
const b = new Battle({ battleId: "rr", seed: "rules-seed", ruleset, map: emptyArena(), participants: parts, recordReplay: true });

/** Última observación y último comando de cada bot (se envuelve decide: sólo mira). */
const lastObs = new Map<string, { tick: number; enemyContacts: number; fire: boolean }>();
const fireCmds = new Map<string, number[]>();
for (const p of parts) {
  const bot = new HunterBot(p.botId);
  const decide = bot.decide.bind(bot);
  bot.decide = (obs: any) => {
    const cmd = decide(obs);
    const contacts = (obs.sensors?.radar ?? []).flatMap((r: any) => r.contacts ?? []).filter((c: any) => !c.team);
    const fire = Array.isArray(cmd?.fire) && cmd.fire.length > 0;
    lastObs.set(p.id, { tick: obs.tick, enemyContacts: contacts.length, fire });
    if (fire) (fireCmds.get(p.id) ?? fireCmds.set(p.id, []).get(p.id)!).push(obs.tick);
    return cmd;
  };
  b.attachBot(p.id, bot);
}
const rejected: { tick: number; vehicle: string; reason: string }[] = [];
const emit = (b as any).emit.bind(b);
(b as any).emit = (ev: any, to?: string) => {
  if (ev.kind === "rejected_action" && to) rejected.push({ tick: (b as any).tick, vehicle: to, reason: ev.reason });
  return emit(ev, to);
};

const header =
  "tick,vehicle,team,x,y,hull,ammo,ammoMax,weaponOk,cooldownReady,energyOk,canFireNow,radarRangeM," +
  "nearestEnemyM,enemiesInRadarRange,obsTick,obsEnemyContacts,obsFire,projectilesInFlight";
const rows: string[] = [header];
let hashAt6000: string | null = null;
for (let t = 0; t < ruleset.timeLimitTicks + 10 && !b.isFinished(); t++) {
  b.step();
  const tick = b.tick;
  if (tick === 6000) hashAt6000 = b.stateHash();
  const poses = (b as any).poses();
  const alive = b.getVehicles().filter((v) => v.alive);
  const nProj = (b as any).projectiles.length;
  for (const v of alive) {
    const pos = poses.get(v.id).position;
    const w = v.modulesOf("weapon")[0];
    const st = w ? v.stateOf(w.slot) : "destroyed";
    const weaponOk = !!w && st !== "destroyed" && st !== "offline";
    const cooldownReady = !!w && tick >= w.cooldownUntilTick;
    const am = w ? ammoFor(v, w.spec.acceptsAmmo ?? []) : null;
    const ammo = am ? am.ammo : 0;
    const ammoMax = am ? (am.spec.rounds ?? 0) : 0;
    const energyOk = !!w && v.energyEU >= (w.spec.perActionEU ?? 0);
    const radar = v
      .modulesOf("sensor")
      .filter((m) => m.spec.sensorType === "radar")
      .reduce((a, m) => Math.max(a, m.spec.rangeM ?? 0), 0);
    const enemies = alive.filter((o) => o.team !== v.team);
    const dists = enemies.map((o) => {
      const q = poses.get(o.id).position;
      return Math.hypot(q.x - pos.x, q.y - pos.y);
    });
    const nearest = dists.length ? Math.min(...dists) : -1;
    const inRange = dists.filter((d) => d <= radar).length;
    const o = lastObs.get(v.id);
    rows.push(
      [
        tick, v.id, v.team, pos.x.toFixed(2), pos.y.toFixed(2), Math.round(v.hullHp), ammo, ammoMax,
        +weaponOk, +cooldownReady, +energyOk, +(weaponOk && cooldownReady && ammo > 0 && energyOk), radar,
        nearest.toFixed(2), inRange, o?.tick ?? -1, o?.enemyContacts ?? -1, o ? +o.fire : -1, nProj,
      ].join(","),
    );
  }
}
writeFileSync(csvPath, rows.join("\n") + "\n");

// ---------------------------------------------------------------- resumen
const deaths = b.publicEvents.filter((e: any) => e.kind === "vehicle_destroyed").map((e: any) => ({ tick: e.tick, id: e.targetId }));
const lastDeath = deaths.length ? Math.max(...deaths.map((d) => d.tick)) : 0;
const parsed = rows.slice(1).map((r) => r.split(","));
const col = (name: string) => header.split(",").indexOf(name);
const after = parsed.filter((r) => Number(r[col("tick")]) > lastDeath);
const survivors = [...new Set(after.map((r) => r[col("vehicle")]))];
const perSurvivor = Object.fromEntries(
  survivors.map((id) => {
    const rs = after.filter((r) => r[col("vehicle")] === id);
    const num = (c: string) => rs.map((r) => Number(r[col(c)]));
    return [
      id,
      {
        team: rs[0][col("team")],
        ticks: rs.length,
        ammoMin: Math.min(...num("ammo")),
        ammoMax: rs[0][col("ammoMax")],
        ticksCanFireNow: num("canFireNow").filter((x) => x === 1).length,
        ticksCooldownBlocked: num("cooldownReady").filter((x) => x === 0).length,
        ticksEnergyBlocked: num("energyOk").filter((x) => x === 0).length,
        radarRangeM: rs[0][col("radarRangeM")],
        nearestEnemyMinM: Math.min(...num("nearestEnemyM")),
        ticksEnemyInRadarRange: num("enemiesInRadarRange").filter((x) => x > 0).length,
        ticksObsWithEnemyContact: num("obsEnemyContacts").filter((x) => x > 0).length,
        fireCommandsAfterLastDeath: (fireCmds.get(id) ?? []).filter((t) => t > lastDeath).length,
        fireCommandsTotal: (fireCmds.get(id) ?? []).length,
      },
    ];
  }),
);
const aliveByTeamAfter = { red: Infinity, blue: Infinity } as Record<string, number>;
for (const tick of new Set(after.map((r) => r[col("tick")]))) {
  const rs = after.filter((r) => r[col("tick")] === tick);
  for (const team of ["red", "blue"]) aliveByTeamAfter[team] = Math.min(aliveByTeamAfter[team], rs.filter((r) => r[col("team")] === team).length);
}
const result = b.getResult();
const summary = {
  scenario: "tdm_4v4_norespawn (tdm_mvp@1, respawn off, scoreToWin 99, seed rules-seed, emptyArena 4v4 HunterBot)",
  timeLimitTicks: ruleset.timeLimitTicks,
  hashAt6000,
  hashAt6000MatchesAnchor: hashAt6000 === ANCHOR_6000,
  deaths,
  lastDeathTick: lastDeath,
  ticksAfterLastDeath: after.length ? Number(after[after.length - 1][col("tick")]) - lastDeath : 0,
  minAliveByTeamAfterLastDeath: aliveByTeamAfter,
  rejectedActions: { total: rejected.length, afterLastDeath: rejected.filter((r) => r.tick > lastDeath).length, byReason: rejected.reduce((a: any, r) => ((a[r.reason] = (a[r.reason] ?? 0) + 1), a), {}) },
  noAmmoRejections: rejected.filter((r) => r.reason === "no_ammo").length,
  ticksWithProjectilesAfterLastDeath: new Set(after.filter((r) => Number(r[col("projectilesInFlight")]) > 0).map((r) => r[col("tick")])).size,
  perSurvivor,
  finalPositions: Object.fromEntries(
    b.getVehicles().filter((v) => v.alive).map((v) => [v.id, (b as any).poses().get(v.id).position]),
  ),
  arena: { widthM: (b.config.map as any).widthM, heightM: (b.config.map as any).heightM },
  result: result ? { winner: result.winner, endReason: (result as any).endReason, ticks: result.ticks, score: (result as any).score } : null,
};
writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify({ hashAt6000MatchesAnchor: summary.hashAt6000MatchesAnchor, lastDeath, rows: rows.length - 1, result: summary.result }));
b.free();
