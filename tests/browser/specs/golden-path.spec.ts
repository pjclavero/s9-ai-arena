/**
 * REVIEW (cierre funcional, R6) · GOLDEN PATH en navegador real (Chromium de la
 * imagen oficial fijada) contra el entorno aislado de run.sh, SIN mocks de
 * servicios internos de S9:
 *
 *   registro → bot A (equipamiento + código) → build REAL en el sandbox de A
 *   (bot-build-worker → s9-docker-proxy local → Docker rootless) → published →
 *   bot B → build → published → equipo → mapa (importar, guardar, F5, reabrir,
 *   renombrar, guardar, publicar) → logout/login (todo recuperado) → nueva batalla
 *   en el mapa propio → la ejecuta el tournament-worker con el ARTEFACTO FIRMADO de
 *   cada versión (contenedores reales) → visor EN DIRECTO (ticket real de la API →
 *   TLS → gateway → worker) → finished → ganador → stats → replay → reproducción.
 *
 * Los bots son distinguibles: «Artillero» dispara a todo contacto de radar,
 * «Pacifista» nunca dispara. Que gane el Artillero con disparos > 0 y el Pacifista
 * tenga 0 intentos prueba que corrió SU código (con HunterBot dispararían ambos).
 *
 * Incluye los pasos del recorrido provisional de DEV-C (tests/fc-c-browser, ya
 * unificado aquí): verdad del equipamiento, persistencia del mapa, equipo, y el
 * formulario de batalla con rulesets y mapas servidos por la API.
 *
 * Escribe /out/golden/battle.json ({battleId}) para las fases siguientes (replay,
 * sonda TD-028): sustituye al atajo seed-replay de DEV-D.
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { OUT, go, login, registerNewUser, shot, watchProblems } from "./helpers.js";

const ARTILLERO = `from arena_sdk import ArenaBot, angle_diff, angle_to

WAYPOINTS = [(30.0, 64.0), (88.0, 64.0), (100.0, 40.0)]


class Artillero(ArenaBot):
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.wp = 0

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
        tx, ty = WAYPOINTS[min(self.wp, len(WAYPOINTS) - 1)]
        if (tx - pos["x"]) ** 2 + (ty - pos["y"]) ** 2 < 16 and self.wp < len(WAYPOINTS) - 1:
            self.wp += 1
        turn = angle_diff(me["heading"], angle_to(pos, {"x": tx, "y": ty}))
        return {"move": {"throttle": 0.9 if abs(turn) < 1.0 else 0.3, "steer": max(-1.0, min(1.0, turn * 2.0))}}
`;

const PACIFISTA = `from arena_sdk import ArenaBot


class Pacifista(ArenaBot):
    def on_observation(self, observation):
        return {"move": {"throttle": 0.0, "steer": 0.0}}
`;

const STAMP = Date.now().toString(36);
const BOT_A = `golden-artillero-${STAMP}`;
const BOT_B = `golden-pacifista-${STAMP}`;
const TEAM = `Golden Rojos ${STAMP}`;
const MAP_ID = `golden-${STAMP}`;

/** Bot por la UI: equipamiento con radar (legal), código pegado, build REAL y publicación. */
async function publishedBot(page: Page, name: string, code: string) {
  await go(page, "#/bots");
  await page.getByLabel("nuevo-bot").fill(name);
  await page.getByRole("button", { name: "Crear bot" }).click();
  await page.getByRole("button", { name, exact: true }).click();
  await page.getByLabel("chasis").selectOption("chassis.medium@1");
  await page.getByLabel("slot-drive").selectOption("movement.wheels@1");
  await page.getByLabel("slot-power").selectOption("power.battery@1");
  await page.getByLabel("slot-sensor_a").selectOption("sensor.radar@1");
  await page.getByLabel("slot-turret_main").selectOption("weapon.cannon@1");
  await page.getByLabel("slot-armor_front").selectOption("armor.steel_front@1");
  // C4 · la UI dice la verdad sobre el efecto real del equipamiento.
  // UX-01 · el loadout elegido ES el vehículo de la batalla (no el arquetipo del chasis).
  await expect(page.getByTestId("effect-note")).toContainText("es el vehículo que juega");
  await expect(page.getByTestId("effect-note")).not.toContainText("arquetipo");
  await expect(page.getByTestId("effect-chassis")).toHaveAttribute("data-effect", "ACTIVE");
  await expect(page.getByTestId("effect-slot-turret_main")).toHaveAttribute("data-effect", "ACTIVE");
  await page.getByTestId("effect-detail-turret_main").locator("summary").click();
  await expect(page.getByTestId("effect-detail-turret_main")).toContainText("rangeM");
  await expect(page.getByTestId("effect-detail-turret_main")).toContainText("FUTURE");
  await page.getByTestId("save-loadout").click();
  await expect(page.getByTestId("saved")).toBeVisible();
  await page.getByLabel("codigo").fill(code);
  await page.getByRole("button", { name: "Subir como versión nueva" }).click();
  await page.getByRole("button", { name: "Enviar a validación v1" }).click();
  // Build REAL: cola → bot-build-worker → contenedor del sandbox. Sin atajos.
  await expect(page.getByTestId("version-row-1")).toContainText("validated", { timeout: 240_000 });
  await page.getByRole("button", { name: "Publicar v1" }).click();
  await expect(page.getByTestId("version-row-1")).toContainText("published");
}

/**
 * UX-D (G-08 · TD-047) · Las vistas de una batalla (detalle, stats, auditoría) ya
 * no son anónimas: sólo las lee quien puede leer su replay. Antes estas lecturas
 * iban SIN sesión y funcionaban por la fuga. Ahora llevan el Bearer del usuario
 * del golden (login por la API pública con sus credenciales).
 */
let bearer = "";
let creds: { email: string; password: string } | null = null;
async function apiLogin(page: Page, email: string, password: string): Promise<void> {
  creds = { email, password };
  const r = await page.request.post("/api/v1/auth/login", { data: { email, password } });
  expect(r.status(), `login API: ${await r.text()}`).toBe(200);
  bearer = ((await r.json()) as { accessToken: string }).accessToken;
}

async function api<T>(page: Page, path: string): Promise<T> {
  const get = () =>
    page.request.get(`/api/v1${path}`, bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {});
  let r = await get();
  // El access token dura 15 min y el golden puede acercarse: se renueva una vez.
  if (r.status() === 401 && creds) {
    await apiLogin(page, creds.email, creds.password);
    r = await get();
  }
  expect(r.status(), `${path}: ${await r.text()}`).toBe(200);
  return (await r.json()) as T;
}

test.describe("@golden Golden path", () => {
  test("registro → 2 bots buildeados y publicados → equipo → mapa → batalla REAL → visor → stats → replay", async ({
    page,
  }, info) => {
    test.setTimeout(900_000);
    const problems = watchProblems(page);
    const { email, password } = await registerNewUser(page);
    await apiLogin(page, email, password);

    // --- bots A y B: código del usuario, build real, publicados ----------
    await publishedBot(page, BOT_A, ARTILLERO);
    await shot(page, info, "golden-bot-a-publicado");
    await publishedBot(page, BOT_B, PACIFISTA);

    // --- equipo ----------------------------------------------------------
    await go(page, "#/teams");
    await page.getByLabel("nuevo-equipo").fill(TEAM);
    await page.getByRole("button", { name: "Crear equipo" }).click();
    const team = page.getByRole("region", { name: `equipo ${TEAM}` });
    await expect(team).toBeVisible();
    await team.getByLabel(`añadir-bot-${TEAM}`).selectOption({ label: BOT_A });
    await team.getByRole("button", { name: "Añadir bot" }).click();
    await expect(team.getByText(BOT_A)).toBeVisible();

    // --- mapa: importar (geometría de la serie) → guardar → F5 → renombrar → publicar
    const base = await api<Record<string, unknown>>(page, "/maps/mvp-arena-01/versions/1/content");
    const content = (base as { content?: unknown }).content ?? base;
    await go(page, "#/maps/editor");
    // UX-EDITOR: el JSON vive plegado en «Opciones avanzadas» del editor visual.
    await page.getByText("Opciones avanzadas: archivo JSON del mapa").click();
    await page.getByLabel("JSON a importar").fill(JSON.stringify(content));
    await page.getByRole("button", { name: "Importar", exact: true }).click();
    await page.getByLabel("id del mapa").fill(MAP_ID);
    await page.getByLabel("nombre del mapa").fill("Golden uno");
    const dm = page.getByLabel("modo deathmatch");
    if (!(await dm.isChecked())) await dm.check();
    await page.getByTestId("editor-save").click();
    await expect(page.getByTestId("editor-notice")).toContainText(`${MAP_ID} v1`);
    await page.reload(); // F5: reabre desde la API
    await expect(page.getByLabel("nombre del mapa")).toHaveValue("Golden uno");
    await expect(page.getByTestId("editor-current")).toHaveText(`${MAP_ID} v1`);
    await page.getByLabel("nombre del mapa").fill("Golden final");
    await page.getByTestId("editor-save").click();
    await expect(page.getByTestId("editor-notice")).toContainText(`${MAP_ID} v1`);
    await page.getByTestId("editor-publish").click();
    await expect(page.getByTestId("editor-notice")).toContainText("Publicado");

    // --- logout / login: todo se recupera del servidor --------------------
    await page.getByTestId("logout").click();
    await login(page, email, password);
    await go(page, "#/maps");
    await expect(page.getByRole("cell", { name: new RegExp(`Golden final · ${MAP_ID} \\(tuyo\\)`) })).toBeVisible();
    await go(page, "#/teams");
    await expect(page.getByRole("region", { name: `equipo ${TEAM}` }).getByText(BOT_A)).toBeVisible();

    // --- nueva batalla en el mapa propio ---------------------------------
    await go(page, "#/battles/new");
    await expect(page.getByLabel("modo")).toHaveValue("deathmatch");
    await expect(page.getByLabel("ruleset")).toHaveValue("deathmatch-mvp"); // id de la BD (GET /rulesets)
    await page.getByLabel("mapa").selectOption(`${MAP_ID}@1`);
    await page.getByLabel("equipo rojo").selectOption({ label: TEAM });
    await page.getByLabel("bot rojo").selectOption({ label: `${BOT_A} (v1)` });
    await page.getByLabel("bot azul").selectOption({ label: `${BOT_B} (v1)` });
    const created = page.waitForResponse((r) => r.url().endsWith("/api/v1/battles") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Crear batalla" }).click();
    const resp = await created;
    expect(resp.status()).toBe(202);
    await expect(page.getByTestId("battle-created")).toBeVisible();
    await expect(page.getByTestId("run-real")).toHaveCount(0); // R4.6: crear = ejecutar
    const battleId = (await resp.json()).id as string;
    mkdirSync(`${OUT}/golden`, { recursive: true });
    writeFileSync(`${OUT}/golden/battle.json`, JSON.stringify({ battleId }));

    // --- visor EN DIRECTO mientras corre (ticket real → TLS → gateway → worker)
    await expect
      .poll(async () => (await api<{ status: string }>(page, `/battles/${battleId}`)).status, { timeout: 120_000 })
      .not.toBe("scheduled");
    await go(page, `#/viewer/${battleId}`);
    await expect(page.getByTestId("viewer-status")).toHaveAttribute("data-state", /live|finished/, {
      timeout: 30_000,
    });
    const viewerState = await page.getByTestId("viewer-status").getAttribute("data-state");
    // No basta con «en directo»: el visor tiene que RECIBIR la partida. Se espera a
    // que el marcador del HUD (alimentado por snapshots/eventos del WebSocket) vea
    // la baja que decide la batalla.
    await expect(page.getByTestId("score")).toContainText("red: 1", { timeout: 180_000 });
    await shot(page, info, "golden-visor-en-directo");

    // --- finished + ganador en la lista de batallas -----------------------
    await expect
      .poll(async () => (await api<{ status: string }>(page, `/battles/${battleId}`)).status, { timeout: 300_000 })
      .toBe("finished");
    await go(page, "#/battles");
    const row = page.locator(`[data-testid="battle-row"][data-battle-id="${battleId}"]`);
    await expect(row).toHaveAttribute("data-status", "finished");
    // UX-F (DEF-R6) · el bando en palabras (rojo/azul), como en el selector.
    await expect(row.getByTestId("battle-outcome")).toContainText("gana rojo");
    await shot(page, info, "golden-batalla-terminada");

    const battle = await api<{
      result: { agents: string; winner: string; schema: string; endReason: string };
      participants: { botId: string; outcome: string; version: number; team: string }[];
      replayAvailable: boolean;
    }>(page, `/battles/${battleId}`);
    expect(battle.result.schema).toBe("battle-result/v1");
    expect(battle.result.agents).toBe("container");
    expect(battle.result.winner).toBe("red");
    expect(battle.replayAvailable).toBe(true);
    const red = battle.participants.find((p) => p.team === "red")!;
    const blue = battle.participants.find((p) => p.team === "blue")!;
    expect(red.outcome).toBe("win");
    expect(blue.outcome).toBe("loss");

    // --- stats: SU código corrió (Pacifista 0 intentos; Artillero dispara) --
    // `status=finished` NO garantiza que `battle_stats` exista ya (TD-065): el
    // worker la escribe tras la transacción de cierre (H3, issue #7). Medido en
    // producción: ~1,4 s después de `finished_at`. Se espera a que estén las DOS
    // entradas; si no aparecen en el plazo, el test FALLA (nunca pasa sin datos).
    type Stats = {
      perBot: Record<string, { shotsFired: number; perModule: Record<string, { uses: number; rejections: number }> }>;
    };
    let stats: Stats = { perBot: {} };
    await expect
      .poll(
        async () => {
          stats = await api<Stats>(page, `/battles/${battleId}/stats`);
          return [red.botId, blue.botId].filter((id) => !stats.perBot?.[id]);
        },
        {
          message: `battle_stats de ${battleId} sin materializar para algún participante (bots sin entrada en perBot)`,
          timeout: 12_000,
          intervals: [250, 500],
        },
      )
      .toEqual([]);
    const sA = stats.perBot[red.botId];
    const sB = stats.perBot[blue.botId];
    expect(sA.shotsFired).toBeGreaterThan(0);
    expect(sB.shotsFired).toBe(0);
    expect(sB.perModule.turret_main.uses + sB.perModule.turret_main.rejections).toBe(0);

    // --- replay y reproducción en la web ---------------------------------
    // PRC REVIEW (TD-004) · el reproductor lee por la API AUTORIZADA
    // (/api/v1/replays/<id>/index y /segment) y NUNCA por /replays* del gateway
    // (cerrado: 404). Se registra cada respuesta para el veredicto independiente.
    const replayHits: { path: string; status: number }[] = [];
    page.on("response", (r) => {
      const path = new URL(r.url()).pathname;
      if (/^\/replays(\/|$)/.test(path) || path.startsWith("/api/v1/replays"))
        replayHits.push({ path, status: r.status() });
    });
    await go(page, "#/replays");
    const rrow = page.locator(`[data-testid="replay-row"][data-battle-id="${battleId}"]`);
    await expect(rrow).toBeVisible({ timeout: 30_000 });
    await rrow.getByTestId("replay-open").click();
    const status = page.getByTestId("replay-status");
    await expect(status).toHaveAttribute("data-state", /playing|finished/, { timeout: 20_000 });
    const tickEl = page.getByTestId("replay-tick");
    await expect
      .poll(async () => Number(await tickEl.getAttribute("data-tick")), { timeout: 15_000 })
      .toBeGreaterThan(30);
    await page.getByRole("button", { name: "8×" }).click();
    await expect(status).toHaveAttribute("data-state", "finished", { timeout: 60_000 });
    await shot(page, info, "golden-replay-fin");
    const replayPath = {
      apiIndex200: replayHits.filter((h) => h.path === `/api/v1/replays/${battleId}/index` && h.status === 200).length,
      apiSegment200: replayHits.filter((h) => h.path === `/api/v1/replays/${battleId}/segment` && h.status === 200)
        .length,
      gatewayReplays: replayHits.filter((h) => /^\/replays(\/|$)/.test(h.path)).length,
    };
    expect(replayPath.apiIndex200, JSON.stringify(replayHits)).toBeGreaterThan(0);
    expect(replayPath.apiSegment200, JSON.stringify(replayHits)).toBeGreaterThan(0);
    expect(replayPath.gatewayReplays, JSON.stringify(replayHits)).toBe(0);

    writeFileSync(
      `${OUT}/golden/evidence.json`,
      JSON.stringify({
        battleId,
        viewerState,
        result: battle.result,
        participants: battle.participants,
        stats: { red: sA.shotsFired, blue: sB.shotsFired },
        replayPath,
      }),
    );
    expect(problems.filter((p) => !p.startsWith("console.error"))).toEqual([]);
  });
});
