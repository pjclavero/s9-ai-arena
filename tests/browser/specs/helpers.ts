/**
 * FC-D · Utillaje común del E2E de navegador. Sin mocks: sólo observa la red y
 * la consola reales para detectar fallos que la UI pudiera tapar.
 */
import { expect, type Page, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";

export const OUT = process.env.S9_E2E_OUT ?? "/out";
export const REPLAY_ID = process.env.S9_E2E_REPLAY_ID ?? "";

/** Registra problemas del navegador: errores JS, contenido mixto, peticiones http:// bajo https. */
export function watchProblems(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (/Mixed Content/i.test(t)) problems.push(`mixed-content: ${t}`);
    if (m.type() === "error" && !/Failed to load resource/i.test(t)) problems.push(`console.error: ${t}`);
  });
  page.on("request", (r) => {
    if (r.url().startsWith("http://")) problems.push(`http-under-https: ${r.method()} ${r.url()}`);
  });
  page.on("response", (r) => {
    const loc = r.headers()["location"];
    if (r.status() >= 300 && r.status() < 400 && loc && loc.startsWith("http://"))
      problems.push(`redirect-to-http: ${r.url()} -> ${loc}`);
  });
  return problems;
}

export async function shot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: `${OUT}/shots/${name}.png`, fullPage: true });
  await info.attach(name, { path: `${OUT}/shots/${name}.png`, contentType: "image/png" });
}

export async function go(page: Page, hash: string) {
  await page.evaluate((h) => (window.location.hash = h), hash);
}

/** Alta de un usuario nuevo por la UI real (registro + login automático). */
export async function registerNewUser(page: Page): Promise<{ email: string; password: string }> {
  const email = `e2e-${randomUUID().slice(0, 8)}@example.internal`;
  const password = `e2e-${randomUUID()}`;
  await page.goto("/");
  await page.getByLabel("email").waitFor();
  await page.getByRole("button", { name: "Crear cuenta" }).click();
  await page.getByLabel("nombre").fill("Piloto E2E");
  await page.getByLabel("email").fill(email);
  await page.getByLabel("contraseña").fill(password);
  await page.getByRole("button", { name: "Registrarse y entrar" }).click();
  await expect(page.getByTestId("logout")).toBeVisible();
  return { email, password };
}

export async function login(page: Page, email: string, password: string) {
  await page.goto("/");
  await page.getByLabel("email").fill(email);
  await page.getByLabel("contraseña").fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByTestId("logout")).toBeVisible();
}
