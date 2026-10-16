/**
 * FC-D · TD-028 — Sonda de RUNTIME del contrato del ticket de espectador a
 * través de la cadena real: TLS (proxy tipo VM104) → gateway nginx (`/ws/`) →
 * tournament-worker (SpectateGateway) — tres procesos distintos.
 *
 * Firma un ticket con `signSpectateTicket` usando el JWT_SECRET_FILE que se le
 * pase (el de la API, o uno ajeno como control negativo) y abre el WebSocket
 * como lo hace el navegador (ticket en el subprotocolo). Imprime el código de
 * cierre:
 *   4404 battle_not_live  ⇒ el worker VERIFICÓ el ticket (la batalla no está viva);
 *   4401 invalid_ticket   ⇒ el worker NO comparte el secreto del emisor.
 *
 * Uso: JWT_SECRET_FILE=<f> tsx ticket-probe.ts <wssBase> <battleId>
 * Salida: una línea JSON {code, reason}. rc=0 siempre que obtenga un cierre.
 */
import { WebSocket } from "ws";
import { signSpectateTicket } from "../../../apps/api/src/auth/tokens.js";

const [base, battleId] = process.argv.slice(2);
const ticket = signSpectateTicket({ battleId, jti: `probe-${Date.now()}` }, 60);
const ws = new WebSocket(`${base}/${battleId}`, ["spectate.v1", `ticket.${ticket}`], { rejectUnauthorized: false });
const timer = setTimeout(() => {
  console.log(JSON.stringify({ code: null, reason: "timeout" }));
  process.exit(3);
}, 10_000);
ws.on("close", (code, reason) => {
  clearTimeout(timer);
  console.log(JSON.stringify({ code, reason: String(reason) }));
  process.exit(0);
});
ws.on("error", (e) => {
  clearTimeout(timer);
  console.log(JSON.stringify({ code: null, reason: `error: ${e.message}` }));
  process.exit(4);
});
