> **DOCUMENTACIÓN HISTÓRICA**
> Estos documentos describen diseños, estados o procedimientos anteriores.
> No deben utilizarse como guía de funcionamiento actual.

# Funciones completadas que figuraban como pendientes (auditoría 2026-11-02)

Al auditar [pending-features.md](../../roadmap/pending-features.md) contra `main` (`e3bf2fa`) se comprobó que estas funciones
ya existen. Salieron de la lista de pendientes y se anotan aquí con el PR que las completó (comprobado con
`gh pr list --state merged` y `git log`) y la evidencia. La clasificación completa, con las que siguen
pendientes o parciales, está en [la auditoría](../../audits/2026-11/PENDING-AUDIT.md).

| Función | Completada en | Fecha de fusión | Evidencia |
|---|---|---|---|
| Cierre del ciclo de vida de la batalla en el camino real (`finished`, hashes, `replay_ref`, `battle_stats`) | PR #152 «cierre funcional» | 2026-10-18 | `apps/tournament-worker/src/battle-runner.ts:164,470,534,556`; migración `013_battle_claim`; `battle-lifecycle.test.ts`; `tests/browser/specs/golden-path.spec.ts` |
| Gobernanza de la lectura anónima de replays (una sola autoridad y gateway cerrado) | PR #158 «Production Readiness» (TD-004) | 2026-10-18 | `apps/api/src/replay-access.ts`; `td004-replay-access.test.ts`; `infrastructure/gateway/tests/replay-gateway.test.ts` |
| Política única de lectura de batallas, estadísticas y diagnóstico | PR #178 (UX-D), integrado por #180 | 2026-10-27 | `apps/api/src/battle-access.ts`; `uxd-battle-access.test.ts` |
| Guardado del editor de mapas (guardar, reabrir, publicar) | PR #152; editor visual en PR #196 | 2026-10-18 / 2026-11-01 | `apps/web/src/pages/MapEditorPage.tsx:279`; `openapi.yaml` `saveMapDraft`; `tests/browser/specs/map-editor.spec.ts` |
| Ejecución real de batallas con el código de cada bot | PR #152 | 2026-10-18 | `apps/bot-manager/src/bot-launch.ts`; `apps/tournament-worker/src/container-agents.ts`; `container-battle-e2e.test.ts` |
| Onboarding en la web con enlace a las plantillas | PR #175 (UX-A) y PR #210 (Centro de Ayuda) | 2026-10-27 / 2026-11-02 | `apps/web/src/pages/HomePage.tsx`; `apps/web/src/help/`; `tests/browser/specs/onboarding.spec.ts` |
| Pool de mapas de los torneos | PR #152 | 2026-10-18 | `apps/tournament-worker/src/scheduler.ts:108-134,168` |
| Reglas oficiales de batalla con copia inmutable, desempates y CTF con prórroga (motor 0.4.0) | PR #201 | 2026-11-02 | `docs/adr/ADR-022-motor-0-4-0-reglas-ctf-prorroga.md`; migración `016_battle_rules` |
| Batallas por equipos 4 contra 4 | PR #189 | 2026-10-29 | `apps/api/src/routes/battles.ts` (`MAX_PARTICIPANTS_PER_TEAM`); `tests/browser/specs/team-battle-4v4.spec.ts` |
| Frontera de privilegio y ámbito del proxy de Docker | PR #164 (RC2) y PR #167 | 2026-10-21 | `infrastructure/scripts/install-docker-proxy.sh`; `functional-e2e / container-proxy-e2e` |
