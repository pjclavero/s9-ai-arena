/**
 * #255 · ayudas de test para el panel único del bot: [lista] | [secciones | UNA sección].
 * El bot se elige con un ENLACE de la lista y la sección con un enlace del menú de
 * secciones (`bot-section-nav`); nada se busca desplazando la página.
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/** Pulsa el bot en la lista «Mis bots». */
export async function openBot(name: string): Promise<void> {
  await userEvent.click(await screen.findByRole("link", { name }));
}

/** Pulsa una sección del menú del bot (p. ej. «Versiones y build»). */
export async function openSection(label: string): Promise<void> {
  const nav = await screen.findByTestId("bot-section-nav");
  await userEvent.click(within(nav).getByRole("link", { name: label }));
}

/** Monta directamente en `#/bots/<id>/<sección>` (como un F5 o un enlace profundo). */
export function atBotSection(botId: string, section = ""): void {
  window.location.hash = section ? `#/bots/${botId}/${section}` : `#/bots/${botId}`;
}
