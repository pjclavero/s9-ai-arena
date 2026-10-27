/**
 * UX-E · BORRADOR local de un texto en edición (código del bot, JSON del mapa…).
 *
 * Si la sesión muere de verdad (el refresh dice «no hay sesión»), el App vuelve
 * al login y DESMONTA el panel: todo el estado local no guardado se pierde. Con
 * este hook el texto se copia en `sessionStorage` (sólo en esta pestaña, se
 * borra al cerrarla) en cada cambio y se recupera al volver a montar la pantalla
 * tras iniciar sesión de nuevo. `restored` dice si lo que hay es un borrador
 * recuperado, para que la pantalla lo anuncie y no parezca el texto guardado.
 *
 * No guarda secretos: es para texto que el usuario escribe en el panel. Si el
 * almacenamiento no está disponible se comporta como un `useState` normal.
 *
 * UX-F (DEF-R2) · el borrador es de UNA cuenta. Antes la clave era global
 * (`s9_draft:bots:upload:code`) y «Salir» no borraba nada: en un ordenador
 * compartido la cuenta B veía en el editor lo que A dejó escrito. Ahora:
 *  - la clave lleva el id del usuario (`s9_draft:<userId>:<clave>`, ver
 *    `setDraftOwner`), así que B nunca lee lo de A;
 *  - `clearAllDrafts()` borra todas las `s9_draft:*` al cerrar sesión (api.ts
 *    `logout`) y cuando entra un usuario distinto del dueño de los borradores;
 *  - si la sesión CADUCA y vuelve a entrar el MISMO usuario, el borrador se
 *    recupera (es para lo que existe, UX-E); si entra otro, se borra antes.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export const DRAFT_PREFIX = "s9_draft:";
/** Quién es el dueño de los borradores guardados en esta pestaña. */
const OWNER_KEY = "s9_draft_owner";

let owner: string | null = null;

/** Prefijo efectivo: incluye al usuario (sin sesión, `anon`). */
function scoped(key: string): string {
  return `${DRAFT_PREFIX}${owner ?? "anon"}:${key}`;
}

/** Borra TODOS los borradores de la pestaña (todas las cuentas). */
export function clearAllDrafts(): void {
  owner = null;
  try {
    const store = window.sessionStorage;
    const doomed: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k && k.startsWith(DRAFT_PREFIX)) doomed.push(k);
    }
    for (const k of doomed) store.removeItem(k);
    store.removeItem(OWNER_KEY);
  } catch {
    // sin almacenamiento no hay nada que borrar
  }
}

/**
 * Fija la cuenta dueña de los borradores ANTES de pintar el panel con ella. Si
 * los borradores guardados son de otra cuenta, se borran todos.
 */
export function setDraftOwner(userId: string): void {
  try {
    const prev = window.sessionStorage.getItem(OWNER_KEY);
    if (prev !== null && prev !== userId) clearAllDrafts();
    window.sessionStorage.setItem(OWNER_KEY, userId);
  } catch {
    // sin almacenamiento: los borradores viven sólo en memoria
  }
  owner = userId;
}

function read(key: string): string | null {
  try {
    return window.sessionStorage.getItem(scoped(key));
  } catch {
    return null;
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(scoped(key));
    else window.sessionStorage.setItem(scoped(key), value);
  } catch {
    // sin almacenamiento: el borrador vive sólo en memoria
  }
}

export interface Draft {
  value: string;
  setValue: (v: string) => void;
  /** Borra el borrador (tras guardar en el servidor o descartar). */
  clear: () => void;
  /** true = el valor viene de un borrador recuperado, distinto del inicial. */
  restored: boolean;
}

/**
 * `key` identifica el documento (p. ej. `bot:<id>:code`); `initial` es el valor
 * del servidor. Un borrador igual al inicial no cuenta como recuperado.
 */
export function useSessionDraft(key: string, initial: string): Draft {
  const [state, setState] = useState(() => {
    const saved = read(key);
    return saved !== null && saved !== initial ? { value: saved, restored: true } : { value: initial, restored: false };
  });
  const keyRef = useRef(key);
  useEffect(() => {
    if (keyRef.current === key) return;
    keyRef.current = key;
    const saved = read(key);
    setState(
      saved !== null && saved !== initial ? { value: saved, restored: true } : { value: initial, restored: false },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const setValue = useCallback(
    (v: string) => {
      write(key, v);
      setState((s) => ({ value: v, restored: s.restored }));
    },
    [key],
  );
  const clear = useCallback(() => {
    write(key, null);
    setState((s) => ({ value: s.value, restored: false }));
  }, [key]);
  return { value: state.value, setValue, clear, restored: state.restored };
}
