# S9 AI Arena — Mejoras visuales de bots

**Documento maestro / Fuente de verdad**

**Rama base de trabajo:** mejoras-visuales

Este documento define producto, requisitos, arquitectura, datos, pruebas y roadmap para evolucionar la representación visual de los bots de S9 AI Arena mediante componentes visuales independientes y componibles.

Si el proyecto se pausa, debe poder retomarse leyendo este documento, el estado del roadmap y los ADR/PR asociados, sin depender de contexto externo.

---

## 1. Objetivo

Construir un sistema visual de bots que represente de forma reconocible:

- tipo/chasis;
- arma principal;
- armas secundarias cuando existan;
- blindaje;
- sensores;
- radio/antenas;
- movilidad;
- accesorios relevantes;
- esquema de color;
- estado de daño;
- estados visuales durante la batalla.

El sistema debe permitir crear cada componente visual de forma independiente y componerlo después en una representación coherente del bot.

La representación visual debe ser reproducible para una versión concreta del bot, de modo que replays y streaming puedan mostrar el aspecto correspondiente al equipamiento que realmente combatió.

---

## 2. Principios de diseño

1. **Composición, no combinaciones dibujadas a mano.**
   No crear una imagen completa por cada combinación de equipo.

2. **Assets independientes.**
   Chasis, armas, sensores, blindajes y accesorios deben poder evolucionar de forma separada.

3. **Determinismo visual.**
   El mismo snapshot/versionado de equipo debe producir el mismo aspecto.

4. **Separación juego/visual.**
   El motor de combate no debe depender del renderer visual.

5. **Progresivo.**
   Debe poder entregarse por fases sin exigir que todo el catálogo visual esté terminado.

6. **Fallback seguro.**
   Si falta un asset visual, el bot sigue siendo usable y muestra una representación genérica.

7. **Un modelo, varios contextos.**
   El mismo modelo visual debe alimentar ficha de bot, editor, visor de batalla, replay y broadcast/streaming.

8. **Sin inventar equipamiento.**
   La representación visual sólo puede mostrar componentes presentes realmente en la versión/snapshot.

---

## 3. Alcance funcional

### 3.1 Incluido

- definición visual de chasis;
- definición de puntos de montaje;
- assets visuales por componente;
- composición automática;
- colores configurables o derivados del bot/equipo;
- renderer de alta resolución;
- renderer simplificado para mapa;
- estados visuales;
- integración progresiva en ficha, batalla, replay y broadcast;
- tooling para validar assets;
- versionado de definiciones visuales;
- tests automáticos;
- documentación del pipeline.

### 3.2 Fuera de alcance inicial

- cambiar reglas del motor;
- cambiar estadísticas por razones visuales;
- generar assets con IA en runtime;
- permitir SVG arbitrario subido por usuarios sin sanitización;
- físicas visuales complejas;
- animación 3D;
- editor 3D;
- marketplace de skins.

---

## 4. PRD — Requisitos de producto

### PRD-01 — Identificación visual

El usuario debe poder distinguir a simple vista:

- clase/tipo de bot;
- arma principal;
- accesorios visualmente relevantes;
- equipo/color.

### PRD-02 — Consistencia

Dos vistas del mismo bot/versionado deben mostrar una representación coherente.

### PRD-03 — Equipamiento visible

Los componentes configurados deben reflejarse visualmente cuando tengan representación definida.

### PRD-04 — Compatibilidad parcial

Un bot con componentes sin asset visual debe seguir renderizando con fallbacks.

### PRD-05 — Historial

Una batalla histórica debe conservar el aspecto correspondiente a su snapshot/versionado, incluso si después cambian los assets o el equipamiento actual del bot.

### PRD-06 — Streaming

El renderer debe ser suficientemente legible para /broadcast.

### PRD-07 — Mapa

Debe existir una representación ligera y reconocible para el mapa de batalla.

### PRD-08 — Rendimiento

La composición no debe degradar apreciablemente el visor con múltiples bots simultáneos.

### PRD-09 — Extensibilidad

Añadir un nuevo componente debe requerir principalmente:

- registrar definición visual;
- añadir asset;
- declarar compatibilidad/puntos de montaje;
- tests.

No debe requerir modificar cada chasis existente salvo incompatibilidad real.

---

## 5. SRS — Requisitos del sistema

### SRS-F01 — VisualDefinition

Cada elemento visual debe tener una definición estructurada.

Campos mínimos:

~~~ts
interface VisualDefinition {
  id: string;
  kind: "chassis" | "weapon" | "armor" | "sensor" | "radio" | "mobility" | "accessory";
  assetId: string;
  version: number;
  mountType?: string;
  layer?: number;
  scale?: number;
  rotation?: number;
  visibilityRules?: string[];
}
~~~

### SRS-F02 — Mount points

Cada chasis debe declarar puntos de montaje.

Ejemplo:

~~~json
{
  "primaryWeapon": { "x": 0.50, "y": 0.25, "rotation": 0 },
  "secondaryWeapon": { "x": 0.66, "y": 0.32, "rotation": 0 },
  "sensor": { "x": 0.50, "y": 0.12, "rotation": 0 },
  "radio": { "x": 0.34, "y": 0.17, "rotation": 0 }
}
~~~

Usar coordenadas normalizadas.

### SRS-F03 — Asset catalog

Cada asset debe poseer:

- ID estable;
- versión;
- tipo;
- formato;
- bounding box;
- anchor;
- licencia/origen;
- hash;
- estado: draft/approved/deprecated.

### SRS-F04 — Composición determinista

Entrada:

~~~text
BotVersion / BattleSnapshot
        +
Visual Catalog Version
~~~

Salida:

~~~text
VisualComposition
~~~

Debe ser determinista.

### SRS-F05 — Render targets

El renderer debe soportar como mínimo:

~~~text
detail
map
broadcast
~~~

### SRS-F06 — Fallback

Si falta un asset:

~~~text
missing component asset
→ generic compatible asset
→ generic marker
→ never blank/crash
~~~

### SRS-F07 — Snapshot histórico

Las batallas deben poder resolver la versión visual usada o una representación compatible con su snapshot.

### SRS-F08 — Seguridad

No aceptar SVG/HTML no confiable sin sanitización.

### SRS-F09 — Cache

Las composiciones estables deben poder cachearse por:

~~~text
botVersionId
visualCatalogVersion
renderTarget
palette
~~~

### SRS-F10 — Accesibilidad

No depender únicamente del color para identificar equipo/estado.

---

## 6. Arquitectura

### 6.1 Componentes

~~~text
Equipment snapshot
       │
       ▼
Visual Resolver
       │
       ├── Chassis definition
       ├── Equipment definitions
       ├── Mount points
       ├── Palette
       └── State
       │
       ▼
Visual Composition
       │
       ▼
BotVisual renderer
       ├── DetailRenderer
       ├── MapRenderer
       └── BroadcastRenderer
~~~

### 6.2 Separación de responsabilidades

#### Game engine

Autoridad sobre:

- equipamiento;
- estado;
- daño;
- munición;
- posición;
- orientación.

No conoce SVG ni assets visuales.

#### Visual resolver

Traduce IDs de dominio a definiciones visuales.

#### Asset catalog

Autoridad sobre:

- assets;
- versiones;
- anchors;
- capas;
- compatibilidad.

#### Renderer

Compone y dibuja.

#### UI

Decide tamaño, contexto y nivel de detalle.

---

## 7. Tecnología recomendada

### 7.1 Formato principal

**SVG por capas** para assets de alta resolución.

Ventajas:

- escalable;
- recolorable;
- ligero;
- composición DOM;
- fácil de versionar;
- bueno para ficha/broadcast.

### 7.2 Mapa

Dos opciones permitidas:

1. SVG simplificado;
2. raster/sprites derivados automáticamente del SVG.

Decidir después de benchmark.

### 7.3 IA generativa

Puede utilizarse para:

- concept art;
- bocetos;
- referencias.

El asset final debe ser normalizado, versionado y validado.

No generar imágenes en runtime.

---

## 8. Modelo de datos

### 8.1 Entidades lógicas

#### visual_catalog_versions

~~~text
id
version
status
created_at
published_at
~~~

#### visual_assets

~~~text
id
catalog_version
kind
name
format
path
sha256
width
height
status
metadata
~~~

#### visual_component_definitions

~~~text
id
catalog_version
domain_component_id
component_kind
asset_id
mount_type
layer
scale
rotation
metadata
~~~

#### visual_chassis_definitions

~~~text
id
catalog_version
domain_chassis_id
asset_id
mount_points
base_dimensions
metadata
~~~

### 8.2 Persistencia inicial

No introducir tablas de BD en la primera fase si el catálogo puede vivir de forma segura como datos versionados en repo.

Preferencia inicial:

~~~text
packages/bot-visuals/catalog/
~~~

con JSON/TS validado por schema.

Mover a BD sólo si existe una necesidad real de administración dinámica.

---

## 9. Estructura propuesta en repo

~~~text
packages/
  bot-visuals/
    src/
      resolver.ts
      schema.ts
      compose.ts
      palette.ts
      fallbacks.ts
    catalog/
      chassis/
      weapons/
      armor/
      sensors/
      radio/
      mobility/
      accessories/
    assets/
      svg/
    tests/

apps/web/
  src/
    bot-visual/
      BotVisual.tsx
      DetailBotVisual.tsx
      MapBotVisual.tsx
      BroadcastBotVisual.tsx
~~~

La estructura final puede adaptarse al monorepo real durante la fase de diseño.

---

## 10. Capas y z-order

Convención inicial sugerida:

~~~text
0  shadow
10 mobility/rear
20 chassis
30 armor
40 primary weapon
45 secondary weapon
50 sensors
60 radio/antenna
70 effects
80 damage
90 UI indicators
~~~

No hardcodear números dispersos por la UI.

Centralizar.

---

## 11. Paletas

Separar geometría de color.

Paleta mínima:

~~~ts
interface BotPalette {
  primary: string;
  secondary: string;
  accent: string;
  team?: string;
}
~~~

Los SVG deben usar tokens/clases de color cuando sea posible.

---

## 12. Estados dinámicos

Fases posteriores podrán añadir:

### Salud

~~~text
>70%   normal
30-70% daño ligero
<30%   daño grave
0%     destruido
~~~

### Radio

- antena/pulso discreto;
- no revelar información secreta a espectadores no autorizados.

### Armas

- flash de disparo;
- cooldown opcional;
- sin munición, sólo si el producto decide hacerlo visible.

### Sensores

- barrido/efecto;
- respetar información observable.

---

## 13. Privacidad y fog of war

La capa visual NO debe filtrar datos que el espectador no deba conocer.

Ejemplos:

- accesorio físicamente visible: puede mostrarse si las reglas lo permiten;
- estado interno secreto: no;
- munición restante exacta: no por defecto;
- radio activa: sólo si es observable según reglas.

Gate obligatorio:

~~~text
VISUAL_INFORMATION_LEAK = PASS
~~~

---

## 14. Testing strategy

### 14.1 Schema tests

- catálogos válidos;
- IDs únicos;
- anchors válidos;
- mount types conocidos;
- assets existentes;
- hashes correctos.

### 14.2 Resolver tests

- componente conocido;
- componente desconocido;
- fallback;
- compatibilidad;
- catalog version.

### 14.3 Composition tests

- orden de capas;
- coordenadas;
- escala;
- rotación;
- palette.

### 14.4 Golden tests

Para configuraciones canónicas:

~~~text
light + gun
medium + cannon + sensor
heavy + armor + radio
~~~

Comparar composición estructural y/o imagen golden.

### 14.5 Visual regression

Capturas Playwright de:

- ficha;
- mapa;
- replay;
- broadcast;
- móvil.

### 14.6 Performance

Escenarios:

~~~text
1 bot
8 bots
16 bots
32 bots
~~~

Medir:

- render time;
- frame rate;
- DOM size;
- memory.

### 14.7 Historical determinism

Una batalla histórica debe mantener composición consistente tras publicar un catálogo nuevo.

### 14.8 Security

- SVG sanitizado;
- no scripts;
- no foreignObject inseguro;
- no external URL arbitraria;
- no CSS injection.

---

## 15. Gates globales

~~~text
VISUAL_SCHEMA_VALID             PASS
ASSET_CATALOG_VALID             PASS
MOUNT_POINTS_VALID              PASS
COMPOSITION_DETERMINISTIC       PASS
FALLBACKS_COMPLETE              PASS
VISUAL_INFORMATION_LEAK         PASS
VISUAL_SECURITY                 PASS
DETAIL_RENDERER                 PASS
MAP_RENDERER                    PASS
BROADCAST_RENDERER              PASS
REPLAY_COMPATIBILITY            PASS
HISTORICAL_DETERMINISM          PASS
PERFORMANCE                     PASS
VISUAL_REGRESSION               PASS
CI                              PASS
INDEPENDENT_REVIEW              PASS
~~~

---

## 16. Roadmap

### FASE 0 — Descubrimiento y contrato visual

Objetivo:

Inventariar equipamiento actual y definir qué elementos merecen representación.

Entregables:

- catálogo de tipos reales;
- matriz componente → representación;
- ADR formato visual;
- ADR mount points;
- schema inicial.

Gate:

~~~text
VISUAL_CONTRACT_READY=PASS
~~~

### FASE 1 — Infraestructura visual mínima

Implementar:

- package bot-visuals;
- schemas;
- catálogo versionado;
- resolver;
- composer;
- fallback.

Sin cambiar todavía el visor principal.

Gate:

~~~text
VISUAL_CORE_READY=PASS
~~~

PR separado.

### FASE 2 — Primer chasis

Crear un vertical slice completo:

~~~text
1 chasis
1 arma
1 sensor
1 radio
1 blindaje
~~~

Integrarlo en ficha de bot.

Objetivo:

probar el pipeline entero antes de producir muchos assets.

Gate:

~~~text
VERTICAL_SLICE_READY=PASS
~~~

### FASE 3 — Catálogo base

Cubrir los tipos/equipos usados actualmente.

Prioridad:

1. chasis;
2. armas principales;
3. movilidad;
4. blindaje;
5. sensores;
6. radio;
7. accesorios menores.

Gate:

~~~text
BASE_CATALOG_COVERAGE >= 90%
~~~

El 10% restante debe tener fallback explícito.

### FASE 4 — Ficha y editor

Integrar:

- detalle del bot;
- editor/configurador;
- preview en tiempo real.

Gate:

~~~text
BOT_DETAIL_VISUALS=PASS
BOT_EDITOR_PREVIEW=PASS
~~~

### FASE 5 — Mapa de batalla

Añadir renderer ligero.

Requisitos:

- legibilidad;
- orientación;
- team identity;
- buen rendimiento.

Gate:

~~~text
MAP_VISUALS_READY=PASS
~~~

### FASE 6 — Replay

La apariencia debe salir del snapshot histórico.

Gate:

~~~text
REPLAY_VISUALS_READY=PASS
HISTORICAL_DETERMINISM=PASS
~~~

### FASE 7 — Broadcast / Streaming

Integrar renderer visual en /broadcast.

Prioridades:

- lectura clara a 1080p;
- no sobrecargar pantalla;
- rendimiento estable;
- no filtrar datos privados.

Gate:

~~~text
BROADCAST_VISUALS_READY=PASS
~~~

### FASE 8 — Estados y efectos

Añadir progresivamente:

- daño;
- humo;
- disparo;
- destrucción;
- radio/sensor cuando sea observable.

Gate:

~~~text
DYNAMIC_VISUAL_STATES=PASS
~~~

### FASE 9 — Tooling de assets

Crear herramientas para:

- preview;
- validar mount points;
- comparar escalas;
- detectar overflow;
- validar SVG;
- generar thumbnails;
- comprobar catálogo completo.

Gate:

~~~text
ASSET_TOOLING_READY=PASS
~~~

### FASE 10 — Completo

Definición de COMPLETE:

~~~text
CATALOG_COVERAGE=100% o fallback aprobado
DETAIL_RENDERER=PASS
EDITOR_PREVIEW=PASS
MAP_RENDERER=PASS
REPLAY_RENDERER=PASS
BROADCAST_RENDERER=PASS
DYNAMIC_STATES=PASS
HISTORICAL_DETERMINISM=PASS
SECURITY=PASS
PERFORMANCE=PASS
ACCESSIBILITY=PASS
DOCUMENTATION=PASS
CI=PASS
INDEPENDENT_REVIEW=PASS
~~~

Estado final:

~~~text
BOT_VISUAL_SYSTEM_COMPLETE=PASS
~~~

---

## 17. Estrategia de PRs

No hacer un mega-PR.

Propuesta:

~~~text
PR-VIS-01 contract/schema
PR-VIS-02 core resolver/composer
PR-VIS-03 vertical slice
PR-VIS-04 base chassis/assets
PR-VIS-05 bot detail/editor
PR-VIS-06 map renderer
PR-VIS-07 replay
PR-VIS-08 broadcast
PR-VIS-09 dynamic states
PR-VIS-10 tooling + catalog completion
~~~

Cada PR debe incluir:

- tests;
- evidencia;
- revisión independiente;
- sin desplegar automáticamente.

---

## 18. Definición de Done por componente

Un componente visual no está DONE sólo porque exista un SVG.

Debe tener:

~~~text
asset
definition
anchor
mount compatibility
fallback behavior
schema validation
unit tests
visual regression
license/origin metadata
review
~~~

---

## 19. Registro de decisiones

Toda decisión arquitectónica importante debe tener ADR.

ADR mínimas:

~~~text
ADR-VIS-001 SVG vs raster
ADR-VIS-002 catalog versioning
ADR-VIS-003 mount point coordinate system
ADR-VIS-004 historical rendering
ADR-VIS-005 user palettes
ADR-VIS-006 asset security
~~~

---

## 20. Cómo retomar el proyecto si se pausa

Antes de pausar, actualizar esta sección.

### Estado

~~~text
LAST_UPDATED:
BRANCH: mejoras-visuales
BASE_MAIN_SHA:
CURRENT_PHASE:
LAST_MERGED_VIS_PR:
ACTIVE_VIS_PR:
NEXT_ACTION:
BLOCKERS:
~~~

### Procedimiento de reanudación

1. Leer este documento.
2. Consultar ADR.
3. Revisar roadmap.
4. Obtener estado de mejoras-visuales.
5. Comparar con main.
6. Ejecutar suite visual.
7. Identificar último gate PASS.
8. Continuar desde el primer gate pendiente.

No iniciar nuevas features hasta conocer estos ocho puntos.

---

## 21. Control de alcance

Toda propuesta nueva debe clasificarse:

~~~text
REQUIRED_FOR_CURRENT_PHASE
NEXT_PHASE
BACKLOG
OUT_OF_SCOPE
~~~

No añadir una mejora sólo porque sea atractiva.

Si no contribuye al gate de la fase actual, va al backlog.

---

## 22. Roadmap status

Estado actual:

~~~text
LAST_UPDATED:        2026-11-10
BRANCH:              mejoras-visuales-fase-0-inventario (base: mejoras-visuales @ 983d2f5; «mejoras-visuales/…» no es creable mientras exista la rama mejoras-visuales)
BASE_MAIN_SHA:       b254e3dac1ab25f39f9b4565b3349aa66a9f3963
CURRENT_PHASE:       FASE 0 — Descubrimiento y contrato visual (IN_PROGRESS)
LAST_MERGED_VIS_PR:  ninguno
ACTIVE_VIS_PR:       #253 (draft, FASE 0, base mejoras-visuales; ronda 2 de correcciones aplicada, pendiente de re-revisión)
NEXT_ACTION:         re-revisión independiente de la ronda 2; decisiones de producto D-01..D-08
BLOCKERS:            ninguno técnico; FASE 0 no pasa a PASS sin revisión independiente; PRE-1 (backend) en otro PR contra main
~~~

Entregables de FASE 0: [VISUAL_COMPONENT_INVENTORY](VISUAL_COMPONENT_INVENTORY.md),
[VISUAL_COMPONENT_MATRIX](VISUAL_COMPONENT_MATRIX.md), [MOUNT_TYPE_DRAFT](MOUNT_TYPE_DRAFT.md),
[ADR-VIS-001](adr/ADR-VIS-001-svg-vs-raster.md), [ADR-VIS-002](adr/ADR-VIS-002-catalog-versioning.md),
[ADR-VIS-003](adr/ADR-VIS-003-mount-coordinate-system.md).

~~~text
PHASE_0_DISCOVERY             IN_PROGRESS
PHASE_1_VISUAL_CORE           NOT_STARTED
PHASE_2_VERTICAL_SLICE        NOT_STARTED
PHASE_3_BASE_CATALOG          NOT_STARTED
PHASE_4_DETAIL_EDITOR         NOT_STARTED
PHASE_5_MAP                   NOT_STARTED
PHASE_6_REPLAY                NOT_STARTED
PHASE_7_BROADCAST             NOT_STARTED
PHASE_8_DYNAMIC_STATES        NOT_STARTED
PHASE_9_TOOLING               NOT_STARTED
PHASE_10_COMPLETE             NOT_STARTED

BOT_VISUAL_SYSTEM_COMPLETE    NO
~~~

---

## 23. Siguiente acción

Primer trabajo de la rama:

~~~text
FASE 0
~~~

Inventariar los tipos de bot, chasis, armas, sensores, radio, movilidad, blindajes y accesorios que existen actualmente en S9 AI Arena.

No dibujar el catálogo completo todavía.

Primero producir:

~~~text
VISUAL_COMPONENT_INVENTORY
VISUAL_COMPONENT_MATRIX
MOUNT_TYPE_DRAFT
ADR-VIS-001
ADR-VIS-002
ADR-VIS-003
~~~

y someterlos a revisión.

---

## 24. Regla de rama

La rama:

~~~text
mejoras-visuales
~~~

es la línea base de este proyecto.

Los trabajos visuales se crean a partir de ella o en ramas hijas.

No desarrollar estas mejoras directamente sobre main.

Cuando una fase esté aceptada, su integración en main se hará mediante PR explícito y revisión.
