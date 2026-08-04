/**
 * D1/B13 · Lectura de un Dockerfile por INSTRUCCIONES, no por texto.
 *
 * Nació en B7/D1: la comprobación de "¿el Dockerfile prueba el guard dentro de
 * la imagen?" leía el texto crudo, así que comentar entero el `RUN` de las
 * pruebas la dejaba verde mientras dentro de la imagen no se ejecutaba nada.
 *
 * B13 la mueve aquí —sin cambiarle el comportamiento— porque hace falta el mismo
 * guard-rail para la prueba viva de la imagen del streamer, y dos copias del
 * criterio serían dos copias que se pueden desincronizar.
 */

/**
 * Devuelve las instrucciones que Docker ejecuta de verdad: descarta comentarios
 * y líneas en blanco, y une las continuaciones de línea (`\`) en una sola
 * instrucción. No interpreta nada más: sólo hace falta distinguir "esto se
 * ejecuta" de "esto es texto muerto".
 */
export function instruccionesDockerfile(df: string): string[] {
  const instrucciones: string[] = [];
  let acumulada: string | null = null;
  for (const cruda of df.split("\n")) {
    const linea = cruda.trimEnd();
    if (acumulada === null && (linea.trim() === "" || linea.trim().startsWith("#"))) continue;
    const continua = linea.endsWith("\\");
    const cuerpo = continua ? linea.slice(0, -1) : linea;
    acumulada = acumulada === null ? cuerpo : `${acumulada}\n${cuerpo}`;
    if (!continua) {
      instrucciones.push(acumulada);
      acumulada = null;
    }
  }
  if (acumulada !== null) instrucciones.push(acumulada);
  return instrucciones;
}

/** Todas las instrucciones RUN de un Dockerfile, concatenadas. */
export function instruccionesRun(df: string): string {
  return instruccionesDockerfile(df)
    .filter((i) => /^RUN\s/i.test(i))
    .join("\n");
}
