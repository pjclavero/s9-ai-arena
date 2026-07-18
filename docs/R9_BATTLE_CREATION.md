# R9 · Crear batalla desde la UI (prepared/seguro)

Pantalla `#/battles/new` para crear una **batalla de práctica** desde el panel, usando el
endpoint EXISTENTE y seguro `POST /battles` (`createPracticeBattle`).

## Qué hace

- Carga **mapas publicados** (`GET /maps`, `state=published`) y **bots con versión
  publicada** (`GET /bots`, `latestPublishedVersion != null`).
- Formulario: modo (deathmatch/tdm/ctf/zc), mapa publicado, semilla (opcional), bot rojo y
  bot azul. El `rulesetId` se deriva del modo; el límite de ticks lo fija el ruleset.
- Valida: mapa obligatorio, dos bots distintos con versión publicada.
- Envía `POST /battles` con `PracticeBattleInput` → 202 (encolada) → pantalla de éxito con
  enlace a `#/battles`.

## Seguridad (regla crítica R9)

- **NO** habla con Docker, **NO** salta bot-manager/firma/digest ni el `s9-docker-proxy`,
  **NO** usa mocks, **NO** abre puertos. Solo llama al endpoint RBAC existente (`x-min-role: user`).
- La batalla encolada la ejecuta el **worker de la plataforma** (agentes internos del motor).
  La **ejecución con runner containerizado** (código no confiable aislado) es un flujo
  operativo **opt-in** (arnés `e2e-real-battle-smoke`) y **NO se dispara desde la UI** — se
  avisa explícitamente en la pantalla.
- El botón "Crear batalla" se **deshabilita** si no hay ≥2 bots publicados o ningún mapa publicado.

## Tests

`apps/web/tests/battle-new-page.test.tsx` (mock de `api`, sin Docker): crear prepared con
mapa+2 bots → `POST /battles` con payload correcto; solo mapas publicados; rechazo sin mapa;
botón deshabilitado con <2 bots; aviso de runner containerizado no disponible.

## Nota de integración (conflicto conocido)

`#/battles/new` requiere registrar ruta y render en `apps/web/src/App.tsx` (marcado con
comentarios "R9"). **Las PRs draft #45 (Maps) y #46 (System/Audit/Roles) también editan
`App.tsx`.** Al consolidar/mergear esas PRs habrá que reconciliar estos añadidos (mínimos:
1 import, 1 rama en `matchPanelRoute`, 1 rama de render). El enlace de navegación se puso en
`BattlesPage` (no tocada por #45/#46) para minimizar el solape.

## Estado / dictamen

- **R9-A** en modo prepared/seguro: la creación funciona contra el endpoint real seguro; la
  ejecución containerizada queda fuera de la UI por diseño (opt-in, documentado).
