/**
 * s9-smoke-bot — smoke bot para pruebas E2E de arena/1 (s9-ai-arena).
 *
 * Bot minimalista que implementa el protocolo arena/1 directamente (sin SDK):
 *  - Hace HELLO con el token de batalla recibido por env.
 *  - Recibe WELCOME y ajusta decisionEveryNTicks.
 *  - En cada OBSERVATION: avanza con zigzag lento, gira la torreta y dispara
 *    si hay contactos de radar.
 *  - Sale limpiamente en SHUTDOWN (code 0) o en error de red (code 1).
 *
 * Entorno de ejecución: nodo runtime image del proyecto (ver Dockerfile).
 * Variables de entorno requeridas:
 *   ARENA_WS_URL    WebSocket URL del motor (ej. ws://127.0.0.1:8081)
 *   BOT_ID          Identificador del bot en la batalla (ej. smoke-bot-red)
 *   BATTLE_TOKEN    Token para el handshake arena/1 HELLO
 *
 * Nota: se escribe en CJS ('use strict' + require) para evitar dependencias
 * de package.json con "type": "module" — la imagen de runtime NO incluye un
 * /bot/package.json y Node trata /bot/main.js como CJS por defecto.
 */
'use strict';
const { WebSocket } = require('ws');

// ── configuración de entorno ─────────────────────────────────────────────────
const ARENA_WS_URL  = process.env.ARENA_WS_URL  || 'ws://127.0.0.1:8081';
const BOT_ID        = process.env.BOT_ID        || 'smoke-bot';
const BATTLE_TOKEN  = process.env.BATTLE_TOKEN  || '';
const BOT_VERSION   = process.env.BOT_VERSION   || '1.0.0';
const LOG_FORMAT    = process.env.LOG_FORMAT    || 'text';

// ── logging ───────────────────────────────────────────────────────────────────
function log(level, msg, extra) {
  if (LOG_FORMAT === 'json') {
    process.stderr.write(JSON.stringify({ level, service: 's9-smoke-bot', botId: BOT_ID, msg, ...extra }) + '\n');
  } else {
    process.stderr.write(`[${level}] ${BOT_ID}: ${msg}\n`);
  }
}

// ── estado del bot ────────────────────────────────────────────────────────────
let seq = 0;
let decisionEveryNTicks = 3;
let connected = false;
let tickCount = 0;

function sendMsg(ws, type, payload, tick) {
  const msg = { proto: 'arena/1', type, seq: seq++, payload };
  if (tick !== undefined) msg.tick = tick;
  try {
    ws.send(JSON.stringify(msg));
  } catch (e) {
    log('warn', `send ${type} failed: ${e.message}`);
  }
}

// ── IA del smoke-bot ──────────────────────────────────────────────────────────
/**
 * Devuelve un COMMAND para el tick de observación dado.
 * Estrategia: zigzag con steer alternante, torreta rotando, disparo si hay radar.
 */
function decideCommand(obs) {
  const radarContacts = (obs.sensors && obs.sensors.radar) ? obs.sensors.radar : [];
  const hasTarget = radarContacts.length > 0;

  // Zigzag: alterna steer cada 30 ticks
  const steer = (Math.floor(tickCount / 30) % 2 === 0) ? 0.4 : -0.4;

  // turret solo admite targetHeading/targetPoint (command.schema.json); "turn"
  // no es un campo válido. Barrido lento y continuo del ángulo absoluto.
  const targetHeading = ((tickCount * 0.05) % (2 * Math.PI)) - Math.PI;

  const command = {
    move: { throttle: 0.6, steer },
    turret: { targetHeading },
  };
  // "fire" es un array de slotId a nivel del comando, no un campo de turret.
  if (hasTarget) command.fire = ['turret_main'];

  return command;
}

// ── conexión WebSocket ────────────────────────────────────────────────────────
log('info', `conectando a ${ARENA_WS_URL}`);
const ws = new WebSocket(ARENA_WS_URL);

ws.on('open', () => {
  connected = true;
  log('info', 'conexión abierta, enviando HELLO');
  sendMsg(ws, 'HELLO', {
    botId: BOT_ID,
    botVersion: BOT_VERSION,
    battleToken: BATTLE_TOKEN,
    sdk: { name: 'arena-sdk-js', version: '0.1.0' },
  });
});

ws.on('message', (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return; // mensaje malformado: ignorar (regla 5 del protocolo)
  }
  if (!msg || typeof msg !== 'object') return;
  if (msg.proto !== 'arena/1') return;

  switch (msg.type) {
    case 'WELCOME':
      decisionEveryNTicks = msg.payload?.timing?.decisionEveryNTicks ?? 3;
      log('info', 'WELCOME recibido', { decisionEveryNTicks, battleId: msg.payload?.battleId });
      // Señal de readiness para el healthcheck de la plataforma.
      try {
        require('fs').writeFileSync('/tmp/alive', '1');
      } catch { /* /tmp puede no estar disponible fuera del contenedor */ }
      break;

    case 'OBSERVATION': {
      const obs = msg.payload;
      tickCount++;
      const forTick = obs.tick + decisionEveryNTicks;
      const intent = decideCommand(obs);
      sendMsg(ws, 'COMMAND', { ...intent, forTick }, forTick);
      break;
    }

    case 'EVENT':
      // Eventos informativos: se registran pero no cambian la estrategia del smoke-bot.
      log('debug', `EVENT ${msg.payload?.kind ?? 'unknown'}`, { tick: msg.tick });
      break;

    case 'SHUTDOWN':
      log('info', 'SHUTDOWN recibido', {
        reason: msg.payload?.reason,
        outcome: msg.payload?.result?.outcome,
      });
      ws.close();
      process.exit(0);
      break;

    default:
      // Regla 5: tipos desconocidos se ignoran.
      break;
  }
});

ws.on('close', (code) => {
  if (connected) {
    log('info', `WebSocket cerrado (code=${code})`);
  }
  process.exit(0);
});

ws.on('error', (err) => {
  log('error', `error WebSocket: ${err.message}`);
  process.exit(1);
});

// Timeout de seguridad: si en 30 s no se completa el handshake, salir.
const startupTimeout = setTimeout(() => {
  if (!connected) {
    log('error', 'timeout de arranque: no se conectó en 30 s');
    process.exit(1);
  }
}, 30_000);
startupTimeout.unref();
