# ADR-VIS-003 · Sistema de coordenadas de los mounts

**Estado:** propuesto (2026-11-09, FASE 0, AUTHOR; pendiente de revisión independiente) ·
**Ámbito:** cómo se expresan posición, rotación, escala, espejo y orden de los mounts de un chasis visual.
**Base:** `mejoras-visuales` @ `983d2f5`. **Relacionados:** [MASTER-PLAN §5 SRS-F02, §10](../MASTER-PLAN.md),
[MOUNT_TYPE_DRAFT](../MOUNT_TYPE_DRAFT.md), [VISUAL_COMPONENT_MATRIX §9](../VISUAL_COMPONENT_MATRIX.md).

## Contexto (verificado en el repo)

- **El motor** trabaja en metros (`WORLD_UNIT = "m"`), con el vehículo como un **círculo** de `radiusM` (collider
  `ball` en `physics.ts`): 1.2 m ligero, 1.6 m medio, 2 m pesado. `PIXELS_PER_METER = 10` es «sólo para el visor».
- Ángulos en **radianes**; `heading` 0 = eje +x; la boca del arma está a `radiusM + 0.3` m a lo largo de
  `turretHeading` (`battle.ts`). Sectores de impacto: frontal ±45°, trasero ±135° respecto al morro (`combat.ts`).
- **El visor** dibuja cascos rectangulares de tamaño fijo por arquetipo (2.6×1.8, 3.2×2.2 y 3.8×2.8 m en
  `atlas-geometry.ts`) a `PX_PER_M = 8 × FRAME_SCALE`; la torreta es un contenedor que rota `turretHeading − heading`
  relativo al casco (`PhaserViewer.ts`).
- El schema de chasis admite `slots[].offsetM {x, y}` pero **ningún** chasis lo usa: no hay coordenadas de montaje.
- Contextos de tamaño muy distinto: ficha (cientos de px), mapa (decenas de px por bot), broadcast 1080p.

## Opciones

| Opción | Ventajas | Inconvenientes |
| --- | --- | --- |
| Píxeles | Simple para quien dibuja | Ligado a un tamaño de render; cada contexto reescala a mano |
| Porcentaje | Independiente del tamaño | Ambiguo (¿de qué caja?), mismo problema que normalizado sin origen claro |
| Normalizado 0..1 de la caja del chasis | Independiente del tamaño; lo pide SRS-F02 | Origen en esquina: rotar alrededor del centro exige convertir; distorsiona si la caja no es cuadrada |
| Coordenadas locales del SVG (viewBox) | Natural para el artista | Cada asset su propio sistema; difícil validar entre chasis |
| Ancla + transformación | Rotación y espejo limpios alrededor de un punto conocido | Por sí sola no fija la unidad |

## Decisión

**Coordenadas normalizadas centradas en el casco + ancla y transformación por pieza.**

1. **Espacio del chasis**: cada chasis visual declara una caja `bounds` en su propio espacio; el **origen (0,0) es el
   centro de rotación del vehículo** (el centro del círculo del motor), **+x = morro** (rumbo 0 del motor), **+y = a la
   izquierda del morro** en el sistema matemático del motor. Las posiciones de mount son **normalizadas** respecto al
   semieje mayor del casco: `x, y ∈ [-1, 1]`, con `(1, 0)` = punta del morro. Así una misma definición sirve a 64 px y a
   1080p, y las rotaciones son alrededor del origen sin conversión.
   *Esto concreta SRS-F02 («coordenadas normalizadas»): el ejemplo del MASTER-PLAN usa 0..1 con origen en esquina; se
   cambia a centrado porque el motor y el visor rotan alrededor del centro.*
2. **Rotación**: radianes, sentido del motor (antihorario desde +x). `rotation` del mount es relativa al casco
   (`ORIENTATION: hull`) o a la torreta (`ORIENTATION: turret`); `none` = no rota con nada.
3. **Escala**: la escala de una pieza la fija el **chasis** (tamaño del mount, ligado al `MAX_SIZE` de la ranura), no el
   asset. Un asset se dibuja en su propia caja normalizada y el mount lo escala a su tamaño. Así no hay que retocar
   cada chasis al añadir un componente (PRD-09).
4. **Mirror**: `mirror: "y"` refleja la pieza respecto al eje longitudinal; lo usan `armor.side`, `mobility.right` y
   `sensor.flank`. Un asset por lado no hace falta.
5. **Ancla del asset**: cada asset declara su `anchor` (punto que se coloca sobre el mount) en su caja normalizada; para
   el arma, el ancla es el eje de giro de la torreta y declara además `muzzle` (punta) para `fx.muzzle`.
6. **z-order**: por `LAYER_GROUP` (tabla única en MOUNT_TYPE_DRAFT §3) y, dentro del grupo, por orden declarado del mount.
   Nunca números sueltos en la UI.
7. **Bounds y overflow**: una pieza puede sobresalir de `bounds` del casco (cañón largo, antena) hasta un margen
   declarado por el chasis (`overflow`); el validador de FASE 9 lo comprueba. Los mounts `sensor.top` y `radio.top`
   no pueden solaparse con el círculo de la torreta (zona reservada) para que la capa 50/60 no tape el arma.
8. **Relación con el motor**: el radio físico (`radiusM`) **no** es el tamaño visual (el visor ya dibuja cascos más
   largos que el diámetro del círculo). Se declara en la definición del chasis `metersPerUnit` para colocar efectos que
   el motor sitúa en metros (boca del arma, explosiones) sin inventar posiciones.

9. **Paso a pantalla (sin flip de y).** El compositor trabaja en el sistema del motor y el renderer lo lleva a pantalla
   **como hace hoy el visor**: `setPosition(x · pxPerM, y · pxPerM)` y `setRotation(heading)` sin invertir y
   (`PhaserViewer.ts`). Phaser tiene y hacia abajo, así que la imagen en pantalla es el espejo del dibujo matemático
   (antihorario en el motor = horario en pantalla), pero **todo** se refleja igual: casco, torreta, proyectiles,
   explosiones y mounts. Reglas que de ello se siguen:
   - `armor.side` del sector **left** (`rel > 0` en `sectorOfImpact`, `combat.ts`) se coloca en **+y del motor**; en
     pantalla queda a la **derecha visual** del morro, que es justo el lado por el que llegan en pantalla los impactos
     que el motor clasifica como «left». No se corrige con un flip: hacerlo separaría la placa del sector que protege.
   - Las coordenadas de mount, `rotation` y `mirror` se expresan siempre en el sistema del motor; ningún asset ni
     ningún mount compensa la y de la pantalla.
   - Un render fuera del visor (ficha, SVG estático) aplica la **misma** transformación (sin flip), para que el mismo
     bot se vea igual en todas partes.

## Consecuencias

- FASE 1: el schema de chasis visual incluye `bounds`, `overflow`, `metersPerUnit` y mounts con
  `{x, y, rotation, mirror?, size}`; el de componente, `anchor`, `muzzle?` y `acceptsMountTypes`.
- La boca visual del arma debe ser coherente con la del motor (`radiusM + 0.3` m) o el fogonazo aparecerá separado del
  cañón; se comprueba con un test de composición.
- Los valores concretos se fijan en FASE 2 (vertical slice), no ahora.
