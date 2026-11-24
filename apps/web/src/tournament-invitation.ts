/**
 * V1 · TORNEOS POR INVITACIÓN (D-OP-43) · el enlace de invitación en la web.
 *
 * Forma del enlace: `<origen>/#/tournaments/<id>/invitation/<token>`.
 *
 * POR QUÉ EL FRAGMENTO (#) + sessionStorage:
 *  - el panel ya navega por hash; el fragmento NUNCA sale del navegador: no viaja en la petición
 *    HTTP (no queda en los logs del gateway ni de la API) y el navegador lo quita de la cabecera
 *    `Referer` hacia terceros;
 *  - al abrir el enlace, `captureInvitationFromLocation` guarda el token en `sessionStorage`
 *    (sólo esta pestaña; se borra al cerrarla y al cerrar sesión) y REEMPLAZA la entrada del
 *    historial por `#/tournaments/<id>` (`history.replaceState`): el token deja de estar en la
 *    barra de direcciones y en el historial;
 *  - si no hay sesión, el panel enseña el acceso SIN cambiar de ruta: tras entrar o registrarse,
 *    la misma ruta pinta la ficha y el formulario lee el token de `sessionStorage`. Ningún
 *    parámetro de vuelta lleva el token;
 *  - a la API el token sólo viaja en el CUERPO de POST (`invitationToken`), nunca en la URL.
 * El enlace habilita el formulario; NO inscribe solo: el invitado elige su bot o equipo y confirma.
 */

const KEY_PREFIX = "s9.tournamentInvitation:";
export const INVITATION_ROUTE = /^#\/tournaments\/([^/?#]+)\/invitation\/([A-Za-z0-9_-]{16,128})\/?$/;

function store(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Enlace que copia el organizador (sólo con el token recién generado). */
export function invitationLink(tournamentId: string, token: string, base = defaultBase()): string {
  return `${base}#/tournaments/${encodeURIComponent(tournamentId)}/invitation/${token}`;
}

function defaultBase(): string {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}`;
}

/**
 * Si la dirección actual es un enlace de invitación, guarda el token en `sessionStorage`, quita el
 * token de la barra y del historial y devuelve la ruta limpia (`#/tournaments/<id>`). Si no, null.
 */
export function captureInvitationFromLocation(): string | null {
  const m = INVITATION_ROUTE.exec(window.location.hash);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  const clean = `#/tournaments/${encodeURIComponent(id)}`;
  try {
    store()?.setItem(KEY_PREFIX + id, m[2]);
  } catch {
    // sin almacenamiento: el invitado tendrá que volver a abrir el enlace tras entrar
  }
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${clean}`);
  return clean;
}

export function pendingInvitation(tournamentId: string): string | null {
  try {
    return store()?.getItem(KEY_PREFIX + tournamentId) ?? null;
  } catch {
    return null;
  }
}

export function clearInvitation(tournamentId: string): void {
  try {
    store()?.removeItem(KEY_PREFIX + tournamentId);
  } catch {
    // nada que borrar
  }
}

/** Al cerrar sesión: fuera todas las invitaciones de la pestaña. */
export function clearAllInvitations(): void {
  const s = store();
  if (!s) return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith(KEY_PREFIX)) doomed.push(k);
    }
    for (const k of doomed) s.removeItem(k);
  } catch {
    // nada que borrar
  }
}
