/**
 * EQ3 · Piezas de presentación del Centro de Ayuda: bloque de código copiable,
 * tabla de campos generada desde un JSON Schema y marcas de estado
 * (pendiente / no verificado). Sin dependencias ni red.
 */
import { useState, type ReactNode } from "react";

// ------------------------------------------------------------- código
export function CodeBlock(props: { code: string; lang: string; label: string; testId?: string }) {
  const [copied, setCopied] = useState<"" | "ok" | "fail">("");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.code);
      setCopied("ok");
    } catch {
      // Sin portapapeles (http sin TLS, permisos): el código sigue seleccionable a mano.
      setCopied("fail");
    }
  };
  return (
    <figure className="help-code" data-testid={props.testId}>
      <figcaption>
        <span>{props.label}</span>{" "}
        <button type="button" onClick={copy} aria-label={`Copiar código: ${props.label}`}>
          Copiar
        </button>{" "}
        <span role="status" aria-live="polite">
          {copied === "ok" ? "Copiado." : copied === "fail" ? "No se pudo copiar: selecciónalo a mano." : ""}
        </span>
      </figcaption>
      <pre tabIndex={0} aria-label={`Código ${props.lang}: ${props.label}`}>
        <code data-lang={props.lang}>{props.code}</code>
      </pre>
    </figure>
  );
}

// -------------------------------------------------------------- estados
/** Algo que existe en el plan pero no en este código: se dice, no se inventa. */
export function Pending(props: { children: ReactNode; testId?: string }) {
  return (
    <div className="help-pending" role="note" data-testid={props.testId ?? "help-pending"}>
      <strong>Pendiente · NOT TESTED.</strong> {props.children}
    </div>
  );
}

export function Note(props: { children: ReactNode }) {
  return (
    <p className="help-note" role="note">
      {props.children}
    </p>
  );
}

// ----------------------------------------------------- tablas de esquema
type Json = Record<string, any>;

export interface SchemaField {
  path: string;
  type: string;
  required: boolean;
  description?: string;
}

function refName(ref: string): string {
  return ref.split("/").pop() ?? ref;
}

function typeOf(node: Json, defs: Json): { type: string; description?: string; node: Json } {
  if (node.$ref) {
    const name = refName(node.$ref);
    const target = (defs[name] ?? {}) as Json;
    const inner = typeOf(target, defs);
    return { type: inner.type === "?" ? name : `${inner.type}`, description: target.description, node: target };
  }
  if (node.const !== undefined) return { type: `"${node.const}"`, node };
  if (Array.isArray(node.enum)) return { type: node.enum.map((e: unknown) => JSON.stringify(e)).join(" | "), node };
  if (node.type === "array") {
    const items = (node.items ?? {}) as Json;
    return { type: `${typeOf(items, defs).type}[]`, node };
  }
  if (typeof node.type === "string") {
    let t = node.type as string;
    if (node.minimum !== undefined || node.maximum !== undefined) {
      t += ` [${node.minimum ?? "…"}, ${node.maximum ?? "…"}]`;
    }
    return { type: t, node };
  }
  if (node.properties) return { type: "object", node };
  return { type: "?", node };
}

/**
 * Aplana un JSON Schema a una lista de campos con ruta (`self.energy.storedEU`,
 * `sensors.radar[].contacts[].position`). Los `$ref` a common.schema.json se
 * resuelven contra sus `$defs` para dar el tipo y la descripción reales.
 */
export function flattenSchema(schema: Json, defs: Json, prefix = "", depth = 0): SchemaField[] {
  const out: SchemaField[] = [];
  const props = (schema.properties ?? {}) as Json;
  const req = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
  for (const [key, raw] of Object.entries(props)) {
    const node = raw as Json;
    const path = prefix ? `${prefix}.${key}` : key;
    const t = typeOf(node, defs);
    out.push({ path, type: t.type, required: req.has(key), description: node.description ?? t.description });
    if (depth >= 4) continue;
    if (node.type === "object" && node.properties) out.push(...flattenSchema(node, defs, path, depth + 1));
    if (node.type === "array" && node.items?.properties) {
      out.push(...flattenSchema(node.items, defs, `${path}[]`, depth + 1));
    }
  }
  return out;
}

/** Los literales JSON de una descripción (`null`, `true`, `false`) se marcan como código, no como prosa. */
export function Literal(props: { text: string }) {
  const parts = props.text.split(/\b(null|true|false)\b/);
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1 ? <code key={i}>{p}</code> : p))}
    </>
  );
}

export function SchemaFields(props: { schema: Json; defs: Json; caption: string; testId?: string; rootPath?: string }) {
  let node = props.schema;
  if (props.rootPath) for (const k of props.rootPath.split(".")) node = node?.properties?.[k] ?? {};
  const fields = flattenSchema(node, props.defs, props.rootPath ?? "");
  return (
    <table className="stack-table" data-testid={props.testId}>
      <caption>{props.caption}</caption>
      <thead>
        <tr>
          <th scope="col">Campo</th>
          <th scope="col">Tipo</th>
          <th scope="col">Obligatorio</th>
          <th scope="col">Qué es</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((f) => (
          <tr key={f.path}>
            <td data-label="Campo">
              <code>{f.path}</code>
            </td>
            <td data-label="Tipo">
              <code>{f.type}</code>
            </td>
            <td data-label="Obligatorio">{f.required ? "sí" : "no"}</td>
            <td data-label="Qué es">{f.description ? <Literal text={f.description} /> : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
