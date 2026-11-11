/**
 * #255 · UNA sola navegación del bot (sustituye a tres que convivían: la página
 * larga de «Mis bots» con su índice por `scrollIntoView`, la segunda vista
 * `BotDetailPage` con pestañas propias y el enlace «detalle y versiones» entre
 * ambas). Ver docs/user/bots.md («Navegación del bot»).
 *
 * Rutas:
 *   #/bots                         lista, sin bot elegido
 *   #/bots/<botId>                 bot elegido, sección «Resumen»
 *   #/bots/<botId>/<sección>       bot elegido y sección
 *
 * Cada sección pinta SÓLO su contenido en el panel central; cambiar de sección
 * no desplaza la página (el foco va al encabezado de la sección).
 */

export type BotSection = "resumen" | "visibilidad" | "equipamiento" | "codigo" | "versiones" | "batallas" | "replays";

/** Menú de secciones (orden y texto). Build va DENTRO de «Versiones y build». */
export const BOT_PANEL_SECTIONS: ReadonlyArray<{ id: BotSection; label: string }> = [
  { id: "resumen", label: "Resumen" },
  { id: "visibilidad", label: "Visibilidad" },
  { id: "equipamiento", label: "Equipamiento" },
  { id: "codigo", label: "Código" },
  { id: "versiones", label: "Versiones y build" },
  { id: "batallas", label: "Batallas" },
  { id: "replays", label: "Replays" },
];

const SECTION_IDS = new Set<string>(BOT_PANEL_SECTIONS.map((s) => s.id));

export interface BotsRoute {
  botId: string | null;
  section: BotSection;
}

/** `#/bots/<id>[/<sección>]` → bot y sección (una sección desconocida es «Resumen»). */
export function parseBotsRoute(hash: string): BotsRoute {
  const m = /^#\/bots\/([^/?#]+)(?:\/([^/?#]+))?/.exec(hash);
  if (!m) return { botId: null, section: "resumen" };
  let botId: string;
  try {
    botId = decodeURIComponent(m[1]);
  } catch {
    return { botId: null, section: "resumen" };
  }
  const s = m[2] && SECTION_IDS.has(m[2]) ? (m[2] as BotSection) : "resumen";
  return { botId, section: s };
}

export function botHref(botId: string, section: BotSection = "resumen"): string {
  const base = `#/bots/${encodeURIComponent(botId)}`;
  return section === "resumen" ? base : `${base}/${section}`;
}

export function sectionLabel(section: BotSection): string {
  return BOT_PANEL_SECTIONS.find((s) => s.id === section)?.label ?? section;
}
