/**
 * REVIEW (cierre funcional, R4.1) · el entrypoint de la API NO cablea el
 * launcher HTTP legado de `/battles/{id}/run` (battle-run-http-launcher.ts usaba
 * `artifact_hash` como imagen). La autoridad de ejecución es el tournament-worker.
 *
 * Se comprueba la ESTRUCTURA (AST ESTree del JS sin tipos: imports y llamadas),
 * no apariciones de texto: un comentario que nombre el fichero no cuenta, y un
 * import con otro alias tampoco se escapa.
 * Techo declarado: un `import()` dinámico con ruta calculada no lo vería.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import * as acorn from "acorn";

const __dirname = dirname(fileURLToPath(import.meta.url));

type AnyNode = { type: string; [k: string]: unknown };

/** Imports estáticos/dinámicos literales y nombres de las funciones llamadas. */
function analyse(file: string) {
  // TypeScript 7 ya no expone la API del compilador: se quitan los tipos con el
  // transformador de Node y se parsea el JS resultante con acorn (ESTree).
  const js = stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip" });
  const ast = acorn.parse(js, { ecmaVersion: "latest", sourceType: "module" }) as unknown as AnyNode;
  const imports: string[] = [];
  const calls: string[] = [];
  const calleeName = (c: AnyNode): string =>
    c.type === "Identifier"
      ? String(c.name)
      : c.type === "MemberExpression"
        ? `${calleeName(c.object as AnyNode)}.${calleeName(c.property as AnyNode)}`
        : c.type;
  const visit = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(visit);
    const node = n as AnyNode;
    if (node.type === "ImportDeclaration") imports.push(String((node.source as AnyNode).value));
    if (node.type === "ImportExpression" && (node.source as AnyNode).type === "Literal") {
      imports.push(String((node.source as AnyNode).value));
    }
    if (node.type === "CallExpression" || node.type === "NewExpression") calls.push(calleeName(node.callee as AnyNode));
    for (const [k, v] of Object.entries(node)) if (k !== "type") visit(v);
  };
  visit(ast);
  return { imports, calls };
}

describe("server.ts · sin launcher HTTP legado de /run", () => {
  const { imports, calls } = analyse(join(__dirname, "server.ts"));

  it("control positivo: el analizador ve los imports y llamadas reales de server.ts", () => {
    expect(imports).toContain("./app.js");
    expect(calls).toContain("createApp");
  });

  it("no importa battle-run-http-launcher ni construye su runner", () => {
    expect(imports.some((m) => /battle-run-http-launcher/.test(m))).toBe(false);
    expect(calls.some((c) => /HttpBattleRunLauncher|battleRunConfigFromEnv/.test(c))).toBe(false);
  });
});
