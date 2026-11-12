/**
 * OLA 2 (EQUIPMENT_PRIVATE, D-B1=R2) · masa y coste de composición de bots AJENOS.
 *
 * POST /battles/rules-check y el 422 `composition_invalid` dan cifras exactas sólo de los
 * bots propios (o de todos si el lector es staff). De un bot ajeno (también público) sólo
 * cumple/excede y el límite; un bando con algún bot ajeno no lleva totales.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { DEV_USERS, seedDev } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { createPublishedBot, type TestBot } from "../../tournament-worker/src/testing/fixtures.js";
import { redactComposition, checkComposition } from "../../../packages/game-rules/battle-rules.js";

let h: TestDbHandle;
let app: Express;
let ownerTok: string;
let thirdTok: string;
let staffTok: string;
const mine: TestBot[] = [];
const foreign: TestBot[] = [];

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, anonQuota: { max: 10_000, windowMs: 3600_000 } });
  const user = await h.db("users").where({ email: DEV_USERS.user }).first();
  ownerTok = await tokenFor(h.db, DEV_USERS.user);
  thirdTok = await tokenFor(h.db, DEV_USERS.developer);
  staffTok = await tokenFor(h.db, DEV_USERS.moderator);
  for (let i = 0; i < 2; i++) mine.push(await createPublishedBot(h.db, `macp-mine-${i}`, { ownerId: user.id }));
  for (let i = 0; i < 2; i++) foreign.push(await createPublishedBot(h.db, `macp-foreign-${i}`));
}, 120_000);

afterAll(async () => {
  await h.stop();
});

const side = (list: TestBot[], team: string) => list.map((b) => ({ botId: b.botId, version: 1, team }));
/** Límites mínimos permitidos: todo excede, así el informe lleva violaciones de bot y de bando. */
const LIMITS = { botCredits: 200, teamCredits: 200, botMassKg: 500, teamMassKg: 500 };
const body = (red: TestBot[], blue: TestBot[]) => ({
  mode: "team_deathmatch",
  rulesetId: "team-deathmatch-mvp",
  mapId: "mvp-arena-01",
  participants: [...side(red, "red"), ...side(blue, "blue")],
  rules: {
    preset: "custom",
    teamSize: 2,
    params: {
      respawn: { mode: "limited", maxRespawns: 2, delaySeconds: 5 },
      victory: "elimination",
      timeLimitMinutes: 10,
      ...LIMITS,
    },
  },
});
const check = (b: object, t: string) =>
  request(app).post("/battles/rules-check").set("Authorization", `Bearer ${t}`).send(b);
const create = (b: object, t: string) => request(app).post("/battles").set("Authorization", `Bearer ${t}`).send(b);

const FIGURE_KEYS = ['"costCredits"', '"massKg"', '"totalCredits"', '"totalMassKg"', '"actual"', '"excess"'];
const noFigures = (v: unknown) => {
  const s = JSON.stringify(v);
  for (const k of FIGURE_KEYS) expect(s, k).not.toContain(k);
};

describe("tercero: bots ajenos sin cifras", () => {
  it("rules-check: ni por bot, ni por bando, ni en violaciones; sí ok y límite", async () => {
    const r = await check(body(foreign, [...mine]), thirdTok);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    noFigures(r.body.composition);
    const red = r.body.composition.teams.find((t: any) => t.team === "red");
    expect(red.bots.map((b: any) => [b.ok, b.figuresHidden])).toEqual([
      [false, true],
      [false, true],
    ]);
    expect(r.body.composition.violations.length).toBeGreaterThan(0);
    for (const v of r.body.composition.violations) {
      expect(typeof v.limit).toBe("number");
      expect(v.message).not.toMatch(/\d+\/\d+/);
    }
  });

  it("POST /battles 422 composition_invalid: mismo recorte, también en el mensaje", async () => {
    const r = await create(body(foreign, [...mine]), thirdTok);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.error).toBe("composition_invalid");
    noFigures(r.body.composition);
    expect(r.body.message).not.toMatch(/\d+\/\d+/);
  });
});

describe("dueño: cifras exactas sólo de lo propio", () => {
  it("bando íntegramente propio ⇒ bots y totales exactos", async () => {
    const r = await check(body(mine, foreign), ownerTok);
    const red = r.body.composition.teams.find((t: any) => t.team === "red");
    expect(red.figuresHidden).toBe(false);
    expect(red.bots.every((b: any) => typeof b.costCredits === "number" && typeof b.massKg === "number")).toBe(true);
    expect(red.totalCredits).toBe(red.bots[0].costCredits + red.bots[1].costCredits);
    expect(typeof red.totalMassKg).toBe("number");
    const redViolations = r.body.composition.violations.filter((v: any) => v.team === "red");
    expect(redViolations.every((v: any) => typeof v.actual === "number" && typeof v.excess === "number")).toBe(true);
    // El bando ajeno, íntegramente sin cifras.
    const blue = r.body.composition.teams.find((t: any) => t.team === "blue");
    noFigures(blue);
    noFigures(r.body.composition.violations.filter((v: any) => v.team === "blue"));
  });

  it("bando MIXTO: sus bots exactos, el ajeno no, y el total del bando no existe", async () => {
    const r = await check(body([mine[0], foreign[0]], [mine[1], foreign[1]]), ownerTok);
    for (const team of ["red", "blue"]) {
      const t = r.body.composition.teams.find((x: any) => x.team === team);
      expect(t.figuresHidden).toBe(true);
      expect(t).not.toHaveProperty("totalCredits");
      expect(t).not.toHaveProperty("totalMassKg");
      const [own, other] = team === "red" ? t.bots : t.bots;
      const ownBot = t.bots.find((b: any) => !b.figuresHidden);
      const otherBot = t.bots.find((b: any) => b.figuresHidden);
      expect(own && other).toBeTruthy();
      expect(typeof ownBot.costCredits).toBe("number");
      expect(typeof ownBot.massKg).toBe("number");
      noFigures(otherBot);
    }
    const teamViolations = r.body.composition.violations.filter((v: any) => !v.botId);
    expect(teamViolations.length).toBeGreaterThan(0);
    noFigures(teamViolations);
    // Por bot: la violación del propio lleva cifras; la del ajeno no.
    const ownV = r.body.composition.violations.find((v: any) => v.botId === mine[0].botId);
    const otherV = r.body.composition.violations.find((v: any) => v.botId === foreign[0].botId);
    expect(typeof ownV.actual).toBe("number");
    noFigures(otherV);
  });

  it("422 al crear: el mismo recorte que rules-check", async () => {
    const r = await create(body([mine[0], foreign[0]], [mine[1], foreign[1]]), ownerTok);
    expect(r.status).toBe(422);
    const red = r.body.composition.teams.find((t: any) => t.team === "red");
    expect(red).not.toHaveProperty("totalCredits");
    noFigures(red.bots.find((b: any) => b.botId === foreign[0].botId));
  });
});

describe("staff (moderador): todo exacto", () => {
  it("rules-check con bots ajenos ⇒ cifras en bots, totales y violaciones", async () => {
    const r = await check(body([foreign[0], mine[0]], foreign.slice(1)), staffTok);
    for (const t of r.body.composition.teams) {
      expect(t.figuresHidden).toBe(false);
      expect(typeof t.totalCredits).toBe("number");
      expect(t.bots.every((b: any) => typeof b.costCredits === "number" && typeof b.massKg === "number")).toBe(true);
    }
    expect(
      r.body.composition.violations.every((v: any) => typeof v.actual === "number" && typeof v.excess === "number"),
    ).toBe(true);
  });
});

describe("redactComposition · unidad", () => {
  const entries = [
    { botId: "a", label: "A v1", team: "red", costCredits: 100, massKg: 10 },
    { botId: "b", label: "B v1", team: "red", costCredits: 200, massKg: 20 },
  ];
  const report = checkComposition(entries, { botCredits: 150, teamCredits: 250, botMassKg: null, teamMassKg: null });

  it("sin lector: nada de cifras", () => {
    noFigures(redactComposition(report, () => false));
  });
  it("todos propios: idéntico al informe completo", () => {
    const r = redactComposition(report, () => true);
    expect(r.teams[0].totalCredits).toBe(300);
    expect(r.violations.map((v) => [v.code, v.actual, v.excess])).toEqual([
      ["bot_credits_exceeded", 200, 50],
      ["team_credits_exceeded", 300, 50],
    ]);
  });
  it("uno ajeno: el total del bando desaparece aunque sea el propio quien se pase", () => {
    const r = redactComposition(report, (id) => id === "a");
    expect(r.teams[0]).not.toHaveProperty("totalCredits");
    expect(r.teams[0].bots[0].costCredits).toBe(100);
    expect(r.teams[0].bots[1]).not.toHaveProperty("costCredits");
  });
});
