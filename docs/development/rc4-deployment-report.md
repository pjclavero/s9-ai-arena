# Informe de despliegue — RC4 (`f32ab2c`)

## Resumen

RC4 es la primera release desplegada en producción desde la auditoría. El commit desplegado es
`f32ab2c74e13e01a2df557e548ab36fb0be99ec0`. Se aplicó con el plan validado por REVIEW (pasos P0–P21 y
correcciones C1–C5), sin correcciones improvisadas en producción.

```
PRODUCTION COMMIT:  f32ab2c (RC4)
MAIN:               35a4fb9 (= f32ab2c + PR #172, sólo test y documentación; NO desplegado)
DESPLIEGUE:         P0–P19 PASS (2026-10-26) · golden final PASS · P20 PASS · P21 PASS (2026-10-27)
VEREDICTO:          DEPLOYMENT_VERIFIED
ROLLBACK:           no aplicado (no fue necesario)
```

## Índice

- [Relación entre 80baf4f y f32ab2c](#relación-entre-80baf4f-y-f32ab2c)
- [Qué cambió en producción](#qué-cambió-en-producción)
- [Golden path tras desplegar: tres intentos](#golden-path-tras-desplegar-tres-intentos)
- [Backup posterior al despliegue (P20)](#backup-posterior-al-despliegue-p20)
- [Observaciones](#observaciones)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Relación entre 80baf4f y f32ab2c

| Commit | Qué es | Contenido |
|---|---|---|
| `4cc7651` | base de RC3 (TD-062 fusionada, PR #167) | — |
| `80baf4f` | merge del PR #171 sobre `4cc7651` | chroot portable en el arnés de namespaces de CI (runner ubuntu-26.04); `body-parser` 2.4.0 y `multer` 2.5.0 por GHSA HIGH |
| `f32ab2c` | merge del PR #170 sobre `80baf4f` = **RC4** | `lock_check` del instalador del proxy portable bajo `mawk`, el `awk` por defecto de Debian 12, con tests mawk/gawk. Era el defecto que paró la ventana de RC3 en P12 |
| `35a4fb9` | merge del PR #172 sobre `f32ab2c` | sólo el test golden y la documentación de TD-065; **no se despliega** |

`f32ab2c` contiene `80baf4f`. Las imágenes desplegadas son las `sha-f32ab2c…` que publicó la CI de
`main`, con `BUILD_COMMIT`, la revisión OCI y `/version` iguales a `f32ab2c`.

## Qué cambió en producción

- **Imágenes:** 10 servicios pasan a `sha-f32ab2c…`, verificados por Id. Nueve se recrean en P11
  (`RUNTIME_MATCH` en P17) y `backup` en P20. `postgres` y `queue` no cambian (mismo PID).
- **Migraciones:** `011` → `013` (`012_bot_versioning` y `013_battle_claim`); el bootstrap es idempotente.
- **Secreto nuevo:** `artifact_verify_key.pem`, derivado de la clave de firma. TD-064: preflight PRE y POST en PASS.
- **Proxy de Docker:** se instala como artefacto de root (TD-062): bundle fuera del árbol, allowlist en
  `/etc`, unidad endurecida y preflight instalado en VERDE. El proxy de RC1 sigue *disabled*.
- **Comprobaciones del proxy:**
  - red: matriz 12/12 en P15;
  - política: imagen ajena y control sobre contenedores ajenos → 403 en P16;
  - TD-057: `chown` del árbol en P18, después del preflight y nunca antes; TD-062 en VERDE después.
- **Ejecución real de batallas:** activada en P19, con batallas en contenedores a través del proxy.
- **Replays:** sólo por la API. El gateway responde 404 en `/replays*`. Un anónimo y un usuario ajeno reciben
  el mismo 404 que con una batalla inexistente.
- **Firewall de host:** el instalado en RC3 se conserva y se verifica.

## Golden path tras desplegar: tres intentos

La spec es `tests/browser/specs/golden-path.spec.ts`, en Chromium real, por la ruta pública real (TLS → gateway →
API). Recorrido: registro → 2 bots buildeados y publicados → equipo → mapa → batalla real → visor en
directo → `finished` → stats → replay reproducido en la web.

| Intento | Resultado | Causa |
|---|---|---|
| **Golden #1** | FAIL | **presión de memoria del hipervisor** (swap-out sostenido, carga muy alta y un *RCU stall* en la VM). Clasificado como fallo de capacidad de infraestructura, no del producto. RC4 se mantuvo, sin rollback |
| **Golden #2** | FAIL | **carrera de materialización de `battle_stats`**: el test leyó stats justo al ver `status=finished`, y el worker las escribe después de cerrar la transacción (unos 1,4 s más tarde). La batalla y los stats eran correctos. Producto PASS; contrato del test FLAKY ([TD-065](../roadmap/technical-debt.md#td-065)) |
| **Golden final** | **PASS** | después de corregir la espera del test (PR #172: `expect.poll` acotado a 12 s; si no aparecen los stats de los dos bots, el test falla y nunca pasa sin datos). Se ejecutó la spec de `35a4fb9` contra producción en `f32ab2c` |

Evidencia del golden final, verificada por separado del exit code:

- **Navegador:** 1 passed (2,3 min); visor `live`; replay por `/api/v1/replays/<id>/index` (200) y
  `/segment` (200 ×2); 0 peticiones a `/replays*` del gateway.
- **Backend:** batalla `finished` con `run_attempts=1` y un único job `done` (`attempts=1`). Los
  participantes son las versiones `published` con build `passed`. `battle_stats` tiene 2 filas: el bot que
  dispara hizo 11 disparos y el otro 0. Hay `replay_ref`, y el hash del replay coincide con el del backup.
- **Autorización:** el anónimo y el usuario ajeno reciben el mismo 404 sobre el replay real (index y
  segment) que sobre uno inexistente.
- **Capacidad:**
  - monitor activo y comprobado antes de lanzar Chromium;
  - durante la prueba, swap-out 0, presión de memoria 0, ningún OOM, ningún *RCU stall* nuevo y ningún reinicio de servicios;
  - para el golden #2 y el final se detuvo temporalmente una VM no relacionada del mismo hipervisor, que volvió a arrancarse al terminar.

## Backup posterior al despliegue (P20)

- `backup` recreado con `sha-f32ab2c…` (Id verificado), healthy; `postgres` con el mismo PID.
- Copia con un envoltorio que intercepta `forget`/`prune`, calibrado antes de usarlo, y un
  `RESTIC_HOSTNAME` propio de la ventana (TD-054). Resultado: `backup SUCCESS` y `restic check` sin errores.
- `evidence.sh --snapshot` rc 0. Restauración temporal: dump igual al manifest; `pg_restore -l`
  rc 0 (35 tablas); 8 ficheros de replay con checksum correcto, entre ellos los de la batalla del golden final;
  secretos 16/16 idénticos. Las restauraciones temporales se borraron y se comprobó que no quedaba nada.
- Ningún snapshot perdido **por la ventana**. Los dos que faltan respecto a P1 los retiró el backup
  nocturno de producción con su retención normal (`--keep-daily 14 --keep-weekly 8 --keep-monthly 12`).

## Observaciones

- **Listado de snapshots justo después de recrear `backup`:** el primer acceso al repositorio falló una
  vez por un error transitorio de la sesión SFTP. Lo siguiente (backup, check y listado) sí funcionó.
  La pérdida cero se demostró comparando con el listado de P1.
- **Cache de stats:** `GET /battles/<id>/stats` responde `Cache-Control: public, max-age=60` incluso
  cuando `perBot` está vacío. Se anota en TD-065.
- **Bug de la herramienta de la ventana, no del producto:** la línea `data_restore_removed=` del verificador de P1 y P20
  no probaba nada (`[` mal formado). La ausencia se comprobó aparte, de forma directa.
- **Residuos de RC3** (clon y carpeta de trabajo de `4cc7651`) y unas 743 rutas de root heredadas: se
  conservan y los decide el operador.

## Documentación relacionada

- [current-status.md](../roadmap/current-status.md) · [technical-debt.md](../roadmap/technical-debt.md)
- [upgrades.md](../operations/upgrades.md) (RC2 y TD-062) · [backup.md](../operations/backup.md)
- [releases.md](releases.md) · [production-readiness-report.md](production-readiness-report.md)

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| Producción en `f32ab2c`, 12/12 healthy | RUNTIME_VERIFIED (2026-10-27) | `git rev-parse` del árbol y `docker inspect` en el host (lectura) |
| `main` = `35a4fb9`; CI de push contada (30 success, 1 neutral = Semáforo AMARILLO, igual que en `f32ab2c`) | RUNTIME_VERIFIED (GitHub) | check-runs del commit |
| Golden final PASS con la verificación del backend y de autorización | RUNTIME_VERIFIED (producción) | evidencia de la ventana (fuera del repo, sin topología) |
| PR #172 no puede pasar sin datos | CODE_VERIFIED | REVIEW independiente: 4 casos en rojo y 1 en verde con `@playwright/test` 1.48.2 |
| P20: backup, check, evidence, restore y secretos | RUNTIME_VERIFIED (producción) | salidas de P20 de la ventana |
