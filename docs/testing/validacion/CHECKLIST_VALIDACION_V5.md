# Checklist de validación V5 — Roadmap R13/R14/R16 + regression locks

> Sucede a `CHECKLIST_VALIDACION_V4.md`. Cubre esta actualización documental y las condiciones
> para las PRs de código que vengan después. Verificado contra `main@e9438f9`.

## A. Checklist de documentos

- [x] `ROADMAP.md` refleja la secuencia: #50 → #51 → #52 → **R13.0** → R10 → R13.1 → R11 → R13.2 →
      R12 → R16 → R14 → R13.5 → save/load·latencia·sharding.
- [x] `ESTADO_ACTUAL.md` marca #50/#51/#52 **mergeadas** y #53/#41 abiertas; `main@e9438f9`.
- [x] `NEXT_PHASE_R10_R11_R12.md` no dice que R10/R11/R12 sean greenfield (ya se corrigió en #52).
- [x] `R13_ENGINE_RUNTIME_QUALITY.md` con auditoría de los 3 fallos.
- [x] `ENGINE_REGRESSION_LOCKS.md` con tests/criterios/ficheros/comandos/done.
- [x] `R14_WEBRTC_STREAMING.md` con dependencia de R11 y RTMP fuera de alcance.
- [x] `R16_VISUAL_UPGRADE.md` con fases R16.1–R16.8 (básico primero).
- [x] `CHECKLIST_VALIDACION_V5.md` (este).

## B. Checklist de seguridad (esta PR: solo docs → sin cambios de código)

Greps (deben seguir sin introducir nada nuevo):

```bash
grep -R "/var/run/docker.sock" .
grep -R "privileged: true" .
grep -R "network_mode: host" .
grep -R "seccomp=unconfined" .
grep -R "DOCKER_PROXY_URL" apps/web || true
grep -R "SECRET" apps/web || true
grep -R "TOKEN" apps/web || true
```

- [x] Esta PR **no** toca código: no añade sock/privileged/host-net/unconfined.
- [x] No expone `DOCKER_PROXY_URL` ni secretos en frontend.
- [x] No abre puertos ni cambia dominios. VM108/VM104/runner/proxy intactos.

## C. Checklist de no solapes

- [x] Rama **solo docs** `docs/roadmap-engine-visual-streaming-updates`; no toca código.
- [x] No pisa #53 (R10, código frontend) ni #41.
- [x] R13/R14/R16 quedan en **PRs separadas** de R10/R11/R12 cuando se implementen.
- [ ] (Futuro) cada PR de código integra su propio conteo OpenAPI si toca el contrato.

## D. Checklist de fallos críticos (auditoría)

- [x] **radio `Map`**: estado (parcial), test (falta), docs (añadidos), acción (R13.0). **No cerrado.**
- [x] **acoustic**: código vivo, test **vacuo**, docs (añadidos), acción (test no vacuo en R13.0). **No cerrado.**
- [x] **ammo**: código **arreglado**, test negativo presente / positivo+respawn faltan, acción (R13.0). **No cerrado del todo.**
- [x] Ninguno se declara "cerrado" sin evidencia de código **y** test.

## E. Checklist de roadmap

- [x] R13.0 = siguiente PR recomendado tras #50/#51/#52.
- [x] R10/R11/R12 separados de R13/R14/R16.
- [x] R14 **no** se adelanta a R11.
- [x] R16 empieza por básico, **no** WebGL avanzado/CDN.
- [x] Rapier (R13.5) solo evaluación en rama separada; no update directo.
- [x] save/load, latencia, sharding = posterior por riesgo.

## F. Checklist de PRs / CI

- [x] #50/#51/#52 mergeadas con CI verde (histórico verificado).
- [x] #53 (R10) draft, CI verde.
- [ ] Esta PR de docs: CI verde (pendiente de ejecutar tras push).
- [x] `npm run lint/typecheck/test/format`: sin cambios de código, no aplican fallos nuevos; se
      ejecutan igualmente como control (ver sección de QA del informe).
