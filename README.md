# S9 AI Arena

Prototipo inicial de una arena 2D programable con servidor autoritativo, bots externos y visor web.

## Incluido en este primer bloque

- Monorepo TypeScript con pnpm.
- Servidor WebSocket autoritativo.
- Protocolo compartido versionado.
- Dos bots de demostración ejecutados como contenedores independientes.
- Movimiento, torreta, disparos, impactos, daño y límites de arena.
- Visor web Phaser en tiempo real.
- Despliegue completo mediante Docker Compose.

## Arranque

Requisitos: Docker Engine y Docker Compose v2.

```bash
git clone https://github.com/pjclavero/s9-ai-arena.git
cd s9-ai-arena
docker compose up --build
```

Abrir:

- Visor: http://localhost:3000
- Salud del servidor: http://localhost:8081/health

## Arquitectura

- `apps/arena-server`: simulación autoritativa y conexiones WebSocket.
- `apps/arena-viewer`: visor Phaser servido por Nginx.
- `packages/protocol`: contratos compartidos entre motor, bots y visor.
- `bots/bot-red`: bot de demostración ofensivo.
- `bots/bot-blue`: bot de demostración evasivo.

## Estado

Este es un prototipo de Sprint 1-3. Todavía no contiene Rapier, mapas, módulos, sensores reales, usuarios, torneos ni persistencia.

## Próximo bloque

1. Añadir Rapier 2D.
2. Separar motor de transporte WebSocket.
3. Incorporar mapas JSON y muros sólidos.
4. Añadir registro de eventos y repetición básica.
5. Endurecer aislamiento de contenedores de bots.
