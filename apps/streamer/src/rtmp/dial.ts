/**
 * STREAMING-UX · §27 / V2 §1-4 · Marcado de la ingesta con Happy Eyeballs
 * (RFC 8305) y TLS verificado contra el NOMBRE.
 *
 * Caso de producción: el DNS del contenedor devolvía la AAAA primero y el host
 * no tenía salida IPv6, así que el intento IPv6 se quedaba colgado. NO se
 * fuerza IPv4 ni se pone «IPv4 siempre primero»: se respeta el orden del DNS.
 * Se intercalan las familias y se lanza el siguiente intento a los
 * `attemptDelayMs` (250 ms) SIN cancelar el anterior. Gana el primero que
 * conecta y los demás se destruyen. Una IPv6 muerta cuesta como mucho un
 * escalón, nunca su plazo entero.
 *
 * ¿Por qué no basta `autoSelectFamily` de Node? En producción, el
 * `tls.connect({host, port: 443})` con el Node 20 de la imagen, que ya trae
 * `autoSelectFamily` activado por defecto, dio TIMEOUT contra la misma
 * ingesta. El runtime no resolvió este caso. Además, su algoritmo es secuencial:
 * cancela cada intento al vencer `autoSelectFamilyAttemptTimeout`, de modo que
 * en un enlace lento un plazo corto mata también el intento bueno. Tampoco deja
 * inyectar el transporte, y sin eso no se puede reproducir en un test una ruta
 * IPv6 que se traga los SYN. Este marcador hace lo mínimo: carreras de TCP con
 * escalonado. El TLS y el certificado los sigue haciendo `node:tls`.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect, type ConnectionOptions } from "node:tls";
import type { Duplex } from "node:stream";

export type LookupAll = (host: string) => Promise<LookupAddress[]>;
/** Abre un TCP hacia `address:port` (inyectable en tests para simular una ruta muerta). */
export type TcpConnect = (address: string, port: number, family: number) => Socket;

export interface DialTarget {
  protocol: "rtmps" | "rtmp";
  host: string;
  port: number;
}

export interface DialOptions {
  lookup?: LookupAll;
  tcpConnect?: TcpConnect;
  /** RFC 8305 «Connection Attempt Delay»: escalón entre intentos. Por defecto 250 ms. */
  attemptDelayMs?: number;
  /** Plazo de CADA intento TCP. Por defecto 5 s. */
  attemptTimeoutMs?: number;
  /** Ronda 1 (H-3) · plazo de la resolución DNS. Por defecto 5 s. */
  lookupTimeoutMs?: number;
  /** Sólo tests: CA propia (en producción, la del sistema o NODE_EXTRA_CA_CERTS). */
  tls?: Pick<ConnectionOptions, "ca">;
}

export const DEFAULT_ATTEMPT_DELAY_MS = 250;
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 5000;
export const DEFAULT_LOOKUP_TIMEOUT_MS = 5000;

const defaultLookup: LookupAll = (host) =>
  new Promise((resolve, reject) =>
    dnsLookup(host, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs))),
  );

const defaultTcp: TcpConnect = (address, port, family) => netConnect({ host: address, port, family });

/**
 * RFC 8305 §4 · orden de intentos: se respeta la preferencia del DNS (la familia
 * de la PRIMERA dirección va primero) y se INTERCALAN las familias:
 * [v6a, v6b, v4a] ⇒ [v6a, v4a, v6b]. Sin duplicados. No reordena por familia.
 */
export function dialOrder(addrs: LookupAddress[]): LookupAddress[] {
  const seen = new Set<string>();
  const uniq = addrs.filter((a) => (seen.has(a.address) ? false : (seen.add(a.address), true)));
  if (uniq.length === 0) return [];
  const first = uniq[0].family;
  const a = uniq.filter((x) => x.family === first);
  const b = uniq.filter((x) => x.family !== first);
  const out: LookupAddress[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i]) out.push(a[i]);
    if (b[i]) out.push(b[i]);
  }
  return out;
}

export class DialError extends Error {
  constructor(
    message: string,
    readonly code: string,
    /** Resumen por dirección (sin secretos: sólo familia y motivo). */
    readonly attempts: { family: number; reason: string }[] = [],
  ) {
    super(message);
  }
}

/** Carrera escalonada de TCP: resuelve con el primer socket conectado; destruye el resto. */
export function raceTcp(
  addrs: LookupAddress[],
  port: number,
  o: { tcp: TcpConnect; attemptDelayMs: number; attemptTimeoutMs: number },
): Promise<{ sock: Socket; address: LookupAddress }> {
  return new Promise((resolve, reject) => {
    const live = new Set<Socket>();
    const timers = new Set<NodeJS.Timeout>();
    const attempts: { family: number; reason: string }[] = [];
    let next = 0;
    let done = false;
    let stagger: NodeJS.Timeout | null = null;

    const finish = () => {
      done = true;
      if (stagger) clearTimeout(stagger);
      for (const t of timers) clearTimeout(t);
    };
    const failIfExhausted = () => {
      if (done || live.size > 0 || next < addrs.length) return;
      finish();
      const summary = attempts.map((x) => `IPv${x.family === 6 ? 6 : 4}: ${x.reason}`).join(", ");
      const allTimeout = attempts.length > 0 && attempts.every((x) => x.reason === "ETIMEDOUT");
      reject(
        new DialError(
          allTimeout
            ? `la ingesta no respondió a la conexión (${summary})`
            : `conexión con la ingesta fallida (${summary})`,
          allTimeout ? "timeout" : "network",
          attempts,
        ),
      );
    };
    const launch = () => {
      if (done || next >= addrs.length) return;
      const a = addrs[next++];
      let sock: Socket;
      try {
        sock = o.tcp(a.address, port, a.family);
      } catch (e) {
        // Ronda 1 (H-2) · un intento ESCALONADO corre dentro de un setTimeout: sin esto, una
        // excepción síncrona salía como uncaughtException y tumbaba el streamer.
        attempts.push({ family: a.family, reason: String((e as { code?: string }).code ?? "EXCEPTION") });
        if (stagger) clearTimeout(stagger);
        launch();
        failIfExhausted();
        return;
      }
      live.add(sock);
      const drop = (reason: string) => {
        if (!live.delete(sock)) return;
        clearTimeout(timer);
        timers.delete(timer);
        sock.destroy();
        attempts.push({ family: a.family, reason });
        // RFC 8305 §5 · un intento que FALLA no espera al escalón: se lanza el siguiente ya.
        if (!done) {
          if (stagger) clearTimeout(stagger);
          launch();
          failIfExhausted();
        }
      };
      const timer = setTimeout(() => drop("ETIMEDOUT"), o.attemptTimeoutMs);
      timers.add(timer);
      sock.once("error", (e: Error & { code?: string }) => drop(String(e.code ?? e.message)));
      sock.once("connect", () => {
        if (done || !live.has(sock)) return;
        live.delete(sock);
        finish();
        // Los perdedores se cancelan: nada queda colgado.
        for (const s of live) s.destroy();
        live.clear();
        sock.removeAllListeners("error");
        // Ronda 1 (P3) · entre resolver y que el publisher ponga su oyente hay un microtask:
        // un 'error' ahí, sin oyentes, lanzaría. El no-op sólo evita eso; los oyentes que
        // se añadan después lo siguen recibiendo.
        sock.on("error", () => {});
        resolve({ sock, address: a });
      });
      if (next < addrs.length) stagger = setTimeout(launch, o.attemptDelayMs);
    };
    launch();
    failIfExhausted();
  });
}

/**
 * Conecta con la ingesta y devuelve el transporte (TLS en rtmps). Rechaza con
 * `DialError` si ninguna dirección responde. Los errores de TLS (certificado)
 * llegan después, por el evento 'error' del socket TLS devuelto.
 */
export async function dialIngest(t: DialTarget, o: DialOptions = {}): Promise<Duplex> {
  const fam = isIP(t.host);
  let addrs: LookupAddress[];
  if (fam) addrs = [{ address: t.host, family: fam }];
  else {
    // Ronda 1 (H-3) · la resolución también tiene plazo: un DNS que no contesta no deja el
    // marcado pendiente para siempre.
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" })),
        o.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS,
      );
    });
    try {
      addrs = dialOrder(await Promise.race([(o.lookup ?? defaultLookup)(t.host), deadline]));
    } catch (e) {
      throw new DialError(`no se pudo resolver la ingesta (${(e as { code?: string }).code ?? "DNS"})`, "dns");
    } finally {
      clearTimeout(timer);
    }
  }
  if (addrs.length === 0) throw new DialError("la ingesta no tiene direcciones", "dns");
  const { sock } = await raceTcp(addrs, t.port, {
    tcp: o.tcpConnect ?? defaultTcp,
    attemptDelayMs: o.attemptDelayMs ?? DEFAULT_ATTEMPT_DELAY_MS,
    attemptTimeoutMs: o.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
  });
  if (t.protocol === "rtmp") return sock;
  return tlsConnect({
    socket: sock,
    host: t.host,
    // SNI y verificación del certificado contra el NOMBRE (no contra la IP marcada).
    servername: fam ? undefined : t.host,
    rejectUnauthorized: true,
    ...(o.tls?.ca ? { ca: o.tls.ca } : {}),
  });
}
