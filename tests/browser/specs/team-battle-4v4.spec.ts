/**
 * 4v4 · T-UI · Batalla POR EQUIPOS de extremo a extremo contra el stack real de
 * run.sh (sin mocks de servicios de S9):
 *
 *   usuario nuevo → 8 bots (API pública con su Bearer: build REAL de cada versión en
 *   el sandbox) → 2 equipos de 4 (API) → «Nueva batalla» → BATALLA POR EQUIPOS en la
 *   UI: Equipo A + Equipo B, 4 vs 4 · 8 / 8, Deathmatch por equipos → la ejecuta el
 *   tournament-worker con contenedores reales → detalle con el resultado POR BANDO →
 *   replay con los 8 por nombre y cámaras por bando de la nómina.
 *
 * 4v4-FIX: los bots combaten (disparos en los dos bandos, bajas y reapariciones) y
 * el marcador del resultado debe coincidir con `perTeam.kills` de `/stats`.
 *
 * Coste de CI: 8 builds. Por eso los bots y los equipos se crean por la API (lo
 * que ya cubren golden-path/teams.spec por la UI) y la UI se reserva para lo nuevo:
 * la creación de la batalla por equipos, el detalle y el replay.
 *
 * P1 (escenario negro): sobre el replay REAL se leen los píxeles del canvas y se
 * exige ver el SUELO y los MUROS horneados (colores de S9_ENV), no sólo el fondo.
 * Antes de llamar a RenderTexture.render() el mapa se veía negro y sin obstáculos.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { go, registerNewUser, shot, watchProblems } from "./helpers.js";
import { BUILD_MS, PublicApi, evidence, waitFinished, waitStatsReady } from "./review-lib.js";

const STAMP = Date.now().toString(36);
const RED = ["A-ATK-1", "A-ATK-2", "A-ATK-3", "A-ATK-4"].map((n) => `${n}-${STAMP}`);
const BLUE = ["B-DEF-1", "B-DEF-2", "B-DEF-3", "B-DEF-4"].map((n) => `${n}-${STAMP}`);
const TEAM_A = `Alfa 4v4 ${STAMP}`;
const TEAM_B = `Beta 4v4 ${STAMP}`;

/**
 * 4v4-FIX · Bot que COMBATE de verdad sobre mvp-arena-01 (el anterior iba al centro,
 * se clavaba en el muro central y la batalla de CI acabó 0-0 con 0 disparos tras
 * 9000 ticks). Navegación de `team_bot.py` (ATK, ya probado en producción): avanza
 * por un carril norte/sur hacia la base rival rodeando muros (marcha atrás + desvío
 * de ±90° al atascarse), persigue el contacto de radar más cercano y dispara con
 * la torreta alineada. Medido con el motor local sobre el mapa real: 8-6, 8-6, 8-2
 * (el anterior, 0-0 y 0 disparos). La batalla termina al llegar a 8, no a 9000 ticks.
 */
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
    """Avanza por un carril hacia la base rival (rodeando muros), persigue al
    contacto de radar más cercano y dispara con la torreta alineada."""

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
const LOADOUT = {
  catalogVersion: "mvp@1",
  chassis: "chassis.medium@1",
  modules: [
    { slot: "drive", moduleId: "movement.wheels@1" },
    { slot: "power", moduleId: "power.battery@1" },
    { slot: "sensor_a", moduleId: "sensor.radar@1" },
    { slot: "turret_main", moduleId: "weapon.cannon@1", ammo: "ammo.ap@1" },
  ],
};

/** Colores del horneado estático (apps/web/src/viewer/art-direction.ts · S9_ENV). */
const S9_COLORS = {
  background: [0x10, 0x14, 0x10],
  ground: [0x18, 0x20, 0x1a],
  wall: [0x3a, 0x44, 0x40],
} as const;

/** Bearer recién emitido para la subida multipart (PublicApi sólo envía JSON). */
async function freshBearer(page: Page, creds: { email: string; password: string }): Promise<string> {
  const r = await page.request.post("/api/v1/auth/login", { data: creds });
  expect(r.status(), `login API: ${await r.text()}`).toBe(200);
  return ((await r.json()) as { accessToken: string }).accessToken;
}

/** Bot + loadout + v1 con código subido y enviada a validación (el build se espera después). */
async function botSubmitted(
  page: Page,
  api: PublicApi,
  creds: { email: string; password: string },
  name: string,
): Promise<string> {
  const bot = await api.ok<{ id: string }>("POST", "/bots", { name });
  const loadout = await api.ok<{ revision: number }>("POST", `/bots/${bot.id}/loadouts`, LOADOUT);
  const up = await page.request.post(`/api/v1/bots/${bot.id}/versions`, {
    headers: { Authorization: `Bearer ${await freshBearer(page, creds)}` },
    multipart: {
      source: { name: "bot.py", mimeType: "text/plain", buffer: Buffer.from(SHOOTER) },
      runtime: "python",
      loadoutRevision: String(loadout.revision),
    },
  });
  expect(up.status(), `subir v1 de ${name}: ${await up.text()}`).toBe(201);
  await api.ok("POST", `/bots/${bot.id}/versions/1/actions/submit`);
  return bot.id;
}

/** Cuenta, en el canvas entero (el minimapa ya no está dentro), los píxeles de cada color. */
async function canvasColorCounts(
  page: Page,
  canvas: Locator,
): Promise<{ total: number; counts: Record<keyof typeof S9_COLORS, number> }> {
  const png = await canvas.screenshot();
  return page.evaluate(
    async ({ b64, colors }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      // UX-VIEW · Antes se miraba sólo el 60 % superior porque el minimapa (con
      // fondo de color suelo) iba DENTRO del canvas, abajo a la izquierda. Ahora es
      // un panel aparte, fuera del escenario (se comprueba abajo que no se solapan):
      // el canvas entero es mapa y se cuenta entero (equivalente más estricto).
      const d = ctx.getImageData(0, 0, img.width, img.height).data;
      const counts: Record<string, number> = Object.fromEntries(Object.keys(colors).map((k) => [k, 0]));
      let total = 0;
      for (let i = 0; i < d.length; i += 4) {
        total++;
        for (const [k, [r, g, b]] of Object.entries(colors)) {
          if (Math.abs(d[i] - r) <= 3 && Math.abs(d[i + 1] - g) <= 3 && Math.abs(d[i + 2] - b) <= 3) counts[k]++;
        }
      }
      return { total, counts: counts as Record<"background" | "ground" | "wall", number> };
    },
    { b64: png.toString("base64"), colors: S9_COLORS },
  );
}

test.describe("@golden 4v4 · batalla por equipos", () => {
  test("8 bots → 2 equipos → BATALLA POR EQUIPOS en la UI (4 vs 4) → detalle por bando → replay con los 8 y el mapa pintado", async ({
    page,
  }, info) => {
    test.setTimeout(1_200_000);
    const problems = watchProblems(page);
    const creds = await registerNewUser(page);
    const api = new PublicApi(page.request, creds);
    await api.login();

    // --- 8 bots: las 8 versiones a la cola de builds A LA VEZ (no una tras otra) --
    const ids: Record<string, string> = {};
    for (const name of [...RED, ...BLUE]) ids[name] = await botSubmitted(page, api, creds, name);
    await expect
      .poll(
        async () => {
          const states: Record<string, string> = {};
          for (const [name, id] of Object.entries(ids)) {
            const vs = await api.ok<{ version: number; state: string }[]>("GET", `/bots/${id}/versions`);
            states[name] = vs.find((v) => v.version === 1)?.state ?? "?";
          }
          // Un rechazo no se arregla esperando: se enseña tal cual y falla.
          return Object.values(states).every((s) => s === "validated" || s === "rejected")
            ? JSON.stringify(states)
            : "pendiente";
        },
        { timeout: BUILD_MS * 2, intervals: [3000, 5000] },
      )
      .not.toBe("pendiente");
    for (const [name, id] of Object.entries(ids)) {
      const vs = await api.ok<{ version: number; state: string }[]>("GET", `/bots/${id}/versions`);
      expect(vs.find((v) => v.version === 1)?.state, `build de ${name}`).toBe("validated");
      await api.ok("POST", `/bots/${id}/versions/1/actions/publish`, { codePublic: false });
    }

    // --- 2 equipos de 4 ---------------------------------------------------------
    for (const [team, names] of [
      [TEAM_A, RED],
      [TEAM_B, BLUE],
    ] as const) {
      const t = await api.ok<{ id: string }>("POST", "/teams", { name: team });
      for (const n of names) await api.ok("POST", `/teams/${t.id}/bots`, { botId: ids[n] });
    }

    // --- «Nueva batalla» → BATALLA POR EQUIPOS (UI) -------------------------------
    await go(page, "#/battles/new");
    await page.getByRole("radio", { name: /BATALLA POR EQUIPOS/ }).check();
    await expect(page.getByLabel("modo")).toHaveValue("team_deathmatch");
    await expect(page.getByTestId("team-concepts")).toContainText("Equipo A juega en el bando rojo");
    await expect(page.getByLabel("equipo A", { exact: true }).locator("option", { hasText: TEAM_A })).toHaveCount(1, {
      timeout: 20_000,
    });
    await page.getByLabel("equipo A", { exact: true }).selectOption({ label: TEAM_A });
    await page.getByLabel("equipo B", { exact: true }).selectOption({ label: TEAM_B });
    await expect(page.getByTestId("participants-count")).toHaveText("Participantes: 4 vs 4 · 8 / 8");
    for (const n of RED) await expect(page.getByTestId("team-summary-A")).toContainText(`${n} · v1`);
    for (const n of BLUE) await expect(page.getByTestId("team-summary-B")).toContainText(`${n} · v1`);
    await expect(page.getByTestId("team-summary-A")).toContainText("Equipo A ✓");
    const mapValues = await page
      .getByLabel("mapa")
      .locator("option")
      .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
    await page.getByLabel("mapa").selectOption(mapValues.find((v) => v.startsWith("mvp-arena-01@")) ?? mapValues[0]);
    await expect(page.getByTestId("battle-checklist")).not.toContainText("✗");
    await shot(page, info, "4v4-nueva-batalla");
    const created = page.waitForResponse((r) => r.url().endsWith("/api/v1/battles") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Crear batalla" }).click();
    const resp = await created;
    expect(resp.status(), await resp.text()).toBe(202);
    const sent = resp.request().postDataJSON() as {
      mode: string;
      participants: { botId: string; version: number; team: string }[];
    };
    expect(sent.mode).toBe("team_deathmatch");
    expect(sent.participants).toHaveLength(8);
    expect(sent.participants.filter((p) => p.team === "red").map((p) => p.botId)).toEqual(RED.map((n) => ids[n]));
    expect(sent.participants.filter((p) => p.team === "blue").map((p) => p.botId)).toEqual(BLUE.map((n) => ids[n]));
    expect(sent.participants.every((p) => p.version === 1)).toBe(true);
    const battleId = (await resp.json()).id as string;

    // --- detalle: enlace tras crear, y resultado por bando al terminar ----------------
    await page.getByTestId("battle-detail-link").click();
    await expect(page.getByTestId("battle-detail")).toBeVisible();
    const battle = await waitFinished(api, battleId, 600_000);
    expect(battle.status, JSON.stringify(battle)).toBe("finished");
    expect(battle.participants).toHaveLength(8);
    const winner = battle.result?.winner as string;
    expect(["red", "blue", "draw"]).toContain(winner);

    // 4v4-FIX · hubo COMBATE de verdad y el marcador cuadra con las estadísticas.
    const stats = await waitStatsReady(api, battleId);
    const perTeam = stats.perTeam as Record<string, { kills: number; teamKills: number; shotsFired: number }>;
    const perBot = Object.values(stats.perBot as Record<string, { respawns?: number; kills?: number }>);
    const score = (battle.result?.score ?? {}) as Record<string, number>;
    expect(Object.keys(perTeam).sort(), JSON.stringify(stats.perTeam)).toEqual(["blue", "red"]);
    for (const t of ["red", "blue"]) expect(perTeam[t].shotsFired, `disparos de ${t}`).toBeGreaterThan(0);
    expect(perTeam.red.kills + perTeam.blue.kills, "al menos una baja").toBeGreaterThan(0);
    expect(
      perBot.reduce((a, b) => a + (b.respawns ?? 0), 0),
      "al menos una reaparición",
    ).toBeGreaterThan(0);
    // TDM: cada baja enemiga es un punto; con fuego amigo el rival suma además los teamKills.
    expect(perTeam.red.kills + perTeam.blue.teamKills, "marcador rojo").toBe(score.red ?? 0);
    expect(perTeam.blue.kills + perTeam.red.teamKills, "marcador azul").toBe(score.blue ?? 0);
    await page.reload();
    await expect(page.getByTestId("battle-title")).toContainText(
      `${RED.join(", ")} (rojo) vs ${BLUE.join(", ")} (azul)`,
    );
    const sideRows = page.getByTestId("battle-sides").getByTestId("side-row");
    await expect(sideRows).toHaveCount(2);
    const expected =
      winner === "draw" ? ["empate", "empate"] : winner === "red" ? ["gana", "pierde"] : ["pierde", "gana"];
    await expect(sideRows.nth(0)).toHaveAttribute("data-team", "red");
    await expect(sideRows.nth(0)).toContainText(`4 · ${RED.map((n) => `${n} v1`).join(", ")}`);
    await expect(sideRows.nth(0)).toContainText(expected[0]);
    await expect(sideRows.nth(1)).toHaveAttribute("data-team", "blue");
    await expect(sideRows.nth(1)).toContainText(`4 · ${BLUE.map((n) => `${n} v1`).join(", ")}`);
    await expect(sideRows.nth(1)).toContainText(expected[1]);
    await expect(page.getByTestId("participant-row")).toHaveCount(8);
    await shot(page, info, "4v4-detalle");

    // --- replay: los 8 por nombre, cámaras por bando de la nómina, mapa pintado ------
    await go(page, `#/replay/${battleId}?t=0`);
    const status = page.getByTestId("replay-status");
    await expect(status).toHaveAttribute("data-state", /playing|paused|finished/, { timeout: 30_000 });
    await expect(page.getByTestId("replay-title")).toContainText(`${RED.join(", ")} (rojo) vs`);
    const roster = page.getByTestId("replay-roster");
    await expect(roster.getByTestId("roster-vehicle")).toHaveCount(8);
    await expect(
      roster.locator('[data-testid="roster-side"][data-team="red"] [data-testid="roster-vehicle"]'),
    ).toHaveCount(4);
    await expect(
      roster.locator('[data-testid="roster-side"][data-team="blue"] [data-testid="roster-vehicle"]'),
    ).toHaveCount(4);
    for (const n of [...RED, ...BLUE]) await expect(roster).toContainText(n);
    await expect(page.getByTestId("camera-side")).toHaveText(["Bando rojo", "Bando azul"]);

    // P1 · el escenario NO es negro: suelo y muros horneados en el canvas real.
    const canvas = page.getByTestId("replay-canvas-host").locator("canvas");
    await expect(canvas).toHaveCount(1);
    let pixels = await canvasColorCounts(page, canvas);
    await expect
      .poll(
        async () => {
          pixels = await canvasColorCounts(page, canvas);
          return pixels.counts.ground / pixels.total > 0.2 && pixels.counts.wall > 200;
        },
        { message: "el canvas del replay no muestra suelo ni muros", timeout: 15_000, intervals: [500, 1000] },
      )
      .toBe(true);
    // UX-VIEW · el minimapa es un panel FUERA del escenario: no se solapa con el canvas
    // y dibuja los 8 vehículos (ninguno queda invisible debajo de él).
    const canvasBox = await canvas.boundingBox();
    const miniBox = await page.getByTestId("minimap-canvas").boundingBox();
    expect(canvasBox && miniBox, "canvas y minimapa visibles").toBeTruthy();
    expect(
      canvasBox!.x < miniBox!.x + miniBox!.width &&
        miniBox!.x < canvasBox!.x + canvasBox!.width &&
        canvasBox!.y < miniBox!.y + miniBox!.height &&
        miniBox!.y < canvasBox!.y + canvasBox!.height,
      "el minimapa no tapa el escenario",
    ).toBe(false);
    await expect(page.getByTestId("minimap-canvas")).toHaveAttribute("data-dots", "8");
    await shot(page, info, "4v4-replay");
    evidence("team-4v4", { battleId, winner, score, perTeam, sent: sent.participants, pixels });
    expect(problems.filter((p) => !p.startsWith("console.error"))).toEqual([]);
  });
});
