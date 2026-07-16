/**
 * E6 · bot-manager — persistencia de builds (T6.1, "tabla builds").
 *
 * DECISIÓN DE ENTORNO: el dosier pide una "tabla builds" persistida. La BD PostgreSQL
 * del cap. 23 es responsabilidad de E7 (T7.1) y aún no existe; node:sqlite solo está en
 * Node ≥22 y esta máquina corre Node 20. Para no bloquear E6 se define una interfaz
 * BuildStore y dos implementaciones intercambiables con la MISMA semántica:
 *   - InMemoryBuildStore: usada por los tests.
 *   - JsonFileBuildStore: persistencia real en disco (un JSON por build), demostrando
 *     que el pipeline no asume memoria.
 * Cuando E7 levante la BD, basta una tercera implementación (PgBuildStore) sobre la
 * tabla `builds` del esquema 23; el pipeline no cambia.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Build } from "./types.js";

export interface BuildStore {
  save(build: Build): void;
  get(id: string): Build | undefined;
  list(botId?: string): Build[];
}

export class InMemoryBuildStore implements BuildStore {
  private builds = new Map<string, Build>();
  save(build: Build): void {
    // clon defensivo para que el llamante no mute lo persistido por referencia
    this.builds.set(build.id, structuredClone(build));
  }
  get(id: string): Build | undefined {
    const b = this.builds.get(id);
    return b ? structuredClone(b) : undefined;
  }
  list(botId?: string): Build[] {
    const all = [...this.builds.values()].map((b) => structuredClone(b));
    return botId ? all.filter((b) => b.botId === botId) : all;
  }
}

export class JsonFileBuildStore implements BuildStore {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }
  save(build: Build): void {
    writeFileSync(this.path(build.id), JSON.stringify(build, null, 2), "utf8");
  }
  get(id: string): Build | undefined {
    try {
      return JSON.parse(readFileSync(this.path(id), "utf8")) as Build;
    } catch {
      return undefined;
    }
  }
  list(botId?: string): Build[] {
    const out: Build[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const b = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as Build;
        if (!botId || b.botId === botId) out.push(b);
      } catch {
        /* ignora ficheros corruptos */
      }
    }
    return out;
  }
}
