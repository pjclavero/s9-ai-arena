/**
 * EQ5b · Administración → Streaming en navegador REAL.
 *
 * Dos bloques:
 *  - `@fase1`: en el entorno canónico de tests/browser/run.sh (API real, SIN
 *    streamer ni almacén sellado): RBAC visible (admin la ve; un usuario normal no
 *    y la API le dice que no), estados de la pantalla, botón «Retransmitir» que
 *    sólo PRESELECCIONA (ninguna orden de arranque), axe y móvil sin scroll lateral.
 *  - `@streaming-e2e`: la cadena REAL web → API → streamer (Chromium + Xvfb +
 *    FFmpeg + relé) → ingesta RTMPS local. NO lo lanza run.sh: lo orquesta
 *    tests/streaming-e2e/e2e.sh por pasos (entre paso y paso mide la ingesta, el
 *    argv de ffmpeg y las métricas desde fuera). La clave de PRUEBA llega por
 *    FICHERO (S9_STREAM_E2E_KEY_FILE), se teclea en la web y se comprueba que no
 *    vuelve: ni en respuestas de la API, ni en el DOM, ni en storage.
 */
import { readFileSync } from "node:fs";
import { test, expect, type Page, type Response } from "@playwright/test";
import { login, registerNewUser, shot, REPLAY_ID } from "./helpers.js";
import { forbiddenLines, runAxe, visit } from "./ux-e-lib.js";

const ADMIN_EMAIL = "admin@dev.arena.local";
const PASSWORD = process.env.S9_E2E_DEV_PASSWORD ?? "";

async function blockingAxe(page: Page): Promise<string[]> {
  return (await runAxe(page))
    .filter((v) => v.impact === "critical" || v.impact === "serious")
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.join(" , ")}`);
}
async function hScroll(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test.describe("@fase1 EQ5b Administración → Streaming", () => {
  test("admin: subnavegación, estado sin streamer, axe y móvil", async ({ page }, info) => {
    const starts: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("/admin/streaming/start")) starts.push(r.url());
    });
    await login(page, ADMIN_EMAIL, PASSWORD);
    await visit(page, "#/audit");
    const sub = page.getByRole("navigation", { name: "Administración" });
    await sub.getByRole("link", { name: "Streaming" }).click();
    await expect(page.getByRole("heading", { name: "Streaming", exact: true })).toBeVisible();
    // Recién migrado: desactivado; sin almacén sellado en este entorno.
    await expect(page.getByTestId("streaming-ux-state")).toHaveText("Desactivado");
    await expect(page.getByTestId("sealed-store-missing")).toBeVisible();
    await expect(page.getByTestId("credential-youtube-input")).toBeDisabled();
    await expect(page.getByTestId("stream-start")).toBeDisabled();
    expect(await blockingAxe(page)).toEqual([]);
    await shot(page, info, "eq5b-streaming-1366");
    await page.setViewportSize({ width: 390, height: 844 });
    await visit(page, "#/streaming");
    await expect(page.getByTestId("streaming-page")).toBeVisible();
    expect(await hScroll(page)).toBeLessThanOrEqual(1);
    expect(await blockingAxe(page)).toEqual([]);
    await shot(page, info, "eq5b-streaming-390");
    expect(starts).toEqual([]);
  });

  test("«Retransmitir» en una batalla preselecciona el destino y NO arranca nada", async ({ page }, info) => {
    test.skip(!REPLAY_ID, "sin batalla sembrada en este entorno");
    const starts: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("/admin/streaming/")) starts.push(r.url());
    });
    await login(page, ADMIN_EMAIL, PASSWORD);
    await visit(page, `#/battles/${REPLAY_ID}`);
    await page.getByTestId("broadcast-battle").click();
    await expect(page).toHaveURL(new RegExp(`#/streaming\\?battle=${REPLAY_ID}`));
    await expect(page.getByTestId("stream-target-id")).toHaveValue(REPLAY_ID);
    await expect(page.getByTestId("stream-delay")).toContainText("Retardo del directo");
    await shot(page, info, "eq5b-retransmitir");
    expect(starts).toEqual([]);
  });

  test("usuario normal: ni enlace ni botón, y la API responde «sin permiso»", async ({ page }) => {
    await registerNewUser(page);
    await visit(page, "#/streaming");
    await expect(page.getByTestId("error-forbidden-hint")).toBeVisible();
    expect(forbiddenLines(await page.locator("body").innerText())).toEqual([]);
    await expect(page.getByRole("navigation", { name: "Administración" })).toHaveCount(0);
    if (REPLAY_ID) {
      await visit(page, `#/battles/${REPLAY_ID}`);
      await expect(page.getByTestId("broadcast-battle")).toHaveCount(0);
    }
  });
});

// ─────────────────────────────────────────────────────────── cadena real (§23)
const KEY_FILE = process.env.S9_STREAM_E2E_KEY_FILE ?? "";
const BATTLE = process.env.S9_STREAM_E2E_BATTLE ?? "";
const INGEST = process.env.S9_STREAM_E2E_INGEST ?? "";
const BITRATE = Number(process.env.S9_STREAM_E2E_BITRATE ?? "3000");

/** Ninguna respuesta de la API vista por el navegador contiene la clave. */
function watchKey(page: Page, key: string): string[] {
  const leaks: string[] = [];
  page.on("response", async (r: Response) => {
    if (!r.url().includes("/api/")) return;
    try {
      if ((await r.text()).includes(key)) leaks.push(r.url());
    } catch {
      /* respuesta sin cuerpo */
    }
  });
  return leaks;
}

async function streaming(page: Page, hash = "#/streaming") {
  await login(page, ADMIN_EMAIL, PASSWORD);
  await visit(page, hash);
  await expect(page.getByTestId("streaming-page")).toBeVisible();
}

async function saveSettings(page: Page) {
  page.once("dialog", (d) => void d.accept());
  await page.getByTestId("set-save").click();
  await expect(page.getByTestId("streaming-notice")).toContainText(/Guardado|Sin cambios/);
}

test.describe("@streaming-e2e EQ5b cadena real", () => {
  test.skip(!KEY_FILE, "sólo con tests/streaming-e2e/e2e.sh");

  test("@streaming-e2e-config credencial (no vuelve), RTMPS personalizado y bitrate desde la web", async ({ page }) => {
    const key = readFileSync(KEY_FILE, "utf8").trim();
    const leaks = watchKey(page, key);
    await streaming(page);
    await page.getByTestId("set-enabled").check();
    await page.getByTestId("set-mode").selectOption("rtmps");
    await page.getByTestId("set-platform").selectOption("custom");
    await page.getByTestId("set-ingest").fill(INGEST);
    await page.getByTestId("set-bitrate").fill(String(BITRATE));
    await saveSettings(page);
    await page.getByTestId("credential-custom-input").fill(key);
    await page.getByTestId("credential-custom").getByRole("button", { name: "Guardar clave" }).click();
    await expect(page.getByTestId("credential-custom-state")).toContainText(`****${key.slice(-4)}`);
    await expect(page.getByTestId("credential-custom-input")).toHaveValue("");
    expect(await page.content()).not.toContain(key);
    const storage = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } }));
    expect(storage).not.toContain(key);
    expect(leaks).toEqual([]);
  });

  test("@streaming-e2e-test probar configuración (sin emitir)", async ({ page }) => {
    await streaming(page);
    await page.getByTestId("stream-test").click();
    await expect(page.getByTestId("streaming-notice")).toContainText("Prueba correcta");
  });

  test("@streaming-e2e-start iniciar desde la web: EN DIRECTO", async ({ page }, info) => {
    const key = readFileSync(KEY_FILE, "utf8").trim();
    const leaks = watchKey(page, key);
    await streaming(page, `#/streaming?battle=${BATTLE}`);
    await expect(page.getByTestId("stream-target-info")).toBeVisible();
    await page.getByTestId("stream-start").click();
    await expect(page.getByTestId("streaming-ux-state")).toHaveText("En directo", { timeout: 30_000 });
    await expect(page.getByTestId("mon-rate")).toContainText(/\b(2[5-9]|30)\b fps/, { timeout: 30_000 });
    await shot(page, info, "eq5b-e2e-en-directo");
    expect(await page.content()).not.toContain(key);
    expect(leaks).toEqual([]);
  });

  test("@streaming-e2e-restart cambiar bitrate con emisión activa: aviso y «Reiniciar»", async ({ page }) => {
    await streaming(page);
    await page.getByTestId("set-bitrate").fill(String(BITRATE - 500));
    await saveSettings(page);
    await expect(page.getByTestId("pending-restart")).toBeVisible();
    await page.getByTestId("stream-restart").click();
    await expect(page.getByTestId("pending-restart")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId("streaming-ux-state")).toHaveText("En directo", { timeout: 30_000 });
  });

  test("@streaming-e2e-stop detener desde la web", async ({ page }) => {
    await streaming(page);
    page.once("dialog", (d) => void d.accept());
    await page.getByTestId("stream-stop").click();
    await expect(page.getByTestId("streaming-ux-state")).toHaveText("Listo", { timeout: 15_000 });
  });

  test("@streaming-e2e-record grabar desde la web", async ({ page }) => {
    await streaming(page, `#/streaming?battle=${BATTLE}`);
    await page.getByTestId("set-mode").selectOption("record");
    await saveSettings(page);
    await expect(page.getByTestId("stream-target-info")).toBeVisible();
    await page.getByTestId("stream-start").click();
    await expect(page.getByTestId("streaming-ux-state")).toHaveText("Grabando", { timeout: 30_000 });
    await page.waitForTimeout(15_000);
    page.once("dialog", (d) => void d.accept());
    await page.getByTestId("stream-stop").click();
    await expect(page.getByTestId("streaming-ux-state")).toHaveText("Listo", { timeout: 15_000 });
  });

  test("@streaming-e2e-retention retención 7 días aplicada desde la web y auditada", async ({ page }, info) => {
    await streaming(page);
    await page.getByTestId("ret-age").selectOption("7");
    await page.getByTestId("ret-save").click();
    await expect(page.getByTestId("streaming-notice")).toContainText("Retención guardada");
    page.once("dialog", (d) => void d.accept());
    await page.getByTestId("ret-apply").click();
    await expect(page.getByTestId("streaming-notice")).toContainText(/Retención aplicada: [1-9]\d* grabaciones/);
    await expect(page.getByTestId("streaming-audit")).toContainText("streaming.recording.deleted");
    await shot(page, info, "eq5b-e2e-retencion");
  });
});
