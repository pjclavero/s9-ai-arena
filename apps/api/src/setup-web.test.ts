/**
 * V1 ADM-SETUP (D-OP-44) · Asistente de primer arranque desde el navegador, contra PostgreSQL REAL.
 *
 * Los 9 casos del diseño (V1-ADM-AUDITORIA-UN-ADMIN §5.4). Cada uno se pone rojo sin el arreglo; el
 * mutante que lo calibra está en `scripts/v1-web-setup-mutants.mjs` con el nombre del test entre [].
 *
 * Nota: los usuarios NO se borran entre casos (audit_log es de sólo inserción y su FK `actor_id` es
 * ON DELETE SET NULL, que el trigger rechaza). Cada caso usa emails propios y «reabre» la instalación
 * quitando el rol admin y recreando la fila de `install_state` (el DELETE no lo impide el trigger, y
 * sin fila el asistente está cerrado).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { createApp } from "./app.js";
import { createAdmin } from "./services/create-admin.js";
import { passwordPolicyViolation } from "./auth/passwords.js";
import { announceSetupIfOpen } from "./services/install-state.js";
import { setupTokenFingerprint } from "./services/setup-token.js";
import { SlidingWindowLimiter } from "./middleware/rate-limit.js";

const TOKEN = "tok3n-de-instalacion-de-prueba-0123456789";
const PW = "una-frase-de-paso-larga-y-rara-42";
const allow = { hit: () => true };

let h: TestDbHandle;
let app: Express;
let currentToken: string | null = TOKEN;
let gate: (() => Promise<void>) | undefined;
let seq = 0;
const email = (tag: string) => `setup-${tag}-${++seq}@ejemplo.test`;

async function reopen(): Promise<void> {
  await h.db("user_roles").where({ role: "admin" }).del();
  await h.db("install_state").del();
  await h.db("install_state").insert({ id: true });
  currentToken = TOKEN;
  gate = undefined;
}

async function adminCount(): Promise<number> {
  const [{ c }] = await h.db("user_roles").where({ role: "admin" }).count<{ c: string }[]>({ c: "*" });
  return Number(c);
}

function post(body: Record<string, unknown>, target: Express = app) {
  return request(target).post("/setup/admin").set("user-agent", "vitest-setup").send(body);
}

const body = (tag: string, extra: Record<string, unknown> = {}) => ({
  setupToken: TOKEN,
  email: email(tag),
  displayName: `Admin ${tag}`,
  password: PW,
  ...extra,
});

beforeAll(async () => {
  h = await startTestDb();
  app = createApp({
    db: h.db,
    setup: {
      tokenSource: () => currentToken,
      ipLimiter: allow,
      globalLimiter: allow,
      testHooks: { afterAdminCount: () => (gate ? gate() : Promise.resolve()) },
    },
  });
}, 120_000);

afterAll(async () => {
  await h?.stop();
});

beforeEach(reopen);

describe("V1 ADM-SETUP · asistente de primer arranque", () => {
  it("[T1-status-tres-condiciones] open sólo con 0 admins, instalación abierta y token; sin token, open:false y POST 404", async () => {
    const st = await request(app).get("/setup/status");
    expect(st.status).toBe(200);
    expect(st.body).toEqual({ open: true });
    expect(st.headers["cache-control"]).toBe("no-store");

    currentToken = null;
    expect((await request(app).get("/setup/status")).body).toEqual({ open: false });
    const r = await post(body("sin-token"));
    expect(r.status).toBe(404);
    expect(await adminCount()).toBe(0);

    currentToken = TOKEN;
    await h.db("install_state").del(); // sin fila ⇒ cerrado (fallo cerrado)
    expect((await request(app).get("/setup/status")).body).toEqual({ open: false });
    expect((await post(body("sin-fila"))).status).toBe(410);
    expect(await adminCount()).toBe(0);
  });

  it("[T2-token-erroneo] token erróneo ⇒ 401 y `setup.token_rejected` sin el valor; al superar el límite ⇒ 429", async () => {
    const wrong = "token-que-no-es-el-de-instalacion-000000";
    const r = await post(body("token-malo", { setupToken: wrong }));
    expect(r.status).toBe(401);
    expect(await adminCount()).toBe(0);
    const rows = await h.db("audit_log").where({ action: "setup.token_rejected" }).orderBy("id", "desc").limit(1);
    expect(rows).toHaveLength(1);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(wrong);
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain(PW);
    expect((await post(body("sin-token-campo", { setupToken: undefined }))).status).toBe(401);

    // Límite estricto: 2 por IP ⇒ la tercera es 429 aunque el token sea correcto.
    const limited = createApp({
      db: h.db,
      setup: { tokenSource: () => TOKEN, ipLimiter: new SlidingWindowLimiter(2, 60_000), globalLimiter: allow },
    });
    expect((await post(body("lim1", { setupToken: wrong }), limited)).status).toBe(401);
    expect((await post(body("lim2", { setupToken: wrong }), limited)).status).toBe(401);
    expect((await post(body("lim3"), limited)).status).toBe(429);
    expect(await adminCount()).toBe(0);
  });

  it("[T3-alta-correcta] token correcto ⇒ 201 con roles admin, install_state via=web, auditoría sin secretos, sesión válida y kit", async () => {
    const b = body("ok");
    const r = await post(b);
    expect(r.status).toBe(201);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body.accessToken).toEqual(expect.any(String));
    expect(r.body.recoveryKit).toMatch(/^S9RK(-[A-Z2-9]{4}){8}$/);
    expect(String(r.headers["set-cookie"] ?? "")).toContain("s9_refresh=");

    const me = await request(app).get("/users/me").set("Authorization", `Bearer ${r.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(b.email);
    expect([...me.body.roles].sort()).toEqual(["admin", "developer", "user"]);

    const st = await h.db("install_state").where({ id: true }).first();
    expect(st.via).toBe("web");
    expect(st.setup_completed_at).not.toBeNull();
    expect(st.setup_completed_by).toBe(me.body.id);

    const [row] = await h.db("audit_log").where({ action: "admin.create_web_setup", target: `user:${me.body.id}` });
    expect(row).toBeTruthy();
    const detail = typeof row.detail === "string" ? JSON.parse(row.detail) : row.detail;
    expect(detail.tokenFingerprint).toBe(setupTokenFingerprint(TOKEN));
    expect(detail.userAgent).toBe("vitest-setup");
    const dump = JSON.stringify(row);
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain(PW);
    expect(dump).not.toContain(r.body.recoveryKit);
    // El kit se guarda hasheado (Argon2id), nunca en claro.
    const kit = await h.db("admin_recovery_kits").where({ user_id: me.body.id }).first();
    expect(kit.kit_hash).toMatch(/^\$argon2id\$/);
    expect(kit.kit_hash).not.toContain(r.body.recoveryKit.slice(5));
  });

  it("[T4-segundo-post-410] un segundo POST con el token correcto ⇒ 410 setup_closed", async () => {
    expect((await post(body("primero"))).status).toBe(201);
    const r = await post(body("segundo"));
    expect(r.status).toBe(410);
    expect(r.body.error).toBe("setup_closed");
    expect(await adminCount()).toBe(1);
    expect((await request(app).get("/setup/status")).body).toEqual({ open: false });
  });

  it("[T5-cierre-para-siempre] quitar todos los admins por SQL NO reabre: status cerrado y POST 410", async () => {
    expect((await post(body("efimero"))).status).toBe(201);
    await h.db("user_roles").where({ role: "admin" }).del();
    expect(await adminCount()).toBe(0);
    expect((await request(app).get("/setup/status")).body).toEqual({ open: false });
    const r = await post(body("reapertura"));
    expect(r.status).toBe(410);
    expect(await adminCount()).toBe(0);
  });

  it("[T6-carrera-dos-post] dos POST simultáneos con la ventana de carrera abierta ⇒ exactamente un admin", async () => {
    // Barrera: cada petición, tras contar admins, espera a la otra (máx. 1,5 s). Con el cerrojo la
    // segunda no llega a contar hasta que la primera confirma, así que la barrera vence sola.
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => (release = r));
    gate = async () => {
      arrived += 1;
      if (arrived >= 2) release();
      await Promise.race([both, new Promise((r) => setTimeout(r, 1_500))]);
    };
    const [a, b] = await Promise.all([post(body("carrera-a")), post(body("carrera-b"))]);
    expect([a.status, b.status].sort()).toEqual([201, 410]);
    expect(await adminCount()).toBe(1);
  });

  it("[T7-politica] la política es la de passwordPolicyViolation: corta (11), larga (129) y común se juzgan igual que la función", async () => {
    const r11 = await post(body("p11", { password: "a1b2c3d4e5f" }));
    expect(r11.status).toBe(400);
    expect(await adminCount()).toBe(0);
    // Equivalencia con la fuente ÚNICA: cuando #348 (12-128 + blocklist) entre en main, estos casos
    // pasan a ser 400 sin tocar el asistente. Hoy (sólo mínimo 12) la de 129 y la común se aceptan.
    for (const pw of ["x".repeat(129), "password1234"]) {
      await reopen();
      const r = await post(body("pol", { password: pw }));
      const expected = passwordPolicyViolation(pw) === null ? 201 : 400;
      expect(r.status, `contraseña de ${pw.length}`).toBe(expected);
    }
    await reopen();
    expect((await post(body("pw-no-string", { password: 123456789012345 }))).status).toBe(400);
    expect(await adminCount()).toBe(0);
  });

  it("[T8-cli-cierra] crear el admin por CLI (`create-admin`) cierra el asistente para siempre (via=cli)", async () => {
    await createAdmin(h.db, { email: email("cli"), displayName: "Por consola", password: PW });
    const st = await h.db("install_state").where({ id: true }).first();
    expect(st.via).toBe("cli");
    expect(st.setup_completed_at).not.toBeNull();
    await h.db("user_roles").where({ role: "admin" }).del();
    expect((await request(app).get("/setup/status")).body).toEqual({ open: false });
    expect((await post(body("tras-cli"))).status).toBe(410);
  });

  it("[T10-servicio-revalida] dentro del cerrojo, la vía web revalida install_state: cerrada con 0 admins ⇒ setup_closed", async () => {
    await h.db("install_state").update({ setup_completed_at: h.db.fn.now(), via: "cli" });
    expect(await adminCount()).toBe(0);
    const e = await createAdmin(h.db, {
      email: email("servicio"),
      displayName: "Servicio",
      password: PW,
      via: "web",
      webContext: { tokenFingerprint: setupTokenFingerprint(TOKEN) },
    }).catch((x) => x);
    expect((e as { code?: string }).code).toBe("setup_closed");
    expect(await adminCount()).toBe(0);
    // Y la vía web nunca es «adicional».
    await reopen();
    const e2 = await createAdmin(h.db, {
      email: email("adicional"),
      displayName: "Adicional",
      password: PW,
      via: "web",
      allowAdditionalAdmin: true,
      webContext: { tokenFingerprint: setupTokenFingerprint(TOKEN) },
    }).catch((x) => x);
    expect((e2 as { code?: string }).code).toBe("invalid_input");
  });

  it("[T9-log-sin-token] el aviso de arranque lleva la huella y NUNCA el token; ninguna petición lo escribe en stdout/stderr", async () => {
    const lines: string[] = [];
    expect(
      await announceSetupIfOpen(
        h.db,
        () => TOKEN,
        (l) => lines.push(l),
      ),
    ).toBe(true);
    const banner = lines.join("\n");
    expect(banner).toContain(setupTokenFingerprint(TOKEN));
    expect(banner).toContain("#/setup");
    expect(banner).not.toContain(TOKEN);

    const out: string[] = [];
    const cap = (...a: unknown[]) => void out.push(a.map(String).join(" "));
    const spies = [
      vi.spyOn(console, "log").mockImplementation(cap),
      vi.spyOn(console, "error").mockImplementation(cap),
      vi.spyOn(console, "warn").mockImplementation(cap),
      vi.spyOn(console, "info").mockImplementation(cap),
    ];
    const ow = process.stdout.write.bind(process.stdout);
    const ew = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: unknown, ...r: unknown[]) => (
      out.push(String(c)),
      ow(c as never, ...(r as []))
    )) as never;
    process.stderr.write = ((c: unknown, ...r: unknown[]) => (
      out.push(String(c)),
      ew(c as never, ...(r as []))
    )) as never;
    try {
      await post(body("log-malo", { setupToken: "otro-token-cualquiera-1234567890abcdef" }));
      const ok = await post(body("log-bueno"));
      expect(ok.status).toBe(201);
    } finally {
      spies.forEach((s) => s.mockRestore());
      process.stdout.write = ow;
      process.stderr.write = ew;
    }
    expect(out.join("\n")).not.toContain(TOKEN);

    // Con el asistente cerrado no se anuncia nada.
    const after: string[] = [];
    expect(
      await announceSetupIfOpen(
        h.db,
        () => TOKEN,
        (l) => after.push(l),
      ),
    ).toBe(false);
    expect(after).toEqual([]);
  });
});
