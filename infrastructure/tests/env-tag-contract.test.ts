/**
 * CONTRATO DE ETIQUETAS DEL `.env`.
 *
 * El compose resuelve la imagen de cada servicio con `${<SERVICIO>_TAG:-${TAG}}`, salvo
 * `backup`, que usa `${BACKUP_TAG:-latest}` a propósito para no seguir a la aplicación.
 * Un override que sólo existe en la línea de comandos desaparece con la terminal: el
 * siguiente `docker compose up` global revierte ese servicio sin avisar, y en el caso de
 * `backup` lo manda a un `:latest` que puede no existir en el registro.
 *
 * Por eso la plantilla versionada tiene que nombrar TODAS las variables que el compose
 * consulta. Este test es el guard: si mañana alguien añade un servicio con su `_TAG` y no
 * lo documenta, la suite se pone roja en vez de dejar la mina puesta.
 *
 * Cada garantía lleva su control NEGATIVO: se comprueba que el extractor detecta de verdad
 * una variable ausente, para que un extractor roto no se lea como «todo documentado».
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, "..");

const COMPOSE = readFileSync(join(RAIZ, "docker-compose.yml"), "utf8");
const EJEMPLO = readFileSync(join(RAIZ, ".env.example"), "utf8");

/** Variables `*_TAG` que el compose interpola, en el orden en que aparecen. */
function tagsDelCompose(texto: string): string[] {
  const encontradas = new Set<string>();
  for (const m of texto.matchAll(/\$\{([A-Z_]+_TAG)(?::-|\})/g)) encontradas.add(m[1]);
  return [...encontradas].sort();
}

/** Variables documentadas en la plantilla, comentadas o no (`#FOO_TAG=` cuenta). */
function tagsDocumentadas(texto: string): string[] {
  const encontradas = new Set<string>();
  for (const linea of texto.split("\n")) {
    const m = /^\s*#?\s*([A-Z_]+_TAG)=/.exec(linea);
    if (m) encontradas.add(m[1]);
  }
  return [...encontradas].sort();
}

describe("contrato de etiquetas del .env", () => {
  it("el compose interpola al menos las etiquetas que conocemos", () => {
    const tags = tagsDelCompose(COMPOSE);
    expect(tags).toContain("BACKUP_TAG");
    expect(tags).toContain("TOURNAMENT_WORKER_TAG");
    expect(tags.length).toBeGreaterThanOrEqual(8);
  });

  it("toda variable *_TAG del compose está nombrada en .env.example", () => {
    const enCompose = tagsDelCompose(COMPOSE);
    const documentadas = tagsDocumentadas(EJEMPLO);
    const ausentes = enCompose.filter((t) => !documentadas.includes(t));
    expect(
      ausentes,
      `sin documentar en .env.example: ${ausentes.join(", ")}. ` +
        "Una variable que el compose consulta y la plantilla no nombra sólo se descubre " +
        "cuando un despliegue la olvida y el servicio se mueve solo.",
    ).toEqual([]);
  });

  it("CONTROL NEGATIVO · el extractor detecta una variable no documentada", () => {
    const plantillaCoja = EJEMPLO.split("\n")
      .filter((l) => !/^\s*#?\s*BACKUP_TAG=/.test(l))
      .join("\n");
    expect(tagsDocumentadas(plantillaCoja)).not.toContain("BACKUP_TAG");
    expect(tagsDelCompose(COMPOSE)).toContain("BACKUP_TAG");
  });

  it("CONTROL NEGATIVO · el extractor del compose no inventa variables", () => {
    expect(tagsDelCompose("image: ejemplo:fijo\n")).toEqual([]);
    expect(tagsDelCompose("# comentario sobre FOO_TAG sin interpolar\n")).toEqual([]);
  });

  it("`backup` no sigue a TAG, y la plantilla lo dice", () => {
    // La semántica es deliberadamente distinta: `${BACKUP_TAG:-latest}`, no `:-${TAG}`.
    expect(COMPOSE).toMatch(/\$\{BACKUP_TAG:-latest\}/);
    expect(EJEMPLO).toMatch(/BACKUP_TAG=/);
    expect(EJEMPLO.toLowerCase()).toMatch(/no sigue a tag/);
  });

  it("las copias del .env productivo están ignoradas por git", () => {
    const ignore = readFileSync(join(RAIZ, "..", ".gitignore"), "utf8");
    expect(ignore).toMatch(/^infrastructure\/\.env$/m);
    expect(ignore).toMatch(/^infrastructure\/\.env\.bak-\*$/m);
  });
});
