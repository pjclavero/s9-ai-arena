# 14 · Plan de entrega de la versión presentable (A+)

Sujeto: main 8f380eb · Fecha: 2026-11-19 · Estado: FASE 1 (estática) — FASE 2 pendiente

Propósito: ordenar el backlog de A+ en fases, carriles paralelos con propiedad de ficheros disjunta y puntos de control (congelación y GO), identificando el camino crítico y los cuellos de botella. Documento maestro: [FINAL-PRODUCT-AUDIT.md](FINAL-PRODUCT-AUDIT.md). Tareas: [13-PRIORITIZED-BACKLOG.md](13-PRIORITIZED-BACKLOG.md) · Contrato: [12-RELEASE-DEFINITION-OF-DONE.md](12-RELEASE-DEFINITION-OF-DONE.md) · Brecha y opciones: [11-RELEASE-GAP-ANALYSIS.md](11-RELEASE-GAP-ANALYSIS.md).

**Sin fechas.** Las duraciones son **rangos derivados de las estimaciones** de los informes (S = 0,5 d, M = 1-3 d, L = 5-10 d por persona) y se declaran como tales: no son mediciones ni compromisos. No incluyen esperas que no dependen del equipo (decisiones del operador, apertura de FASE 2, ejecuciones nocturnas de calendario, disponibilidad de la persona ajena).

## 1. Restricciones del entorno que condicionan el plan

1. **Las pruebas pesadas no se ejecutan en la máquina de orquestación.** Builds de imágenes, Playwright, cargas, escaneos de imágenes, ensayos de instalación y restore y calibraciones de mutantes van al **laboratorio aislado** o a CI.
2. **El host de producción comparte hipervisor con otros sistemas.** Nunca se ejecutan pruebas de carga ni de caos contra producción; en producción sólo lectura (T-23), con lista de comandos aprobada antes. Si el laboratorio comparte hipervisor con producción, las pruebas de carga del laboratorio llevan límites de CPU/RAM y no coinciden con ventanas de despliegue del operador.
3. **FASE 2 está bloqueada** hasta que cierre la migración de producción en curso y el operador confirme que no hay operaciones críticas (00-PRERREQUISITOS #2 y #5). El laboratorio puede abrirse antes que la lectura de producción si el operador lo autoriza.
4. **Un único laboratorio = recurso en serie.** Dos calibradores de mutantes o dos ensayos sobre el mismo árbol o el mismo laboratorio no se ejecutan a la vez; se commitea antes de calibrar (el harness revierte el árbol).
5. **Secretos nunca en la línea de comandos** (contraseñas de `create-admin`, claves de prueba): stdin o fichero 0600.
6. **Aislamiento entre carriles por worktree y propiedad de ficheros disjunta** (§3), no por acuerdo verbal: es lo que hace recuperable un accidente.
7. **Merges a main** sólo con CI verde contando las conclusiones de todos los jobs (no la cola de `--watch`); los jobs de staging que hoy dan `success` sin hacer nada (QA-04) no cuentan como evidencia.

## 2. Fases

| Fase | Objetivo | Tareas | Entrada | Salida (puerta) | Rango derivado |
|---|---|---|---|---|---|
| **F0** · Decisiones del operador + FASE 2 de auditoría | Fijar el alcance real de A+ antes de comprometer F1 | Decisiones D-OP-1…8 (abajo); T-02; FASE 2: T-22, T-23, T-24, T-25, T-26 (1.ª pasada) y las mediciones de T-16 y T-18 | Este plan aceptado; laboratorio disponible; para T-23, migración cerrada | Decisiones registradas; actas FASE 2 con «confirma/refuta»; condicionales asignadas a grupo (T-38, T-39, T-44, T-49, T-62, remediaciones de T-16/T-18); backlog re-emitido | Laboratorio en serie: 4,5 – 12,5 d-p (T-22 + T-23 + T-24 + T-25 + T-26) + mediciones de T-16/T-18 (incluidas en sus tareas). Decisiones: no estimable |
| **F1** · Bloqueantes en paralelo por carriles | Implementar el grupo A | L1: T-06, T-07, T-08, T-09, T-19 · L2: T-11, T-12, T-13, T-14 (API) · L3: partes web de T-12/T-13/T-14 y golden D8 · L4: T-10 (flujo), T-17, cableado de gates · L5: T-15, T-16 (prueba), T-18 (remediación) · L6: T-01, T-03, T-04 (borrador) | Para tareas sin dependencia de F0 (T-06, T-11, T-15, T-17, borrador de T-04) puede empezar **en paralelo a F0**; el resto tras la puerta de F0 | Cada tarea con su evidencia de cierre en CI | Carril más largo: L1 ≈ 5,5 – 10 d-p o L2 ≈ 3,5 – 12,5 d-p (con L3 en paralelo) → **≈ 5,5 – 12,5 d** de calendario con una persona por carril y sin esperas |
| **F2** · Integración y condicionales | Validar en laboratorio lo que sólo se ve con la cadena completa; cerrar lo que FASE 2 subió a A | T-07/T-08 validados (S04), T-13 con build real en laboratorio, T-05, T-04 final, T-09 con cifras, T-19 en laboratorio, T-20 (restore), condicionales promovidas | F1 cerrado en sus carriles | Todo el grupo A cerrado salvo lo que §6 reserva al SHA congelado; **SHA candidato** identificado | Dominado por el camino crítico (§4) y por T-20 (1 – 3 d de laboratorio); condicionales: UNKNOWN hasta F0 |
| **F3** · Congelación, release candidate, ensayo por tercero, GO | Producir un único SHA y demostrar el contrato sobre él | Tag `v0.x.y-rc.N`; CI completa; N = 7 nocturnas; T-21; re-escaneo T-18; repetición de T-26 (visitante anónimo, instancia nueva); T-20 si procede; D21; release final | Requisitos de congelación (§6) | Requisitos de GO (§7) → GO / NO-GO | T-21: 1 – 3 d; N nocturnas: ≥ N días naturales si son programadas diarias (o menos con `workflow_dispatch`, decisión del operador); cada RC adicional repite D4, D8, D13, D17, D18 |
| **F4** · Después del GO | Versión objetivo siguiente | Grupo B (T-30 … T-51), luego C | GO dado | — | Grupo B: 28,5 – 79,5 d-p (suma de estimaciones) |

### Decisiones del operador que abren F1 (D-OP)

| # | Decisión | Desbloquea | Si no se toma |
|---|---|---|---|
| D-OP-1 | Licencia (y destino del zip/docx de la raíz) | T-01, T-03, T-71 | D2 imposible: no hay presentación «abierta» |
| D-OP-2 | Política de registro por defecto (invitación o cerrado) y quién invita | T-12, texto de D16 | Se implementa `closed` por defecto (lo más conservador) |
| D-OP-3 | Alcance de streaming en la presentación (no anunciado / experimental) | T-04 (D16), T-60 | Se declara «experimental, no soportado» |
| D-OP-4 | Cierre de PR: «NO MERGEAR», documentales (#277, #286, #266), #295, #275, #253, #169 | T-02, T-45, T-47, T-75, T-80, T-81 | D14 en FAIL |
| D-OP-5 | ¿Instancia de demostración alojada? ¿con registro de terceros? | T-49, T-62, T-38 (pasan a A si sí); capacidad del host | Sólo software autoalojable + capturas/GIF |
| D-OP-6 | Publicación de imágenes y releases: numeración `v0.x.y`, visibilidad del registro de imágenes, asset del bundle del proxy como fuente de confianza | T-10, T-08 | D1 imposible; OPS-01 no cierra |
| D-OP-7 | Persona ajena para el ensayo D4 y valor de N (≥ 7) | T-21, D13 | GO imposible |
| D-OP-8 | Replays antiguos: purga o mensaje | T-45 (B) | Se declara en D16 |

## 3. Carriles

Cada carril trabaja en su propio worktree y **sólo** escribe en sus ficheros. Lo que otro carril necesita de un fichero ajeno se pide al propietario.

| Carril | Especialidad | Ficheros propios (escritura exclusiva) | Tareas A | Suma de estimaciones A |
|---|---|---|---|---|
| **L1** Instalación/operación | DevOps | `infrastructure/.env.example`; `infrastructure/scripts/` (nuevo `install-host.sh`, `smoke.sh`, doctor-lite, `install-docker-proxy.sh`, firewall); `infrastructure/docker-compose.yml` (variables de proxy y orden de arranque); `docs/operations/installation.md`, `first-run.md`, `configuration.md`; runbooks nuevos en `docs/operations/` | T-06, T-07, T-08, T-09, T-19 | 5,5 – 10 d-p |
| **L2** API y CLI | Backend | `apps/api/src/**` (incl. `routes/auth.ts`, `routes/users.ts`, `db/cli.ts`, `db/seeds/**`, migraciones nuevas); `apps/api/openapi.yaml` (**contrato: L2 es el único que lo edita**) | T-11, T-12, T-13, T-14 (parte API; secuenciar T-12 → T-14 en `auth.ts`) | 3,5 – 12,5 d-p (compartido con L3) |
| **L3** Web y E2E | Frontend + QA | `apps/web/src/**`; `tests/browser/**` (golden D8; limpieza de topología de la config de Playwright visual) | Partes web de T-12, T-13, T-14; apoyo a T-05 | incluido en las tareas de L2 |
| **L4** CI y release | CI/release | `.github/workflows/**`; notas de release/CHANGELOG; `.changeset/` | T-10, T-17; cableado del gate de T-03, de la prueba de T-16 y del escaneo de T-18 | 2 – 6,5 d-p + cableado |
| **L5** Seguridad de plataforma | Seguridad | `infrastructure/docker/**` (Dockerfiles, `web/nginx.conf`); `infrastructure/gateway/**`; `tests/sandbox-escape/**` | T-15, T-16, T-18 | 2,5 – 9 d-p (+ remediación UNKNOWN) |
| **L6** Documentación y escaparate | Documentación | `README.md`; `LICENSE`; `NOTICE`; ficheros de la raíz a retirar; campo `license` de todos los `package.json`/`pyproject.toml` (**un único commit al inicio de F1**, antes de que otros carriles toquen esos ficheros); `docs/roadmap/current-status.md`, `known-issues.md`; capturas en `docs/`; script del gate de topología (ruta nueva bajo `scripts/`) | T-01, T-03, T-04, T-05 | 2,5 – 5 d-p |
| **L7** Laboratorio/QA | QA + seguridad + operaciones | Ninguno de código; actas saneadas (un fichero nuevo por acta) bajo `docs/testing/` | T-16 y T-18 (mediciones), T-20, T-21, T-22, T-23 … T-26 | 6,5 – 18,5 d-p |
| **OP** Operador | Propietario | GitHub (PR, release, configuración), sin ficheros | D-OP-1…8, T-02, aprobación de T-23, firma del GO | — |

**Limpieza de topología (T-03):** L6 publica la lista de ficheros afectados; cada carril limpia los suyos (L1 `.env.example` y `smoke.sh`, L3 la config de Playwright, L5 la cabecera de `nginx-behind-proxy.conf`); L6 limpia el resto y el gate se activa en CI (L4) cuando la lista está vacía.

## 4. Camino crítico

Cadena principal (secuencial por dependencia, F1 → F3):

```
D-OP-6 ─▶ T-10 flujo de release + bundle (1,5–6) ─▶ T-08 install-host.sh (1–3) ─▶ T-13 bots de práctica con build real (1,5–6)
      ─▶ T-05 capturas (0,5) ─▶ T-04 README final (1) ─▶ [congelación] ─▶ T-21 ensayo por persona ajena (1–3) ─▶ GO
                                                         └─▶ N = 7 nocturnas sobre el SHA (calendario)
```

- **Trabajo secuencial:** 6,5 – 19,5 días (suma de estimaciones de la cadena), más N nocturnas y las latencias de decisión y de FASE 2, no estimables.
- **Ramas que pueden volverse críticas:**
  - **REV-01 / T-16:** si la medición de F0 muestra conexiones de un bot a servicios con credenciales de BD, la remediación (red por batalla, `enable_icc=false`, separar el anfitrión de sesiones; M-L, incertidumbre alta: 1 – 10 d) más la nueva medición se ponen en paralelo con la cadena principal y pueden superarla. Por eso la medición va en F0.
  - **TD-031 / T-18:** si el recuento exige cambiar imágenes base, se re-ejecuta toda la batería sobre imágenes nuevas.
  - **T-22 → T-09/T-08:** sin cifras medidas no se cierra la tabla de requisitos ni el umbral del preflight.
  - **T-17:** arreglar la nightly puede destapar fallos reales ocultos desde agosto (UNKNOWN), que se corrigen antes de congelar.
  - **T-21:** cada pregunta de la persona ajena es un hallazgo; si exige cambio de código o de guía de instalación, nuevo RC y repetición de D4, D8, D13, D17, D18.

## 5. Cuellos de botella

| Cuello | Por qué | Mitigación |
|---|---|---|
| **Laboratorio único** | Casi todo lo que demuestra el contrato (D4, D9, D10, D12, D15, D17, D18, D19, D20) pasa por él y en serie | Agenda explícita del laboratorio en L7; F0 adelanta lo que no depende de F1 (T-22, T-24, T-25); snapshots base limpios para no reinstalar desde cero cada vez |
| **Decisiones del operador** | D-OP-1, 5 y 6 condicionan licencia, alcance y release | Pedirlas el primer día de F0, con la opción por defecto conservadora de la tabla D-OP |
| **Apertura de FASE 2** | Bloqueada por la migración de producción | Separar laboratorio (puede abrir antes) de producción RO (T-23, espera) |
| **Persona ajena (D4)** | Recurso externo, una sola ejecución válida por RC | Reservarla antes de F3; ensayo previo interno en F2 con la misma guía para descubrir fallos baratos |
| **Módulo de auth** | T-12 y T-14 tocan `routes/auth.ts` | Secuenciar dentro de L2 (T-12 primero) |
| **Contrato OpenAPI** | L2 y L3 dependen de él | L2 publica primero los cambios de contrato de T-12/T-13/T-14; L3 consume |
| **Workflows de CI** | Un solo propietario (L4) para el gate, la prueba de red, el escaneo, la nightly y la release | Cola de peticiones de cableado a L4 desde el inicio de F1 |
| **N nocturnas** | Tiempo de calendario sobre un SHA que no puede cambiar | Arreglar T-17 al principio de F1 para que las nocturnas de F1/F2 ya sean señal; decidir en D-OP-7 si se admite `workflow_dispatch` |

## 6. Congelación

Requisitos completos en [12 §3](12-RELEASE-DEFINITION-OF-DONE.md#3-requisitos-para-congelar-la-versión-release-candidate). Resumen operativo:

1. Grupo A cerrado salvo lo reservado al SHA congelado (T-21, re-escaneo T-18, repetición de T-26 y, si procede, de T-20; N nocturnas).
2. **Un único SHA en main** registrado completo y tag `v0.x.y-rc.N`.
3. CI completa en verde sobre ese SHA (ci, E6 security, acceptance, functional-e2e con el golden D8, gate de topología, escaneo de imágenes), contando conclusiones de todos los jobs.
4. Imágenes publicadas por digest y bundle del proxy construido por el flujo de release.
5. Desde el tag RC, cualquier cambio de código o configuración empaquetada = nuevo RC y repetición de D4, D8, D13, D17, D18.
6. La congelación no incluye ningún despliegue en producción.

## 7. GO

Requisitos completos en [12 §4](12-RELEASE-DEFINITION-OF-DONE.md#4-requisitos-para-el-go). Resumen:

1. D1-D21 en PASS con acta sobre el mismo SHA.
2. N = 7 nocturnas consecutivas verdes sobre ese SHA.
3. Ensayo de instalación por persona ajena y ensayo de restore con acta.
4. Decisiones D-OP-1…8 registradas.
5. Sin P0/P1 abiertos en grupo A; P1 de grupo B (OPS-06 resto, OPS-07 automatización, TD-007) en las notas de release.
6. Tag final `v0.x.y` sobre el mismo SHA que el último RC; release publicada; README apuntando a ella.
7. Firma del director de release y del operador.

**GO ≠ despliegue.** Si el operador decide además desplegar la versión en su host de producción, lo hace con su propio procedimiento (copia de seguridad previa verificada, sin pruebas de carga en producción, coordinación con el resto de cargas del hipervisor), fuera de este plan.

## 8. Riesgos del plan

| Riesgo | Efecto en el plan | Señal temprana | Respuesta |
|---|---|---|---|
| FASE 2 amplía el alcance (REV-01, TD-031, REV-02, UX-11) | Nuevas tareas A en F2 | Actas de F0 | Re-emitir backlog en la puerta de F0; no empezar F2 sin ello |
| Decisión de alojar instancia pública con registro abierto | T-49, T-62, T-38 a grupo A | D-OP-5 | Tomarla en F0; si llega tarde, nuevo alcance y nuevo plan |
| Nightly destapa fallos reales | Retraso de la congelación | Primeras nocturnas tras T-17 | Corregir en F1/F2; no congelar con rojo |
| Persona ajena encuentra bloqueos | Nuevo RC | Ensayo interno previo en F2 | Corregir guía o código y repetir |
| Carga de laboratorio afecta a otros sistemas del mismo hipervisor | Interrupción de servicios ajenos | Métricas del hipervisor | Límites de recursos; nunca cargas contra producción |
| Desfase de la documentación tras el GO | README vuelve a mentir | Check de SHA citado (T-04) | Mantener el check en CI |
