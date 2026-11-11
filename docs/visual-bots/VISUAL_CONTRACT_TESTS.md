# VISUAL_CONTRACT_TESTS — Qué vigila el test del contrato visual

**Proyecto:** visuales componibles de bots ([MASTER-PLAN](MASTER-PLAN.md)) · **Fase:** FASE 0
**Fichero:** `packages/module-catalog/visual-contract.test.ts` (corre en el job `unit` de la CI).
**Estado:** borrador del AUTHOR (ronda 4, 2026-11-11), pendiente de revisión independiente.

El test lee el catálogo real (`loadCatalog()`, el `enum` de `module.schema.json`), el validador real, constantes y
fragmentos del motor, y parsea las tablas Markdown y los bloques JSON y TypeScript de los documentos de
`docs/visual-bots/`. Sin BD, sin red y sin ejecutar el motor.

Ejecución local (un solo worker):

```sh
npx vitest run packages/module-catalog/visual-contract.test.ts --maxWorkers=1
```

## Regla de cobertura: conjunto real = conjunto documentado

Toda tabla con clave se compara como **conjunto exacto**, no como recuento ni como subconjunto, y la clave no puede
repetirse sumando todas las tablas con la misma cabecera:

| QUÉ | CONJUNTO REAL (de dónde sale) | DÓNDE ESTÁ DOCUMENTADO |
| --- | --- | --- |
| Componentes (DOMAIN_ID) | `loadCatalog()` (`id@version`) + lista canónica runtime | Inventario §3-§4, matriz §5-§6 |
| Categorías | `enum` del schema ∪ categorías de `data/` | Matriz §3 |
| Datos de fog of war (DATA_ID) | Lista canónica del test (revisada en las rondas 1-3) | Matriz §12 |
| Ranuras (CHASSIS_SLOT) | `computedSlotTable()` con el validador real | Matriz §12.1 |
| Armas (WEAPON_KIN) | Catálogo + constantes del motor | Matriz §12.2 |
| Fugas entre vistas (CROSS_VIEW_ID) | Lista canónica | Matriz §12.3 |
| Fugas del motor (ENGINE_LEAK_ID) | Lista canónica con su issue | Matriz §12.4 |
| Estados visuales (STATE) | Los 13 estados del encargo | Matriz §13 |
| Mount types (MOUNT_TYPE) | Taxonomía canónica; los de ranura, exactamente los usados en los bloques JSON | MOUNT_TYPE_DRAFT §2, matriz §9 |
| Bloques de chasis (JSON) | Un bloque por chasis; `chasis@versión` único y igual a los chasis del catálogo | Matriz §9 |
| Perfiles de vista (VIEW_PROFILE) | Lista canónica con rol, clases y OBSERVER_DEPENDENT | ADR-VIS-002 |
| Parejas visor↔vehículo (PAIR_CASE) | Matriz mínima canónica + función de referencia | ADR-VIS-002 |
| Cachés (CACHE_ID) | Tres niveles canónicos | ADR-VIS-002 |
| Revelaciones (REVEAL_ID) | Lista canónica; sus datos = filas de §12 «PUBLIC por inferencia tras el primer disparo» | ADR-VIS-002 |
| Transiciones de visibilidad (VIS_TRANSITION) | Casos canónicos T1-T6, relación y políticas + función de referencia | ADR-VIS-002 |

Con eso se detectan, en rojo: una fila duplicada idéntica, un id repetido (también con otra clasificación o en otra
sección), un id real que falta, un id inventado, un bloque JSON repetido (con los mismos valores o con otros), un
duplicado reordenado, una variante con espacios (las celdas se recortan, así que es un duplicado) o con mayúsculas
(no se normaliza, así que es un id inventado) y una clasificación vacía o nula. Una tabla escondida en un bloque de
código o en un comentario HTML no cuenta como cobertura, y una línea con `|` pegada a una tabla es un error.

## Qué comprueba cada bloque

- **TEST 0 · Estructura.** El parser no se salta filas: ids fuera de tablas reconocidas, filas parseadas = filas brutas
  por tabla, referencias de código de los estados CURRENT que existen.
- **TEST 1-3 · Inventario y categorías.** Cobertura exacta del catálogo, campos del catálogo copiados bien.
- **TEST 4 · Clasificación.** Clases válidas; `YES` ⇒ PUBLIC; `DERIVED_DISCLOSURE` = `NO` ⇔ `ENGINE_DERIVED` = `—`; las
  referencias de `ENGINE_DERIVED` son una issue de motor, una decisión `D-0x` o `BY_DESIGN`; §12.3 sólo va hacia vistas
  con menos privilegio.
- **TEST 5-6 · Mounts, sensores y armas.** Ranuras reales con su `maxSize`, chasis únicos, mount types exactos.
- **TEST 7 · Ranuras y PRE-1.** Tabla de encaje calculada; las reglas de `cross.raw_replay` y `cross.owner_to_rival`
  empiezan por «Prohibido» y citan la proyección saneada; ninguna regla es permisiva; ninguna prosa permite a una vista
  pública leer el crudo; `debugOpen` inventariado.
- **TEST 8 · Proyectiles y torreta.** `WEAPON_KIN` calculada (velocidad, alcance, cadencia, daño, ritmo de giro de la
  torreta); premisas del motor vigiladas en el código (ttl, cooldown, disparo sólo en ticks de decisión, giro de
  torreta); armas y blindajes distinguibles atados a #262 y #263.
- **TEST 9 · Perfiles.** Lista canónica de perfiles; las públicas ven exactamente lo PUBLIC y su fuente de
  equipamiento no es el crudo; la de equipo no pasa de PUBLIC ∪ ALLY_ONLY; el dueño ve más que el público.
- **TEST 10 · Pareja visor↔vehículo (P2-9).** Campos exactos de `VisualProjectionContext`; matriz mínima de parejas
  contra una función de referencia escrita en el test (relación a partir del visor y del vehículo **observado**; perfil a
  partir del canal y de la relación); owner(A)/A ≠ owner(A)/B; la IntrinsicComposition no se sirve al cliente y la clave
  de la ProjectedComposition separa cualquier par de parejas con distinto vehículo o distinto perfil.
- **TEST 12 · Transiciones de visibilidad (CROSS_VIEW_VISIBILITY_TRANSITION).** La regla «ProjectedComposition cache
  MUST NOT survive a visibility transition that changes what the viewer may observe» está en ADR-VIS-002 y en
  `cross.composition_cache`; la clave proyectada lleva `visibilityStateVersion` (el estado, recalculado en cada
  petición); `CHANGES` y `KEY` de cada caso salen de una función de referencia; una caché **simulada** con la clave
  declarada en el ADR nunca sirve, tras una transición (revelación, vuelta a oculto en replay o en otra batalla, otro
  visor, dueño → anónimo, espectador → broadcast, cambio de equipo o de política), la composición de antes, en ningún
  orden; el replay público es, en cada estado, la proyección de un espectador; y ningún par de contextos que vean cosas
  distintas comparte clave (parejas × estados × casos).
- **TEST 11 · ENGINE_DERIVED.** Las cuatro clases de fuga; §12.4 con exactamente #261, #262 y #263; sus `DATA_IDS` y
  `DOMAIN_IDS` coinciden en los dos sentidos con §12, §5 y §6 y con lo que sale del catálogo; el roadmap cita las tres
  issues.

## Qué no vigila (y por qué)

- **La prosa cuantitativa** (la frase sobre la cadencia de §12.2, el ejemplo trabajado de ADR-VIS-002): es explicación.
  La autoridad son las tablas calculadas; así lo dicen los propios documentos.
- **La cinemática de la tracción** (velocidad y giro de orugas frente a ruedas): se documenta como «inferible con ruido»
  en la matriz §5, sin tabla calculada.
- **Las fugas ENGINE_DERIVED en sí:** el test vigila que estén clasificadas y atadas a su issue, no que el motor las
  corrija. Su arreglo es de las issues #261, #262 y #263.

## Mutantes

La calibración se hace en serie, sobre un árbol commiteado: aplicar un mutante, ejecutar el fichero con un worker,
revertir y comprobar que el árbol vuelve a estar limpio. Cada mutante exigido tiene que dar `VITEST_RC=1`. La lista y
los resultados de cada ronda van en el informe del AUTHOR de esa ronda, no en este documento.
