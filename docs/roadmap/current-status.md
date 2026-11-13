# Estado actual — S9 AI Arena

## Resumen

Esta es la **fuente única del estado actual del proyecto**. Distingue siempre entre lo que está en `main`, lo que está integrado en ramas de trabajo y lo que corre en producción.

```
MAIN_SHA:        f5909474bb25aeef8f17a5476c6b7319aa96422a
REVISADO:        2026-11-12
CÓDIGO:          main protegida; último merge funcional: PR #269 (MG, ajustes runtime de acceso público)
DESPLEGADO:      núcleo RC9 7bddda9; web con #274 desplegado (b32fcff), según registro del operador
P0 / P1 / P2:    sin recuento nuevo hasta re-auditar tras la integración OLA 2; ver technical-debt.md
STREAMING REAL:  BATTLE_VISIBLE_ON_STREAM=PASS (YouTube real, mapa/tanques/movimiento/HUD, 0 frames descartados)
OLA 2:           7 PR revisados/CI verde; todavía NO integrados como conjunto
STREAMING V2:    MS-1 (#275) = DESIGN_ONLY; D1-D4 decididas; MS-2 no iniciado
```

El estado de producción se anota como **REPORTADO por el operador** cuando no puede deducirse del repositorio.

## Índice

- [Código y despliegue](#código-y-despliegue)
- [Diferencia entre main, hardening y producción](#diferencia-entre-main-hardening-y-producción)
- [Prioridades abiertas](#prioridades-abiertas)
- [Functional](#functional)
- [Partial](#partial)
- [Blocked](#blocked)
- [Security](#security)
- [Next priorities](#next-priorities)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Código y despliegue

| Plano | Estado | Evidencia |
|---|---|---|
| `main` | `f590947`; incluye PR #265, #274 y #269 | rama protegida de GitHub, 2026-11-12 |
| Producción núcleo | RC9 `7bddda9`, 13/13 servicios healthy, sin lockups reportados | registro del operador, 2026-11-12 |
| Producción web | arreglo #274 desplegado; `/broadcast` puede consultar JSON real por `/api/v1/` desde el nginx de `web` | PR #274 + prueba real reportada |
| OLA 2 | ramas/PR #268, #270, #271, #272, #273 y #276 revisadas; MG #269 ya está en `main` | GitHub PRs; integración conjunta pendiente |
| Streaming V2 | PR #275 draft, sólo arquitectura | `docs/technical/STREAMING_ARCHITECTURE_V2.md` en la rama de MS-1 |

### Producción verificada/reportada el 2026-11-12

- RC9 se mantiene estable.
- El espectador público está activado en producción; los replays públicos siguen apagados.
- #274 está desplegado sólo en `web`.
- `BATTLE_VISIBLE_ON_STREAM=PASS`: una batalla real llegó a YouTube con mapa, vehículos, movimiento y HUD, sin pantalla blanca y con 0 frames descartados.
- La presión de la máquina de orquestación desapareció al parar/deshabilitar servicios no usados; el guard de producción volvió a OK.
- La sesión de emisión de la prueba puede cerrarse sin perder configuración ni credenciales.

## Diferencia entre main, hardening y producción

### Ya está en `main`

- PR #265: precisión documental sobre replays; la protección no depende de ocultar la semilla sino de no entregar comandos/estado privado.
- PR #274: proxy interno de `web` para `/api/v1/` y `/ws/`, necesario para que Chromium de `/broadcast` vea la API real.
- PR #269 (MG): ajustes de **Acceso público / Broadcast** persistentes y modificables desde la administración, sin editar `.env` ni recrear servicios.

### OLA 2 revisada pero aún sin gate de integración final

| PR | Equipo | Estado funcional |
|---|---|---|
| #271 | MD | Replay v2, verificación del resultado completo, hash completo y RNG con nombre |
| #272 | MA | Frontera pública única, PublicEntityIds por audiencia y equipamiento privado |
| #273 | MB | Contrato de daño, HE sin doble daño y torreta como propiedad de la montura |
| #276 | MC | Catálogo veraz: alcance de arma/radio real, campos decorativos retirados y minas corregidas |
| #270 | MF | Cleanup idempotente, reaper y pruebas repetidas con Docker real |
| #268 | ME | Baseline/contratos/mutantes para demostrar que los cambios no son vacuos |

Todos han pasado revisión de equipo y CI según el cierre de los equipos, pero **`ENGINE_HARDENING_READY` sigue pendiente hasta que se integren en una sola rama y se valide el conjunto**.

### Streaming V2

MS-1 (#275) fija la arquitectura y las decisiones D1-D4:

- batalla suelta: inicio manual por defecto;
- torneo: inicio automático por defecto;
- una única salida YouTube: batallas en serie, retenidas hasta que el broadcast esté listo;
- abandonar/cancelar una emisión nunca arranca por accidente una batalla retenida;
- ticket de pre-roll firmado para preparar una batalla programada sin hacerla pública;
- sesión RTMP separada del contenido mostrado, para cambiar de batalla sin cortar YouTube;
- fuentes independientes para OBS/vMix;
- replay único y listas de replays.

**Todavía es DESIGN_ONLY.** MS-2 no ha empezado.

## Prioridades abiertas

La lista histórica de deuda sigue en [technical-debt.md](technical-debt.md), pero el recuento de prioridades del 2 de noviembre **no debe reutilizarse como recuento actual** sin una re-auditoría posterior a la integración OLA 2.

Prioridades de cierre actuales:

1. Integrar OLA 2 en el orden acordado y obtener `ENGINE_HARDENING_READY=PASS`.
2. Validar de nuevo privacidad, determinismo, lifecycle y catálogo sobre la rama integrada.
3. Actualizar/retirar caracterizaciones que ahora fallen porque el defecto correspondiente se ha corregido.
4. Revisar MS-1 y empezar MS-2 sólo después del cierre de la integración del motor.
5. Mantener separadas las funciones futuras (Streaming V2, visuales posteriores, nuevas armas) del hardening actual.

## Functional

**FUNCIONA EN `main` o ha sido verificado en producción, según se indica:**

- Recorrido completo jugador/bot/build/batalla/replay de la versión actual.
- Streaming real: la cadena Chromium → Xvfb → FFmpeg → relé RTMPS → YouTube está probada; #256 evita el arranque en blanco mediante `BROADCAST_RENDER_READY`.
- #274 permite que la página capturada internamente por el streamer consulte la API y el WebSocket correctos.
- Administración de streaming con credenciales selladas, relé interno y estado real de publicación.
- **Acceso público / Broadcast (MG)**: el administrador puede activar/desactivar espectador y replays públicos desde la web; se persiste en BD, se audita y se aplica en caliente.
- Política de lectura de batallas/replays y gateway cerrado para el replay-service interno.
- Bots, versiones, loadouts, mapas, torneos, ranking, visor, replays y Centro de Ayuda existentes en `main`.

## Partial

Detalle en [pending-features.md](pending-features.md).

| Área | Estado actual | Falta |
|---|---|---|
| OLA 2 / hardening motor | PRs terminados y revisados | integración conjunta + gate `ENGINE_HARDENING_READY` |
| Streaming V2 | arquitectura MS-1 y decisiones D1-D4 | MS-2…MS-8 |
| Replays públicos | runtime setting disponible | activación es decisión del operador; en producción sigue OFF |
| Observabilidad | perfil y alertas existen | despliegue/ensayo completo del perfil |
| Cuenta | login/TOTP y API existen | UI completa de 2FA/sesiones y recuperación utilizable |
| Torneos | formatos y scheduler existen | E2E de todos los formatos y deudas específicas vigentes |
| Administración operativa | panel funcional + acceso público/streaming | backup/restore/readiness/drift siguen mayormente en CLI |
| Visuales posteriores | fases previas existentes | sonido, terreno, sombreado/shaders/CDN; pospuesto frente a hardening/streaming |

## Blocked

No hay ya un bloqueo de autorización para probar YouTube: la prueba real se completó.

Bloqueos/condiciones reales:

1. **OLA 2 a main:** bloqueada por el gate de integración, no por falta de código individual.
2. **Despliegue de OLA 2/MG adicional:** requiere autorización del operador y plan de rollback; MG ya está en main pero no se asume desplegado por este documento.
3. **Streaming V2:** no bloqueado técnicamente, pero por decisión de proyecto no empieza su implementación fuerte hasta cerrar/revisar la arquitectura y el hardening integrado.
4. **Replays públicos en producción:** siguen desactivados por decisión del operador.

## Security

- Clave RTMPS: ya no viaja en el argv de FFmpeg; el streamer publica mediante su relé interno y la credencial permanece sellada fuera del navegador.
- La lectura pública de batallas/replays se decide en servidor y falla cerrada.
- MG no expone secretos: sólo dos booleanos y metadatos de auditoría.
- OLA 2 refuerza la frontera pública con `projectFrame()`, `PublicEntityId` y `EQUIPMENT_PRIVATE`, pero esas garantías nuevas no se declaran activas en `main` hasta integrar #272 con el conjunto.
- El host de bots y otras deudas históricas siguen registradas en [technical-debt.md](technical-debt.md).

## Next priorities

1. Integrar: MD → MA → MB → MC → MF → ME.
2. Ejecutar suite conjunta, mutantes, E2E relevantes y revisión final de privacidad/determinismo/lifecycle.
3. Obtener `ENGINE_HARDENING_READY=PASS`.
4. Preparar merge/deploy sólo con autorización explícita.
5. Revisar/finalizar MS-1 y comenzar MS-2.
6. Después: cola YouTube continua, start sincronizado, selección manual, fuentes OBS, replays/listas y UI unificada.
7. Mantener visuales/nuevas armas fuera de esta fase hasta cerrar los gates anteriores.

## Documentación relacionada

- [Funciones pendientes](pending-features.md)
- [Problemas conocidos](known-issues.md)
- [Deuda técnica](technical-debt.md)
- [Operación de streaming](../operations/streaming.md)
- [Administración desde la web](../user/administration.md)
- [Arquitectura actual de streaming](../technical/streaming-architecture.md)
- Streaming V2: PR #275, `docs/technical/STREAMING_ARCHITECTURE_V2.md` (DESIGN_ONLY hasta merge)

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| `main=f590947` y #269 mergeado | CODE_VERIFIED | rama `main` de GitHub, 2026-11-12 |
| #270/#271/#272/#273/#275/#276 siguen fuera de `main` | CODE_VERIFIED | estado de PRs en GitHub, 2026-11-12 |
| #274 está en `main` y producción web | CODE_VERIFIED + REPORTADO_RUNTIME | GitHub + registro del operador |
| `BATTLE_VISIBLE_ON_STREAM=PASS` | REPORTADO_RUNTIME | prueba real del operador, 2026-11-12 |
| producción núcleo RC9 `7bddda9` | REPORTADO_RUNTIME | registro del operador |
| espectador público ON, replays públicos OFF en producción | REPORTADO_RUNTIME | registro del operador |
