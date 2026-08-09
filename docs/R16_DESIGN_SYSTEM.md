# R16 · Sistema de diseño propuesto — apps/web

Complementa `docs/R16_VISUAL_AUDIT.md` (léelo primero: cada regla de aquí
responde a un defecto concreto listado allí). Este documento define tokens y
componentes objetivo; **no implementa un rediseño de páginas existentes**.
Solo se implementan aquí primitivas nuevas y aisladas cuando es 100% seguro
hacerlo (ver §8).

## 1. Principios

- Un único origen de tokens. Hoy son las 130 líneas de `apps/web/index.html`;
  deben ser la base literal de la paleta (no reinventar colores), solo
  nombrarlos y completarlos.
- Nunca color como único canal de estado (audit §2, §8): todo estado lleva
  texto o icono, el color es refuerzo.
- Todo lo interactivo es operable por teclado sin excepción, incluidos
  lienzos custom (audit §6).
- Una sola forma de decir "cargando", "vacío" y "error" en toda la app
  (audit §2): el patrón de `resource.tsx` se mantiene como motor; lo que
  falta es una piel visual común para sus tres estados.

## 2. Tokens

Basados en los valores ya presentes en `index.html:7-130` (no se inventan
colores nuevos, se catalogan los existentes):

```
--color-bg:        #10141a   /* body */
--color-bg-raised:  #1a212b   /* nav */
--color-bg-panel:   #171d26   /* .card */
--color-bg-input:   #0d1117   /* input/select/textarea */
--color-border:     #2a3340   /* td/th, .card, .bracket .round */
--color-border-input: #333c4a
--color-text:       #e6e8eb
--color-link:       #7fb4ff
--color-accent:     #2f6fdb   /* button bg */
--color-accent-disabled: #444c58
--color-status-error: #ff8686
--color-status-ok:    #7fe3a1
--color-status-warn:  #ffd479
--focus-ring: 2px solid #7fb4ff (offset 2px)
```

Pendiente para R16 real: verificar con herramienta de contraste (no
disponible en este entorno) que `--color-status-*` sobre `--color-bg-panel`
y sobre el fondo real del HUD (variable, no fijo) cumplen AA. No se afirma
aquí que cumplan; es un pendiente explícito (audit §8).

### Escala tipográfica (propuesta, deriva de lo ya usado, no inventa una nueva)

El audit (§3) muestra 7 tamaños sueltos solo en `BroadcastPage.tsx`. Se
propone consolidar en una escala de 6 pasos que cubre los valores ya vistos:

```
--text-xs:   0.85em   (ya usado: HudOverlay.tsx:87,96)
--text-sm:   0.9em    (ya usado: HudOverlay.tsx:71, ViewerPage.tsx:128 usa 13px≈0.8em, revisar)
--text-base: 1em
--text-lg:   1.6em    (ya usado: HudOverlay.tsx:61)
--text-xl:   2em      (ya usado: HudOverlay.tsx:243)
--text-2xl:  2.5em    (nuevo — para BroadcastPage.tsx que hoy usa 44-64px sueltos)
```

`BroadcastPage.tsx` es una superficie de retransmisión a resolución fija
(1080p); su escala puede vivir en px absolutos aparte (no debe forzarse a
`em` relativos como el resto del panel), pero debe declarar sus propios
tokens (`--broadcast-text-xl: 64px`, etc.) en vez de números sueltos
repetidos en cada `style={{ fontSize: N }}`.

### Escala de espaciado

```
--space-1: 4px
--space-2: 8px
--space-3: 12px
--space-4: 16px
--space-6: 24px
--space-8: 32px
```
Cubre los valores ya vistos en el código (`gap:16` en
`MapEditorPage.tsx:240`, `width:260` en `HudOverlay.tsx:127` queda como
excepción de layout de panel fijo, no de espaciado).

## 3. Layout

- `main` centrado con `max-width:960px` (`index.html:25-29`) es el
  contenedor estándar del panel autenticado. Debe declarar `overflow-x: auto`
  explícito para absorber contenido más ancho (lienzo SVG del editor de
  mapas, audit §7) en vez de dejarlo desbordar la ventana.
- Layout de dos columnas (lista + panel de edición) ya existe implícito en
  `MapEditorPage.tsx:240` (`display:flex, gap:16, flexWrap:wrap`) y
  `LoadoutEditor.tsx`. Candidato a primitiva `<TwoPaneLayout>` cuando se
  toquen esas páginas (fuera de alcance ahora, R10/R9 las tocan).

## 4. Paneles y cards

- `Panel` = la clase `.card` existente (`index.html:70-76`), nombrada como
  componente. Reutilizable ya en `ErrorBoundary.tsx:34`.
- HUD del visor (`viewer/HudOverlay.tsx`) usa una variable local `panel`
  (referenciada en `:82`, `:127`, `:138`, `:212` — no leída completa en esta
  auditoría, fuera de alcance por ser R11/viewer) que es conceptualmente el
  mismo componente que `.card` pero con fondo semitransparente para overlay
  sobre el canvas del juego. Cuando se unifique (fuera de este PR), debe ser
  una *variante* de `Panel` (`variant="overlay"`), no un sistema paralelo.

## 5. Tablas

- Mantener `border-collapse` + borde inferior en `td/th` (`index.html:51-60`).
- Añadir `scope="col"` a todos los `<th>` de cabecera (falta verificar caso
  por caso, audit §4) — cambio de una palabra por tabla, cero riesgo visual,
  pero requiere tocar cada página con tabla (fuera de alcance de "no tocar
  páginas activas": se deja como recomendación para el PR que sí las toque).
- El `overflow-x:auto` en móvil (`index.html:122-124`) se mantiene para no
  romper el layout, pero debe combinarse con `scope` en `th` para no perder
  semántica al colapsar a bloque.

## 6. Badges de estado (`StatusBadge`)

Contrato propuesto (no implementado en páginas activas, ver §8 para la
primitiva aislada que sí se entrega):

```ts
type StatusVariant = "ok" | "warn" | "error" | "neutral";
function StatusBadge(props: { variant: StatusVariant; children: ReactNode })
```

Reglas:
- El texto (`children`) siempre es la fuente de verdad; el color es refuerzo,
  nunca el único canal (audit §2/§8).
- Reemplaza el patrón actual `<span className={stateClass(...)}>` visto en
  `MapsPage.tsx:242,264` sin cambiar su comportamiento — mismo output visual,
  mismas clases CSS subyacentes (`.ok/.warn/.error` de `index.html:61-69`).

## 7. Estados: loading / error / vacío

El motor (`resource.tsx`) ya es correcto y no se toca. Lo que falta es una
piel visual común para los tres casos, que hoy cada página reinventa
(audit §2):

```ts
function LoadingState(props: { label: string })   // role="status" aria-live="polite"
function ErrorState(props: { label: string; message: string; onRetry: () => void }) // role="alert"
function EmptyState(props: { message: string; action?: ReactNode })
```

`ResourceView` (`resource.tsx:94-121`) ya implementa `LoadingState` y
`ErrorState` inline; la extracción a componentes con estos contratos es un
refactor de una función que sí se puede aislar sin tocar páginas que la
consumen (la interfaz pública de `ResourceView` no cambia). `EmptyState` no
tiene hogar hoy: cada página decide sola cuándo pintar su `<p>No hay
X</p>` after leer `resource.status === "ready"`. Formalizarlo requeriría
tocar cada página (`AuditPage.tsx:50`, `BattlesPage.tsx:56`,
`LivePage.tsx:39`, `MapsPage.tsx:224`) — fuera de alcance de este PR de
auditoría; la primitiva se entrega en §8 y YA está adoptada (ver estado real ahí).

## 8. Componentes reutilizables — inventario para R16 posterior

> **Estado actualizado.** La primera versión de esta tabla decía «sin
> consumidores» para las seis primitivas y listaba `scope="col"` como no
> implementado. Era cierto cuando se escribió la auditoría, y dejó de serlo en el
> mismo PR que la adopta: el supervisor independiente de #108 señaló que la
> documentación contradecía al código que la acompaña. Corregido aquí.

| Componente     | Basado en                              | Estado real |
|----------------|------------------------------------------|--------|
| `Panel`        | `.card` (`index.html:70-76`)             | adoptado en AuditPage, MapsPage, TeamsPage |
| `StatusBadge`  | `className="ok/warn/error"` (40 usos)    | adoptado en MapsPage |
| `EmptyState`   | 4 implementaciones divergentes           | adoptado en AuditPage, MapsPage, RankingPage |
| `LoadingState` | `resource.tsx:101-107` (inline)          | adoptado en AuditPage, MapsPage |
| `ErrorState`   | `resource.tsx:108-118` (inline)          | adoptado en AuditPage, MapsPage |
| `Button`       | `<button>` + `index.html:30-41`          | adoptado en TeamsPage |

Todas se implementan en `apps/web/src/ui/` (carpeta nueva, sin colisión con
nada existente), exportan las mismas clases CSS que ya existen en
`index.html` (no se inventa estilo nuevo, se envuelve el existente en
componentes con contrato tipado). La adopción se ha hecho SOLO en las cuatro
páginas autorizadas (AuditPage, MapsPage, TeamsPage, RankingPage): no se ha
tocado ninguna página de R11/R12, ni `BotsPage`, ni `index.html`, ni `App.tsx`.

Pendiente todavía (requiere tocar el HTML compartido o ficheros de otros
carriles, fuera de las reglas de este PR):
- Nav con indicador de ruta activa y colapso móvil (toca `App.tsx`, propiedad
  compartida entre carriles: deliberadamente NO tocado).
- `scope="col"` en tablas: YA implementado en las TRES páginas de este PR que
  tienen tabla con cabeceras — AuditPage (5), MapsPage (7) y RankingPage (4),
  16 ocurrencias. TeamsPage no aparece porque su tabla no lleva `<thead>`/`<th>`.
  (La primera versión de esta línea decía «las cuatro páginas»: una imprecisión
  metida al corregir otra. Señalada por el supervisor del delta de #108.)
  Queda pendiente en las páginas de otros carriles.
- Tokens CSS reales (`:root { --color-bg: ... }`) en `index.html` — technically
  aislado (no rompe nada, los `<style>` actuales seguirían funcionando en
  paralelo), pero se decide no tocarlo en este PR porque `index.html` es
  compartido por *todas* las páginas simultáneamente y cualquier error de
  sintaxis ahí sí sería un incidente global; se deja documentado como paso 1
  de la adopción futura, no como cambio de esta auditoría.
