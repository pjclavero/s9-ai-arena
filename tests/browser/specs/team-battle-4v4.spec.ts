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
import { BUILD_MS, PublicApi, evidence, waitFinished } from "./review-lib.js";

const STAMP = Date.now().toString(36);
const RED = ["A-ATK-1", "A-ATK-2", "A-ATK-3", "A-ATK-4"].map((n) => `${n}-${STAMP}`);
const BLUE = ["B-DEF-1", "B-DEF-2", "B-DEF-3", "B-DEF-4"].map((n) => `${n}-${STAMP}`);
const TEAM_A = `Alfa 4v4 ${STAMP}`;
const TEAM_B = `Beta 4v4 ${STAMP}`;

/** Avanza al centro y dispara al rival más cercano que ve el radar: la partida se decide pronto. */
const SHOOTER = `from arena_sdk import ArenaBot, angle_diff, angle_to


class Tirador(ArenaBot):
    def on_observation(self, observation):
        me = observation["self"]
        pos = me["position"]
        contacts = [c for r in observation.get("sensors", {}).get("radar", []) for c in r.get("contacts", [])]
        enemies = [c for c in contacts if not c.get("team")]
        if enemies:
            t = min(enemies, key=lambda c: (c["position"]["x"] - pos["x"]) ** 2 + (c["position"]["y"] - pos["y"]) ** 2)
            turn = angle_diff(me["heading"], angle_to(pos, t["position"]))
            return {
                "move": {"throttle": 0.3, "steer": max(-1.0, min(1.0, turn * 1.5))},
                "turret": {"targetPoint": t["position"]},
                "fire": ["turret_main"],
            }
        turn = angle_diff(me["heading"], angle_to(pos, {"x": 60.0, "y": 40.0}))
        return {"move": {"throttle": 0.8, "steer": max(-1.0, min(1.0, turn * 2.0))}}
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

/** Cuenta, en la mitad superior del canvas (fuera del minimapa), los píxeles de cada color. */
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
      // El minimapa va en la esquina inferior izquierda con fondo de color suelo:
      // se mira sólo el 60 % superior para que no cuente como «suelo pintado».
      const d = ctx.getImageData(0, 0, img.width, Math.floor(img.height * 0.6)).data;
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
    await expect(page.getByLabel("equipo A").locator("option", { hasText: TEAM_A })).toHaveCount(1, {
      timeout: 20_000,
    });
    await page.getByLabel("equipo A").selectOption({ label: TEAM_A });
    await page.getByLabel("equipo B").selectOption({ label: TEAM_B });
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
    await shot(page, info, "4v4-replay");
    evidence("team-4v4", { battleId, winner, sent: sent.participants, pixels });
    expect(problems.filter((p) => !p.startsWith("console.error"))).toEqual([]);
  });
});
