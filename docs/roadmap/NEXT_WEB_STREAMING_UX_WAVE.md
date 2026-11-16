# Próxima ola — Web UX, Streaming y coherencia de producto

**Estado:** PLANNED / DESIGN_ONLY  
**Fecha de registro:** 2026-11-16  
**No implementar mientras estén en curso OLA 2 / Engine Hardening y los cierres activos actuales.**

Este documento conserva las mejoras acordadas para retomarlas como una ola separada cuando termine el trabajo actualmente en marcha. No implica que estas funciones estén implementadas.

## Objetivo

Mejorar la usabilidad humana de la web, cerrar defectos visibles del streaming ya conocidos y completar varias incoherencias de producto sin mezclar estos cambios con OLA 2.

Reglas para la futura ola:

- un bloque funcional por PR;
- tests y mutantes/no-vacuidad cuando corresponda;
- review independiente para cambios de seguridad, competición o streaming;
- no rediseñar la pantalla de streaming que ya funciona salvo los cambios funcionales descritos aquí;
- conservar compatibilidad y privacidad de bots/versiones.

---

## 1. Navegación general

### WEB_NAV_LEFT_ALIGNMENT

El menú lateral sigue demasiado centrado.

Pendiente:

- moverlo sensiblemente más a la izquierda;
- aprovechar mejor el ancho disponible;
- mantener comportamiento responsive;
- evitar volver a centrar visualmente navegación y contenido en pantallas anchas.

Criterio:

```
WEB_NAV_LEFT_ALIGNMENT = PASS
```

---

## 2. Mis bots

### 2.1 Crear bot arriba

El botón **Crear bot** debe estar arriba, antes de la lista, visible como acción principal.

No debe quedar al final de una lista larga.

### 2.2 Bots retirados

Añadir control para mostrar/ocultar bots retirados.

Comportamiento deseado:

- lista normal: retirados ocultos por defecto;
- opción/filtro: `Mostrar retirados`;
- posible vista/sección `Retirados`;
- retirar no borra versiones, batallas ni replays.

### 2.3 Buscador y filtros

Añadir búsqueda por nombre y filtros combinables, como mínimo:

- Público;
- Código público;
- Pertenece a un equipo;
- Estado activo/retirado;
- nombre del bot.

El diseño debe funcionar con cientos de bots, no sólo con listas pequeñas.

### 2.4 Resumen del bot

Revisar la lógica del bloque **En batallas**.

Caso detectado: un bot puede mostrarse como público/publicado y, aun así, el resumen decir:

> Ninguna versión publicada y elegible: este bot todavía no puede entrar en batallas.

El resumen debe mostrar el motivo real de elegibilidad, por ejemplo:

- versión publicada y elegible;
- frozen e inmutable pero reutilizable;
- loadout inválido;
- suspendida/revocada;
- no compatible con el modo;
- no existe versión elegible.

No usar mensajes genéricos que contradigan el estado real.

Si tiene batallas/replays, el resumen puede mostrar actividad reciente o enlaces útiles.

---

## 3. Equipamiento

Se mantiene la idea actual del icono de información `ⓘ`.

Actualmente aparecen textos técnicos del tipo:

```
(`drive` · movimiento, ≤XL) [ACTIVE · cambia la batalla]
```

Estos metadatos son útiles, pero no deben dominar la interfaz normal.

Pendiente:

- dejar nombre y descripción en lenguaje humano;
- mover identificadores/metadatos técnicos al popup `ⓘ`;
- traducirlos a texto comprensible.

Ejemplo:

```
Afecta al movimiento
Compatible hasta tamaño XL
Tiene efecto durante la batalla
```

El identificador interno `drive` puede aparecer en un apartado técnico secundario.

---

## 4. Replays de bot

Añadir filtros para listas grandes.

Mínimo:

- fecha desde/hasta;
- accesos rápidos: 24 h, 7 días, 30 días;
- considerar más adelante filtros por oponente, modo y resultado.

No diseñar la vista sólo para el volumen actual de replays.

---

## 5. Torneos

### 5.1 Crear torneo arriba

**Crear torneo** debe estar arriba y mostrarse como acción principal claramente visible.

### 5.2 Ruleset como selector

No pedir al usuario que escriba manualmente un identificador de `ruleset` si el servidor ya conoce las opciones válidas.

Pendiente:

- desplegable/selector con rulesets disponibles;
- nombre humano;
- descripción mediante `ⓘ`;
- identificador interno como información secundaria;
- impedir errores tipográficos.

### 5.3 Ayuda de ruleset

La ayuda debe explicar que un ruleset es el conjunto de reglas que gobierna la batalla/torneo, incluyendo los límites y comportamiento que correspondan al ruleset real.

No documentar valores inventados: obtener nombres y descripciones de la fuente real del producto.

---

## 6. Batallas

### 6.1 Nueva batalla como acción principal

**Nueva batalla** debe verse como un botón claro y suficientemente grande.

### 6.2 Textos explicativos a ancho útil

Los bloques explicativos de Nueva batalla no deben quedar restringidos a media pantalla.

En particular, revisar los bloques que explican:

- que la batalla se encola y la ejecuta el worker;
- que los bots usan versiones publicadas;
- que las batallas manuales no cuentan para ranking;
- diferencia entre bot, versión, bando rojo/azul y equipo.

Deben ocupar el ancho útil cuando sean visibles.

### 6.3 Descripción de modos mediante ⓘ

Para textos como:

```
Duelo · Una vida. Sin reaparición.
Gana el último bot operativo...
```

mostrar:

```
Duelo ⓘ
```

y mover la explicación completa a popup/ayuda contextual.

Mantener la misma convención visual que Equipamiento.

---

## 7. Mapas

### 7.1 Editor visible

**Editor de mapas** debe ser un botón/acción principal visible.

### 7.2 Ayuda contextual

Aplicar el patrón `ⓘ` para explicar:

- guardar como borrador;
- reabrir;
- publicar;
- import JSON interno;
- export/import de Tiled;
- generación procedural;
- validación real;
- sólo mapas publicados en batallas;
- compatibilidad por modos;
- borde del mapa como muro.

Los textos largos deben:

- ocupar el ancho útil; o
- reducirse a un resumen breve + popup/ayuda.

### 7.3 Importar mapa existente

**Importar un mapa existente** debe aparecer como una acción clara, no perdida dentro de un párrafo largo.

---

## 8. Administración

Revisar y rediseñar la zona de administración para uso humano.

Objetivo: agrupar por tareas, no por detalles internos.

Áreas candidatas:

- usuarios y permisos;
- plataforma;
- bots y batallas;
- streaming;
- copias/restore;
- diagnóstico/estado.

Reglas:

- acciones frecuentes visibles;
- opciones peligrosas claramente diferenciadas;
- configuración avanzada secundaria;
- textos técnicos detrás de ayuda contextual cuando sea posible.

Gate propuesto:

```
WEB_UX_HUMAN_READABLE = PASS
```

Criterio: un administrador no debe necesitar conocer nombres internos del código para entender qué hace cada control.

---

## 9. Streaming — mejoras para próxima ola

La pantalla actual de streaming no se rediseña de cero. Se mantiene y se añaden estas mejoras funcionales.

### 9.1 Delay configurable desde web

Actualmente el retardo usado en el flujo probado es fijo.

Pendiente:

```
STREAM_DELAY_CONFIGURABLE
```

Requisitos:

- configurable desde la web;
- validado también por API;
- una única fuente de verdad;
- web, API, gateway, director y renderer usan exactamente el mismo valor;
- ningún fallback asume 30 s;
- ningún valor hard-coded que pueda adelantar una transición.

Propuesta inicial de UX:

- 0 s;
- 15 s;
- 30 s;
- 60 s;
- personalizado.

Rango orientativo de producto: 0–300 s. Validar antes de fijarlo como contrato definitivo.

Tests mínimos:

- 0;
- 15;
- 30;
- 60;
- máximo;
- inválido;
- cambio entre batallas;
- fin de batalla;
- fin de torneo;
- gateway degradado/fallback.

Gate:

```
CONFIGURABLE_STREAM_DELAY = PASS
```

### 9.2 Color de bots en streaming

Bug confirmado pendiente:

```
STREAMING_BOT_TEAM_COLOR = FAIL
```

En streaming los bots pueden aparecer blancos aunque live/replay web los coloreen correctamente.

Esperado:

```
mismo battle state
→ mismo bot/team color en web live
→ mismo bot/team color en replay
→ mismo bot/team color en streaming
```

Probar explícitamente que no cae a blanco/default salvo ausencia real de color.

### 9.3 Pantalla entre batallas

P3 observado: durante un torneo ya iniciado puede reaparecer:

> Esperando el inicio del torneo…

entre batallas.

Debe usar un mensaje coherente con torneo en curso, por ejemplo espera/transición a la siguiente batalla, sin volver al estado inicial.

### 9.4 Cabecera de batalla

P3 observado: la cabecera puede mostrar siempre **Batalla 1**.

Debe mostrar la batalla/posición real que el director está emitiendo.

### 9.5 Resultado público / anti-spoiler

La API pública puede revelar el resultado real antes que el feed retrasado.

No se clasificó como canal de coaching durante la batalla, pero sí como spoiler.

Decisión para la ola:

- diseñar si el delay del espectador también debe actuar como anti-spoiler;
- si se activa, la proyección pública temporal debe respetar el mismo timeline;
- no mezclar estado real y estado retrasado en superficies visibles.

---

## 10. Streaming de replays

### 10.1 BROADCAST_BATTLE_REPLAY

Actualmente una batalla finalizada puede aparecer en el selector, pero la emisión sólo puede mostrar su pantalla final; el replay completo no se retransmite.

Implementar como feature separada:

```
replay guardado
→ reproductor a velocidad 1x
→ snapshots/ticks
→ renderer/HUD
→ streamer
→ YouTube o MP4
```

Requisitos:

- iniciar desde tick 0;
- velocidad normal 1x inicialmente;
- mismo HUD/renderer coherente;
- al terminar, mostrar resultado;
- no modificar estado real de la batalla;
- replay terminado no necesita anti-coaching;
- mantener privacidad de bots/código.

Gate:

```
BROADCAST_BATTLE_REPLAY = PASS
```

### 10.2 BROADCAST_TOURNAMENT_REPLAY

Después del replay individual, permitir retransmitir un torneo finalizado como playlist de replays.

Necesita:

- orden determinista;
- transición entre batallas;
- tratamiento definido para batallas originalmente simultáneas;
- clasificación/final al terminar;
- no alterar el torneo real.

Gate:

```
BROADCAST_TOURNAMENT_REPLAY = PASS
```

---

## 11. Frozen — coherencia pendiente

La reutilización de versiones frozen ya se implementó aparte. Quedan dos hallazgos preexistentes para esta ola.

### 11.1 FROZEN_PUBLIC_SOURCE_VISIBILITY

Una versión frozen cuyo código era público no debería volverse ilegible para terceros sólo porque dejó de estar en estado `published`.

Revisar `canReadSource` y separar:

- inmutabilidad;
- visibilidad;
- elegibilidad.

### 11.2 FROZEN_REVALIDATE_ON_ENTRY_CLOSE

Al cerrar inscripciones, revalidar el estado/elegibilidad de las versiones inscritas.

Caso a impedir:

```
versión válida al inscribirse
→ suspendida/revocada antes del cierre
→ cierre la acepta sin revalidar
```

No saltarse el resto de reglas de elegibilidad.

### 11.3 Inscribir mientras cargan versiones

P3 UX:

- deshabilitar **Inscribir** mientras la lista de versiones/elegibilidad todavía está cargando;
- la API sigue siendo la autoridad.

---

## 12. Calidad / observabilidad

### 12.1 Dropped frames

Hubo dropped frames en pruebas reales de streaming.

Estado:

```
STREAM_DROPPED_FRAMES_DIAGNOSIS = UNKNOWN
```

La hipótesis principal es infraestructura, pero no está demostrado.

Añadir instrumentación para separar:

- renderer;
- encoder/FFmpeg;
- relay;
- tap;
- network backpressure;
- CPU/IO/host pressure.

No "arreglar" reseteando contadores.

Gate:

```
STREAM_DROPPED_FRAMES_UNDERSTOOD = PASS
```

### 12.2 tests/acceptance en CI

Se detectó que parte de `tests/acceptance` no estaba incluida en CI, permitiendo que algunos gates sólo fallasen en ejecución manual.

Pendiente:

- decidir qué subset debe ejecutarse en CI normal;
- incluir gates baratos y deterministas;
- dejar los que dependan de infraestructura pesada en una job explícita, no invisibles.

Gate:

```
ACCEPTANCE_GATES_IN_CI = PASS
```

---

## 13. Cierre de aceptación C3b

El streaming con director retrasado se verificó en producción, pero C3 no cerró formalmente porque el requisito pedía 5+ ticks por batalla y las batallas fueron demasiado cortas para el intervalo real de keyframes.

Pendiente:

```
ACCEPTANCE_C3B
```

Diseñar la prueba para obtener evidencia suficiente:

- batallas suficientemente largas o captura adecuada;
- 5+ ticks distintos por batalla;
- movimiento;
- HUD cambiante;
- transición;
- final respetando delay;
- sin reset RTMP.

No confundir falta de evidencia con fallo funcional.

---

## 14. Prioridad propuesta

Cuando termine el trabajo actualmente en marcha:

### Ola A — coherencia/bugs

1. color de bots en streaming;
2. revalidación frozen al cierre;
3. visibilidad de código frozen;
4. cabecera/transición visual de streaming;
5. acceptance gates en CI;
6. C3b.

### Ola B — UX Web

1. navegación;
2. Mis bots;
3. resumen;
4. equipamiento;
5. replays;
6. torneos/ruleset;
7. batallas;
8. mapas;
9. administración.

### Ola C — nuevas capacidades streaming

1. delay configurable;
2. anti-spoiler coherente;
3. battle replay broadcast;
4. tournament replay broadcast;
5. instrumentación/cierre de dropped frames.

La agrupación final puede cambiar al abrir los PRs, pero no mezclar varios bloques funcionales independientes en un único PR.

---

## 15. Fuera de esta ola

Mantener separados:

- OLA 2 / Engine Hardening;
- asistente de primera configuración;
- cron/configuración de backups;
- volumen de backup configurable;
- perfiles/credenciales de streaming por usuario;
- nuevas reglas/modos de juego no relacionadas con estas correcciones.

Estas mejoras pueden tener su propia planificación posterior.
