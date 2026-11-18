/**
 * PORTABLE · formato, verificación y seguridad del export/import de bots y equipos
 * (scripts/portable). Sin red ni BD: un export sintético escrito a mano en un directorio
 * temporal. Cada `it` es el «test asesino» de algún mutante de scripts/portable/mutants.py
 * (el nombre del mutante figura en el título).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  SUPPORTED_ENGINE_VERSIONS,
  assertEngineCompatible,
  assignSlugs,
  scanBuffer,
  selectVersions,
  slugify,
  verifyExport,
} from "../../../scripts/portable/lib/format.mjs";
import { runImport } from "../../../scripts/portable/lib/import.mjs";
import { loadAuth } from "../../../scripts/portable/lib/api.mjs";
import { main as cli } from "../../../scripts/portable/portable.mjs";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

interface Opts {
  engineVersion?: string;
  formatVersion?: number;
  teamBots?: string[];
}

/** Escribe un export sintético válido (2 bots, 1 equipo) con el formato documentado. */
function writeSyntheticExport(dir: string, o: Opts = {}) {
  const files: { path: string; sha256: string; bytes: number }[] = [];
  const put = (rel: string, content: Buffer | string) => {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const full = join(dir, ...rel.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, buf);
    files.push({ path: rel, sha256: sha(buf), bytes: buf.length });
  };
  const code = (n: number) => Buffer.from(`# bot sintético ${n}\nprint("hola")\n`);
  const bot = (slug: string, name: string, n: number) => {
    const c = code(n);
    put(`bots/${slug}/versions/v1/source.bin`, c);
    put(
      `bots/${slug}/bot.json`,
      json({
        slug,
        name,
        visibility: "private",
        retired: false,
        loadouts: [
          {
            revision: 1,
            catalogVersion: "mvp@1",
            chassis: "chassis.medium@1",
            modules: [{ slot: "drive", moduleId: "movement.tracks@1" }],
          },
        ],
        versions: [
          {
            version: 1,
            state: "published",
            runtime: "python",
            loadoutRevision: 1,
            parentVersion: null,
            codePublic: false,
            source: {
              file: `bots/${slug}/versions/v1/source.bin`,
              filename: "main.py",
              sha256: sha(c),
              bytes: c.length,
            },
          },
        ],
        omittedVersions: [],
      }),
    );
  };
  bot("alfa", "Alfa", 1);
  bot("beta", "Beta", 2);
  put(
    "teams/rojo.json",
    json({
      slug: "rojo",
      name: "Rojo",
      operatorRole: "captain",
      bots: o.teamBots ?? ["alfa", "beta"],
      externalBots: [],
      otherMembers: { count: 0, roles: [] },
    }),
  );
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const manifestText = json({
    formatVersion: o.formatVersion ?? 1,
    tool: "s9-portable-export",
    sourceSha: "0".repeat(40),
    engineVersion: o.engineVersion ?? "0.5.0",
    createdAt: "2026-11-18T00:00:00.000Z",
    versionsPolicy: "heads",
    counts: { bots: 2, teams: 1, versions: 2, loadouts: 2, omittedVersions: 0 },
    files,
  });
  writeFileSync(join(dir, "manifest.json"), manifestText);
  const lines = [...files.map((f) => `${f.sha256}  ${f.path}`), `${sha(manifestText)}  manifest.json`].sort((a, b) =>
    a.slice(66) < b.slice(66) ? -1 : 1,
  );
  writeFileSync(join(dir, "checksums.sha256"), lines.join("\n") + "\n");
}

/** Reescribe manifest + checksums tras editar un fichero (para forjar un export «coherente» pero semánticamente roto). */
function rehash(dir: string) {
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  for (const f of m.files) {
    const b = readFileSync(join(dir, ...f.path.split("/")));
    f.sha256 = sha(b);
    f.bytes = b.length;
  }
  const mt = json(m);
  writeFileSync(join(dir, "manifest.json"), mt);
  const lines = [
    ...m.files.map((f: { sha256: string; path: string }) => `${f.sha256}  ${f.path}`),
    `${sha(mt)}  manifest.json`,
  ].sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1));
  writeFileSync(join(dir, "checksums.sha256"), lines.join("\n") + "\n");
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "portable-fmt-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Cliente de red que CUENTA toda petición: un import que falle antes de escribir no hace ninguna. */
function spyClient() {
  const calls: string[] = [];
  const trap = async (m: string, p: string) => {
    calls.push(`${m} ${p}`);
    throw new Error("no debería haber red");
  };
  return {
    calls,
    client: { json: trap, request: trap, listAll: async (p: string) => trap("GET", p), writes: 0, requests: 0 },
  };
}

describe("verifyExport · export válido", () => {
  it("acepta un export coherente y devuelve bots y equipos", () => {
    writeSyntheticExport(dir);
    const v = verifyExport(dir);
    expect(v.bots.map((b: { slug: string }) => b.slug).sort()).toEqual(["alfa", "beta"]);
    expect(v.teams).toHaveLength(1);
    expect(v.manifest.formatVersion).toBe(1);
  });

  it("checksums.sha256 es compatible con `sha256sum -c` (formato «hash␣␣ruta»)", () => {
    writeSyntheticExport(dir);
    const lines = readFileSync(join(dir, "checksums.sha256"), "utf8").trimEnd().split("\n");
    expect(lines.length).toBeGreaterThan(3);
    for (const l of lines) {
      const m = /^([0-9a-f]{64}) {2}(\S.*)$/.exec(l);
      expect(m).not.toBeNull();
      expect(sha(readFileSync(join(dir, m![2])))).toBe(m![1]);
    }
  });
});

describe("verifyExport · corrupción (mutante M1 no_checksum)", () => {
  it("M1 · un fichero de código alterado se detecta por checksum", () => {
    writeSyntheticExport(dir);
    writeFileSync(join(dir, "bots/alfa/versions/v1/source.bin"), "# alterado\n");
    expect(() => verifyExport(dir)).toThrow(/checksum/i);
  });

  it("M1 · un bot.json alterado se detecta por checksum", () => {
    writeSyntheticExport(dir);
    const f = join(dir, "bots/beta/bot.json");
    writeFileSync(f, readFileSync(f, "utf8").replace("Beta", "Beta2"));
    expect(() => verifyExport(dir)).toThrow(/checksum/i);
  });

  it("M1 · un manifest alterado se detecta (checksums.sha256 lo cubre)", () => {
    writeSyntheticExport(dir);
    const f = join(dir, "manifest.json");
    writeFileSync(f, readFileSync(f, "utf8").replace("0.5.0", "0.4.0"));
    expect(() => verifyExport(dir)).toThrow(/checksum/i);
  });

  it("falta un fichero listado, sobra uno no listado y un enlace simbólico se rechazan", () => {
    writeSyntheticExport(dir);
    rmSync(join(dir, "bots/beta/versions/v1/source.bin"));
    expect(() => verifyExport(dir)).toThrow(/Falta un fichero/);
    rmSync(dir, { recursive: true });
    mkdirSync(dir);
    writeSyntheticExport(dir);
    writeFileSync(join(dir, "bots/alfa/extra.txt"), "x");
    expect(() => verifyExport(dir)).toThrow(/no figura/);
    rmSync(join(dir, "bots/alfa/extra.txt"));
    symlinkSync("/etc/hostname", join(dir, "bots/alfa/link"));
    expect(() => verifyExport(dir)).toThrow(/simbólico/);
  });

  it("un export marcado como incompleto no se importa", () => {
    writeSyntheticExport(dir);
    writeFileSync(join(dir, ".export-incomplete"), "x");
    expect(() => verifyExport(dir)).toThrow(/incompleto/);
  });
});

describe("verifyExport · referencias (mutante M5 team_dangling_bot)", () => {
  it("M5 · un equipo que referencia un bot inexistente falla la verificación", () => {
    writeSyntheticExport(dir, { teamBots: ["alfa", "fantasma"] });
    expect(() => verifyExport(dir)).toThrow(/fantasma/);
  });

  it("una versión que usa una revisión de loadout inexistente falla (dangling_loadout)", () => {
    writeSyntheticExport(dir);
    const f = join(dir, "bots/alfa/bot.json");
    writeFileSync(f, readFileSync(f, "utf8").replace('"loadoutRevision": 1', '"loadoutRevision": 7'));
    rehash(dir);
    expect(() => verifyExport(dir)).toThrow(/revisión 7/);
  });

  it("los recuentos del manifest tienen que cuadrar", () => {
    writeSyntheticExport(dir);
    const f = join(dir, "manifest.json");
    writeFileSync(f, readFileSync(f, "utf8").replace('"bots": 2', '"bots": 3'));
    rehash(dir);
    expect(() => verifyExport(dir)).toThrow(/recuentos/);
  });
});

describe("compatibilidad (mutantes M6 engine y M7 format)", () => {
  it("M7 · una formatVersion desconocida falla limpiamente", () => {
    writeSyntheticExport(dir, { formatVersion: 2 });
    expect(() => verifyExport(dir)).toThrow(/formatVersion 2 no soportada/);
  });

  it("M6 · motor desconocido, o export más nuevo que el destino, falla; igual o anterior pasa", () => {
    expect(() => assertEngineCompatible("9.9.9", "0.5.0")).toThrow(/no soportado/);
    expect(() => assertEngineCompatible("0.5.0", "9.9.9")).toThrow(/no está entre los soportados/);
    expect(() => assertEngineCompatible("0.5.0", "0.4.0")).toThrow(/más nuevo/);
    expect(() => assertEngineCompatible("0.4.0", "0.5.0")).not.toThrow();
    expect(() => assertEngineCompatible("0.5.0", "0.5.0")).not.toThrow();
    expect(SUPPORTED_ENGINE_VERSIONS).toContain("0.5.0");
  });

  it("M6 · el import con motor incompatible falla ANTES de cualquier petición de red", async () => {
    writeSyntheticExport(dir, { engineVersion: "0.5.0" });
    const { client, calls } = spyClient();
    await expect(runImport({ client, src: dir, targetEngine: "0.4.0" })).rejects.toThrow(/más nuevo/);
    expect(calls).toEqual([]);
  });
});

describe("import · valida antes de escribir (mutante M2 write_before_validate)", () => {
  it("M2 · un export corrupto aborta sin una sola petición (ni lectura ni escritura)", async () => {
    writeSyntheticExport(dir);
    writeFileSync(join(dir, "bots/alfa/versions/v1/source.bin"), "# alterado\n");
    const { client, calls } = spyClient();
    await expect(runImport({ client, src: dir, targetEngine: "0.5.0" })).rejects.toThrow(/checksum/i);
    expect(calls).toEqual([]);
  });

  it("M2 · el CLI con un export corrupto sale con 1 sin credenciales ni red (verificación previa)", async () => {
    writeSyntheticExport(dir);
    writeFileSync(join(dir, "bots/beta/versions/v1/source.bin"), "# alterado\n");
    await expect(
      cli(["import", "--from", dir, "--target-engine", "0.5.0", "--dry-run"], { out: () => {}, err: () => {} }),
    ).rejects.toThrow(/checksum/i);
  });

  it("--dry-run offline valida y no hace red", async () => {
    writeSyntheticExport(dir);
    const out: string[] = [];
    const rc = await cli(["import", "--from", dir, "--target-engine", "0.5.0", "--dry-run"], {
      out: (s: string) => out.push(s),
      err: () => {},
    });
    expect(rc).toBe(0);
    expect(out.join("\n")).toMatch(/DRY-RUN OFFLINE/);
  });

  it("`verify` del CLI acepta un export bueno y rechaza uno malo", async () => {
    writeSyntheticExport(dir);
    expect(await cli(["verify", dir], { out: () => {}, err: () => {} })).toBe(0);
    writeFileSync(join(dir, "teams/rojo.json"), "{}");
    await expect(cli(["verify", dir], { out: () => {}, err: () => {} })).rejects.toThrow();
  });
});

describe("selección de versiones (política heads)", () => {
  const v = (version: number, state: string) => ({ version, state });
  it("última publicada + última en borrador; el resto se omite con motivo", () => {
    const { selected, omitted } = selectVersions([v(1, "published"), v(2, "published"), v(3, "draft"), v(4, "draft")]);
    expect(selected.map((x: { version: number }) => x.version)).toEqual([2, 4]);
    expect(omitted.map((x: { version: number }) => x.version)).toEqual([1, 3]);
  });
  it("sin publicadas, la mejor cabeza disponible; todo bot con versiones exporta al menos una", () => {
    expect(
      selectVersions([v(1, "retired"), v(2, "frozen")]).selected.map((x: { version: number }) => x.version),
    ).toEqual([2]);
    expect(selectVersions([v(1, "retired")]).selected).toHaveLength(1);
    expect(selectVersions([]).selected).toEqual([]);
  });
  it("un borrador más antiguo que la publicada también se conserva (decisión del brief)", () => {
    expect(
      selectVersions([v(1, "draft"), v(2, "published")]).selected.map((x: { version: number }) => x.version),
    ).toEqual([1, 2]);
  });
  it("una versión rejected posterior a todo se conserva; la anterior no", () => {
    expect(
      selectVersions([v(1, "published"), v(2, "rejected")]).selected.map((x: { version: number }) => x.version),
    ).toEqual([1, 2]);
    expect(
      selectVersions([v(1, "rejected"), v(2, "published")]).selected.map((x: { version: number }) => x.version),
    ).toEqual([2]);
  });
  it("`all` las exporta todas y una política desconocida falla", () => {
    expect(selectVersions([v(1, "retired"), v(2, "published")], "all").selected).toHaveLength(2);
    expect(() => selectVersions([], "otra")).toThrow(/Política/);
  });
});

describe("slugs", () => {
  it("normaliza, es determinista y nunca produce rutas peligrosas", () => {
    expect(slugify("Ñandú Rápido!")).toBe("nandu-rapido");
    expect(slugify("../../etc/passwd")).toBe("etc-passwd");
    expect(slugify("日本語")).toMatch(/^x-[0-9a-f]{8}$/);
    expect(assignSlugs(["A b", "a-b", "A.B"])).toEqual(["a-b", "a-b-2", "a-b-3"]);
  });
});

describe("escáner de secretos (mutante M3 secret_leak)", () => {
  it("M3 · detecta correo, UUID, JWT, Bearer, clave PEM, destino de streaming y claves prohibidas en metadatos", () => {
    const bad = [
      '{"nota":"alguien@example.com"}',
      '{"x":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}',
      '{"t":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk"}',
      '{"h":"Bearer abcdefghijklmnop12345"}',
      '{"k":"-----BEGIN PRIVATE KEY-----"}',
      '{"s":"rtmp://a.rtmp.youtube.com/live2/xxxx"}',
      '{"ownerId":"x"}',
      '{"password":"x"}',
    ];
    for (const b of bad) expect(scanBuffer(Buffer.from(b), "meta", "f.json").length).toBeGreaterThan(0);
    expect(scanBuffer(Buffer.from('{"name":"Alfa","chassis":"chassis.medium@1"}'), "meta", "f.json")).toEqual([]);
  });
  it("el código de un bot sólo se bloquea por credenciales de alta confianza (un correo en un comentario no)", () => {
    expect(scanBuffer(Buffer.from("# autor: yo@example.com\nprint(1)"), "source", "s.bin")).toEqual([]);
    expect(scanBuffer(Buffer.from("TOKEN='ghp_abcdefghijklmnopqrstuvwxyz0123456789'"), "source", "s.bin").length).toBe(
      1,
    );
  });
  it("un valor sensible conocido (correo, id, token) no puede aparecer en ningún fichero", () => {
    expect(scanBuffer(Buffer.from("hola mi-token-secreto"), "source", "s.bin", ["mi-token-secreto"]).length).toBe(1);
  });
});

describe("credenciales (nunca por argv)", () => {
  it("el fichero de credenciales o de token exige permisos 0600", () => {
    const f = join(dir, "cred.json");
    writeFileSync(f, JSON.stringify({ email: "a@b.c", password: "p" }));
    chmodSync(f, 0o644);
    expect(() => loadAuth({ credentialsFile: f })).toThrow(/0600/);
    chmodSync(f, 0o600);
    expect(loadAuth({ credentialsFile: f })).toMatchObject({ email: "a@b.c" });
    const t = join(dir, "tok");
    writeFileSync(t, "abc\n", { mode: 0o600 });
    chmodSync(t, 0o600);
    expect(loadAuth({ tokenFile: t })).toEqual({ token: "abc" });
    expect(() => loadAuth({})).toThrow(/argv/);
  });
  it("el CLI no acepta credenciales por argv (opción desconocida)", async () => {
    writeSyntheticExport(dir);
    await expect(
      cli(["import", "--from", dir, "--password", "x", "--target-engine", "0.5.0"], { out: () => {}, err: () => {} }),
    ).rejects.toThrow();
  });
});

describe("cliente HTTP (reintentos y reautenticación)", () => {
  const mk = (responses: { status: number; body?: unknown }[]) => {
    const seen: { url: string; auth?: string }[] = [];
    let i = 0;
    const fetchImpl = async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, auth: init.headers.Authorization });
      const r = responses[Math.min(i++, responses.length - 1)];
      return new Response(JSON.stringify(r.body ?? {}), {
        status: r.status,
        headers: { "content-type": "application/json" },
      });
    };
    return { seen, fetchImpl: fetchImpl as unknown as typeof fetch };
  };

  it("un 429 (60 versiones/hora) espera y reintenta; agotada la espera dice cómo reanudar", async () => {
    const { ApiClient } = await import("../../../scripts/portable/lib/api.mjs");
    const waits: number[] = [];
    const { fetchImpl, seen } = mk([{ status: 429 }, { status: 429 }, { status: 200, body: { ok: 1 } }]);
    const c = new ApiClient({
      baseUrl: "http://x/api",
      auth: { token: "t" },
      fetchImpl,
      sleep: async (ms: number) => void waits.push(ms),
      rateLimitWaitMs: 5,
    });
    expect(await c.json("GET", "/a")).toEqual({ ok: 1 });
    expect(waits).toEqual([5, 5]);
    expect(seen).toHaveLength(3);
    const always = mk([{ status: 429 }]);
    const c2 = new ApiClient({
      baseUrl: "http://x",
      auth: { token: "t" },
      fetchImpl: always.fetchImpl,
      sleep: async () => {},
      rateLimitWaitMs: 5,
      rateLimitMaxWaitMs: 10,
    });
    await expect(c2.json("POST", "/a", { json: {} })).rejects.toThrow(/idempotente/);
  });

  it("un 401 con usuario/contraseña reautentica una vez; los errores jamás llevan el token ni la contraseña", async () => {
    const { ApiClient } = await import("../../../scripts/portable/lib/api.mjs");
    const { fetchImpl, seen } = mk([
      { status: 401 },
      { status: 200, body: { accessToken: "NUEVO-TOKEN-123" } },
      { status: 200, body: { ok: 1 } },
    ]);
    const c = new ApiClient({
      baseUrl: "http://x",
      auth: { email: "a@b.c", password: "SECRETA-pw", token: "VIEJO-TOKEN" },
      fetchImpl,
      sleep: async () => {},
    });
    expect(await c.json("GET", "/a")).toEqual({ ok: 1 });
    expect(seen.map((s) => s.url)).toEqual(["http://x/a", "http://x/auth/login", "http://x/a"]);
    expect(seen[2].auth).toBe("Bearer NUEVO-TOKEN-123");
    const bad = mk([{ status: 403, body: { error: "forbidden", message: "no" } }]);
    const c2 = new ApiClient({
      baseUrl: "http://x",
      auth: { token: "TOKEN-QUE-NO-DEBE-SALIR" },
      fetchImpl: bad.fetchImpl,
      sleep: async () => {},
    });
    const err = await c2.json("POST", "/z", { json: { password: "SECRETA-pw" } }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/HTTP 403 forbidden/);
    expect((err as Error).message).not.toContain("TOKEN-QUE-NO-DEBE-SALIR");
    expect((err as Error).message).not.toContain("SECRETA-pw");
  });
});
