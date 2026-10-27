/**
 * UX-02 · Del informe crudo del bootstrap (traza de Python o `stack` de Node) a
 * un mensaje que el autor del bot entiende: FICHERO y LÍNEA de SU código y la
 * última línea del error. Las rutas del sandbox (`/tmp/bot/…`, `file:///tmp/bot/…`)
 * se reducen a la ruta dentro del paquete: el usuario no necesita (ni debe ver)
 * dónde se materializa su código.
 */

/** Raíz donde el bootstrap materializa el paquete (sandbox-bootstrap/bootstrap.*). */
const SANDBOX_ROOT = /(?:file:\/\/)?\/tmp\/bot\//g;

export interface UserErrorLocation {
  /** Ruta dentro del paquete del usuario (p. ej. `src/bot.py`). */
  file: string;
  line: number;
}

export interface LocatedUserError {
  location?: UserErrorLocation;
  /** Última línea útil del error (`NameError: name 'x' is not defined`). */
  summary: string;
}

/**
 * Localiza el error en el código del usuario. Python: el ÚLTIMO marco de la traza
 * que cae dentro del paquete (`File "/tmp/bot/src/bot.py", line 7`). Node: el
 * PRIMER marco del paquete (`/tmp/bot/src/bot.js:7:11`), que es el más interno.
 */
export function locateUserError(detail: string): LocatedUserError {
  const text = detail.replace(/\r/g, "");
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let location: UserErrorLocation | undefined;
  const py = [...text.matchAll(/File "(?:\/tmp\/bot\/)([^"]+)", line (\d+)/g)];
  if (py.length > 0) {
    const last = py[py.length - 1];
    location = { file: last[1], line: Number(last[2]) };
  } else {
    const js = /(?:file:\/\/)?\/tmp\/bot\/([^\s:"')]+):(\d+)/.exec(text);
    if (js) location = { file: js[1], line: Number(js[2]) };
  }

  // Python pone el error al final; Node, en la primera línea que parece «Tipo: msg».
  const errorLine =
    [...lines].reverse().find((l) => /^[A-Za-z_][\w.]*(Error|Exception|Interrupt|Exit)\b/.test(l)) ??
    lines.find((l) => /^[A-Za-z_]\w*:/.test(l)) ??
    lines[lines.length - 1] ??
    "";
  return { ...(location ? { location } : {}), summary: errorLine.replace(SANDBOX_ROOT, "") };
}

/** «src/bot.py, línea 7: NameError: …» (o sólo el resumen si no hay ubicación). */
export function describeUserError(detail: string): string {
  const { location, summary } = locateUserError(detail);
  return location ? `${location.file}, línea ${location.line}: ${summary}` : summary;
}
