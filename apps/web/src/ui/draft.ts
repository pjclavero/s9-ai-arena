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
 */
import { useCallback, useEffect, useRef, useState } from "react";

export const DRAFT_PREFIX = "s9_draft:";

function read(key: string): string | null {
  try {
    return window.sessionStorage.getItem(DRAFT_PREFIX + key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(DRAFT_PREFIX + key);
    else window.sessionStorage.setItem(DRAFT_PREFIX + key, value);
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
