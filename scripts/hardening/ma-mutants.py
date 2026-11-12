#!/usr/bin/env python3
"""OLA 2 · MA · Calibración por mutantes (se ejecuta EN VM112, dentro de flock, en serie).

Uso: python3 scripts/hardening/ma-mutants.py <worktree> <salida.json> [M1,N7,...]
La matriz completa (M*, MP_*, MW_*, N1-N17 y N18-N29 de la revisión 3) está definida aquí con su
ancla; un patrón ausente/no único se registra como `error` (killed=false), nunca se omite.

Cada mutante: aplica un cambio mínimo, ejecuta los tests que lo deben matar, registra el
rc REAL de vitest y restaura con `git checkout -- <ficheros>`. El árbol está en un commit
limpio (detached) antes de empezar: no hay nada sin commitear que perder.
"""
import json
import re
import subprocess
import sys

WT = sys.argv[1]
OUT = sys.argv[2]
ONLY = set(sys.argv[3].split(",")) if len(sys.argv) > 3 else None

P = "packages/projection/"
GW = "apps/api/src/spectate/gateway.ts"
BOUNDARY = "apps/api/src/spectate/ma-projection-boundary.test.ts"
PURE = "packages/projection/projection.test.ts"
WELCOME = "apps/arena-engine/tests/ma-welcome-projection.test.ts"
STATS_DB = "apps/api/src/uxd-battle-access.test.ts"
PRE1 = "apps/api/src/pre1-replay-projection.test.ts"
BOTIDS = "apps/arena-engine/tests/ma-bot-ids.test.ts"
BOTIDS_OBJ = "apps/arena-engine/tests/ma-bot-ids-objectives.test.ts"
COMP = "apps/api/src/ma-composition-private.test.ts"
LU = "apps/api/src/ma-loadout-unavailable.test.ts"
ELIG = "apps/api/src/version-eligibility-api.test.ts"
BIDS = "packages/projection/bot-ids.ts"
BRULES = "apps/api/src/services/battle-rules.ts"
VELIG = "apps/api/src/services/version-eligibility.ts"

MUTANTS = [
    # ---------------------------------------------------------- PUBLIC_ENTITY_IDS
    ("M1_public_id_equals_internal", P + "public-id-mapper.ts",
     "    return this.toPub.get(String(entity));",
     "    return String(entity) as PublicEntityId;", [PURE, BOUNDARY]),
    ("M7_shared_counter_across_prefixes", P + "public-id-mapper.ts",
     "    const n = (this.next.get(prefix) ?? 0) + 1;\n    this.next.set(prefix, n);",
     "    const n = (this.next.get(\"v\") ?? 0) + 1;\n    this.next.set(\"v\", n);", [PURE, BOUNDARY]),
    ("M8_internal_order_in_frame", P + "public-id-mapper.ts",
     "    fresh.sort(\n      (a, b) => cmp(a.prefix, b.prefix) || qn(a.x) - qn(b.x) || qn(a.y) - qn(b.y) || qn(a.tie ?? 0) - qn(b.tie ?? 0),\n    );",
     "", [PURE]),
    ("M3_mapping_shared_across_audiences", P + "public-id-mapper.ts",
     'JSON.stringify(["s9.mapping", battleId, String(audience), projectionVersion])',
     'JSON.stringify(["s9.mapping", battleId, projectionVersion])', [PURE, BOUNDARY]),
    ("M3g_gateway_one_projector_for_all", GW,
     "    for (const view of FEED_VIEWS) {\n      const projector = new AudienceProjector({",
     "    const shared = new AudienceProjector({ battleId, audience: audienceKey(\"public_live\"), roster, mapEntityIds: opts.mapEntityIds });\n    for (const view of FEED_VIEWS) {\n      const projector = shared; void new AudienceProjector({",
     [BOUNDARY]),
    ("M_seg_ids_from_segment_not_stream", "apps/api/src/replay-projection.ts",
     "    snapshots: full.snapshots.filter((s) => ticks.has(s.tick)),",
     "    snapshots: projectReplayStream({ battleId: String(body?.battleId ?? \"\"), audience: PUBLIC_REPLAY, snapshots: body?.snapshots ?? [], events: [] }).snapshots,",
     [PRE1]),
    # ------------------------------------------------ PUBLIC_PROJECTION_BOUNDARY
    ("M9_gateway_sends_raw_frame", GW,
     "          snapshot: projected.body,",
     "          snapshot: frame,", [BOUNDARY]),
    ("M9b_gateway_sends_raw_event", GW,
     "        if (projected) this.broadcast(feed, af, { type: \"event\", event: projected });",
     "        this.broadcast(feed, af, { type: \"event\", event: ev });", [BOUNDARY]),
    ("M9c_gateway_raw_result", GW,
     "        this.broadcast(feed, af, { type: \"result\", result: af.projector.projectResult(result) });",
     "        this.broadcast(feed, af, { type: \"result\", result });", [BOUNDARY]),
    ("M2_epoch_out_of_cache_key", P + "projection-key.ts",
     "    k.visibilityEpochDigest,\n", "", [PURE]),
    ("M_EPOCH_in_state_hash", P + "visibility.ts",
     "    const canon = [...components].sort();",
     "    EPOCH_LEAK.n++;\n    const canon = [...components].sort();", [BOUNDARY],
     # mutación compuesta: el contador global entra en stateHash()
     [(P + "visibility.ts", "interface Slot {", "export const EPOCH_LEAK = { n: 0 };\n(globalThis as any).__EPOCH_LEAK = EPOCH_LEAK;\n\ninterface Slot {"),
      ("apps/arena-engine/src/sim/battle.ts", "      tick: this.tick,\n      rng: this.rng.getState(),",
       "      tick: this.tick,\n      ep: (globalThis as any).__EPOCH_LEAK?.n ?? 0,\n      rng: this.rng.getState(),")]),
    ("M_ticket_without_view_accepted", "apps/api/src/auth/tokens.ts",
     "    if (!SPECTATOR_VIEWS.includes(p.view as SpectatorView)) return null;",
     "    if (!SPECTATOR_VIEWS.includes(p.view as SpectatorView)) p.view = \"public_live\";", [BOUNDARY]),
    # ------------------------------------------------------------ PRIVATE_EQUIPMENT
    ("MP_modules_public", P + "policy.ts",
     '    "vehicle.modules": PRIVATE, // ranuras + estado = loadout',
     '    "vehicle.modules": PUBLIC,', [PURE, BOUNDARY]),
    ("MP_hull_exact_public", P + "policy.ts",
     '    "vehicle.hullHp": all("SANITIZED"),',
     '    "vehicle.hullHp": PUBLIC,', [PURE, BOUNDARY]),
    ("MP_hullmax_public", P + "policy.ts",
     '    "vehicle.hullHpMax": PRIVATE, // revela el chasis',
     '    "vehicle.hullHpMax": PUBLIC,', [PURE, BOUNDARY]),
    ("MP_roster_chassis_public", P + "policy.ts",
     '    "roster.chassis": PRIVATE, // equipamiento',
     '    "roster.chassis": PUBLIC,', [PURE, BOUNDARY]),
    ("MP_stats_permodule_public", P + "policy.ts",
     '    "stats.perModule": ownerOnly(),',
     '    "stats.perModule": PUBLIC,', [PURE, STATS_DB]),
    ("MP_stats_route_unprojected", "apps/api/src/routes/battles.ts",
     '        const sporting = projectBotStats(rest, owner ? "owner" : "public_replay") as Record<string, any>;',
     '        const sporting = rest as Record<string, any>; void projectBotStats;', [STATS_DB]),
    ("MW_welcome_full_modulespec", "apps/arena-engine/src/protocol-server.ts",
     "    const modules = vehicle.spec.modules.map((m) => projectWelcomeModule(m as unknown as Record<string, unknown>));",
     "    const modules = vehicle.spec.modules.map((m) => {\n      const { slot, moduleId, category, ...specs } = m;\n      return { slot, moduleId, category, specs };\n    }); void projectWelcomeModule;",
     [WELCOME]),
    # ================================================== correcciones de la revisión (v2)
    ("N1_reveal_no_public_tiebreak", P + "public-id-mapper.ts",
     " || qn(a.tie ?? 0) - qn(b.tie ?? 0),\n    );", ",\n    );", [PURE]),
    ("N2_stats_damage_exact_for_third", P + "policy.ts",
     '    "stats.damageDealt": ownerOnly(),', '    "stats.damageDealt": PUBLIC,', [PURE, STATS_DB]),
    ("N14_damage_taken_public", P + "policy.ts",
     '    "stats.damageTaken": ownerOnly(),', '    "stats.damageTaken": PUBLIC,', [PURE]),
    ("N3_stats_hits_not_quantized", P + "equipment.ts",
     '  if ("shotsHit" in out && q("shotsHit")) out.shotsHit = step(out.shotsHit, STATS_HITS_STEP);', "", [PURE]),
    ("N4_accuracy_from_exact_hits", P + "equipment.ts",
     '''    const hitsQ = num(
      "shotsHit" in out && q("shotsHit")
        ? out.shotsHit
        : step((stats as Record<string, unknown>).shotsHit, STATS_HITS_STEP),
    );''', '    const hitsQ = num((stats as Record<string, unknown>).shotsHit);', [PURE]),
    ("N5_loadouts_public_bot_listed", "apps/api/src/routes/bots.ts",
     "      if (!isBotOwner(req.auth, bot) && !isStaff(req.auth)) throw notFound();\n", "", ["apps/api/src/ma-loadouts-private.test.ts"]),
    ("N6_replay_cache_without_roster_digest", "apps/api/src/replay-projection.ts",
     ':${publicRosterDigest(rosterOf(h, meta))}`;', '`; void publicRosterDigest;', ["apps/api/src/ma-replay-cache.test.ts"]),
    ("N7_bot_observation_raw", "apps/arena-engine/src/protocol-server.ts",
     "this.ids.observation(observation)", "observation", [BOTIDS]),
    ("N8_bot_event_raw", "apps/arena-engine/src/protocol-server.ts",
     "this.ids.event(event)", "event", [BOTIDS]),
    ("N9_bot_welcome_internal_self", "apps/arena-engine/src/protocol-server.ts",
     "selfId: ids.selfId(),", "selfId: vehicle.id,", [BOTIDS, WELCOME]),
    ("N10_bot_command_untranslated", "apps/arena-engine/src/protocol-server.ts",
     "this.pendingCommand = this.ids.command(payload);", "this.pendingCommand = payload;", [BOTIDS]),
    ("N13_team_damage_published", "apps/api/src/routes/battles.ts",
     "      delete copy.damageDealt;\n      delete copy.damageTaken;\n", "", ["apps/api/src/team4v4-battle-stats.test.ts"]),
    ("N14_damage_dealt_to_third_party", P + "policy.ts",
     '"stats.damageDealt": ownerOnly(),', '"stats.damageDealt": PUBLIC,', [PURE]),
    ("N15_damage_taken_to_third_party", P + "policy.ts",
     '"stats.damageTaken": ownerOnly(),', '"stats.damageTaken": PUBLIC,', [PURE]),
    ("N16_web_shows_zero_without_damage", "apps/web/src/pages/BattleDetailPage.tsx",
     '<td>{typeof st.damageDealt === "number" ? Math.round(st.damageDealt) : "—"}</td>',
     '<td>{Math.round(st.damageDealt ?? 0)}</td>', ["apps/web/tests/team-4v4-stats.test.tsx"]),
    ("N17_side_damage_zero_without_damage", "apps/web/src/pages/BattleDetailPage.tsx",
     '<td>{typeof t.damageTaken === "number" ? Math.round(t.damageTaken) : "—"}</td>',
     '<td>{Math.round(t.damageTaken ?? 0)}</td>', ["apps/web/tests/team-4v4-stats.test.tsx"]),
    ("N11_hud_modules_count_back", "apps/web/src/viewer/HudOverlay.tsx",
     "        {bot.armorBroken ? \"🛡✖ \" : \"\"}", "        {bot.armorBroken ? \"🛡✖ \" : \"\"}\n        <span data-testid=\"hud-bot-modules\">0/0 módulos</span>", ["apps/web/tests/ma-hud-private-modules.test.tsx"]),
    # ============================== revisión 3 (N18-N29): ids del bot, composición, elegibilidad
    ("N18_objectives_untranslated", BIDS,
     "    if (Array.isArray(obs.objectives)) {", "    if (false && Array.isArray(obs.objectives)) {", [BOTIDS_OBJ]),
    ("N18b_scrub_disabled", BIDS,
     "  private scrub<T>(v: T, key?: string): T {", "  private scrub<T>(v: T, key?: string): T {\n    if (key !== undefined || true) return v;", [BOTIDS_OBJ, BOTIDS]),
    # N19 es compuesto: `scrub` también traduce `from` (segunda capa); hay que quitar las dos.
    ("N19_radio_from_untranslated", BIDS,
     "        .map((m: any) => ({ ...m, from: this.vehicleRef(m?.from) }))", "        .map((m: any) => ({ ...m }))", [BOTIDS],
     [(BIDS, "  private scrub<T>(v: T, key?: string): T {", "  private scrub<T>(v: T, key?: string): T {\n    if (key !== undefined || true) return v;")]),
    ("N20_radio_data_scrubbed", BIDS,
     "OPAQUE_FIELDS.has(`${key}.${k}`)", "(OPAQUE_FIELDS.has(`${key}.${k}`) && false)", [BOTIDS]),
    ("N21_composition_visible_to_all", BRULES,
     "  return redactComposition(report, (id) => visible.has(id));", "  return redactComposition(report, () => true);", [COMP]),
    ("N22_foreign_violations_keep_figures", "packages/game-rules/battle-rules.ts",
     "    if (!hidden) return { ...v };", "    if (true) return { ...v };", [COMP]),
    ("N23_mixed_side_totals_published", "packages/game-rules/battle-rules.ts",
     "      ...(figuresHidden ? {} : { totalCredits: t.totalCredits, totalMassKg: t.totalMassKg }),",
     "      ...({ totalCredits: t.totalCredits, totalMassKg: t.totalMassKg }),", [COMP]),
    ("N24_eligibility_detail_for_all", VELIG,
     "    !!viewer && (viewer.staff || (viewer.userId !== null && owners.get(botId) === viewer.userId));", "    true;", [ELIG]),
    ("N25_loadout_unavailable_detail_for_all", BRULES,
     "(id) => visible.has(id));\n    } catch", "() => true);\n    } catch", [LU]),
    ("N26_resolve_error_message_forwarded", BRULES,
     "        canSee(p.botId)\n          ? `${label}: su loadout no se puede resolver", "        true\n          ? `${label}: su loadout no se puede resolver", [LU]),
    ("N27_staff_for_everyone", BRULES,
     "  if (viewer?.staff) {\n    for (const p of participants) visible.add(p.botId);", "  if (true) {\n    for (const p of participants) visible.add(p.botId);", [COMP, LU]),
    ("N28_viewer_always_staff", BRULES,
     "staff: (auth?.rank ?? 0) >= ROLE_RANK.moderator", "staff: true", [COMP, LU]),
    ("N29_eligibility_violations_for_third", VELIG,
     "          violations: [],\n        },", "          violations: b.e!.blocking.map((x) => ({ code: x.code, moduleId: x.moduleId })),\n        },", [ELIG]),
]
if ONLY:
    MUTANTS = [m for m in MUTANTS if m[0] in ONLY]


def run(cmd, timeout=1200):
    p = subprocess.run(cmd, cwd=WT, shell=True, capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout + p.stderr


def apply(path, old, new):
    full = f"{WT}/{path}"
    s = open(full).read()
    if s.count(old) != 1:
        raise RuntimeError(f"patrón no único/ausente en {path}: {old[:60]!r}")
    open(full, "w").write(s.replace(old, new))


results = []
for m in MUTANTS:
    name, path, old, new, tests = m[:5]
    extra = m[5] if len(m) > 5 else []
    touched = {path} | {e[0] for e in extra}
    entry = {"mutant": name, "files": sorted(touched), "tests": tests}
    try:
        apply(path, old, new)
        for (p2, o2, n2) in extra:
            apply(p2, o2, n2)
        rc, out = run("npx vitest run " + " ".join(tests))
        clean = re.sub(r"\x1b\[[0-9;]*m", "", out)
        entry["vitest_rc"] = rc
        entry["killed"] = rc != 0
        entry["failing"] = sorted(set(re.findall(r"FAIL\s+(\S+ > .+)", clean)))[:6]
        entry["summary"] = [l.strip() for l in clean.splitlines() if l.strip().startswith(("Test Files", "Tests "))]
    except Exception as e:  # noqa: BLE001
        entry["error"] = str(e)
        entry["killed"] = False
    finally:
        run("git checkout -- " + " ".join(sorted(touched)))
    results.append(entry)
    print(json.dumps({k: entry.get(k) for k in ("mutant", "vitest_rc", "killed", "error")}), flush=True)

rc, st = run("git status --porcelain")
json.dump({"results": results, "tree_after": st.strip()}, open(OUT, "w"), indent=1, ensure_ascii=False)
print("TREE_AFTER=" + (st.strip() or "clean"))
print("KILLED=%d/%d" % (sum(1 for r in results if r.get("killed")), len(results)))
