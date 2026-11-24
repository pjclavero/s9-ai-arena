# replay-service (E8 · T8.1)

Formato y herramientas de replays (cap. 20 y 23.1). Desde V1 REPLAYS el formato en disco es
**S9R/1**: receta `<battleId>.<intento>.s9r` (comandos, hashes y checkpoints por fragmentos) y
vista `<battleId>.<intento>.s9v` (snapshots, eventos y keyframes), publicadas por el
tournament-worker con `ReplayRecorder` + `publishPair` (prueba de cierre) e inventariadas en
`replay_artifacts`. El código del formato vive en `src/s9r/`.

```bash
npx tsx apps/replay-service/src/cli.ts verify <battleId> --dir data/arena_replays
npx tsx apps/replay-service/src/cli.ts verify --file <receta.s9r>
```

El proceso de servicio (`src/main.ts`) sólo expone `/healthz` y `/version` y comprueba que el
volumen es escribible: **no sirve ni ingiere replays**. Los lee la API por fragmentos
(`apps/api/src/replay-s9r.ts`, rutas `/api/v1/replays/*`).

V1 REPLAYS PR-4b · RETIRADO (corte D-OP-30): el JSONL v2 (`toJsonl`/`fromJsonl`), el almacén
`store.ts` (ingesta, listado, retención), `segment.ts`, las rutas HTTP antiguas (`server.ts`,
`POST /replays/:id`, `/retention/sweep`), su credencial (`auth.ts`) y los comandos de CLI
`ingest`, `sweep` y `serve`. Para tests y herramientas, `src/s9r/replay-file.ts` escribe y lee un
replay completo en S9R/1.

T8.4 (pipeline de estadísticas) vive también aquí: `src/stats.ts`.
