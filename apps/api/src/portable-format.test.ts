/**
 * PORTABLE · formato, verificación y seguridad del export/import de bots y equipos
 * (scripts/portable). Sin red ni BD: un export sintético escrito a mano en un directorio
 * temporal. Cada `it` es el «test asesino» de algún mutante de scripts/portable/mutants.py
 * (el nombre del mutante figura en el título).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_LIMITS,
  DEFAULT_VERSIONS_POLICY,
  SUPPORTED_ENGINE_VERSIONS,
  assertEngineCompatible,
  assignSlugs,
  scanBuffer,
  selectVersions,
  slugify,
  verifyExport,
} from "../../../scripts/portable/lib/format.mjs";
import { runImport } from "../../../scripts/portable/lib/import.mjs";
import { detectEngineVersion, resolveEngineVersion, runExport } from "../../../scripts/portable/lib/export.mjs";
import { ApiClient, loadAuth } from "../../../scripts/portable/lib/api.mjs";
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
      externalBotsCount: 0,
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
    const { selected, omitted } = selectVersions(
      [v(1, "published"), v(2, "published"), v(3, "draft"), v(4, "draft")],
      "heads",
    );
    expect(selected.map((x: { version: number }) => x.version)).toEqual([2, 4]);
    expect(omitted.map((x: { version: number }) => x.version)).toEqual([1, 3]);
  });
  it("sin publicadas, la mejor cabeza disponible; todo bot con versiones exporta al menos una", () => {
    expect(
      selectVersions([v(1, "retired"), v(2, "frozen")], "heads").selected.map((x: { version: number }) => x.version),
    ).toEqual([2]);
    expect(selectVersions([v(1, "retired")], "heads").selected).toHaveLength(1);
    expect(selectVersions([], "heads").selected).toEqual([]);
  });
  it("un borrador más antiguo que la publicada también se conserva (decisión del brief)", () => {
    expect(
      selectVersions([v(1, "draft"), v(2, "published")], "heads").selected.map((x: { version: number }) => x.version),
    ).toEqual([1, 2]);
  });
  it("una versión rejected posterior a todo se conserva; la anterior no", () => {
    expect(
      selectVersions([v(1, "published"), v(2, "rejected")], "heads").selected.map(
        (x: { version: number }) => x.version,
      ),
    ).toEqual([1, 2]);
    expect(
      selectVersions([v(1, "rejected"), v(2, "published")], "heads").selected.map(
        (x: { version: number }) => x.version,
      ),
    ).toEqual([2]);
  });
  it("P1-3 · el valor POR DEFECTO es `all`: las versiones congeladas de torneo y las antiguas viajan", () => {
    const vs = [v(1, "frozen"), v(2, "frozen"), v(3, "published"), v(4, "draft")];
    expect(DEFAULT_VERSIONS_POLICY).toBe("all");
    expect(selectVersions(vs).selected.map((x: { version: number }) => x.version)).toEqual([1, 2, 3, 4]);
    // `heads` (opt-in) perdería las congeladas 1 y 2: justo lo que la migración no puede permitirse.
    expect(selectVersions(vs, "heads").selected.map((x: { version: number }) => x.version)).toEqual([3, 4]);
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
  it("R5 · el CLI RECHAZA EXPLÍCITAMENTE las credenciales por argv (credentials_argv), con todo lo demás válido", async () => {
    // Todo lo demás es válido (URL, fichero de credenciales 0600, destino): el ÚNICO motivo de fallo
    // posible es el argumento de credencial. Si el CLI aceptase --password, fallaría por otra causa
    // (red) y este test se pondría en rojo por el código de error.
    const cred = join(dir, "cred.json");
    writeFileSync(cred, JSON.stringify({ email: "a@b.c", password: "p" }), { mode: 0o600 });
    chmodSync(cred, 0o600);
    const base = ["--api-url", "http://127.0.0.1:1/api/v1", "--credentials-file", cred];
    const cases: string[][] = [
      ["--password", "hunter2"],
      ["--password=hunter2"],
      ["--token", "abc"],
      ["--totp", "123456"],
      ["--email", "a@b.c"],
      ["--refresh-token", "r"],
    ];
    for (const extra of cases) {
      for (const argv of [
        ["export", "--out", join(dir, "o"), "--engine-version", "0.5.0", ...base, ...extra],
        ["import", "--from", join(dir, "x"), "--target-engine", "0.5.0", ...base, ...extra],
      ]) {
        const err = await cli(argv, { out: () => {}, err: () => {} }).catch(
          (e: { code?: string; message: string }) => e,
        );
        expect((err as { code?: string }).code, `${argv.join(" ")}`).toBe("credentials_argv");
        // el mensaje nunca repite el valor
        expect((err as Error).message).not.toContain("hunter2");
      }
    }
  });
  it("una opción desconocida que no es una credencial se rechaza como uso incorrecto", async () => {
    const err = await cli(["verify", dir, "--lo-que-sea", "1"], { out: () => {}, err: () => {} }).catch(
      (e: { code?: string }) => e,
    );
    expect((err as { code?: string }).code).toBe("usage");
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

// ====================================================================================================
// RONDA 2 (PR #300): tests que matan los mutantes supervivientes de la revisión (R1a, R1b, R5, R7, R9,
// R10, R12, R13) y cubren los hallazgos P1/P2 nuevos. Cliente SIMULADO: sin red ni BD.
// ====================================================================================================

interface FakeVersion {
  version: number;
  state: string;
  runtime?: string;
  loadoutRevision?: number;
  parentVersion?: number | null;
  codePublic?: boolean;
  bytes?: Buffer;
}
interface FakeBot {
  id: string;
  name: string;
  versions: FakeVersion[];
  loadouts?: { revision: number; name?: string }[];
}
interface FakeWorld {
  bots: FakeBot[];
  teams?: Record<string, unknown>[];
  failSourceOf?: string; // id de bot cuyo código «falla» al descargarse
  tamperHashOf?: string; // id de bot cuyo hash declarado no coincide
}

const ME = { id: "11111111-2222-4333-8444-555555555555", email: "operador@example.org" };

/** Cliente que imita la parte de la API que usa el export. */
function fakeApi(w: FakeWorld, token = "opaque-token-0123456789") {
  const byId = new Map(w.bots.map((b) => [b.id, b]));
  const bot = (id: string) => byId.get(id)!;
  const lo = (b: FakeBot) =>
    (b.loadouts ?? [{ revision: 1 }]).map((l) => ({
      revision: l.revision,
      ...(l.name ? { name: l.name } : {}),
      catalogVersion: "mvp@1",
      chassis: "chassis.medium@1",
      modules: [{ slot: "drive", moduleId: "movement.tracks@1" }],
    }));
  const bytesOf = (b: FakeBot, v: FakeVersion) => v.bytes ?? Buffer.from(`# ${b.id} v${v.version}\n`);
  const json = async (_m: string, path: string) => {
    if (path === "/users/me") return ME;
    let m: RegExpExecArray | null;
    if ((m = /^\/bots\/([^/]+)\/versions$/.exec(path)))
      return bot(m[1]).versions.map((v) => ({
        version: v.version,
        state: v.state,
        runtime: v.runtime ?? "python",
        loadoutRevision: v.loadoutRevision ?? 1,
        parentVersion: v.parentVersion ?? null,
        codePublic: v.codePublic ?? false,
      }));
    if ((m = /^\/bots\/([^/]+)\/loadouts$/.exec(path))) return lo(bot(m[1]));
    if ((m = /^\/bots\/([^/]+)\/versions\/(\d+)$/.exec(path))) {
      const b = bot(m[1]);
      const v = b.versions.find((x) => x.version === Number(m![2]))!;
      return { canReadSource: true, sourceSha256: w.tamperHashOf === b.id ? "0".repeat(64) : sha(bytesOf(b, v)) };
    }
    throw new Error(`fake: ruta no simulada ${path}`);
  };
  const request = async (_m: string, path: string) => {
    const m = /^\/bots\/([^/]+)\/versions\/(\d+)\/source$/.exec(path);
    if (!m) throw new Error(`fake: ruta no simulada ${path}`);
    if (w.failSourceOf === m[1]) throw new Error("fallo simulado de red a mitad del export");
    const b = bot(m[1]);
    const v = b.versions.find((x) => x.version === Number(m[2]))!;
    return { bytes: bytesOf(b, v), headers: new Headers({ "content-disposition": 'attachment; filename="main.py"' }) };
  };
  const listAll = async (path: string) => {
    if (path === "/bots")
      return w.bots.map((b, i) => ({
        id: b.id,
        name: b.name,
        ownerId: ME.id,
        visibility: "private",
        retiredAt: null,
        createdAt: `2026-01-01T00:00:0${i}.000Z`,
      }));
    if (path === "/teams") return w.teams ?? [];
    throw new Error(`fake: ruta no simulada ${path}`);
  };
  return { json, request, listAll, token, requests: 0, writes: 0 };
}

const bt = (id: string, name: string, versions: FakeVersion[], loadouts?: FakeBot["loadouts"]): FakeBot => ({
  id,
  name,
  versions,
  loadouts,
});

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? "SIN_CODIGO";
  }
  return "NO_FALLA";
};
const asyncCodeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? "SIN_CODIGO";
  }
  return "NO_FALLA";
};

describe("R10 · motor de origen obligatorio en runExport", () => {
  it("R10 · sin engineVersion el export falla con no_engine y no crea nada", async () => {
    const out = join(dir, "e");
    expect(await asyncCodeOf(runExport({ client: fakeApi({ bots: [] }), dest: out }))).toBe("no_engine");
    expect(existsSync(out)).toBe(false);
    expect(await asyncCodeOf(runExport({ client: fakeApi({ bots: [] }), dest: out, engineVersion: "" }))).toBe(
      "no_engine",
    );
  });
});

describe("R9 · marcador de export incompleto", () => {
  it("R9 · un export que falla a mitad deja .export-incomplete y NO se puede verificar ni importar", async () => {
    const out = join(dir, "e");
    const world: FakeWorld = {
      bots: [bt("b1", "Uno", [{ version: 1, state: "draft" }]), bt("b2", "Dos", [{ version: 1, state: "draft" }])],
      failSourceOf: "b2",
    };
    await expect(runExport({ client: fakeApi(world), dest: out, engineVersion: "0.4.0" })).rejects.toThrow(
      /fallo simulado/,
    );
    expect(existsSync(join(out, ".export-incomplete"))).toBe(true);
    expect(codeOf(() => verifyExport(out))).toBe("incomplete");
  });
  it("un hash declarado por la API que no coincide con el código descargado aborta el export", async () => {
    const world: FakeWorld = { bots: [bt("b1", "Uno", [{ version: 1, state: "draft" }])], tamperHashOf: "b1" };
    expect(await asyncCodeOf(runExport({ client: fakeApi(world), dest: join(dir, "e"), engineVersion: "0.4.0" }))).toBe(
      "source_hash_mismatch",
    );
  });
});

describe("R13 · el escáner recibe los valores sensibles conocidos", () => {
  it("R13 · el token de la sesión dentro del CÓDIGO de un bot (sin forma de JWT) aborta el export", async () => {
    const token = "opaque-token-0123456789";
    const world: FakeWorld = {
      bots: [bt("b1", "Uno", [{ version: 1, state: "draft", bytes: Buffer.from(`TOKEN = "${token}"\n`) }])],
    };
    expect(
      await asyncCodeOf(runExport({ client: fakeApi(world, token), dest: join(dir, "e"), engineVersion: "0.4.0" })),
    ).toBe("secret_in_export");
  });
  it("el correo o el id del operador dentro del código también aborta", async () => {
    let n = 0;
    for (const leak of [ME.email, ME.id]) {
      const world: FakeWorld = {
        bots: [bt("b1", "Uno", [{ version: 1, state: "draft", bytes: Buffer.from(`# ${leak}\n`) }])],
      };
      const c = await asyncCodeOf(
        runExport({ client: fakeApi(world), dest: join(dir, `e${n++}`), engineVersion: "0.4.0" }),
      );
      expect(c, leak).toBe("secret_in_export");
    }
  });
});

describe("R12 · versión con padre colgante", () => {
  it("R12 · una versión cuyo padre no está en el export falla la verificación (dangling_parent)", () => {
    writeSyntheticExport(dir);
    const f = join(dir, "bots/alfa/bot.json");
    writeFileSync(f, readFileSync(f, "utf8").replace('"parentVersion": null', '"parentVersion": 9'));
    rehash(dir);
    expect(codeOf(() => verifyExport(dir))).toBe("dangling_parent");
  });
});

describe("R1a / R1b · capas contra el traversal y los slugs abiertos (cada una por separado)", () => {
  it("R1a · una ruta con `..` o absoluta en checksums.sha256 se rechaza por unsafe_path (no sólo por «falta»)", () => {
    for (const bad of ["../fuera.txt", "/etc/passwd", "bots/../../x"]) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      writeSyntheticExport(dir);
      const f = join(dir, "checksums.sha256");
      writeFileSync(f, readFileSync(f, "utf8") + `${"a".repeat(64)}  ${bad}\n`);
      expect(
        codeOf(() => verifyExport(dir)),
        bad,
      ).toBe("unsafe_path");
    }
  });
  it("R1a · una ruta con `..` en manifest.files se rechaza por manifest_invalid", () => {
    writeSyntheticExport(dir);
    const f = join(dir, "manifest.json");
    const m = JSON.parse(readFileSync(f, "utf8"));
    m.files[0].path = "../x";
    writeFileSync(f, json(m));
    // el manifest alterado rompe también su checksum: se recalcula para aislar la capa de rutas
    const lines = readFileSync(join(dir, "checksums.sha256"), "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => (l.endsWith("  manifest.json") ? `${sha(readFileSync(f))}  manifest.json` : l));
    writeFileSync(join(dir, "checksums.sha256"), lines.join("\n") + "\n");
    expect(codeOf(() => verifyExport(dir))).toBe("manifest_invalid");
  });
  it("R1b · un slug fuera de [a-z0-9-] se rechaza aunque coincida con su carpeta (bot_invalid)", () => {
    writeSyntheticExport(dir);
    // Se renombra la carpeta y se reescriben TODAS las referencias para que sólo SLUG_RE pueda impedirlo.
    renameSync(join(dir, "bots/alfa"), join(dir, "bots/Alfa Raro"));
    for (const rel of ["bots/Alfa Raro/bot.json", "manifest.json", "checksums.sha256", "teams/rojo.json"]) {
      const p = join(dir, rel);
      writeFileSync(
        p,
        readFileSync(p, "utf8")
          .split("bots/alfa/")
          .join("bots/Alfa Raro/")
          .replace('"slug": "alfa"', '"slug": "Alfa Raro"')
          .replace('"alfa",', '"Alfa Raro",'),
      );
    }
    rehash(dir);
    expect(codeOf(() => verifyExport(dir))).toBe("bot_invalid");
  });
});

describe("R7 · el hash del código se comprueba en el DESTINO tras subirlo", () => {
  /** Destino simulado: `hashOf(slug)` es el sha256 que «guarda» el destino para ese bot. */
  const target = (hashOf: (slug: string) => string) => {
    let n = 0;
    const slugOf = new Map<string, string>();
    return {
      requests: 0,
      writes: 0,
      json: async (m: string, p: string, o?: { json?: { name?: string } }) => {
        if (p === "/users/me") return { id: "u1" };
        if (m === "POST" && p === "/bots") {
          const id = `bot-${++n}`;
          slugOf.set(id, String(o!.json!.name).toLowerCase());
          return { id, visibility: "private" };
        }
        if (m === "POST" && /\/loadouts$/.test(p)) return { revision: 1 };
        if (m === "POST" && /\/versions$/.test(p)) return { version: 1, state: "draft" };
        const g = /^\/bots\/([^/]+)\/versions\/1$/.exec(p);
        if (m === "GET" && g) return { sourceSha256: hashOf(slugOf.get(g[1])!) };
        return { id: "t1", bots: [] };
      },
      request: async () => ({}),
      listAll: async () => [],
    };
  };
  it("R7 · si el destino guarda un código con otro hash, la versión falla y se informa", async () => {
    writeSyntheticExport(dir);
    const r = await runImport({ client: target(() => "f".repeat(64)), src: dir, targetEngine: "0.5.0" });
    const rows = r.bots.flatMap((b: { versions: { action: string }[] }) => b.versions);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x: { action: string }) => x.action === "failed")).toBe(true);
    expect(r.errors.map((e: { message: string }) => e.message).join("\n")).toMatch(/no coincide con el exportado/);
  });
  it("con el hash correcto en destino la misma importación sale limpia (control positivo)", async () => {
    writeSyntheticExport(dir);
    const hash = (slug: string) => sha(readFileSync(join(dir, `bots/${slug}/versions/v1/source.bin`)));
    const r = await runImport({ client: target(hash), src: dir, targetEngine: "0.5.0" });
    expect(r.errors).toEqual([]);
  });
});

describe("P1-3 · política de versiones por defecto = all en runExport", () => {
  it("sin versionsPolicy el export lleva TODAS las versiones (también las congeladas antiguas)", async () => {
    const world: FakeWorld = {
      bots: [
        bt("b1", "Uno", [
          { version: 1, state: "frozen" },
          { version: 2, state: "frozen" },
          { version: 3, state: "published" },
        ]),
      ],
    };
    const { manifest } = await runExport({ client: fakeApi(world), dest: join(dir, "e"), engineVersion: "0.4.0" });
    expect(manifest.versionsPolicy).toBe("all");
    expect(manifest.counts.versions).toBe(3);
    expect(manifest.counts.omittedVersions).toBe(0);
    const heads = await runExport({
      client: fakeApi(world),
      dest: join(dir, "h"),
      engineVersion: "0.4.0",
      versionsPolicy: "heads",
    });
    expect(heads.manifest.counts.versions).toBe(1);
    expect(heads.manifest.omittedVersions).toHaveLength(2);
  });
});

describe("P2-4 · pérdidas parcialmente silenciosas declaradas en el manifest", () => {
  it("las revisiones de loadout descartadas se LISTAN (bot y revisión), con aviso y recuento", async () => {
    const world: FakeWorld = {
      bots: [
        bt(
          "b1",
          "Uno",
          [{ version: 1, state: "draft", loadoutRevision: 1 }],
          [{ revision: 1 }, { revision: 2, name: "intermedio" }, { revision: 3 }],
        ),
      ],
    };
    const { manifest } = await runExport({ client: fakeApi(world), dest: join(dir, "e"), engineVersion: "0.4.0" });
    // la 1 la usa la versión; la 3 es la última; la 2 se descarta
    expect(manifest.omittedLoadouts).toEqual([{ bot: "uno", revision: 2, name: "intermedio" }]);
    expect(manifest.counts.omittedLoadouts).toBe(1);
    expect(manifest.warnings.join("\n")).toMatch(/omittedLoadouts/);
    expect(verifyExport(join(dir, "e")).manifest.omittedLoadouts).toHaveLength(1);
  });
  it("los bots propios que estaban en equipos donde NO es capitán se listan por slug, sin datos ajenos", async () => {
    const world: FakeWorld = {
      bots: [bt("b1", "Uno", [{ version: 1, state: "draft" }]), bt("b2", "Dos", [{ version: 1, state: "draft" }])],
      teams: [
        {
          id: "t-ajeno",
          name: "Equipo SECRETO del otro",
          isMember: true,
          isCaptain: false,
          members: [{ userId: "otro-usuario-id", role: "captain" }],
          bots: [
            { id: "b1", name: "Uno" },
            { id: "bot-de-otro", name: "Bot privado de otro" },
          ],
        },
        { id: "t-ajeno2", name: "Otro equipo", isMember: true, isCaptain: false, bots: [{ id: "b1", name: "Uno" }] },
      ],
    };
    const { manifest } = await runExport({ client: fakeApi(world), dest: join(dir, "e"), engineVersion: "0.4.0" });
    expect(manifest.botsInForeignTeams).toEqual([{ bot: "uno", teams: 2 }]);
    const text = readFileSync(join(dir, "e", "manifest.json"), "utf8");
    // ni el nombre del equipo ajeno, ni el del bot ajeno, ni ids ajenos
    for (const leak of ["SECRETO", "Bot privado de otro", "otro-usuario-id", "bot-de-otro", "Otro equipo"])
      expect(text, leak).not.toContain(leak);
  });
});

describe("R3-3 · el export no lleva NINGÚN dato de bots de otros usuarios", () => {
  it("R3-3 · un bot ajeno en un equipo propio deja sólo un recuento: ni nombre ni id en ningún fichero", async () => {
    const world: FakeWorld = {
      bots: [bt("b1", "Uno", [{ version: 1, state: "draft" }])],
      teams: [
        {
          id: "t1",
          name: "Mi equipo",
          isMember: true,
          isCaptain: true,
          members: [],
          bots: [
            { id: "b1", name: "Uno" },
            { id: "bot-ajeno-1", name: "Nombre AJENO Alfa" },
            { id: "bot-ajeno-2", name: "Nombre AJENO Beta" },
          ],
        },
      ],
    };
    const out = join(dir, "e");
    await runExport({ client: fakeApi(world), dest: out, engineVersion: "0.4.0" });
    const team = JSON.parse(readFileSync(join(out, "teams", "mi-equipo.json"), "utf8"));
    expect(team.externalBotsCount).toBe(2);
    expect(team.externalBots).toBeUndefined();
    expect(team.bots).toEqual(["uno"]);
    for (const f of ["teams/mi-equipo.json", "manifest.json"]) {
      const text = readFileSync(join(out, f), "utf8");
      for (const leak of ["AJENO", "bot-ajeno"]) expect(text, `${f}: ${leak}`).not.toContain(leak);
    }
    expect(verifyExport(out).teams).toHaveLength(1);
  });
});

describe("P2-5 · el escáner no aborta porque el NOMBRE de un bot parezca un correo o un UUID", () => {
  const uuidName = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  it("scanBuffer: un `name` con forma de correo/UUID es válido; en cualquier otro campo sigue siendo un hallazgo", () => {
    const ok = JSON.stringify({
      name: "juan@club.example",
      loadouts: [{ name: uuidName }],
      externalBots: [{ name: "x@y.es" }],
    });
    expect(scanBuffer(Buffer.from(ok), "meta", "bot.json")).toEqual([]);
    expect(
      scanBuffer(Buffer.from(JSON.stringify({ name: "ok", nota: "juan@club.example" })), "meta", "b.json"),
    ).toHaveLength(1);
    expect(scanBuffer(Buffer.from(JSON.stringify({ name: "ok", id: uuidName })), "meta", "b.json")).toHaveLength(1);
  });
  it("una credencial DE ALTA CONFIANZA dentro de un nombre sigue abortando (la lista blanca no es un agujero)", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk";
    expect(scanBuffer(Buffer.from(JSON.stringify({ name: jwt })), "meta", "b.json").length).toBeGreaterThan(0);
    expect(
      scanBuffer(Buffer.from(JSON.stringify({ name: "Bearer abcdefghijklmnop12345" })), "meta", "b.json").length,
    ).toBeGreaterThan(0);
  });
  it("un valor sensible conocido en un nombre también aborta", () => {
    expect(scanBuffer(Buffer.from(JSON.stringify({ name: ME.email })), "meta", "b.json", [ME.email])).toHaveLength(1);
  });
  it("export con bots y equipo llamados como un correo y como un UUID: no aborta y los nombres viajan intactos", async () => {
    const world: FakeWorld = {
      bots: [
        bt("b1", "juan@club.example", [{ version: 1, state: "draft" }]),
        bt("b2", uuidName, [{ version: 1, state: "draft" }]),
      ],
      teams: [
        {
          id: "t1",
          name: "equipo@x.example",
          isCaptain: true,
          isMember: true,
          members: [{ userId: ME.id, role: "captain" }],
          bots: [{ id: "b1", name: "juan@club.example" }],
        },
        // aviso del manifest que CITA el nombre de un equipo con forma de correo
        {
          id: "t2",
          name: "otro@x.example",
          isCaptain: true,
          isMember: true,
          members: [
            { userId: ME.id, role: "captain" },
            { userId: "z", role: "member" },
          ],
          bots: [],
        },
      ],
    };
    const out = join(dir, "e");
    const { manifest } = await runExport({ client: fakeApi(world), dest: out, engineVersion: "0.4.0" });
    expect(manifest.counts.bots).toBe(2);
    expect(manifest.warnings.join("\n")).toContain("otro@x.example");
    const v = verifyExport(out);
    expect(v.bots.map((b: { name: string }) => b.name).sort()).toEqual([uuidName, "juan@club.example"].sort());
    expect(v.teams.map((t: { name: string }) => t.name).sort()).toEqual(["equipo@x.example", "otro@x.example"]);
  });
});

describe("P2-5b · el manifest también se escanea y los slugs no imitan UUID", () => {
  it("slugify nunca produce un tramo con forma de UUID (ni solo ni dentro de un nombre más largo)", () => {
    const u = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    for (const n of [u, `Equipo ${u} B`, u.toUpperCase()]) {
      const s = slugify(n);
      expect(s).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(scanBuffer(Buffer.from(JSON.stringify({ slug: s })), "meta", "x.json")).toEqual([]);
    }
    expect(slugify(u)).toBe("3f2504e04f8941d39a0c0305e82c3301");
  });
  it("un secreto que sólo llega al MANIFEST (p. ej. un --source-sha mal puesto) aborta el export", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk";
    const world: FakeWorld = { bots: [bt("b1", "Uno", [{ version: 1, state: "draft" }])] };
    expect(
      await asyncCodeOf(
        runExport({ client: fakeApi(world), dest: join(dir, "e"), engineVersion: "0.4.0", sourceSha: jwt }),
      ),
    ).toBe("secret_in_export");
  });
});

describe("P2-3 · topes de tamaño en verifyExport (por fichero y total, configurables)", () => {
  it("un fichero por encima del tope por fichero se rechaza ANTES de leerse (file_too_large)", () => {
    writeSyntheticExport(dir);
    writeFileSync(join(dir, "bots/alfa/versions/v1/source.bin"), Buffer.alloc(2048, 1));
    // el tope se mira antes que el checksum: aunque el hash ya no cuadre, el error es el de tamaño
    expect(codeOf(() => verifyExport(dir, { maxFileBytes: 1024 }))).toBe("file_too_large");
    expect(codeOf(() => verifyExport(dir))).toBe("checksum_mismatch"); // con el tope por defecto, falla por hash
  });
  it("la suma de todos los ficheros por encima del tope total se rechaza (export_too_large)", () => {
    writeSyntheticExport(dir);
    expect(codeOf(() => verifyExport(dir, { maxTotalBytes: 100 }))).toBe("export_too_large");
  });
  it("manifest.json tiene su propio tope (mayor que el de un fichero normal)", () => {
    writeSyntheticExport(dir);
    expect(codeOf(() => verifyExport(dir, { maxManifestBytes: 50 }))).toBe("file_too_large");
    // un tope por fichero minúsculo con manifest holgado: el que falla es otro fichero, no el manifest
    let msg = "";
    try {
      verifyExport(dir, { maxFileBytes: 10, maxManifestBytes: 10_000_000 });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/tope por fichero/);
    expect(msg).not.toMatch(/^manifest\.json/);
  });
  it("los valores por defecto son razonables (10 MiB por fichero como la API) y un export normal los cumple", () => {
    expect(DEFAULT_LIMITS.maxFileBytes).toBe(10 * 1024 * 1024);
    expect(DEFAULT_LIMITS.maxManifestBytes).toBeGreaterThan(DEFAULT_LIMITS.maxFileBytes);
    expect(DEFAULT_LIMITS.maxTotalBytes).toBeGreaterThanOrEqual(1024 * 1024 * 1024);
    writeSyntheticExport(dir);
    expect(() => verifyExport(dir)).not.toThrow();
  });
  it("el tope es configurable desde el CLI (--max-file-mb / --max-total-mb)", async () => {
    writeSyntheticExport(dir);
    const io = { out: () => {}, err: () => {} };
    expect(await cli(["verify", dir, "--max-file-mb", "1", "--max-total-mb", "10"], io)).toBe(0);
    expect(await asyncCodeOf(cli(["verify", dir, "--max-total-mb", "0.0001"], io))).toBe("export_too_large");
    expect(await asyncCodeOf(cli(["verify", dir, "--max-file-mb", "-3"], io))).toBe("usage");
  });
  it("el import también aplica los topes ANTES de cualquier petición", async () => {
    writeSyntheticExport(dir);
    const { client, calls } = spyClient();
    expect(
      await asyncCodeOf(runImport({ client, src: dir, targetEngine: "0.5.0", limits: { maxTotalBytes: 100 } })),
    ).toBe("export_too_large");
    expect(calls).toEqual([]);
  });
});

describe("P1-1 · el motor de origen se lee de la API y se valida", () => {
  const apiWith = (items: unknown[], audits: Record<string, unknown>) => ({
    json: async (_m: string, p: string) => {
      if (p.startsWith("/battles?")) {
        // como la API real: honra ?status= (los items sin `status` se consideran siempre visibles)
        const st = new URLSearchParams(p.split("?")[1]).get("status");
        return {
          items: items.filter(
            (i) => !st || (i as { status?: string }).status === undefined || (i as { status?: string }).status === st,
          ),
        };
      }
      const m = /^\/battles\/([^/]+)\/audit$/.exec(p);
      if (m && audits[m[1]] !== undefined) return audits[m[1]];
      throw new Error("404");
    },
  });
  it("detectEngineVersion lee versions.engine de la auditoría de la batalla terminada MÁS RECIENTE", async () => {
    const c = apiWith(
      [
        { id: "viejo", createdAt: "2026-10-01T00:00:00Z" },
        { id: "nuevo", createdAt: "2026-11-10T00:00:00Z" },
      ],
      { viejo: { versions: { engine: "0.3.0" } }, nuevo: { versions: { engine: "0.4.0" } } },
    );
    expect(await detectEngineVersion(c)).toEqual({ version: "0.4.0", battleId: "nuevo" });
  });
  it("Q1 · una batalla MÁS RECIENTE sin terminar no puede decidir el motor (sólo cuentan las terminadas)", async () => {
    const c = apiWith(
      [
        { id: "terminada", status: "finished", createdAt: "2026-11-01T00:00:00Z" },
        { id: "en-curso", status: "running", createdAt: "2026-11-17T00:00:00Z" },
      ],
      { terminada: { versions: { engine: "0.4.0" } }, "en-curso": { versions: { engine: "0.5.0" } } },
    );
    expect(await detectEngineVersion(c)).toEqual({ version: "0.4.0", battleId: "terminada" });
  });
  it("salta batallas sin motor legible y devuelve null si no hay ninguna", async () => {
    const c = apiWith(
      [
        { id: "a", createdAt: "2026-11-10T00:00:00Z" },
        { id: "b", createdAt: "2026-11-09T00:00:00Z" },
      ],
      { a: { versions: {} }, b: { versions: { engine: "0.4.0" } } },
    );
    expect((await detectEngineVersion(c))?.version).toBe("0.4.0");
    expect(await detectEngineVersion(apiWith([], {}))).toBeNull();
    const basura = apiWith([{ id: "x", createdAt: "2026-11-10T00:00:00Z" }], { x: { versions: { engine: "basura" } } });
    expect(await detectEngineVersion(basura)).toBeNull();
  });
  it("resolveEngineVersion: sin flag usa lo detectado; con flag lo VALIDA; discrepancia = engine_mismatch; sin nada = error", () => {
    const det = { version: "0.4.0", battleId: "b" };
    expect(resolveEngineVersion(undefined, det)).toEqual({ engineVersion: "0.4.0", engineVersionSource: "audit" });
    expect(resolveEngineVersion("0.4.0", det)).toEqual({ engineVersion: "0.4.0", engineVersionSource: "flag+audit" });
    expect(resolveEngineVersion("0.5.0", null)).toEqual({ engineVersion: "0.5.0", engineVersionSource: "flag" });
    expect(codeOf(() => resolveEngineVersion("0.5.0", det))).toBe("engine_mismatch");
    expect(() => resolveEngineVersion(undefined, null)).toThrow(/Falta --engine-version/);
  });
  it("R3-2 · --accept-engine: fuerza la discrepancia sólo repitiendo el valor exacto y con motivo, y queda auditado", () => {
    const det = { version: "0.4.0", battleId: "b9" };
    const motivo = "despliegue nuevo sin batallas posteriores";
    // sin --accept-engine sigue siendo error
    expect(codeOf(() => resolveEngineVersion("0.5.0", det, {}))).toBe("engine_mismatch");
    // valor distinto al de --engine-version
    expect(codeOf(() => resolveEngineVersion("0.5.0", det, { version: "0.5.1", reason: motivo }))).toBe(
      "engine_accept_mismatch",
    );
    // sin motivo (o trivial)
    expect(codeOf(() => resolveEngineVersion("0.5.0", det, { version: "0.5.0" }))).toBe("engine_accept_reason");
    expect(codeOf(() => resolveEngineVersion("0.5.0", det, { version: "0.5.0", reason: "ok" }))).toBe(
      "engine_accept_reason",
    );
    const r = resolveEngineVersion("0.5.0", det, { version: "0.5.0", reason: motivo });
    expect(r).toEqual({
      engineVersion: "0.5.0",
      engineVersionSource: "flag-forced",
      engineOverride: { accepted: "0.5.0", detected: "0.4.0", detectedBattleId: "b9", reason: motivo },
    });
  });
  it("R3-2 · el manifest y los avisos del export dejan constancia del motor forzado", async () => {
    const world: FakeWorld = { bots: [bt("b1", "Uno", [{ version: 1, state: "draft" }])] };
    const out = join(dir, "forzado");
    const ov = {
      accepted: "0.5.0",
      detected: "0.4.0",
      detectedBattleId: "b9",
      reason: "despliegue nuevo sin batallas",
    };
    await runExport({
      client: fakeApi(world),
      dest: out,
      engineVersion: "0.5.0",
      engineVersionSource: "flag-forced",
      engineOverride: ov,
    });
    const m = verifyExport(out).manifest;
    expect(m.engineOverride).toEqual(ov);
    expect(m.engineVersionSource).toBe("flag-forced");
    expect(m.warnings.join("\n")).toMatch(/FORZADO/);
    const normal = await runExport({ client: fakeApi(world), dest: join(dir, "normal"), engineVersion: "0.4.0" });
    expect(normal.manifest.engineOverride).toBeUndefined();
  });
});

describe("P2-3b · autenticación de larga duración (token de 15 min, 2FA)", () => {
  const scripted = (steps: Record<string, { status: number; body?: unknown }[]>) => {
    const seen: { url: string; auth?: string; body?: string }[] = [];
    const idx: Record<string, number> = {};
    const fetchImpl = async (url: string, init: { headers: Record<string, string>; body?: string }) => {
      const path = url.replace("http://x", "");
      seen.push({ url: path, auth: init.headers.Authorization, body: init.body });
      const list = steps[path] ?? [{ status: 200, body: { ok: 1 } }];
      const r = list[Math.min(idx[path] ?? 0, list.length - 1)];
      idx[path] = (idx[path] ?? 0) + 1;
      return new Response(JSON.stringify(r.body ?? {}), {
        status: r.status,
        headers: { "content-type": "application/json" },
      });
    };
    return { seen, fetchImpl: fetchImpl as unknown as typeof fetch };
  };

  it("cuenta con 2FA: login con TOTP una vez; al caducar el token se renueva con el REFRESH (sin reutilizar el TOTP)", async () => {
    const { seen, fetchImpl } = scripted({
      "/auth/login": [{ status: 200, body: { accessToken: "A1", refreshToken: "R1" } }],
      "/auth/refresh": [
        { status: 200, body: { accessToken: "A2", refreshToken: "R2" } },
        { status: 200, body: { accessToken: "A3", refreshToken: "R3" } },
      ],
      "/bots": [
        { status: 200, body: { n: 1 } },
        { status: 401 },
        { status: 200, body: { n: 2 } },
        { status: 401 },
        { status: 200, body: { n: 3 } },
      ],
    });
    const c = new ApiClient({
      baseUrl: "http://x",
      auth: { email: "a@b.c", password: "pw", totp: "123456" },
      fetchImpl,
      sleep: async () => {},
    });
    await c.json("GET", "/bots");
    await c.json("GET", "/bots"); // 401 -> refresh -> reintento
    await c.json("GET", "/bots"); // 401 -> refresh con el token ROTADO
    const logins = seen.filter((s) => s.url === "/auth/login");
    expect(logins).toHaveLength(1); // el TOTP se usó UNA vez
    expect(JSON.parse(logins[0].body!).totp).toBe("123456");
    const refreshes = seen.filter((s) => s.url === "/auth/refresh").map((s) => JSON.parse(s.body!).refreshToken);
    expect(refreshes).toEqual(["R1", "R2"]); // rotación: cada refresh usa el último emitido
    expect(c.reauths).toBe(2);
    expect(seen[seen.length - 1].auth).toBe("Bearer A3");
  });

  it("Q3 · si el refresh FALLA, el refresh token guardado se anula y no se reenvía (reuso ⇒ familia revocada)", async () => {
    const { seen, fetchImpl } = scripted({
      "/auth/login": [{ status: 200, body: { accessToken: "A1", refreshToken: "R1" } }],
      "/auth/refresh": [{ status: 401 }],
      "/bots": [{ status: 401 }],
    });
    const c = new ApiClient({
      baseUrl: "http://x",
      auth: { email: "a@b.c", password: "pw", totp: "123456" },
      fetchImpl,
      sleep: async () => {},
    });
    await expect(c.json("GET", "/bots")).rejects.toMatchObject({ code: "auth_failed" });
    await expect(c.json("GET", "/bots")).rejects.toMatchObject({ code: "auth_failed" });
    const refreshes = seen.filter((s) => s.url === "/auth/refresh");
    expect(refreshes).toHaveLength(1); // el segundo intento NO reenvía el R1 ya rechazado
  });

  it("sin 2FA y sin refresh válido: reautentica con usuario/contraseña SIN enviar TOTP", async () => {
    const { seen, fetchImpl } = scripted({
      "/auth/login": [
        { status: 200, body: { accessToken: "A1" } },
        { status: 200, body: { accessToken: "A2" } },
      ],
      "/bots": [{ status: 401 }, { status: 200, body: {} }],
    });
    const c = new ApiClient({
      baseUrl: "http://x",
      auth: { email: "a@b.c", password: "pw" },
      fetchImpl,
      sleep: async () => {},
    });
    await c.json("GET", "/bots");
    expect(seen.filter((s) => s.url === "/auth/login")).toHaveLength(2);
  });

  it("con TOTP y refresh rechazado: NO reintenta el login con un código consumido y explica cómo reanudar", async () => {
    const { seen, fetchImpl } = scripted({
      "/auth/login": [{ status: 200, body: { accessToken: "A1", refreshToken: "R1" } }],
      "/auth/refresh": [{ status: 401 }],
      "/bots": [{ status: 401 }],
    });
    const c = new ApiClient({
      baseUrl: "http://x",
      auth: { email: "a@b.c", password: "pw", totp: "123456" },
      fetchImpl,
      sleep: async () => {},
    });
    const err = await c.json("GET", "/bots").catch((e: Error) => e);
    expect((err as Error).message).toMatch(/TOTP.*consumido/);
    expect(seen.filter((s) => s.url === "/auth/login")).toHaveLength(1);
  });

  it("un token suelto (--token-file) no se puede renovar: el error lo dice y recomienda las credenciales", async () => {
    const { fetchImpl } = scripted({ "/bots": [{ status: 401 }] });
    const c = new ApiClient({
      baseUrl: "http://x",
      auth: { token: "TOKEN-SECRETO" },
      fetchImpl,
      sleep: async () => {},
    });
    const err = await c.json("GET", "/bots").catch((e: { code?: string; message: string }) => e);
    expect((err as { code?: string }).code).toBe("auth_failed");
    expect((err as Error).message).toMatch(/15 min/);
    expect((err as Error).message).not.toContain("TOKEN-SECRETO");
  });
});

describe("R4 · salida del CLI con el motor forzado y guarda de anfitrión del E2E", () => {
  /** API mínima y real (HTTP en 127.0.0.1): sin bots ni equipos; la última batalla dice que el motor es 0.4.0. */
  async function conApi<T>(fn: (url: string) => Promise<T>): Promise<T> {
    const srv = createServer((req, res) => {
      const path = (req.url ?? "").split("?")[0];
      const send = (b: unknown) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(b));
      };
      if (path === "/users/me") return send(ME);
      if (path === "/battles") return send({ items: [{ id: "b9", createdAt: "2026-11-01T00:00:00Z" }] });
      if (path === "/battles/b9/audit") return send({ versions: { engine: "0.4.0" } });
      if (path === "/system/status") return send({ commit: "abc1234" });
      if (path === "/bots" || path === "/teams") return send({ items: [] });
      res.statusCode = 404;
      send({ error: "no" });
    });
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
    try {
      return await fn(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`);
    } finally {
      await new Promise((ok) => srv.close(ok));
    }
  }
  const tokenFile = () => {
    const p = join(dir, "token");
    writeFileSync(p, "opaque-token-0123456789\n", { mode: 0o600 });
    return p;
  };
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
  };

  it("R4-3 · el CLI export con --accept-engine anuncia el motor FORZADO, lo que reporta la API y el motivo", async () => {
    await conApi(async (url) => {
      const c = capture();
      const rc = await cli(
        [
          "export",
          "--out",
          join(dir, "forzado"),
          "--api-url",
          url,
          "--token-file",
          tokenFile(),
          "--engine-version",
          "0.5.0",
          "--accept-engine",
          "0.5.0",
          "--accept-engine-reason",
          "despliegue nuevo sin batallas",
        ],
        c.io,
      );
      expect(rc).toBe(0);
      const aviso = c.err.find((l) => l.startsWith("· AVISO: motor de origen FORZADO"));
      expect(aviso).toBeDefined();
      expect(aviso).toContain("0.5.0");
      expect(aviso).toContain("0.4.0");
      expect(aviso).toContain("despliegue nuevo sin batallas");
      expect(c.out.join("\n")).toMatch(
        /motor de origen 0\.5\.0 \(flag-forced; forzado, API reporta 0\.4\.0; motivo: despliegue nuevo sin batallas\)/,
      );
    });
  });
  it("R4-3 · sin forzar, el CLI no anuncia ningún motor forzado", async () => {
    await conApi(async (url) => {
      const c = capture();
      const rc = await cli(
        ["export", "--out", join(dir, "normal"), "--api-url", url, "--token-file", tokenFile()],
        c.io,
      );
      expect(rc).toBe(0);
      expect(c.err.join("\n")).not.toMatch(/FORZADO/);
      expect(c.out.join("\n")).not.toMatch(/forzado/);
    });
  });

  // Guarda del E2E: se ejecuta de verdad (bash) con un `docker` FALSO en el PATH (sin variables de prueba que
  // sustituyan a docker ps), con los nombres y etiquetas REALES de producción (proyecto compose `infrastructure`).
  const REPO = join(__dirname, "../../..");
  const PROD_SERVICES = (() => {
    const t = readFileSync(join(REPO, "infrastructure/docker-compose.yml"), "utf8");
    const body = t.slice(t.indexOf("\nservices:") + 1).split(/\n(?=[a-z])/)[0];
    return [...body.matchAll(/^ {2}([a-z0-9-]+):\s*$/gm)].map((m) => m[1]);
  })();
  /** Línea tal como la emite `docker ps -a --format '{{json .Names}}<tab>{{json .State}}<tab>{{json (.Label …)}}…'`:
   *  cada campo como cadena JSON, separados por un tabulador real. */
  const row = (name: string, state: string, own: string, proj: string) =>
    [name, state, own, proj].map((v) => JSON.stringify(v)).join("\t");
  const prod = (svc: string, state = "running") => row(`infrastructure-${svc}-1`, state, "", "infrastructure");
  const propio = (n: string) => row(`s9portable-${n}`, "running", "1", "");
  const guard = (env: Record<string, string>, docker: { ps?: string[]; rc?: number; sinDocker?: boolean } = {}) => {
    const bin = mkdtempSync(join(tmpdir(), "fake-docker-"));
    try {
      writeFileSync(join(bin, "ps.txt"), (docker.ps ?? []).join("\n") + "\n");
      writeFileSync(
        join(bin, "docker"),
        `#!/bin/sh\n[ "$1" = ps ] || exit 2\n[ "$2" = -a ] || { echo "docker falso: ps sin -a (no ve contenedores parados)" >&2; exit 3; }\n[ "$3" = --format ] || exit 4\ncat "${join(bin, "ps.txt")}"\nexit ${docker.rc ?? 0}\n`,
      );
      chmodSync(join(bin, "docker"), 0o755);
      return spawnSync("/bin/bash", ["-c", "source scripts/portable/e2e/guard.sh && s9_portable_guard"], {
        cwd: REPO,
        env: { PATH: docker.sinDocker ? "/nonexistent-s9" : `${bin}:/usr/bin:/bin`, ...env },
        encoding: "utf8",
      });
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  };
  const LAB = { S9_PORTABLE_E2E_LAB: "1" };
  it("R5-0 · la lista de servicios de producción se lee del compose real (no está vacía)", () => {
    expect(PROD_SERVICES).toEqual(
      expect.arrayContaining(["api", "postgres", "gateway", "tournament-worker", "streamer"]),
    );
    expect(PROD_SERVICES.length).toBeGreaterThanOrEqual(20);
  });
  it("R4-2 · sin consentimiento explícito el E2E NO corre (protege por defecto)", () => {
    const r = guard({}, { ps: [] });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/S9_PORTABLE_E2E_LAB=1/);
  });
  it("R5-1 · con consentimiento y SIN contenedores, corre", () => {
    expect(guard(LAB, { ps: [] }).status).toBe(0);
  });
  it("R5-1 · los contenedores del propio ensayo (etiqueta s9portable.e2e=1) no cuentan como ajenos", () => {
    const r = guard(LAB, { ps: [propio("src-9"), propio("dst-9"), propio("api")] });
    expect(r.status).toBe(0);
  });
  for (const svc of PROD_SERVICES) {
    it(`R5-2 · producción real «infrastructure-${svc}-1» en marcha ⇒ se niega`, () => {
      const r = guard(LAB, { ps: [prod(svc)] });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`infrastructure-${svc}-1`);
    });
  }
  it("R5-2 · producción completa en marcha junto al ensayo ⇒ se niega", () => {
    const r = guard(LAB, { ps: [...PROD_SERVICES.map((s) => prod(s)), propio("src-1")] });
    expect(r.status).toBe(1);
  });
  it("R5-2 · producción PARADA pero con la etiqueta de compose ⇒ se niega (defensa adicional)", () => {
    const r = guard(LAB, { ps: [prod("api", "exited"), prod("postgres", "exited")] });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/proyecto compose/);
  });
  it("R5-2 · un proyecto compose cualquiera (no sólo `infrastructure`) también se niega", () => {
    const r = guard(LAB, { ps: [row("otro-web-1", "running", "", "otro")] });
    expect(r.status).toBe(1);
  });
  it("R5-3 · un contenedor ajeno cualquiera (foo) en marcha ⇒ se niega", () => {
    const r = guard(LAB, { ps: [row("foo", "running", "", "")] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("foo");
  });
  it("R5-3 · ajeno junto a uno del ensayo ⇒ se niega igualmente", () => {
    expect(guard(LAB, { ps: [propio("src-1"), row("foo", "running", "", "")] }).status).toBe(1);
  });
  it("R5-3 · el NOMBRE s9portable- sin la etiqueta no basta (no se puede suplantar por nombre)", () => {
    const r = guard(LAB, { ps: [row("s9portable-api", "running", "", "")] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("s9portable-api");
  });
  it("R5-3 · un contenedor ajeno PARADO y sin compose no bloquea (sólo importan los vivos)", () => {
    expect(guard(LAB, { ps: [row("foo", "exited", "", "")] }).status).toBe(0);
  });
  it("R6-1 · ESPOOFING: la etiqueta `s9portable.e2e=1|` (barra) NO se toma por propia ⇒ se niega", () => {
    const r = guard(LAB, { ps: [row("ajeno-spoof", "running", "1|", "")] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ajeno-spoof");
  });
  it("R6-1 · ESPOOFING: etiquetas con tabulador, comillas, barras o espacios tras el 1 tampoco son propias", () => {
    for (const own of ["1\t", "1\tx", '1"', "1\\", "1|x|y", "1 ", " 1", "1\n"]) {
      const r = guard(LAB, { ps: [row("ajeno-spoof", "running", own, "")] });
      expect(r.status, JSON.stringify(own)).toBe(1);
    }
  });
  it("R6-1 · un nombre con `|` o tabulador no desplaza campos ni oculta el contenedor", () => {
    const r = guard(LAB, { ps: [row("x|running|1|", "running", "", ""), row("y\trunning\t1", "running", "", "")] });
    expect(r.status).toBe(1);
  });
  it("R6-1 · salida de «docker ps» con formato inesperado ⇒ FALLA CERRADO", () => {
    expect(guard(LAB, { ps: ["foo|running|1|"] }).status).toBe(1);
    expect(guard(LAB, { ps: [propio("a") + "\textra"] }).status).toBe(1);
  });
  it("R6-2 · el docker falso EXIGE `ps -a`: sin -a falla (la guarda invoca docker ps -a)", () => {
    const bin = mkdtempSync(join(tmpdir(), "fake-docker-"));
    try {
      writeFileSync(join(bin, "docker"), '#!/bin/sh\n[ "$2" = -a ] || exit 3\nexit 0\n');
      chmodSync(join(bin, "docker"), 0o755);
      const r = spawnSync("/bin/bash", ["-c", "source scripts/portable/e2e/guard.sh && s9_portable_guard"], {
        cwd: REPO,
        env: { PATH: `${bin}:/usr/bin:/bin`, ...LAB },
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
  for (const v of ["true", "0", "", "yes", "2"]) {
    it(`R6-3 · la etiqueta s9portable.e2e con valor ${JSON.stringify(v)} (≠ 1) es AJENA ⇒ se niega`, () => {
      const r = guard(LAB, { ps: [row("etiqueta-rara", "running", v, "")] });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("etiqueta-rara");
    });
  }
  it("R6-4 · ALLOW_PRODUCT_CONTAINERS definida pero VACÍA no anula la guarda", () => {
    const r = guard({ ...LAB, S9_PORTABLE_E2E_ALLOW_PRODUCT_CONTAINERS: "" }, { ps: [prod("api")] });
    expect(r.status).toBe(1);
    expect(r.stderr).not.toMatch(/AVISO PELIGROSO/);
  });
  it("R6-4 · ALLOW_PRODUCT_CONTAINERS con otro valor (0, true, yes) tampoco anula la guarda", () => {
    for (const v of ["0", "true", "yes"]) {
      const r = guard({ ...LAB, S9_PORTABLE_E2E_ALLOW_PRODUCT_CONTAINERS: v }, { ps: [prod("api")] });
      expect(r.status, v).toBe(1);
    }
  });
  it("R5-4 · si «docker ps» falla, FALLA CERRADO", () => {
    const r = guard(LAB, { ps: [], rc: 1 });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/docker ps.*falló/);
  });
  it("R5-4 · si docker no está en el PATH, FALLA CERRADO", () => {
    const r = guard(LAB, { sinDocker: true });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no hay docker/);
  });
  it("R5-5 · S9_PORTABLE_GUARD_CONTAINERS ya no existe: definida (y vacía) no oculta la producción", () => {
    const r = guard({ ...LAB, S9_PORTABLE_GUARD_CONTAINERS: "" }, { ps: [prod("api")] });
    expect(r.status).toBe(1);
  });
  it("R5-6 · la anulación consciente ALLOW_PRODUCT_CONTAINERS=1 deja pasar pero imprime un AVISO PELIGROSO", () => {
    const r = guard({ ...LAB, S9_PORTABLE_E2E_ALLOW_PRODUCT_CONTAINERS: "1" }, { ps: [prod("api")] });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/AVISO PELIGROSO/);
  });
  it("R5-6 · la anulación no sustituye al consentimiento LAB=1", () => {
    expect(guard({ S9_PORTABLE_E2E_ALLOW_PRODUCT_CONTAINERS: "1" }, { ps: [] }).status).toBe(1);
  });
  it("R4-2 · S9_PORTABLE_FORBIDDEN_HOSTS veta el anfitrión por su nombre (con LAB=1: se prueba el veto, no el consentimiento)", () => {
    const host = execFileSync("hostname").toString().trim();
    const vetado = guard({ ...LAB, S9_PORTABLE_FORBIDDEN_HOSTS: `x ${host}` }, { ps: [] });
    expect(vetado.status).toBe(1);
    expect(vetado.stderr).toMatch(/vetado/);
    // control: con otro nombre vetado, el mismo entorno corre => el rechazo de arriba es del veto
    expect(guard({ ...LAB, S9_PORTABLE_FORBIDDEN_HOSTS: "x-otro-anfitrion" }, { ps: [] }).status).toBe(0);
  });
  it("R5-7 · run.sh etiqueta sus contenedores con s9portable.e2e=1 (es lo que la guarda reconoce como propios)", () => {
    const t = readFileSync(join(REPO, "scripts/portable/e2e/run.sh"), "utf8");
    expect(t).toMatch(/docker run -d --name "\$1" --label s9portable\.e2e=1 /);
  });
  it("R4-2 · run.sh y repeat.sh invocan la guarda antes de tocar nada", () => {
    for (const f of ["run.sh", "repeat.sh"]) {
      const t = readFileSync(join(__dirname, "../../../scripts/portable/e2e", f), "utf8");
      expect(t).toMatch(/source "\$\(dirname "\$0"\)\/guard\.sh"/);
      expect(t.indexOf("s9_portable_guard ||")).toBeGreaterThan(0);
      expect(t.indexOf("s9_portable_guard ||")).toBeLessThan(t.search(/\b(docker|npx|node) /));
    }
  });
});
