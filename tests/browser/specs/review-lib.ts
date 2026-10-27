/**
 * [REVIEW] UX Acceptance · utillaje de las specs de la revisión independiente.
 *
 * Sólo UI real y API pública con cuentas normales recién registradas: ni BD, ni
 * admin, ni inyección. Lo que no se puede hacer por la UI (no hay control de
 * visibilidad del bot en la web) se hace con la API pública y el Bearer del dueño,
 * y se anota como hallazgo.
 */
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { OUT, go } from "./helpers.js";

export const BUILD_MS = 240_000;

export interface Creds {
  email: string;
  password: string;
}

/** Cliente de la API pública con el Bearer de UNA cuenta normal (o anónimo si no hay creds). */
export class PublicApi {
  private bearer = "";
  constructor(
    private readonly req: APIRequestContext,
    private readonly creds: Creds | null,
  ) {}

  async login(): Promise<void> {
    if (!this.creds) return;
    const r = await this.req.post("/api/v1/auth/login", { data: this.creds });
    expect(r.status(), `login API: ${await r.text()}`).toBe(200);
    this.bearer = ((await r.json()) as { accessToken: string }).accessToken;
  }

  private headers(): Record<string, string> {
    return this.bearer ? { Authorization: `Bearer ${this.bearer}` } : {};
  }

  /** Petición cruda (estado + cuerpo); renueva el token una vez si caduca. */
  async raw(method: "GET" | "POST" | "PATCH", path: string, data?: unknown): Promise<{ status: number; body: any }> {
    const send = () =>
      this.req.fetch(`/api/v1${path}`, { method, headers: this.headers(), ...(data !== undefined ? { data } : {}) });
    let r = await send();
    if (r.status() === 401 && this.creds) {
      await this.login();
      r = await send();
    }
    const text = await r.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* cuerpo no JSON */
    }
    return { status: r.status(), body };
  }

  async ok<T = any>(method: "GET" | "POST" | "PATCH", path: string, data?: unknown): Promise<T> {
    const r = await this.raw(method, path, data);
    expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).toBeGreaterThanOrEqual(200);
    expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
    return r.body as T;
  }
}

export function evidence(name: string, data: unknown): void {
  mkdirSync(`${OUT}/review`, { recursive: true });
  writeFileSync(`${OUT}/review/${name}.json`, JSON.stringify(data, null, 2));
}

export interface LoadoutPick {
  chassis: string;
  slots: Record<string, string>;
}

/** Crea el bot por la UI, lo abre y guarda el loadout pedido. */
export async function createBotWithLoadout(page: Page, name: string, loadout: LoadoutPick): Promise<void> {
  await go(page, "#/bots");
  await page.getByLabel("nuevo-bot").fill(name);
  await page.getByRole("button", { name: "Crear bot" }).click();
  await page.getByRole("button", { name, exact: true }).click();
  await page.getByLabel("chasis").selectOption(loadout.chassis);
  for (const [slot, mod] of Object.entries(loadout.slots)) await page.getByLabel(`slot-${slot}`).selectOption(mod);
  await page.getByTestId("save-loadout").click();
  await expect(page.getByTestId("saved")).toBeVisible();
}

/** Sube lo que haya en el editor (o `code`) como versión `v` y la envía a validación. */
export async function submitVersion(page: Page, v: number, code?: string): Promise<void> {
  if (code !== undefined) await page.getByLabel("codigo").fill(code);
  await page.getByRole("button", { name: "Subir como versión nueva" }).click();
  await expect(page.getByTestId(`version-row-${v}`)).toContainText("draft");
  await page.getByRole("button", { name: `Enviar a validación v${v}` }).click();
}

export async function expectState(page: Page, v: number, state: "validated" | "rejected"): Promise<void> {
  await expect(page.getByTestId(`version-row-${v}`)).toContainText(state, { timeout: BUILD_MS });
}

export async function publish(page: Page, v: number): Promise<void> {
  await page.getByRole("button", { name: `Publicar v${v}` }).click();
  await expect(page.getByTestId(`version-row-${v}`)).toContainText("published");
}

/** Elige en «Nueva batalla» el bot cuyo nombre es `name` en el bando dado (por su value real). */
export async function pickBot(page: Page, side: "rojo" | "azul", name: string): Promise<void> {
  const sel = page.getByLabel(`bot ${side}`);
  const opt = sel.locator("option", { hasText: name });
  await expect(opt).toHaveCount(1, { timeout: 20_000 });
  await expect(opt).toBeEnabled();
  const value = await opt.getAttribute("value");
  expect(value, `option de ${name} sin value`).toBeTruthy();
  await sel.selectOption(value!);
}

/** Crea la batalla desde el formulario y devuelve su id (respuesta 202 real). */
export async function createBattle(page: Page): Promise<string> {
  // UX-F (DEF-R8) · el primer mapa compatible viene preseleccionado (antes había un
  // «— elige —» y hacían falta ≥2 opciones); se elige igualmente el del catálogo
  // (mvp-arena-01) si admite el modo o, si no, el primero publicado.
  const mapSel = page.getByLabel("mapa");
  const mapValues = () =>
    mapSel.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
  await expect.poll(async () => (await mapValues()).length > 0, { timeout: 20_000 }).toBe(true);
  const values = await mapValues();
  const chosen = values.find((v) => v.startsWith("mvp-arena-01@")) ?? values[0];
  await mapSel.selectOption(chosen);
  await expect(page.getByTestId("battle-checklist")).not.toContainText("✗");
  const created = page.waitForResponse((r) => r.url().endsWith("/api/v1/battles") && r.request().method() === "POST", {
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Crear batalla" }).click();
  const resp = await created;
  expect(resp.status(), await resp.text()).toBe(202);
  await expect(page.getByTestId("battle-created")).toBeVisible();
  return (await resp.json()).id as string;
}

export async function waitFinished(api: PublicApi, battleId: string, timeout = 480_000): Promise<any> {
  let last: any = null;
  await expect
    .poll(
      async () => {
        last = await api.ok("GET", `/battles/${battleId}`);
        return last.status;
      },
      { timeout, intervals: [2000, 3000, 5000] },
    )
    .toMatch(/^(finished|failed)$/);
  return last;
}

export async function waitStatsReady(api: PublicApi, battleId: string): Promise<any> {
  let s: any = null;
  await expect
    .poll(
      async () => {
        s = await api.ok("GET", `/battles/${battleId}/stats`);
        return s.status;
      },
      { timeout: 30_000, intervals: [500, 1000] },
    )
    .toBe("ready");
  return s;
}

/** Todas las instantáneas del replay por la API autorizada (como el reproductor). */
export async function replaySnapshots(api: PublicApi, battleId: string): Promise<{ index: any; snapshots: any[] }> {
  const index = await api.ok("GET", `/replays/${battleId}/index`);
  const seg = await api.ok("GET", `/replays/${battleId}/segment?fromTick=0&toTick=${index.ticks}`);
  return { index, snapshots: seg.snapshots as any[] };
}

/** Basura que nunca debe salir en la UI (SPEC-COMUN §7). */
export const GARBAGE = /\bundefined\b|\[object Object\]|\bNaN\b|^null$|\snull\s/m;

/** Las vistas de una batalla, una por una, para un solicitante que NO debe verla: todas 404. */
export async function expectBattleHidden(
  api: PublicApi,
  battleId: string,
  who: string,
): Promise<Record<string, number>> {
  const probes: [string, "GET" | "POST", string][] = [
    ["getBattle", "GET", `/battles/${battleId}`],
    ["getBattleStats", "GET", `/battles/${battleId}/stats`],
    ["getBattleAudit", "GET", `/battles/${battleId}/audit`],
    ["getSpectateTicket", "POST", `/battles/${battleId}/spectate-ticket`],
    ["getReplayIndex", "GET", `/replays/${battleId}/index`],
    ["getReplaySegment", "GET", `/replays/${battleId}/segment?fromTick=0&toTick=30`],
    ["verifyReplay", "POST", `/replays/${battleId}/verify`],
  ];
  const got: Record<string, number> = {};
  for (const [op, m, p] of probes) got[op] = (await api.raw(m, p)).status;
  const list = await api.raw("GET", "/battles?limit=100");
  const listed = list.status === 200 && (list.body.items as any[]).some((b) => b.id === battleId);
  got["listBattles(contiene)"] = listed ? 1 : 0;
  // 404 uniforme (o 401/429 de sesión/cuota para un anónimo: tampoco revelan nada; se registra el código).
  for (const [op, code] of Object.entries(got)) {
    if (op === "listBattles(contiene)") expect(code, `${who}: ${op}`).toBe(0);
    else expect([401, 404, 429], `${who}: ${op} devolvió ${code}`).toContain(code);
  }
  return got;
}
