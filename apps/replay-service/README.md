# replay-service (E8 · T8.1)

Servicio y formato de replays (cap. 20 y 23.1). El contenido lógico es el JSONL de E2
(`apps/arena-engine/src/replay.ts`, importado, no reimplementado); este servicio añade la
capa de almacenamiento: compresión (zstd; gzip de reserva en Node < 22.15), checksum
sha256, índice de keyframes para salto temporal y política de retención 23.1 (los
temporales caducan, los oficiales se conservan siempre).

```bash
npx tsx apps/replay-service/src/cli.ts verify <battleId> --dir data/arena_replays
npx tsx apps/replay-service/src/cli.ts ingest <replay.jsonl> --official
npx tsx apps/replay-service/src/cli.ts sweep
npx tsx apps/replay-service/src/cli.ts serve --port 8082
```

HTTP: `GET /replays/:id` (con rango de bytes), `GET /replays/:id/index` (keyframes),
`GET /replays/:id/segment?fromTick&toTick` (salto temporal), `POST /replays/:id`
(ingesta), `POST /replays/:id/verify` (re-simulación, criterio cap. 28).

La operación pública `verifyReplay` del contrato OpenAPI la sirve la API de E7
(`apps/api/src/routes/battles.ts`) usando este servicio. T8.4 (pipeline de estadísticas)
vive también aquí: `src/stats.ts`.
