/**
 * EQ5b · Unitarios puros de Administración → Streaming (sin BD): validación de la
 * configuración, clasificación de cambios, URL de /broadcast y deriva web↔API.
 */
import { describe, expect, it } from "vitest";
import {
  applySettingsPatch,
  bitrateRecommendation,
  broadcastUrlFor,
  CHANGE_CLASSES,
  DEFAULT_BRANDING,
  parseTarget,
  validIngestUrl,
  validLogoUrl,
  validStreamKey,
  type StreamingSettings,
} from "./streaming.js";
// La pantalla es TSX (fuera del tsconfig de la API): se carga en tiempo de ejecución.
const WEB_PAGE = "../../../web/src/pages/StreamingPage.js";
async function web(): Promise<{
  recommendation: typeof bitrateRecommendation;
  IMPACT_TEXT: Record<string, string>;
}> {
  return import(/* @vite-ignore */ WEB_PAGE);
}

const BASE: StreamingSettings = {
  enabled: false,
  mode: "record",
  platform: "youtube",
  ingestUrl: null,
  encoder: "x264",
  preset: "1080p",
  fps: 30,
  videoBitrateKbps: 4500,
  branding: { ...DEFAULT_BRANDING },
  retention: { enabled: false, maxAgeDays: 14, maxTotalBytes: null },
  version: 1,
  updatedAt: "2026-11-02T00:00:00.000Z",
  updatedBy: null,
};

describe("EQ5b · validación de la configuración", () => {
  it("campos desconocidos, __proto__ y tipos erróneos se rechazan", () => {
    const r = applySettingsPatch(BASE, JSON.parse('{"__proto__":{"enabled":true},"foo":1,"enabled":"sí"}'), {
      nvenc: null,
    });
    expect(r.errors.join(" ")).toMatch(/__proto__/);
    expect(r.errors.join(" ")).toMatch(/foo/);
    expect(r.errors.join(" ")).toMatch(/enabled/);
    expect(r.next.enabled).toBe(false);
  });

  it("límites de bitrate, fps y preset; aviso fuera del rango recomendado", () => {
    expect(applySettingsPatch(BASE, { videoBitrateKbps: 999 }, { nvenc: null }).errors).toHaveLength(1);
    expect(applySettingsPatch(BASE, { videoBitrateKbps: 12001 }, { nvenc: null }).errors).toHaveLength(1);
    expect(applySettingsPatch(BASE, { videoBitrateKbps: 4500.5 }, { nvenc: null }).errors).toHaveLength(1);
    expect(applySettingsPatch(BASE, { fps: 24 }, { nvenc: null }).errors).toHaveLength(1);
    expect(applySettingsPatch(BASE, { preset: "4k" }, { nvenc: null }).errors).toHaveLength(1);
    const w = applySettingsPatch(BASE, { videoBitrateKbps: 11000 }, { nvenc: null });
    expect(w.errors).toEqual([]);
    expect(w.warnings[0]).toMatch(/fuera del rango recomendado/);
  });

  it("60 FPS exige confirmación; NVENC sólo si el runtime lo confirma", () => {
    expect(applySettingsPatch(BASE, { fps: 60 }, { nvenc: null }).errors[0]).toMatch(/confirm/);
    expect(applySettingsPatch(BASE, { fps: 60, confirmHighFps: true }, { nvenc: null }).errors).toEqual([]);
    expect(applySettingsPatch(BASE, { encoder: "nvenc" }, { nvenc: false }).errors[0]).toMatch(/NVENC/);
    expect(applySettingsPatch(BASE, { encoder: "nvenc" }, { nvenc: null }).errors[0]).toMatch(/NVENC/);
    expect(applySettingsPatch(BASE, { encoder: "nvenc" }, { nvenc: true }).errors).toEqual([]);
  });

  it("RTMPS personalizado exige ingesta rtmps:// sin credenciales ni query", () => {
    expect(applySettingsPatch(BASE, { mode: "rtmps", platform: "custom" }, { nvenc: null }).errors[0]).toMatch(
      /ingestUrl/,
    );
    for (const bad of [
      "rtmp://x/live",
      "rtmps://u:p@x/live",
      "rtmps://x/live?k=1",
      "https://x/live",
      "rtmps://x/",
      "rtmps://x/a b",
    ]) {
      expect(validIngestUrl(bad), bad).toBeNull();
    }
    expect(validIngestUrl("rtmps://ingest.example:443/app/sub")).toBe("rtmps://ingest.example:443/app/sub");
  });

  it("branding: logo sólo https:// o ruta propia; colores #hex; nombre sin controles", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:image/png;base64,x",
      "//evil/x",
      "http://x/y.png",
      "https://x/a b",
      'https://x/"y',
    ]) {
      expect(validLogoUrl(bad), bad).toBe(false);
    }
    expect(validLogoUrl("https://cdn.example/l.png")).toBe(true);
    expect(validLogoUrl("/logo.png")).toBe(true);
    const r = applySettingsPatch(
      BASE,
      { branding: { primaryColor: "red", eventName: "a b", extra: 1 } },
      { nvenc: null },
    );
    expect(r.errors.length).toBe(3);
  });

  it("clave de emisión: 8-256 imprimibles, sin espacios", () => {
    expect(validStreamKey("abcd-efgh-ijkl-mnop")).toBe(true);
    expect(validStreamKey("corta")).toBe(false);
    expect(validStreamKey("con espacio dentro")).toBe(false);
    expect(validStreamKey("x".repeat(257))).toBe(false);
    expect(validStreamKey("clave\nconsalto")).toBe(false);
  });

  it("retención: activa exige edad o tamaño; límites", () => {
    expect(
      applySettingsPatch(BASE, { retention: { enabled: true, maxAgeDays: null } }, { nvenc: null }).errors,
    ).toHaveLength(1);
    expect(applySettingsPatch(BASE, { retention: { maxAgeDays: 0 } }, { nvenc: null }).errors).toHaveLength(1);
    expect(applySettingsPatch(BASE, { retention: { maxTotalBytes: 10 } }, { nvenc: null }).errors).toHaveLength(1);
    expect(applySettingsPatch(BASE, { retention: { enabled: true, maxAgeDays: 7 } }, { nvenc: null }).errors).toEqual(
      [],
    );
  });

  it("clasificación de cambios: retención en caliente, codificación con reinicio, desactivar para", () => {
    expect(CHANGE_CLASSES.retention).toBe("hot");
    expect(CHANGE_CLASSES.videoBitrateKbps).toBe("restart");
    expect(CHANGE_CLASSES.branding).toBe("restart");
    expect(CHANGE_CLASSES.enabled).toBe("stop");
  });

  it("cada clase de cambio tiene su texto en la pantalla", async () => {
    const { IMPACT_TEXT } = await web();
    for (const v of Object.values(CHANGE_CLASSES)) expect(IMPACT_TEXT[v]).toBeTruthy();
  });
});

describe("EQ5b · destino y /broadcast", () => {
  it("parseTarget sólo batalla/torneo + UUID", () => {
    expect(parseTarget("battle", "11111111-2222-4333-8444-555555555555")).toBeTruthy();
    expect(parseTarget("map", "11111111-2222-4333-8444-555555555555")).toBeNull();
    expect(parseTarget("battle", "../../etc")).toBeNull();
  });

  it("la URL del streamer es la vista /broadcast del origen configurado, con el branding codificado", () => {
    const u = new URL(
      broadcastUrlFor(
        "http://web:3000/broadcast?x=1",
        { kind: "battle", id: "b1" },
        { ...DEFAULT_BRANDING, eventName: "Copa & <x>" },
      ),
    );
    expect(u.origin + u.pathname).toBe("http://web:3000/broadcast");
    expect(u.searchParams.get("x")).toBeNull();
    expect(u.searchParams.get("battle")).toBe("b1");
    expect(u.searchParams.get("event")).toBe("Copa & <x>");
  });
});

describe("EQ5b · deriva web ↔ API", () => {
  it("los rangos de bitrate de la pantalla son los de la API", async () => {
    const webRecommendation = (await web()).recommendation;
    for (const p of ["1080p", "720p"])
      for (const f of [30, 60]) expect(webRecommendation(p, f)).toEqual(bitrateRecommendation(p, f));
  });
});
