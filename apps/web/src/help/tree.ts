/**
 * EQ3 · Árbol del Centro de Ayuda y sus rutas.
 *
 * Rutas: `#/help` (portada = Primeros pasos), `#/help/<grupo>` (primera hoja del
 * grupo) y `#/help/<grupo>/<hoja>`. Los alias `#/ayuda/...` y `#/docs/...` llevan al
 * mismo sitio (App.tsx ya enruta los tres prefijos a la ayuda). Nada de anclas `#x`:
 * el router es por hash y un ancla sería otra ruta.
 */
export interface HelpLeaf {
  id: string;
  title: string;
  /** Palabras extra para el buscador de la ayuda. */
  keywords?: string;
}

export interface HelpGroup {
  id: string;
  title: string;
  leaves: HelpLeaf[];
}

export const HELP_TREE: HelpGroup[] = [
  {
    id: "inicio",
    title: "Primeros pasos",
    leaves: [{ id: "primeros-pasos", title: "Primeros pasos", keywords: "cuenta recorrido glosario empezar" }],
  },
  {
    id: "bots",
    title: "Bots",
    leaves: [
      { id: "conceptos", title: "Conceptos", keywords: "versión estados runtime build validación tick decisión" },
      { id: "sdk-python", title: "SDK Python", keywords: "arena_sdk on_observation pip" },
      { id: "sdk-javascript", title: "SDK JavaScript", keywords: "@arena/sdk onObservation node esm" },
      { id: "observaciones", title: "Observaciones", keywords: "observation self sensores objetivos" },
      { id: "comandos", title: "Comandos", keywords: "command move turret fire deployMine radio" },
      { id: "eventos", title: "Eventos", keywords: "event rejected_action hit_taken" },
      { id: "sensores", title: "Sensores", keywords: "radar lidar proximidad acústico niebla" },
      { id: "radio", title: "Radio", keywords: "mensajes equipo bytes" },
      { id: "ejemplos", title: "Ejemplos", keywords: "plantilla tutorial código copiar" },
    ],
  },
  {
    id: "equipamiento",
    title: "Equipamiento",
    leaves: [
      { id: "loadout", title: "Loadout y presupuesto", keywords: "créditos masa energía ranuras validación" },
      { id: "chassis", title: "Chasis", keywords: "ranuras casco" },
      { id: "movement", title: "Movimiento", keywords: "ruedas orugas velocidad" },
      { id: "power", title: "Energía", keywords: "batería generador EU" },
      { id: "sensor", title: "Sensores", keywords: "radar lidar" },
      { id: "weapon", title: "Armas", keywords: "cañón ametralladora" },
      { id: "ammo", title: "Munición", keywords: "perforante explosiva" },
      { id: "armor", title: "Blindaje", keywords: "sector reducción" },
      { id: "radio", title: "Radio", keywords: "radio corta" },
      { id: "otros", title: "Otros módulos", keywords: "minas utilidades" },
    ],
  },
  {
    id: "batallas",
    title: "Batallas",
    leaves: [
      { id: "nueva", title: "Nueva batalla", keywords: "práctica crear semilla mapa" },
      { id: "1v1", title: "1v1", keywords: "individual bando" },
      { id: "equipos", title: "Equipos", keywords: "4v4 bandos" },
      { id: "respawns", title: "Respawns", keywords: "reaparición vidas" },
      { id: "puntuacion", title: "Puntuación", keywords: "puntos derribos victoria" },
      { id: "desempates", title: "Desempates", keywords: "tiempo empate límite" },
    ],
  },
  {
    id: "modos",
    title: "Modos de juego",
    leaves: [
      { id: "deathmatch", title: "Deathmatch", keywords: "todos contra todos" },
      { id: "team_deathmatch", title: "Deathmatch por equipos", keywords: "tdm" },
      { id: "eliminacion", title: "Eliminación", keywords: "último en pie sin reaparición" },
      { id: "respawn-limitado", title: "Respawn limitado", keywords: "vidas" },
      { id: "capture_the_flag", title: "Captura la bandera", keywords: "ctf bandera base" },
      { id: "zone_control", title: "Control de zona", keywords: "zona captura disputada koth" },
      { id: "otros", title: "Otros presets oficiales", keywords: "dominación juggernaut koth motor" },
    ],
  },
  {
    id: "torneos",
    title: "Torneos",
    leaves: [
      { id: "torneos", title: "Torneos", keywords: "liga eliminatoria suizo inscripción" },
      { id: "ranking", title: "Ranking", keywords: "elo rating clasificación V-D-E" },
    ],
  },
  {
    id: "mapas",
    title: "Mapas",
    leaves: [
      { id: "editor", title: "Editor", keywords: "paleta herramientas" },
      { id: "spawns", title: "Spawns", keywords: "aparición" },
      { id: "bases", title: "Bases", keywords: "base equipo" },
      { id: "banderas", title: "Banderas", keywords: "flag" },
      { id: "zonas", title: "Zonas", keywords: "captura daño" },
      { id: "muros", title: "Muros", keywords: "obstáculo" },
      { id: "cajas", title: "Cajas", keywords: "destructible" },
      { id: "validacion", title: "Validación", keywords: "errores publicar" },
    ],
  },
  {
    // EQ5b · ayuda offline de Administración → Streaming (sólo la usan administradores).
    id: "administracion",
    title: "Administración",
    leaves: [
      { id: "streaming", title: "Streaming", keywords: "emisión directo youtube rtmps grabar mp4 clave retransmitir" },
    ],
  },
  {
    id: "referencia",
    title: "Referencia",
    leaves: [
      { id: "reglas", title: "Reglas", keywords: "rulesets constantes" },
      { id: "catalogo", title: "Catálogo", keywords: "módulos todos" },
      { id: "protocolo", title: "Protocolo", keywords: "arena/1 mensajes hello welcome" },
      { id: "versiones", title: "Versiones", keywords: "sdk motor protocolo" },
    ],
  },
];

export interface HelpLocation {
  group: HelpGroup;
  leaf: HelpLeaf;
  /** La ruta pedida no existía y se muestra la portada. */
  notFound: boolean;
}

export function helpHref(groupId: string, leafId?: string): string {
  return leafId ? `#/help/${groupId}/${leafId}` : `#/help/${groupId}`;
}

/** `#/help/modos/zone_control` → grupo + hoja. Una ruta desconocida cae en la portada con aviso. */
export function parseHelpHash(hash: string): HelpLocation {
  const path = hash.replace(/^#\/(?:help|ayuda|docs)/, "").split("?")[0];
  const [g, l] = path
    .split("/")
    .filter(Boolean)
    .map((s) => decodeURIComponent(s));
  const home = { group: HELP_TREE[0], leaf: HELP_TREE[0].leaves[0] };
  if (!g) return { ...home, notFound: false };
  const group = HELP_TREE.find((x) => x.id === g);
  if (!group) return { ...home, notFound: true };
  if (!l) return { group, leaf: group.leaves[0], notFound: false };
  const leaf = group.leaves.find((x) => x.id === l);
  if (!leaf) return { group, leaf: group.leaves[0], notFound: true };
  return { group, leaf, notFound: false };
}

/** Búsqueda simple (sin red, sin índice externo): título, grupo y palabras clave. */
export function searchHelp(q: string): { group: HelpGroup; leaf: HelpLeaf }[] {
  const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const terms = norm(q).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const out: { group: HelpGroup; leaf: HelpLeaf }[] = [];
  for (const group of HELP_TREE) {
    for (const leaf of group.leaves) {
      const hay = norm(`${group.title} ${leaf.title} ${leaf.id} ${leaf.keywords ?? ""}`);
      if (terms.every((t) => hay.includes(t))) out.push({ group, leaf });
    }
  }
  return out;
}
