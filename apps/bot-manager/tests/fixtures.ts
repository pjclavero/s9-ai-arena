/**
 * Fixtures compartidas de los tests de bot-manager: submissions de bot Python/JS y
 * fábricas de agente en-proceso (candidatos) que sustituyen al contenedor real.
 */
import type { BotSubmission, CandidateAgentFactory, SourceFile } from "../src/types.js";
import { ForwardBot, HunterBot } from "../../arena-engine/src/stubs.js";

export function pyGoodFiles(): SourceFile[] {
  return [
    { path: "requirements.txt", content: "# deps del bot\narena-sdk==1.0.0\nnumpy==1.26.4\n" },
    { path: "requirements.lock", content: "arena-sdk==1.0.0\nnumpy==1.26.4\n" },
    { path: "manifest.json", content: JSON.stringify({ runtime: "python", entry: "src/bot.py" }, null, 2) },
    {
      path: "src/bot.py",
      content: [
        "import os",
        "import math",
        "import numpy as np",
        "from arena_sdk import Bot",
        "",
        "class MyBot(Bot):",
        "    def decide(self, obs):",
        "        return {'forTick': obs['tick'], 'move': {'throttle': 1.0, 'steer': 0.0}}",
        "",
      ].join("\n"),
    },
  ];
}

export function jsGoodFiles(): SourceFile[] {
  return [
    {
      path: "package.json",
      content: JSON.stringify(
        { name: "bot", version: "1.0.0", dependencies: { "@arena/sdk": "1.0.0", ws: "^8.18.0" } },
        null,
        2,
      ),
    },
    { path: "package-lock.json", content: JSON.stringify({ lockfileVersion: 3, packages: {} }, null, 2) },
    {
      path: "src/bot.js",
      content: [
        "import { WebSocket } from 'ws';",
        "import { createBot } from '@arena/sdk';",
        "export function decide(obs) {",
        "  return { forTick: obs.tick, move: { throttle: 1, steer: 0 } };",
        "}",
        "",
      ].join("\n"),
    },
  ];
}

export function pyBadDepFiles(): SourceFile[] {
  // Declara una dependencia fuera de la allowlist en el manifiesto (y su lockfile), sin
  // importarla en el código: así el fallo cae en la etapa `dependencies` (allowlist del
  // manifiesto), no en `static_analysis` (imports). El caso de import prohibido lo cubre
  // static-analysis.test.ts.
  const files = pyGoodFiles();
  const req = files.find((f) => f.path === "requirements.txt")!;
  req.content += "requests==2.31.0\n"; // fuera de allowlist
  const lock = files.find((f) => f.path === "requirements.lock")!;
  lock.content += "requests==2.31.0\n";
  return files;
}

export function pySecretFiles(): SourceFile[] {
  const files = pyGoodFiles();
  const bot = files.find((f) => f.path === "src/bot.py")!;
  // Clave AWS de EJEMPLO (formato AKIA + 16), no una credencial real.
  bot.content = "AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'\n" + bot.content;
  return files;
}

export function submission(files: SourceFile[], overrides: Partial<BotSubmission> = {}): BotSubmission {
  return {
    botId: "bot_test",
    version: 1,
    ownerUserId: "user_owner",
    runtime: "python",
    archetype: "scout",
    files,
    ...overrides,
  };
}

/** Candidato "bueno": comandos válidos cada ciclo (ForwardBot de E5). */
export const goodCandidate: CandidateAgentFactory = {
  create(botId: string) {
    return new ForwardBot(botId);
  },
};

/** Candidato que compila pero INCUMPLE protocolo: throttle fuera de [-1,1] (signedUnit). */
export const brokenProtocolCandidate: CandidateAgentFactory = {
  create(botId: string) {
    return {
      botId,
      decide(obs: any) {
        return { forTick: obs.tick, move: { throttle: 5, steer: 0 } }; // 5 > 1 → viola command.schema
      },
    };
  },
};

/** Candidato que agota su presupuesto de CPU por decisión (bucle ocupado). */
export const slowCandidate: CandidateAgentFactory = {
  create(botId: string) {
    return {
      botId,
      decide(obs: any) {
        const end = performance.now() + 250; // > maxDecisionMs (100 ms)
        while (performance.now() < end) {
          /* busy */
        }
        return { forTick: obs.tick, move: { throttle: 0, steer: 0 } };
      },
    };
  },
};

/** Bot de referencia de E5 para la partida de humo. */
export function referenceAgent(botId: string) {
  return new HunterBot(botId);
}
