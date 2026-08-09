# R16 · Auditoría visual — apps/web

Base: `origin/main` @ `4505a54`. Rama: `design/r16-visual-audit`.

Alcance: inventario real de lo que hay en `apps/web/src`, con defectos concretos
citados a `fichero:línea`. No incluye rediseño. No toca páginas que R11
(spectator, `LivePage.tsx`, `viewer/*`) o R12 (`BracketPage.tsx`) van a tocar —
se citan como referencia, no se editan.

## 0. Qué hay realmente

- No existe carpeta de componentes compartidos (`apps/web/src/components/` no
  existe). No hay CSS Modules, styled-components ni Tailwind.
- **Todo el sistema visual vive en un único `<style>` inline dentro de
  `apps/web/index.html:7-130`.** Es el único lugar con tokens de color,
  tipografía y layout para las 21 páginas de `apps/web/src/pages/`.
- El resto del "estilo" está disperso en `style={{ ... }}` inline por página
  (colores, tamaños de fuente y espaciados repetidos y no reutilizables, ver
  §3).
- No hay página de inicio/"home" dedicada: la ruta por defecto (`App.tsx:95`,
  `App.tsx:271-275`) es `#/bots` → `BotsPage`. `App.tsx:95`:
  `useState(window.location.hash || "#/bots")`.
- Router: hash-routing manual con `matchPublicRoute`/`matchPanelRoute`
  (`App.tsx:48-89`), sin librería.
- Estado de carga/error: patrón único y bien resuelto vía `useResource` +
  `ResourceView` (`apps/web/src/resource.tsx:29-121`) y `ErrorBoundary`
  (`apps/web/src/ErrorBoundary.tsx:19-45`) — ver §5, es lo mejor cimentado del
  código actual y debe conservarse como base del sistema de diseño.

## 1. Navegación (`App.tsx:196-241`)

- `<nav aria-label="principal">` con enlaces de texto plano (`App.tsx:199-224`);
  ningún indicador de ruta activa (ni `aria-current="page"` ni clase `.active`).
  Un usuario no ve en qué pantalla está por la nav.
- El nombre de usuario y el botón "Salir" se separan con
  `style={{ marginLeft: "auto" }}` puntual (`App.tsx:226`) en vez de una regla
  reutilizable — funciona porque `nav` es `display:flex` (`index.html:15`) pero
  es un ejemplo de layout resuelto ad-hoc por página.
- En móvil (`index.html:113-117`) la `nav` hace `flex-wrap`, pero con 9-13
  enlaces (según rol) más el badge de usuario y "Salir", en una pantalla
  estrecha se convierte en un bloque de 3-4 líneas de enlaces sueltos sin
  agrupación visual ni menú colapsable — no hay `<button>` de hamburguesa ni
  `aria-expanded`.
- Los enlaces admin (`App.tsx:210-225`: Administración/Sistema/Auditoría/Roles)
  se ocultan por rol pero no llevan ninguna separación visual del resto
  (ej. separador o agrupación `role="group"`) — quedan mezclados con "Mapas" y
  "Ranking" en la misma lista plana.

## 2. Estados de carga / error / vacío

Patrón central correcto: `useResource`/`ResourceView` (`resource.tsx:94-121`)
pinta `role="status" aria-live="polite"` para loading y `role="alert"` +
botón "Reintentar" para error. Bien.

Defectos concretos:
- **Vacíos no unificados**: cada página escribe su propio mensaje de "no hay
  nada" como `<p>` suelto, con textos y ubicación inconsistentes:
  `pages/AuditPage.tsx:50` (`No hay eventos de auditoría todavía.`),
  `pages/BattlesPage.tsx:56` (`No hay batallas que casen con el filtro.`),
  `pages/LivePage.tsx:39` (`data-testid="live-empty"`, con testid — inconsistente,
  las otras tres no lo llevan), `pages/MapsPage.tsx:224`
  (`No hay mapas todavía.`). Ningún componente `EmptyState` compartido: 4
  implementaciones divergentes del mismo concepto.
- **Color como único canal de estado**: `className="error"/"ok"/"warn"`
  (`index.html:61-69`) se usa 40 veces en `pages/*.tsx` (verificado por grep)
  para pintar texto en rojo/verde/ámbar sin icono ni prefijo textual
  redundante en la mayoría de los casos, p. ej. `pages/MapsPage.tsx:264`
  (`<span className="ok">Disponible para batallas</span>` — al menos aquí el
  texto es autoexplicativo) frente a otros usos donde el color es la única
  señal (revisar `BotsPage.tsx`, que concentra la mayoría de los 40 usos).
  Riesgo real de contraste/daltonismo dado que no hay verificación de ratio
  documentada en ningún sitio.
- `resource.tsx:110`: el `data-testid` del error se genera con
  `label.replace(/\s+/g, "-")` — funciona, pero es un identificador frágil
  (dos labels que difieren solo en mayúsculas/tildes colisionan o generan
  ids inconsistentes entre tests).

## 3. Tipografía y espaciado

- Cero tokens: cada página fija `fontSize` en píxeles o em sueltos:
  `pages/BroadcastPage.tsx:96` (`fontSize: 32`), `:113` (`64`), `:114` (`32`),
  `:145` (`36`), `:176` (`44`), `:177` (`40`), `:196` (`56`) — 7 tamaños
  distintos de fuente solo en esa página, ninguno derivado de una escala.
  `viewer/HudOverlay.tsx` añade otra escala paralela en `em` relativos
  (`:61` `1.6em`, `:71` `0.9em`, `:87` `0.85em`, `:243` `2em`) que no
  comparte valores con `BroadcastPage.tsx` pese a representar datos
  equivalentes (marcador, reloj) en dos superficies del mismo producto.
  El font-family global es `system-ui, sans-serif` (`index.html:9`) sin
  fallback a monoespaciada en ningún sitio, ni siquiera en paneles con datos
  tabulares/numéricos (`SystemPage.tsx`, `AuditPage.tsx`).
- Espaciado: `index.html` usa `rem` (`0.8rem`, `1.2rem`, `1rem` — líneas
  16-17, 74-76) pero las páginas individuales mezclan `px` sueltos:
  `MapEditorPage.tsx:240` (`gap: 16`), `:292` (`minWidth: 260`),
  `HudOverlay.tsx:127` (`width: 260`), `ReplayPage.tsx:227` (`height: 640`).
  No hay una escala de espaciado (4/8/12/16...) documentada ni seguida con
  consistencia — los valores en px conviven con los rem del CSS global sin
  relación aritmética declarada.

## 4. Paneles, cards, tablas, badges

- `.card` (`index.html:70-76`) es el único componente de "panel" reutilizado
  vía clase CSS; se usa en `ErrorBoundary.tsx:34` y presumiblemente en varias
  páginas admin. Es la primitiva más cercana a un "Panel" del sistema de
  diseño futuro.
- Tablas: estilo genérico en `index.html:51-60` (`border-collapse`, borde
  inferior en `td/th`). En móvil, `index.html:122-124` fuerza
  `display:block; overflow-x:auto` en `table` — soluciona el desbordamiento
  pero rompe la semántica de encabezados de columna (un lector de pantalla
  pierde la asociación `th`↔`td` al convertir la tabla en bloque). Ninguna
  tabla usa `scope="col"` en sus `<th>` (verificar `MapsPage.tsx`,
  `BotsPage.tsx`) como mitigación.
- Badges de estado: no existe un componente `StatusBadge`; el patrón es
  `<span className={stateClass(m.state)}>{m.state}</span>`
  (`MapsPage.tsx:242`, con `stateClass` mapeando a `error/ok/warn`) repetido
  con variantes propias por página en vez de una única primitiva
  parametrizada por `variant`.

## 5. Formularios y accesibilidad de inputs

- Patrón mixto de etiquetado: algunos inputs usan `<label>` envolvente con
  texto visible (`MapEditorPage.tsx:309-318`, `pages/LoadoutEditor.tsx`),
  otros usan solo `aria-label` sin texto visible en pantalla
  (`BattleNewPage.tsx:218` `aria-label="semilla"`, `BotsPage.tsx:370`
  `aria-label="nuevo-bot"`, `TournamentsPage.tsx:90,115`,
  `LoginPage.tsx:52,84`). Ambos son válidos para lectores de pantalla, pero
  la inconsistencia entre "etiqueta visible" y "solo aria-label" dentro del
  mismo formulario (p. ej. `BattleNewPage.tsx`) genera una experiencia
  desigual para usuarios videntes que sí ven el resto de labels.
- Botones sin `type="button"` explícito conviven con botones que sí lo
  llevan: sin tipo en `BattleNewPage.tsx:153,243`, `ReplayPage.tsx:207-209`,
  `ViewerPage.tsx:101-106` (con `type="button"` en cambio en
  `MapEditorPage.tsx:243-249`, `MapsPage.tsx:262`,
  `LoadoutEditor.tsx:152,285,325`). Dentro de un `<form>`, un `<button>` sin
  `type` explícito por defecto es `submit`: riesgo real de envío accidental
  si alguno de esos botones termina dentro de un `form` (verificar caso a
  caso antes de tocar; no se ha confirmado ningún `form` ancestro roto, pero
  el patrón es inconsistente y frágil).

## 6. Foco y navegación por teclado

- `:focus-visible` está definido globalmente y de forma correcta
  (`index.html:78-82`, outline 2px + offset). Buena base.
- `MapEditorPage.tsx:262-286`: los objetos del mapa son `<circle>`/`<rect>`
  SVG con `onClick` (`:271`, `:284`) pero **sin** `tabIndex`, `role="button"`
  ni `onKeyDown` — no son alcanzables ni activables por teclado directamente
  sobre el lienzo. Mitigación parcial existente: la lista lateral
  (`MapEditorPage.tsx:267-273`, botones reales) permite seleccionar el mismo
  objeto por teclado, así que la función no está bloqueada, pero el lienzo en
  sí no es operable sin ratón.
- Ningún `onKeyDown`/`tabIndex` custom en todo `apps/web/src/pages` ni
  `apps/web/src/viewer` (grep sin resultados) — todo el teclado depende de
  los elementos nativos (`button`, `a`, `input`), lo cual es correcto por
  defecto pero significa que cualquier interacción "custom" futura (drag,
  canvas) no tiene un patrón de teclado ya resuelto que copiar.

## 7. Responsive / móvil

- Único breakpoint en todo el proyecto: `@media (max-width: 720px)`
  (`index.html:113-129`), y solo ajusta `nav`, `main`, `table`, `textarea`.
  Ningún ajuste responsive específico para:
  - El lienzo SVG de `MapEditorPage.tsx:253-256` (`width={map.width * scale}`)
    — ancho fijo en píxeles multiplicado por escala, sin `max-width:100%` ni
    contenedor con scroll declarado explícitamente; en pantalla estrecha
    puede desbordar el `main` (`index.html:25-29`, `max-width:960px` con
    `overflow` no declarado en `main`).
  - Los paneles fijos del HUD (`viewer/HudOverlay.tsx:127`
    `position:absolute, width:260`, `:212` `width:260`) — posiciones y
    anchos fijos en px pensados para pantalla grande, sin adaptación a
    viewport de móvil ni a la resolución de retransmisión
    (`BroadcastPage.tsx` asume 1080p, ver `apps/web/src/pages/BroadcastPage.tsx`
    comentario T11.1 en `App.tsx:138`).
  - `ViewerPage.tsx:134` y `ReplayPage.tsx:227` fijan `height: 640` para el
    host del visor Phaser — no se reduce en viewports pequeños.

## 8. Contraste (revisión estática, sin herramienta de medición en este entorno)

Colores de `index.html`:
- Fondo `#10141a` / texto `#e6e8eb` → contraste alto, correcto.
- Enlaces `#7fb4ff` sobre fondo `#1a212b` (nav, `index.html:22`) — se estima
  aceptable (azul claro sobre oscuro) pero no se ha calculado el ratio
  exacto en esta auditoría; **pendiente de verificación con herramienta**.
- Estados: `.error #ff8686`, `.ok #7fe3a1`, `.warn #ffd479` — los tres son
  colores claros pensados para fondo oscuro; no se ha verificado contraste
  frente a `#10141a`/`#171d26` (fondo de `.card`, `index.html:71`) con una
  herramienta real. Riesgo señalado en §2 (color como único canal) es
  independiente de si el contraste numérico pasa AA.
- `opacity: 0.5/0.45/0.7/0.85` se usa reiteradamente para "atenuar" texto
  secundario (`HudOverlay.tsx:65,71,87,96,98,157,179,193,243,249`,
  `ViewerPage.tsx:128`) — la opacidad reduce el contraste efectivo por
  debajo del ya calculado para el color base, sin que se haya verificado
  el resultado final contra el fondo real (que además cambia: el HUD se
  monta sobre el canvas del juego, no sobre `#10141a` fijo).

## 9. Páginas fuera de alcance de este PR (no auditadas en detalle / no tocar)

- `viewer/*` (Phaser) — no auditado en profundidad: `phaser` no está
  instalado en este entorno (typecheck falla ahí; es del entorno, confirmado,
  no se ha intentado arreglar ni instalar).
- `pages/LivePage.tsx`, cualquier página de "spectator" — territorio de R11.
- `pages/BracketPage.tsx` — territorio de R12.

## 10. Resumen priorizado

1. Sin componente `EmptyState`/`StatusBadge` reutilizable → 4+
   implementaciones divergentes de "no hay nada" y 40 usos de clases de color
   sin canal redundante.
2. Sin escala tipográfica ni de espaciado → valores sueltos en cada página
   (`BroadcastPage.tsx` con 7 tamaños de fuente sin relación entre sí).
3. Lienzo del editor de mapas no operable por teclado directamente
   (mitigado parcialmente por la lista lateral).
4. Tablas con `overflow-x:auto` en móvil rompen semántica de cabecera sin
   `scope` en `th` (a verificar caso por caso).
5. Nav sin indicador de ruta activa y sin colapso en móvil pese al
   `flex-wrap`.
6. Contraste de colores de estado y de textos con `opacity` reducida no
   verificado con herramienta — pendiente de medición real.
