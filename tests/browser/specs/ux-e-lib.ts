/**
 * UX-E · Utillaje de las specs transversales (matriz de estados, accesibilidad
 * básica y responsive). Las rutas son TODAS las de App.tsx; las de parámetro
 * usan un id que no existe (camino de 404 real).
 */
import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

export const ZERO = "00000000-0000-0000-0000-000000000000";

/** Rutas del panel (con sesión). */
export const PANEL_ROUTES = [
  "#/bots",
  `#/bots/${ZERO}`,
  "#/teams",
  "#/tournaments",
  `#/tournaments/${ZERO}`,
  `#/tournaments/${ZERO}/bracket`,
  "#/battles",
  "#/battles/new",
  "#/replays",
  "#/maps",
  "#/maps/editor",
  "#/system",
  "#/audit",
  "#/roles",
  "#/admin",
  "#/ruta-que-no-existe",
] as const;

/** Rutas públicas (sin sesión). */
export const PUBLIC_ROUTES = ["#/live", "#/ranking", `#/viewer/${ZERO}`, `#/replay/${ZERO}?t=0`] as const;

/**
 * Lo que NUNCA debe ver un usuario: valores sin pintar, objetos sin formatear,
 * nombres de excepciones del motor JS ni trazas.
 */
export const FORBIDDEN_TEXT =
  /\bundefined\b|\bnull\b|\(none\)|\[object Object\]|\bNaN\b|^\s*at \S+ \(|\bTypeError\b|\bReferenceError\b|\{"/m;

export function forbiddenLines(text: string): string[] {
  return text.split("\n").filter((l) => FORBIDDEN_TEXT.test(l));
}

/** Navega por hash y espera a que no quede ningún «Cargando…» en la pantalla. */
export async function visit(page: Page, hash: string, timeout = 25_000): Promise<void> {
  await page.evaluate((h) => (window.location.hash = h), hash);
  // Dos frames: React ya ha pintado la pantalla nueva (si no, se leería la anterior).
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await expect
    .poll(
      async () =>
        /Cargando/.test(
          await page
            .locator("main")
            .innerText()
            .catch(() => "Cargando"),
        ),
      {
        timeout,
        message: `«Cargando…» eterno en ${hash}`,
      },
    )
    .toBe(false);
}

/**
 * Texto visible del contenido (sin la barra), SIN lo que el usuario edita o
 * exporta a propósito (textarea, pre, code): un JSON exportado no es basura.
 */
export async function mainText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    if (!main) return "";
    const out: string[] = [];
    const walk = document.createTreeWalker(main, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement?.closest("textarea,pre,code,script,style,[hidden]")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const t = (n.textContent ?? "").trim();
      if (t) out.push(t);
    }
    return out.join("\n");
  });
}

/** ¿La pantalla enseña un fallo (alerta, error clasificado o texto de error)? */
export async function showsError(page: Page): Promise<boolean> {
  return (await page.locator('main [role="alert"], main [data-error-kind], main .error').count()) > 0;
}

/** Fuente de axe-core (devDependency de tests/browser), para inyectarla en la página. */
export function axeSource(): string {
  const req = createRequire(import.meta.url);
  return readFileSync(req.resolve("axe-core/axe.min.js"), "utf8");
}

export interface AxeViolation {
  id: string;
  impact: string | null;
  nodes: string[];
}

/** axe-core WCAG 2.0/2.1 A+AA sobre el documento actual. */
export async function runAxe(page: Page): Promise<AxeViolation[]> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ content: axeSource() });
  return page.evaluate(async () => {
    // @ts-expect-error axe global inyectado
    const r = await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] });
    return r.violations.map((v: { id: string; impact: string | null; nodes: { target: string[] }[] }) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.slice(0, 5).map((n) => n.target.join(" ")),
    }));
  });
}
