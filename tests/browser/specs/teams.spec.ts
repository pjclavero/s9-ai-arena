/**
 * UX-C · C1 · Equipos de punta a punta en navegador real contra la API real
 * (fase 1, sin builds): crear, renombrar, añadir/quitar miembro (otro usuario
 * real, por email), añadir/quitar bot y borrar. Y que la página EXPLICA qué es un
 * equipo y que el bando de una batalla no lo es.
 */
import { test, expect } from "@playwright/test";
import { go, registerNewUser, shot, watchProblems } from "./helpers.js";

test.describe("@fase1 UX-C equipos", () => {
  test("crear → renombrar → miembro (alta/baja) → bot (alta/baja) → borrar", async ({ page, browser }, info) => {
    // Segundo usuario REAL para invitar por email (otro contexto: otra sesión).
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    const { email: otherEmail } = await registerNewUser(otherPage);
    await other.close();

    const problems = watchProblems(page);
    await registerNewUser(page);
    const stamp = Date.now().toString(36);
    const bot = `equipo-bot-${stamp}`;
    const name = `UXC Equipo ${stamp}`;
    const renamed = `UXC Renombrado ${stamp}`;

    await go(page, "#/bots");
    await page.getByLabel("nuevo-bot").fill(bot);
    await page.getByRole("button", { name: "Crear bot" }).click();
    await expect(page.getByText(bot).first()).toBeVisible();

    await go(page, "#/teams");
    await expect(page.getByTestId("teams-concepts")).toContainText("agrupa personas y bots");
    await expect(page.getByTestId("teams-concepts")).toContainText("mismo equipo pueden enfrentarse");
    await expect(page.getByTestId("teams-empty")).toBeVisible();
    await page.getByLabel("nuevo-equipo").fill(name);
    await page.getByRole("button", { name: "Crear equipo" }).click();
    await expect(page.getByRole("region", { name: `equipo ${name}` })).toBeVisible();

    // Renombrar
    await page.getByLabel(`renombrar-${name}`).fill(renamed);
    await page.getByRole("button", { name: "Renombrar" }).click();
    const team = page.getByRole("region", { name: `equipo ${renamed}` });
    await expect(team).toBeVisible();

    // Miembro: alta por email y baja
    await team.getByLabel(`invitar-${renamed}`).fill(otherEmail);
    await team.getByRole("button", { name: "Añadir miembro" }).click();
    await expect(page.getByTestId("teams-notice")).toContainText("Miembro añadido");
    await expect(team.getByText("Miembros (2)")).toBeVisible();
    await team.getByRole("button", { name: /^quitar-miembro-/ }).click();
    await expect(team.getByText("Miembros (1)")).toBeVisible();

    // Bot: alta y baja
    await team.getByLabel(`añadir-bot-${renamed}`).selectOption({ label: bot });
    await team.getByRole("button", { name: "Añadir bot" }).click();
    await expect(team.getByText("Bots del equipo (1)")).toBeVisible();
    await shot(page, info, "uxc-equipo-con-bot");
    await team.getByRole("button", { name: `quitar-bot-${bot}` }).click();
    await expect(team.getByText("Bots del equipo (0)")).toBeVisible();

    // Borrar (confirmación nativa aceptada)
    page.once("dialog", (d) => void d.accept());
    await team.getByRole("button", { name: "Borrar equipo" }).click();
    await expect(page.getByTestId("teams-notice")).toContainText("borrado");
    await expect(page.getByRole("region", { name: `equipo ${renamed}` })).toHaveCount(0);
    await expect(page.getByTestId("teams-error")).toHaveCount(0);
    expect(problems).toEqual([]);
  });
});
