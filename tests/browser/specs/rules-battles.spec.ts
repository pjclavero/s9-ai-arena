/**
 * R-RULES · FASE 19 · Batallas REALES con los conjuntos de reglas, contra el stack de
 * run.sh (API + PG efímero, tournament-worker con contenedores reales, replay-service,
 * gateway y TLS). Etiqueta `@rules`: NO está en las fases de la CI (golden/fase1-3);
 * se lanza a mano con `.local`/manual (ver informe R-RULES) porque juega 7 batallas.
 *
 *  1. 1v1 Duelo                       (preset duel)              — UI
 *  2. 1v1 con respawn                 (preset combat)            — API
 *  3. 4v4 Eliminación                 (preset team_elimination)  — API
 *  4. 4v4 Respawn limitado            (preset team_limited_respawn) — API
 *  5. 4v4 Team Deathmatch             (preset team_deathmatch)   — API
 *  6. Personalizada con tope de créditos (2v2) — UI: primero ✗ con un bot caro, luego ✓
 *  7. Personalizada con tope de masa (2v2)     — API: 422 con el pesado, luego 202
 *  8. CTF preset ctf@1 2v2 (corredor + tirador por bando)                 — API (EQ2, 0.4.0)
 *  9. CTF personalizada 1 min SIN corredores: prórroga sin tope ⇒ salvaguarda TÉCNICA (≈21 min), sin resultado — API
 * 10. CTF personalizada 1 min con un corredor rojo: captura (en tiempo o en prórroga) — API
 *
 * Para cada una se comprueba: resultado coherente con las reglas, copia de reglas en la
 * batalla, replay (índice con el ruleset copiado), visor del replay (canvas pintado) y
 * stats por modo. Toda la evidencia va a $S9_E2E_OUT/review/rules-*.json.
 */
import { test, expect, type Page } from "@playwright/test";
import { go, registerNewUser, shot, watchProblems } from "./helpers.js";
import { BUILD_MS, PublicApi, evidence, waitFinished, waitStatsReady } from "./review-lib.js";

const STAMP = Date.now().toString(36);

/** Mismo bot de combate que la spec 4v4 (probado en CI y producción). */
const SHOOTER = `import math

from arena_sdk import ArenaBot


def angle_to(a, b):
    return math.atan2(b["y"] - a["y"], b["x"] - a["x"])


def angle_diff(a, b):
    d = b - a
    while d > math.pi:
        d -= 2 * math.pi
    while d < -math.pi:
        d += 2 * math.pi
    return d


def dist(a, b):
    return math.hypot(b["x"] - a["x"], b["y"] - a["y"])


def num(entity_id):
    digits = "".join(ch for ch in str(entity_id or "") if ch.isdigit())
    return int(digits) if digits else 0


class Atacante(ArenaBot):
    ready = False

    def on_welcome(self, welcome):
        self.me = welcome.get("selfId")
        self.team = welcome.get("team")
        m = welcome.get("map") or {}
        self.w = float(m.get("widthM") or 120)
        self.h = float(m.get("heightM") or 80)
        spawns = m.get("spawns") or []
        own = [s["position"] for s in spawns if s.get("team") == self.team]
        foe = [s["position"] for s in spawns if s.get("team") != self.team]
        center = {"x": self.w / 2, "y": self.h / 2}
        home = own[0] if own else center
        enemy = foe[0] if foe else center
        self.weapon = None
        for mod in (welcome.get("vehicle") or {}).get("modules") or []:
            if mod.get("category") == "weapon" and self.weapon is None:
                self.weapon = mod.get("slot")
        lane_y = self.h * (0.3 if num(self.me) % 2 else 0.7)
        fwd = 1 if enemy["x"] >= home["x"] else -1
        self.lane = [{"x": self.w / 2, "y": lane_y}, {"x": enemy["x"] - fwd * 15, "y": lane_y}, dict(enemy)]
        self.wp = 0
        self.seen = None
        self.last_pos = None
        self.last_tick = 0
        self.detour_until = 0
        self.reverse_until = 0
        self.detour_heading = 0.0
        self.side = 1 if num(self.me) % 2 else -1
        self.stuck = 0
        self.ready = True

    def drive(self, obs, goal, speed=1.0, keep_away=None):
        s = obs["self"]
        me = s["position"]
        tick = obs.get("tick", 0)
        if tick < self.detour_until:
            if tick < self.reverse_until:
                return {"throttle": -1.0, "steer": 0.0}
            turn = angle_diff(s["heading"], self.detour_heading)
            return {"throttle": 1.0 if abs(turn) < 0.9 else 0.4, "steer": max(-1.0, min(1.0, turn * 2.0))}
        want = angle_to(me, goal)
        far = dist(me, goal)
        if keep_away is not None and far < keep_away:
            want = angle_to(goal, me)
        turn = angle_diff(s["heading"], want)
        throttle = speed * (0.6 if abs(turn) > 1.4 else 1.0)
        if throttle > 0.3:
            if self.last_pos is None:
                self.last_pos, self.last_tick = dict(me), tick
            elif tick - self.last_tick >= 30:
                if dist(self.last_pos, me) < 1.5:
                    self.stuck += 1
                    if self.stuck >= 3:
                        self.side, self.stuck = -self.side, 0
                    self.detour_heading = want + self.side * (math.pi / 2)
                    self.reverse_until = tick + 9
                    self.detour_until = tick + 9 + 30 + 25 * min(self.stuck + 1, 4)
                else:
                    self.stuck = 0
                self.last_pos, self.last_tick = dict(me), tick
        else:
            self.last_pos = None
        return {"throttle": throttle, "steer": max(-1.0, min(1.0, turn * 2.0))}

    def on_observation(self, observation):
        try:
            return self.decide(observation)
        except Exception:
            return {}

    def decide(self, obs):
        if not self.ready or not obs.get("self") or obs["self"].get("respawningInTicks"):
            return {}
        s = obs["self"]
        me = s["position"]
        tick = obs.get("tick", 0)
        enemies = []
        for radar in (obs.get("sensors") or {}).get("radar") or []:
            for c in radar.get("contacts") or []:
                p = c.get("position") or {}
                if not c.get("team") and "x" in p:
                    enemies.append(p)
        if enemies:
            self.seen = (min(enemies, key=lambda p: dist(me, p)), tick)
        target = self.seen[0] if self.seen and tick - self.seen[1] < 90 else None
        cmd = {}
        if target is not None:
            cmd["move"] = self.drive(obs, target, 0.8, keep_away=12)
            cmd["turret"] = {"targetPoint": {"x": target["x"], "y": target["y"]}}
            aligned = abs(angle_diff(s.get("turretHeading", s["heading"]), angle_to(me, target))) < 0.15
            if aligned and enemies and self.weapon and dist(me, target) <= 45:
                cmd["fire"] = [self.weapon]
        else:
            goal = self.lane[self.wp % len(self.lane)]
            if dist(me, goal) < 6:
                self.wp = self.wp + 1 if self.wp + 1 < len(self.lane) else 1
            cmd["move"] = self.drive(obs, goal, 1.0)
        return cmd
`;
/**
 * EQ2 · Corredor de CTF: el MISMO pilotaje que SHOOTER, pero su objetivo es la bandera
 * rival (en la base rival, pública en el WELCOME) y, con ella, su propia base. Dispara
 * de paso si tiene a alguien a tiro.
 */
const RUNNER = SHOOTER.replace(
  `    def decide(self, obs):
        if not self.ready or not obs.get("self") or obs["self"].get("respawningInTicks"):
            return {}`,
  `    def decide(self, obs):
        if not self.ready or not obs.get("self") or obs["self"].get("respawningInTicks"):
            return {}
        s = obs["self"]
        me = s["position"]
        own = [b["position"] for b in self.bases if b.get("team") == self.team]
        foe = [b["position"] for b in self.bases if b.get("team") != self.team]
        if own and foe:
            goal = own[0] if s.get("carryingFlag") else foe[0]
            return {"move": self.drive(obs, goal, 1.0)}`,
).replace(
  `        self.ready = True`,
  `        self.bases = m.get("bases") or []
        self.ready = True`,
);

/** Ligero: 690 cr · 2260 kg (chasis+módulos; masa con la munición embebida). */
const LIGHT = {
  catalogVersion: "mvp@1",
  chassis: "chassis.medium@1",
  modules: [
    { slot: "drive", moduleId: "movement.wheels@1" },
    { slot: "power", moduleId: "power.battery@1" },
    { slot: "sensor_a", moduleId: "sensor.radar@1" },
    { slot: "turret_main", moduleId: "weapon.cannon@1", ammo: "ammo.ap@1" },
  ],
};
/** Caro y pesado: + blindaje frontal de acero (+120 cr, +420 kg) ⇒ 810 cr · 2680 kg. */
const HEAVY = { ...LIGHT, modules: [...LIGHT.modules, { slot: "armor_front", moduleId: "armor.steel_front@1" }] };

const NAMES = ["R1", "R2", "R3", "R4", "B1", "B2", "B3", "B4"].map((n) => `rules-${n}-${STAMP}`);
const HEAVY_NAME = `rules-HEAVY-${STAMP}`;
const RUNNER_NAMES = ["RUN-R", "RUN-B"].map((n) => `rules-${n}-${STAMP}`);

async function bearer(page: Page, creds: { email: string; password: string }) {
  const r = await page.request.post("/api/v1/auth/login", { data: creds });
  expect(r.status()).toBe(200);
  return ((await r.json()) as { accessToken: string }).accessToken;
}

async function botSubmitted(page: Page, api: PublicApi, creds: any, name: string, loadout: unknown, code = SHOOTER) {
  const bot = await api.ok<{ id: string }>("POST", "/bots", { name });
  const lo = await api.ok<{ revision: number }>("POST", `/bots/${bot.id}/loadouts`, loadout);
  const up = await page.request.post(`/api/v1/bots/${bot.id}/versions`, {
    headers: { Authorization: `Bearer ${await bearer(page, creds)}` },
    multipart: {
      source: { name: "bot.py", mimeType: "text/plain", buffer: Buffer.from(code) },
      runtime: "python",
      loadoutRevision: String(lo.revision),
    },
  });
  expect(up.status(), await up.text()).toBe(201);
  await api.ok("POST", `/bots/${bot.id}/versions/1/actions/submit`);
  return bot.id;
}

type P = { botId: string; version: number; team: string };
const side = (ids: string[], team: string): P[] => ids.map((botId) => ({ botId, version: 1, team }));

/** Resultado, copia de reglas, stats por modo, replay (índice) y visor del replay. */
async function verifyBattle(
  page: Page,
  api: PublicApi,
  info: any,
  key: string,
  battleId: string,
  expectFn: (b: any, s: any) => void,
) {
  const battle = await waitFinished(api, battleId, 900_000);
  expect(battle.status, JSON.stringify(battle)).toBe("finished");
  const stats = await waitStatsReady(api, battleId);
  expect(stats.rules?.presetId ?? stats.rules?.source).toBeTruthy();
  const index = await api.ok<any>("GET", `/replays/${battleId}/index`).catch((e) => ({ error: String(e) }));
  expectFn(battle, stats);
  // Visor del replay: la nómina y el canvas.
  await go(page, `#/replay/${battleId}?t=0`);
  await expect(page.getByTestId("replay-status")).toHaveAttribute("data-state", /playing|paused|finished/, {
    timeout: 30_000,
  });
  await expect(page.getByTestId("replay-canvas-host").locator("canvas")).toHaveCount(1);
  await shot(page, info, `rules-${key}-replay`);
  await go(page, `#/battles/${battleId}`);
  await expect(page.getByTestId("battle-detail")).toBeVisible();
  await expect(page.getByTestId("battle-stats")).toBeVisible({ timeout: 30_000 });
  await shot(page, info, `rules-${key}-detalle`);
  const rulesText = await page.getByTestId("battle-rules").textContent();
  evidence(`rules-${key}`, {
    battleId,
    rules: battle.rules,
    result: battle.result,
    participants: battle.participants,
    profile: stats.profile,
    perTeam: stats.perTeam,
    perBot: stats.perBot,
    replayIndex: index,
    detailRulesText: rulesText,
  });
  return { battle, stats };
}

const teamsOf = (b: any) => Object.keys(b.result?.score ?? {});
const sum = (o: Record<string, any>, k: string) => Object.values(o).reduce((a: number, x: any) => a + (x[k] ?? 0), 0);

test.describe("@rules R-RULES · batallas reales por conjunto de reglas", () => {
  test("10 batallas reales: presets 1v1/4v4, personalizadas con créditos y masa, CTF y prórroga", async ({
    page,
  }, info) => {
    test.setTimeout(5_400_000);
    const problems = watchProblems(page);
    const creds = await registerNewUser(page);
    const api = new PublicApi(page.request, creds);
    await api.login();

    // --- 9 bots (8 ligeros + 1 pesado), builds en paralelo, publicados ---------------
    const ids: string[] = [];
    for (const n of NAMES) ids.push(await botSubmitted(page, api, creds, n, LIGHT));
    const heavyId = await botSubmitted(page, api, creds, HEAVY_NAME, HEAVY);
    const runners: string[] = [];
    for (const n of RUNNER_NAMES) runners.push(await botSubmitted(page, api, creds, n, LIGHT, RUNNER));
    const all = [...ids, heavyId, ...runners];
    await expect
      .poll(
        async () => {
          const st = await Promise.all(
            all.map(
              async (id) => (await api.ok<any[]>("GET", `/bots/${id}/versions`)).find((v) => v.version === 1)?.state,
            ),
          );
          return st.every((s) => s === "validated" || s === "rejected") ? JSON.stringify(st) : "pendiente";
        },
        { timeout: BUILD_MS * 3, intervals: [3000, 5000] },
      )
      .not.toBe("pendiente");
    for (const id of all) await api.ok("POST", `/bots/${id}/versions/1/actions/publish`, { codePublic: false });
    const red4 = ids.slice(0, 4);
    const blue4 = ids.slice(4, 8);

    // --- 1 · Duelo por la UI ---------------------------------------------------------
    await go(page, "#/battles/new");
    await expect(page.getByLabel("reglas Duelo")).toBeChecked();
    await expect(page.getByTestId("rules-summary")).toContainText("Reaparición: Sin reaparición (1 vida)");
    await expect(page.getByTestId("rules-tiebreak")).toContainText("más bots vivos");
    await page.getByLabel("mapa").selectOption({ index: 0 });
    await page.getByLabel("bot rojo").selectOption({ label: `${NAMES[0]} (v1)` });
    await page.getByLabel("bot azul").selectOption({ label: `${NAMES[4]} (v1)` });
    await expect(page.getByTestId("battle-checklist")).toContainText("Reglas y presupuestos: válidos");
    await shot(page, info, "rules-1-duelo-nueva");
    const c1 = page.waitForResponse((r) => r.url().endsWith("/api/v1/battles") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Crear batalla" }).click();
    const r1 = await c1;
    expect(r1.status(), await r1.text()).toBe(202);
    const duelId = (await r1.json()).id as string;

    // --- 2-5 · por la API (presets) ------------------------------------------------------
    const dm = (p: P[], rules: unknown) => ({
      mode: "deathmatch",
      rulesetId: "deathmatch-mvp",
      mapId: "mvp-arena-02",
      participants: p,
      rules,
    });
    const tdm = (p: P[], rules: unknown) => ({
      mode: "team_deathmatch",
      rulesetId: "team-deathmatch-mvp",
      mapId: "mvp-arena-01",
      participants: p,
      rules,
    });
    const combatId = (
      await api.ok<any>(
        "POST",
        "/battles",
        dm([...side([ids[1]], "red"), ...side([ids[5]], "blue")], { preset: "combat", teamSize: 1 }),
      )
    ).id;
    const elimId = (
      await api.ok<any>(
        "POST",
        "/battles",
        tdm([...side(red4, "red"), ...side(blue4, "blue")], { preset: "team_elimination", teamSize: 4 }),
      )
    ).id;
    const limitedId = (
      await api.ok<any>(
        "POST",
        "/battles",
        tdm([...side(red4, "red"), ...side(blue4, "blue")], { preset: "team_limited_respawn", teamSize: 4 }),
      )
    ).id;
    const tdmId = (
      await api.ok<any>(
        "POST",
        "/battles",
        tdm([...side(red4, "red"), ...side(blue4, "blue")], { preset: "team_deathmatch", teamSize: 4 }),
      )
    ).id;

    // --- 6 · Personalizada con créditos por la UI (2v2: bot ≤ 700 cr, equipo ≤ 1400 cr) --
    // Por la API, para no depender de equipos en la UI: primero el informe con el pesado.
    const customCredits = (red: string[]) => ({
      preset: "custom",
      teamSize: 2,
      params: {
        respawn: { mode: "limited", maxRespawns: 1, delaySeconds: 3 },
        victory: "elimination",
        timeLimitMinutes: 4,
        botCredits: 700,
        teamCredits: 1400,
      },
    });
    const badCredits = await api.raw(
      "POST",
      "/battles",
      tdm([...side([ids[2], heavyId], "red"), ...side([ids[6], ids[7]], "blue")], customCredits([])),
    );
    expect(badCredits.status).toBe(422);
    const badCreditsBody = badCredits.body;
    expect(badCreditsBody.error).toBe("composition_invalid");
    evidence("rules-6-creditos-rechazo", badCreditsBody);
    const creditsId = (
      await api.ok<any>(
        "POST",
        "/battles",
        tdm([...side([ids[2], ids[3]], "red"), ...side([ids[6], ids[7]], "blue")], customCredits([])),
      )
    ).id;

    // --- 7 · Personalizada con masa (2v2: bot ≤ 2300 kg, equipo ≤ 4600 kg) ------------------
    const customMass = {
      preset: "custom",
      teamSize: 2,
      params: {
        respawn: { mode: "unlimited", delaySeconds: 3 },
        victory: "score_limit",
        scoreLimit: 3,
        timeLimitMinutes: 4,
        botMassKg: 2300,
        teamMassKg: 4600,
        friendlyFire: false,
      },
    };
    const badMass = await api.raw(
      "POST",
      "/battles",
      tdm([...side([ids[0], heavyId], "red"), ...side([ids[4], ids[5]], "blue")], customMass),
    );
    expect(badMass.status).toBe(422);
    evidence("rules-7-masa-rechazo", badMass.body);
    const massId = (
      await api.ok<any>(
        "POST",
        "/battles",
        tdm([...side([ids[0], ids[1]], "red"), ...side([ids[4], ids[5]], "blue")], customMass),
      )
    ).id;

    // --- 8-10 · CTF (EQ2, motor 0.4.0) ---------------------------------------------------
    const ctf = (p: P[], rules: unknown) => ({
      mode: "capture_the_flag",
      rulesetId: "capture-the-flag-mvp",
      mapId: "mvp-arena-01",
      participants: p,
      rules,
    });
    const ctfId = (
      await api.ok<any>(
        "POST",
        "/battles",
        ctf([...side([runners[0], ids[2]], "red"), ...side([runners[1], ids[6]], "blue")], {
          preset: "ctf",
          teamSize: 2,
        }),
      )
    ).id;
    const ctfQuick = {
      preset: "custom",
      teamSize: 2,
      params: {
        game: "capture_the_flag",
        respawn: { mode: "unlimited", delaySeconds: 5 },
        victory: "score_limit",
        scoreLimit: 3,
        timeLimitMinutes: 1,
        ctf: { flagReturnSeconds: 10, requireOwnFlagAtBase: true },
      },
    };
    const otDrawId = (
      await api.ok<any>(
        "POST",
        "/battles",
        ctf([...side([ids[3], ids[1]], "red"), ...side([ids[7], ids[5]], "blue")], ctfQuick),
      )
    ).id;
    const otRunId = (
      await api.ok<any>(
        "POST",
        "/battles",
        ctf([...side([runners[0], ids[0]], "red"), ...side([ids[4], ids[5]], "blue")], ctfQuick),
      )
    ).id;
    const badTeams = await api.raw(
      "POST",
      "/battles",
      ctf([...side([runners[0], ids[0]], "A"), ...side([ids[4], ids[5]], "B")], { preset: "ctf", teamSize: 2 }),
    );
    expect(badTeams.status).toBe(409);
    expect(badTeams.body.error).toBe("map_team_mismatch");
    evidence("rules-ctf-bandos-sin-bandera", badTeams.body);

    // --- UI de la personalizada: checklist con el bot pesado (✗) en «Nueva batalla» -------
    // Tras crear el Duelo la página sigue en «Batalla encolada» con el MISMO hash: se
    // pasa por la lista para que «Nueva batalla» se monte de nuevo.
    await go(page, "#/battles");
    await go(page, "#/battles/new");
    await expect(page.getByTestId("battle-rules")).toBeVisible();
    await page.getByLabel("reglas Personalizado").check();
    await page.getByLabel("Créditos máximos por bot: sin restricción").uncheck();
    const cr = page.getByLabel("Créditos máximos por bot", { exact: true });
    await cr.fill("700");
    await page.getByLabel("mapa").selectOption({ index: 0 });
    await page.getByLabel("bot rojo").selectOption({ label: `${HEAVY_NAME} (v1)` });
    await page.getByLabel("bot azul").selectOption({ label: `${NAMES[4]} (v1)` });
    await expect(page.getByTestId("rules-check-invalid")).toContainText(
      "supera el presupuesto máximo por bot en 110 cr",
    );
    await expect(page.getByTestId("rules-check")).toContainText(`✗ ${HEAVY_NAME} v1 — 810/700 cr`);
    await expect(page.getByRole("button", { name: "Crear batalla" })).toBeDisabled();
    await shot(page, info, "rules-6-ui-rechazo-creditos");

    // --- verificación de las 7 ---------------------------------------------------------------
    await verifyBattle(page, api, info, "1-duelo", duelId, (b, s) => {
      expect(b.rules.presetId).toBe("duel");
      expect(s.profile).toBe("elimination");
      const deaths = sum(s.perBot, "deaths");
      // Sin respawn: 1 muerte termina la batalla; si no hubo, decidió el desempate.
      expect(deaths).toBeLessThanOrEqual(1);
      expect(sum(s.perBot, "respawns")).toBe(0);
    });
    await verifyBattle(page, api, info, "2-combate", combatId, (b, s) => {
      expect(b.rules.presetId).toBe("combat");
      expect(s.profile).toBe("deathmatch");
      const score = b.result.score;
      if (b.result.ticks < b.rules.engine.timeLimitTicks)
        expect(Math.max(...(Object.values(score) as number[]))).toBe(5);
    });
    await verifyBattle(page, api, info, "3-eliminacion-4v4", elimId, (b, s) => {
      expect(s.profile).toBe("elimination");
      expect(sum(s.perBot, "respawns")).toBe(0);
      if (b.result.winner !== "draw" && b.result.ticks < b.rules.engine.timeLimitTicks) {
        const loser = teamsOf(b).find((t) => t !== b.result.winner)!;
        expect(s.perTeam[loser].survivors).toBe(0);
      }
    });
    await verifyBattle(page, api, info, "4-respawn-limitado-4v4", limitedId, (b, s) => {
      expect(s.profile).toBe("limited_respawn");
      for (const bot of Object.values<any>(s.perBot)) {
        expect(bot.lives).toBe(3);
        expect(bot.respawns).toBeLessThanOrEqual(2);
        expect(bot.respawnsRemaining).toBe(2 - bot.respawns);
      }
    });
    await verifyBattle(page, api, info, "5-tdm-4v4", tdmId, (b, s) => {
      expect(s.profile).toBe("deathmatch");
      for (const t of teamsOf(b)) {
        const other = teamsOf(b).find((x) => x !== t)!;
        expect(s.perTeam[t].kills + s.perTeam[other].teamKills).toBe(b.result.score[t]);
      }
    });
    await verifyBattle(page, api, info, "6-personalizada-creditos", creditsId, (b, s) => {
      expect(b.rules.source).toBe("custom");
      expect(b.rules.composition.botCredits).toBe(700);
      expect(s.profile).toBe("limited_respawn");
    });
    await verifyBattle(page, api, info, "7-personalizada-masa", massId, (b, s) => {
      expect(b.rules.composition.botMassKg).toBe(2300);
      expect(s.profile).toBe("deathmatch");
    });
    const otEvents = async (battleId: string) => {
      const idx = await api.ok<any>("GET", `/replays/${battleId}/index`).catch(() => null);
      return idx;
    };
    await verifyBattle(page, api, info, "8-ctf-preset", ctfId, (b, s) => {
      expect(b.rules.presetId).toBe("ctf");
      expect(b.rules.engine.overtime).toEqual({ kind: "next_score_wins" });
      expect(s.profile).toBe("capture_the_flag");
      const sc = Object.values(b.result.score) as number[];
      // Termina por 3 capturas, por más capturas al tiempo, en prórroga o empate al límite de seguridad.
      expect(b.result.ticks).toBeLessThanOrEqual(9000 + 36_000);
      if (b.result.ticks < 9000) expect(Math.max(...sc)).toBe(3);
    });
    // ADR-022 (decisión del operador): la prórroga NO tiene tope competitivo. Sin corredores
    // nadie captura ⇒ la salvaguarda TÉCNICA la detiene a los 20 min de prórroga, SIN
    // resultado deportivo (nunca «empate»). Esta batalla dura ≈ 21 min de reloj.
    const ot = await verifyBattle(page, api, info, "9-ctf-prorroga-limite-tecnico", otDrawId, (b) => {
      expect(b.rules.engine.overtime).toEqual({ kind: "next_score_wins" });
      if ((Object.values(b.result.score) as number[]).every((x) => x === 0)) {
        expect(b.result.endReason).toBe("technical_limit");
        expect(b.result.winner).toBeNull();
        expect(b.result.ticks).toBe(1800 + 36_000);
        for (const p of b.participants) expect(p.outcome ?? null).toBeNull();
      }
    });
    evidence("rules-9-indice", await otEvents(otDrawId));
    await verifyBattle(page, api, info, "10-ctf-corredor", otRunId, (b) => {
      const sc = b.result.score as Record<string, number>;
      if (b.result.ticks > 1800) {
        // Decidida en la prórroga por la primera captura, o detenida por la salvaguarda técnica.
        if (b.result.endReason === "technical_limit") expect(b.result.winner).toBeNull();
        else expect(sc[b.result.winner]).toBeGreaterThan(Math.min(...Object.values(sc)));
      }
    });
    void ot;
    evidence("rules-problems", problems);
    expect(problems.filter((p) => !p.startsWith("console.error"))).toEqual([]);
  });
});
