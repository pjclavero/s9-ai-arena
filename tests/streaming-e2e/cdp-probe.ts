/**
 * #256 · Sonda CDP del Chromium REAL del streamer (el mismo proceso que pinta en
 * el Xvfb que captura ffmpeg), para el diagnóstico de la emisión en blanco.
 *
 *   npx tsx tests/streaming-e2e/cdp-probe.ts <puerto-cdp> <dir-salida> <etiqueta>
 *
 * Sólo lee: DOM de `broadcast-stage`, canvas (tamaño real, caja, contexto WebGL,
 * vendor/renderer UNMASKED), estado de la escena de Phaser, consola/errores JS,
 * info de GPU del navegador y una captura del compositor de Chromium
 * (Page.captureScreenshot), que es lo que Chromium CREE que pinta — distinto de lo
 * que hay en el framebuffer del Xvfb.
 *
 * Escribe <dir>/<etiqueta>-cdp.json, <dir>/<etiqueta>-chromium.png e imprime las
 * líneas `clave=valor` del encargo. El puerto de depuración sólo existe en la
 * sesión de diagnóstico (envoltorio de CHROMIUM_BIN), nunca en la imagen.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";

const [portArg, outDir, label] = process.argv.slice(2);
const port = Number(portArg);
const CDP_TIMEOUT_MS = Number(process.env.CDP_TIMEOUT_MS ?? 10_000);
/** Órdenes CDP que no contestaron a tiempo (renderer atascado). */
const timeouts: string[] = [];

async function json(path: string): Promise<any> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  return r.json();
}

class Cdp {
  private id = 0;
  private pending = new Map<number, (m: any) => void>();
  readonly events: any[] = [];
  constructor(private ws: WebSocket) {
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)!(m);
        this.pending.delete(m.id);
      } else if (m.method) this.events.push(m);
    });
  }
  static open(url: string): Promise<Cdp> {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url, { perMessageDeflate: false });
      ws.once("open", () => res(new Cdp(ws)));
      ws.once("error", rej);
    });
  }
  /**
   * Cada orden con PLAZO: un renderer con el hilo principal atascado no contesta nunca
   * (visto en #256) y la sonda no debe colgar el diagnóstico. Sin respuesta ⇒ `{ timeout }`.
   */
  send(method: string, params: Record<string, unknown> = {}, timeoutMs = CDP_TIMEOUT_MS): Promise<any> {
    const id = ++this.id;
    return new Promise((res) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        timeouts.push(method);
        res({ timeout: method });
      }, timeoutMs);
      this.pending.set(id, (m) => {
        clearTimeout(t);
        res(m);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    this.ws.close();
  }
}

// Se ejecuta DENTRO de la página. Sólo lectura: getContext() sobre un canvas que ya
// tiene contexto devuelve ESE contexto (no crea otro).
const PAGE_PROBE = `(() => {
  const q = (s) => document.querySelector(s);
  const stage = q('[data-testid=broadcast-stage]');
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const screens = ['waiting', 'intermission', 'finished', 'live'].filter((k) => q('[data-testid=broadcast-' + k + ']'));
  const canvases = [...document.querySelectorAll('canvas')];
  const canvas = canvases[0] || null;
  let ctxType = 'none', vendor = null, renderer = null, unmaskedVendor = null, unmaskedRenderer = null, lost = null, attrs = null;
  if (canvas) {
    for (const t of ['webgl2', 'webgl']) {
      const gl = canvas.getContext(t);
      if (gl) {
        ctxType = t;
        lost = gl.isContextLost();
        attrs = gl.getContextAttributes();
        vendor = gl.getParameter(gl.VENDOR);
        renderer = gl.getParameter(gl.RENDERER);
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        if (ext) { unmaskedVendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL); unmaskedRenderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL); }
        break;
      }
    }
    if (ctxType === 'none' && canvas.getContext('2d')) ctxType = '2d';
  }
  const cs = stage ? getComputedStyle(stage) : null;
  return {
    url: location.href.replace(/[?#].*$/, '') + (location.search ? '?' + [...new URLSearchParams(location.search).keys()].join('&') : ''),
    search: location.search,
    readyState: document.readyState,
    title: document.title,
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    htmlBackground: getComputedStyle(document.documentElement).backgroundColor,
    stage: stage ? { box: box(stage), background: cs.backgroundColor, childCount: stage.children.length } : null,
    header: !!q('[data-testid=broadcast-header]'),
    event: q('[data-testid=broadcast-event]')?.textContent ?? null,
    hud: !!q('[data-testid=hud]') || !!q('[data-testid=broadcast-score]'),
    scoreText: q('[data-testid=broadcast-score]')?.textContent ?? null,
    ticker: q('[data-testid=broadcast-ticker]')?.textContent ?? null,
    screens,
    canvasCount: canvases.length,
    canvas: canvas ? { width: canvas.width, height: canvas.height, box: box(canvas), cssDisplay: getComputedStyle(canvas).display, cssVisibility: getComputedStyle(canvas).visibility } : null,
    ctxType, contextLost: lost, contextAttributes: attrs, vendor, renderer, unmaskedVendor, unmaskedRenderer,
    phaserGlobal: typeof window.Phaser,
    textSample: (stage?.innerText ?? '').slice(0, 400),
  };
})()`;

// Estado de la escena de Phaser: se buscan las instancias vivas de Phaser.Game en
// el heap (Runtime.queryObjects) sin depender de ningún gancho de la página.
async function phaserState(cdp: Cdp): Promise<any> {
  const proto = await cdp.send("Runtime.evaluate", {
    expression: "typeof Phaser !== 'undefined' && Phaser.Game ? Phaser.Game.prototype : null",
  });
  const protoId = proto.result?.result?.objectId;
  if (!protoId) return { found: false, reason: "Phaser.Game no accesible como global" };
  const q = await cdp.send("Runtime.queryObjects", { prototypeObjectId: protoId });
  const arrId = q.result?.objects?.objectId;
  const r = await cdp.send("Runtime.callFunctionOn", {
    objectId: arrId,
    returnByValue: true,
    functionDeclaration: `function () {
      return this.map((g) => {
        const s = g.scene && g.scene.getScene && g.scene.getScene('viewer');
        const STATUS = ['PENDING','INIT','START','LOADING','CREATING','RUNNING','PAUSED','SLEEPING','SHUTDOWN','DESTROYED'];
        return {
          isRunning: g.isRunning, isBooted: g.isBooted,
          rendererType: g.renderer ? (g.renderer.type === 2 ? 'WEBGL' : g.renderer.type === 1 ? 'CANVAS' : String(g.renderer.type)) : null,
          rendererSize: g.renderer ? { w: g.renderer.width, h: g.renderer.height } : null,
          frame: g.loop ? g.loop.frame : null, actualFps: g.loop ? g.loop.actualFps : null,
          scene: s ? { key: s.sys.settings.key, status: STATUS[s.sys.settings.status] ?? s.sys.settings.status, visible: s.sys.settings.visible, displayList: s.children ? s.children.length : null } : null,
          backgroundColor: g.config && g.config.backgroundColor ? g.config.backgroundColor.rgba : null,
        };
      });
    }`,
  });
  return { found: true, games: r.result?.result?.value ?? r };
}

const list = await json("/json/list");
const page = list.find((t: any) => t.type === "page");
if (!page) {
  console.error("sin target de página en CDP");
  process.exit(2);
}
const version = await json("/json/version");
const cdp = await Cdp.open(page.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
await cdp.send("Log.enable"); // reenvía las entradas de log ya recogidas
const dom = (await cdp.send("Runtime.evaluate", { expression: PAGE_PROBE, returnByValue: true })).result?.result?.value;
const phaser = dom ? await phaserState(cdp) : { found: false, reason: "renderer sin respuesta" };
const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
// Sin captura (compositor sin frame) NO se escribe PNG: el detector lo verá ausente.
if (shot.result?.data) writeFileSync(join(outDir, `${label}-chromium.png`), Buffer.from(shot.result.data, "base64"));
// Info de GPU del navegador (lo que muestra chrome://gpu) por el endpoint del navegador.
const browser = await Cdp.open(version.webSocketDebuggerUrl);
const sys = await browser.send("SystemInfo.getInfo");
// El endpoint del navegador (proceso browser) contesta aunque el renderer esté atascado.
browser.close();
await new Promise((r) => setTimeout(r, 300)); // deja llegar las entradas de Log.enable
const logs = cdp.events
  .filter((e) => e.method === "Log.entryAdded" || e.method === "Runtime.exceptionThrown" || e.method === "Runtime.consoleAPICalled")
  .map((e) =>
    e.method === "Log.entryAdded"
      ? { level: e.params.entry.level, source: e.params.entry.source, text: String(e.params.entry.text).slice(0, 300) }
      : e.method === "Runtime.exceptionThrown"
        ? { level: "exception", text: String(e.params.exceptionDetails?.exception?.description ?? e.params.exceptionDetails?.text).slice(0, 300) }
        : { level: e.params.type, text: (e.params.args ?? []).map((a: any) => a.value ?? a.description).join(" ").slice(0, 300) },
  );
cdp.close();
const gpu = sys.result?.gpu ?? null;
const out = { label, rendererUnresponsive: timeouts.length > 0, timeouts, userAgent: version["User-Agent"], dom, phaser, logs, gpu: gpu && { devices: gpu.devices, featureStatus: gpu.featureStatus, driverBugWorkarounds: gpu.driverBugWorkarounds, auxAttributes: gpu.auxAttributes } };
writeFileSync(join(outDir, `${label}-cdp.json`), JSON.stringify(out, null, 2));
const g0 = phaser.games?.[0];
console.log(`${label} broadcast_stage=${dom?.stage ? `${dom.stage.box.w}x${dom.stage.box.h}` : "AUSENTE"} stage_background=${dom?.stage?.background} screens=${dom?.screens?.join(",") || "ninguna"} header=${dom?.header} hud=${dom?.hud} ticker=${dom?.ticker !== null}`);
console.log(`${label} canvas_width=${dom?.canvas?.width ?? "NA"} canvas_height=${dom?.canvas?.height ?? "NA"} canvas_box=${dom?.canvas ? `${dom.canvas.box.w}x${dom.canvas.box.h}@${dom.canvas.box.x},${dom.canvas.box.y}` : "NA"} context=${dom?.ctxType} context_lost=${dom?.contextLost}`);
console.log(`${label} renderer=${g0?.rendererType ?? "NA"} webgl_vendor=${JSON.stringify(dom?.unmaskedVendor)} webgl_renderer=${JSON.stringify(dom?.unmaskedRenderer)} scene_status=${g0?.scene?.status ?? "NA"} phaser_frame=${g0?.frame ?? "NA"} phaser_fps=${g0?.actualFps?.toFixed?.(1) ?? "NA"}`);
console.log(`${label} renderer_unresponsive=${timeouts.length > 0 ? 1 : 0} cdp_timeouts=${timeouts.join(",") || "ninguno"}`);
console.log(`${label} js_errors=${logs.filter((l) => l.level === "error" || l.level === "exception").length} log_entries=${logs.length}`);
process.exit(0);
