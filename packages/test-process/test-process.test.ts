/**
 * EQ1 · Robustez · contrato de `spawnService` / `killTree`.
 */
import { afterAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { killAllServices, killTree, MARK_VAR, spawnService } from "./index.js";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    const st = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !st.slice(st.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    return false;
  }
};

/** Lanza `sh` que deja dos nietos `sleep` y escribe sus PIDs en stdout. */
function treeWithGrandchildren() {
  const child = spawnService("sh", ["-c", 'sleep 60 & a=$!; sleep 60 & b=$!; echo "$a $b"; wait'], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const pids = new Promise<number[]>((resolve) => {
    let out = "";
    child.stdout!.on("data", (b: Buffer) => {
      out += b.toString();
      if (out.includes("\n")) resolve(out.trim().split(/\s+/).map(Number));
    });
  });
  return { child, pids };
}

const until = async (cond: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return cond();
};

afterAll(() => killAllServices());

describe.skipIf(process.platform !== "linux")("spawnService / killTree", () => {
  it("caracterización del defecto: matar sólo el envoltorio deja vivos a los nietos", async () => {
    const { child, pids } = treeWithGrandchildren();
    const nietos = await pids;
    child.kill("SIGKILL"); // lo que hacían los tests antes
    await until(() => !alive(child.pid!));
    expect(alive(child.pid!)).toBe(false);
    expect(nietos.every(alive), "los nietos sobreviven a la muerte del envoltorio").toBe(true);
    await killTree(child); // y el grupo los alcanza aunque el líder ya haya muerto
    expect(nietos.some(alive)).toBe(false);
  });

  it("killTree mata el árbol entero y espera a que quede vacío", async () => {
    const { child, pids } = treeWithGrandchildren();
    const nietos = await pids;
    await killTree(child);
    expect([child.pid!, ...nietos].some(alive)).toBe(false);
  });

  it("con SIGTERM que el árbol ignora, escala a SIGKILL tras el plazo de gracia", async () => {
    const child = spawnService("sh", ["-c", "trap '' TERM; sleep 60 & wait"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    await killTree(child, "SIGTERM", 300);
    expect(alive(child.pid!)).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  });

  it("servicio real bajo tsx (envoltorio + nieto node): no queda ningún proceso", async () => {
    const tsx = join(dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist", "cli.mjs");
    const dir = mkdtempSync(join(tmpdir(), "eq1-tsx-"));
    const main = join(dir, "main.ts");
    writeFileSync(main, 'const n: number = process.pid; console.log(`listo ${n}`); setInterval(() => {}, 1000);\n');
    const child = spawnService(process.execPath, [tsx, main], { stdio: ["ignore", "pipe", "ignore"] });
    const servicePid = await new Promise<number>((resolve) => {
      let out = "";
      child.stdout!.on("data", (b: Buffer) => {
        out += b.toString();
        const m = /listo (\d+)/.exec(out);
        if (m) resolve(Number(m[1]));
      });
    });
    expect(servicePid).not.toBe(child.pid); // tsx ejecuta el servicio en un proceso NIETO
    await killTree(child);
    expect(alive(child.pid!)).toBe(false);
    expect(alive(servicePid), "el servicio de verdad (nieto de tsx) sigue vivo").toBe(false);
  }, 30_000);

  it("propaga la marca de huérfanos aunque el test pase un entorno mínimo", async () => {
    const prev = process.env[MARK_VAR];
    process.env[MARK_VAR] = "marca-de-prueba";
    try {
      const child = spawnService("sh", ["-c", `printf %s "$${MARK_VAR}"`], {
        env: { PATH: process.env.PATH ?? "" },
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      child.stdout!.on("data", (b: Buffer) => (out += b.toString()));
      await new Promise((r) => child.once("exit", r));
      expect(out).toBe("marca-de-prueba");
      await killTree(child);
    } finally {
      if (prev === undefined) delete process.env[MARK_VAR];
      else process.env[MARK_VAR] = prev;
    }
  });
});
