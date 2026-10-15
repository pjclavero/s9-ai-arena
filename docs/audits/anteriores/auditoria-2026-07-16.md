# Auditoría del proyecto — 2026-07-16

> Auditoría técnica realizada tras completar los 12 equipos del dosier (E1–E12) en su capa
> verificable sin Docker. Contrasta el dosier (`Dosier_tareas_S9_AI_Arena.md`, hitos M0–M5
> y checklist del cap. 14), las 12 entregas (`entrega-E*.md`) y el estado real del repo
> (suite verificada: 646 pasan / 1 falla de entorno / 3 skipped).

## 1. Estado global contra el plan del dosier

| Hito | Estado | Qué lo bloquea |
|---|---|---|
| M0 Contratos | ✅ Completo | — (ADR-000 aceptado, contratos publicados, compatibilidad.md) |
| M1 Motor demostrable | ⚠️ ~90% | Falta ver una batalla en vivo en un navegador real; primera ejecución real de la CI |
| M2 Juego completo | ✅ Completo en capa verificable | — (informe de balance 45–55% existe; replay CTF verifica) |
| M3 Plataforma y sandbox | ⚠️ ~70% | Suite de escape del sandbox nunca ejecutada contra contenedores vivos; etapas containerizadas del E2E en skip |
| M4 Competición automática | ⚠️ ~85% | El torneo E2E corre con bots stub del motor, no con bots de usuario en contenedores |
| M5 Público y producción | 🔴 ~40% | Sin emisión real a YouTube, sin simulacro de recuperación, checklist de producción sin empezar |

**La línea divisoria de todo lo pendiente es una sola: hasta hoy no existía ningún
entorno donde ejecutar Docker con salida a internet.**

## 2. Qué queda por hacer (por dependencia)

### 2.1 Decisión de infraestructura (bloquea el resto)

- VM108 tiene Docker pero sin salida a internet para pulls (detectado 2026-07-16;
  probable DNS/firewall/router — diagnóstico pendiente). Alternativas: repararla,
  crear una VM de staging separada (el checklist final exige staging y producción
  separadas), o usar la CI de GitHub Actions que E10 dejó definida.
- En ia-server (VM102): añadir `ia02` al grupo docker; subir Node a ≥22.15.

### 2.2 Cola de verificación con Docker (guionizada en las entregas)

1. Build de imágenes de runtimes y fijar digests reales de `DIGESTS.lock` (hoy placeholders).
2. Suite de escape del sandbox en vivo + `docker inspect` vs tabla 18.2 + Trivy (puerta M3).
3. `docker compose up` del stack completo, healthchecks 24 h, escaneo de puertos externo.
4. Simulacro de recuperación cronometrado < 2 h (puerta M5).
5. Emisión privada de 30 min a YouTube midiendo que no afecta al tick (puerta M5).
6. E2E con navegador real (Playwright) y medición de 60 fps del visor.

### 2.3 Deuda de integración entre equipos (no requiere Docker)

- **H2+H3**: el tournament-worker no cablea el espectador en vivo (`attachBattle`) ni las
  estadísticas ricas (`runStatsJob`) de E8; `battle_stats` tiene dos formas de escritura.
  Es el hueco funcional más visible: un torneo corre pero no se puede ver en directo.
- **H4**: la CI construye imágenes de solo 2 de 8 servicios.
- **H5–H7**: `cpuMs` sin rellenar (depende del runner), rutas de rating/standings por
  equipos, 7 errores de `tsc --noEmit` preexistentes (typecheck no bloqueante).

## 3. Fallos detectados

1. **H1 (P1, seguridad):** el análisis estático de E6 solo anota como hallazgo los
   builtins peligrosos de la stdlib (`socket`, `subprocess`…) en vez de bloquear; la
   contención real la da el sandbox Docker, no verificado en vivo. Con el estado actual,
   un bot hostil de solo-stdlib llegaría a `validated`. No abrir el registro de bots a
   terceros hasta tener el sandbox verificado o bloqueo estático.
2. **Placeholders con apariencia de configuración real:** digests `000…0` en
   `DIGESTS.lock` y hashes de lockfiles. Documentados, pero desplegables por error.
   Falta un guard que rechace arrancar con digests placeholder.
3. **Discrepancia de contrato E6↔E7:** E6 llama al estado final `published`; la máquina
   17.1 de E7, `validated`. E7 aplica 17.1 (correcto), pero la discrepancia sigue viva
   en E6 y morderá en la integración containerizada.
4. **La CI nunca ha corrido:** validada por parseo e inspección; hasta el primer run
   verde en GitHub, la puerta M1 ("CI operativa") no está realmente cruzada.
5. **Deriva documental (corregida hoy, sintomática):** ADR-000 estuvo "pendiente de
   firma" tras estar implementado; ROADMAP.md contradecía al dosier. Sostener la
   disciplina de `estado-proyecto.md`.

## 4. Mejoras recomendadas

- Ratificar ADR-010 (npm workspaces, Elo, Prometheus+restic). *(Ratificado por el
  operador el 2026-07-16 — ver ADR-010.)*
- Declarar `engines: node >=22.15` en el package.json raíz y alinear ia-server.
- Protección de rama en GitHub (ADR-010 D10.5): main gateada por CI; el flujo por PR
  ya es el vigente.
- Limpieza del prototipo v1 del repo (compose raíz + arena-server/viewer antiguos)
  cuando VM108 migre a la v2.
- Gestionar H1–H7 y las reconciliaciones como issues de GitHub (asignables, no se
  pierden en markdown).
- Provisionar en Vaultwarden los secretos con nombre (BD, firma de artefactos, RTMPS)
  antes del despliegue.

## 5. Conclusión

No queda ningún equipo del dosier por implementar: **lo pendiente es operación y
verificación, no desarrollo** — salvo el cableado H2/H3, único trabajo de código
sustantivo restante. Camino crítico: (1) entorno Docker, (2) primer run de CI verde,
(3) verificación containerizada de E6 (desbloquea el veredicto de seguridad),
(4) cierre de H2/H3, (5) checklist de producción M5.
