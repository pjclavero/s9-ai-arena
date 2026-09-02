/**
 * R17 · Diferencial de CALIBRACIÓN del asistente de primer arranque.
 *
 * Muta el CÓDIGO DE PRODUCCIÓN (no las sondas) para comprobar que la suite se
 * pone roja. Una suite que sobrevive a estas mutaciones no está comprobando lo
 * que dice comprobar. Deja siempre los ficheros como estaban.
 *
 * Uso: node scripts/r17-first-run-mutants.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const MUTANTS = [
  {
    name: "una comprobación ausente ya no deja el dominio en unknown",
    file: "packages/first-run/wizard.ts",
    from: '        gaps.push(`${checkId}: no figura en el informe, así que NO está comprobado`);\n        if (state === "satisfied") state = "unknown";',
    to: "        gaps.push(`${checkId}: no figura en el informe, así que NO está comprobado`);",
  },
  {
    name: "los requisitos no satisfechos dejan de bloquear el piso de arriba",
    file: "packages/first-run/wizard.ts",
    from: '      if (state === "satisfied") state = "blocked";',
    to: "      /* mutante: sin bloqueo */",
  },
  {
    name: "las confusiones sin cubrir dejan de quitar el READY",
    file: "packages/first-run/wizard.ts",
    from: "  for (const id of globallyUnresolved) {\n    blockers.push(",
    to: "  for (const id of []) {\n    blockers.push(",
  },
  {
    name: "los errores de configuración dejan de hacer fallar preflight",
    file: "packages/first-run/wizard.ts",
    from: '        state = "failed";\n        for (const e of errors) gaps.push(e.message);',
    to: "        for (const e of errors) gaps.push(e.message);",
  },
  {
    name: "el bloqueo del operador deja de impedir la activación",
    file: "packages/first-run/activation.ts",
    from: "  if (blockedGates.includes(request.gateKey) || plan.blockedGates.includes(request.gateKey)) {",
    to: "  if (false) {",
  },
  {
    name: "la frase de reconocimiento deja de exigirse",
    file: "packages/first-run/activation.ts",
    from: "    request.acknowledgement !== requiredAcknowledgement(request.gateKey)",
    to: "    false",
  },
  {
    name: "escribir 0 bytes pasa a considerarse almacenamiento escribible",
    file: "packages/first-run/checks.ts",
    from: "      const empty = requireEffect(r.bytesWritten, {",
    to: "      const empty = requireEffect(r.bytesWritten + 1, {",
  },
  {
    name: "se aprueba sin saber QUÉ PROCESO escribió",
    file: "packages/first-run/checks.ts",
    from: "      if (r.uid === null || r.gid === null) {",
    to: "      if (false) {",
  },
  {
    name: "cero administradores pasa a ser aceptable",
    file: "packages/first-run/checks.ts",
    from: "    const empty = requireEffect(r.adminCount, {",
    to: "    const empty = requireEffect(r.adminCount + 1, {",
  },
];

let survivors = 0;
for (const m of MUTANTS) {
  const original = readFileSync(m.file, "utf8");
  if (!original.includes(m.from)) {
    console.log(`ROTO   · ${m.name} (el patrón ya no existe: actualiza el mutante)`);
    survivors += 1;
    continue;
  }
  writeFileSync(m.file, original.replace(m.from, m.to));
  let red = false;
  try {
    execFileSync("npx", ["vitest", "run", "packages/first-run"], { stdio: "pipe" });
  } catch {
    red = true;
  } finally {
    writeFileSync(m.file, original);
  }
  console.log(`${red ? "ROJA  " : "SOBREVIVE"} · ${m.name}`);
  if (!red) survivors += 1;
}

console.log(survivors === 0 ? "\nTodas las mutaciones se detectaron." : `\n${survivors} mutación(es) sin detectar.`);
process.exit(survivors === 0 ? 0 : 1);
