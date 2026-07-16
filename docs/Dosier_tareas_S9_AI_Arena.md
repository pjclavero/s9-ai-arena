# S9 AI ARENA

## Dosier de tareas, prompts y pruebas de aceptación

*Desglose ejecutable del Dosier técnico v1.0 · Motor 2D modular*

Versión 1.0 · Julio de 2026 · 12 equipos · Objetivo: proyecto terminado y desplegable

---

## Índice

- [0. Cómo usar este dosier](#0-cómo-usar-este-dosier)
- [0.1 Mapa de equipos y dependencias](#01-mapa-de-equipos-y-dependencias)
- [E1. Equipo de Contratos y Especificación](#e1-equipo-de-equipo-de-contratos-y-especificacin)
- [E2. Equipo de Motor de Simulación](#e2-equipo-de-equipo-de-motor-de-simulacin)
- [E3. Equipo de Sistema Modular de Vehículos](#e3-equipo-de-equipo-de-sistema-modular-de-vehculos)
- [E4. Equipo de Mapas y Generación Procedural](#e4-equipo-de-equipo-de-mapas-y-generacin-procedural)
- [E5. Equipo de Protocolo y SDKs de Bots](#e5-equipo-de-equipo-de-protocolo-y-sdks-de-bots)
- [E6. Equipo de Seguridad y Ejecución de Código](#e6-equipo-de-equipo-de-seguridad-y-ejecucin-de-cdigo)
- [E7. Equipo de Plataforma Web y API](#e7-equipo-de-equipo-de-plataforma-web-y-api)
- [E8. Equipo de Visor y Replays](#e8-equipo-de-equipo-de-visor-y-replays)
- [E9. Equipo de Torneos y Clasificación](#e9-equipo-de-equipo-de-torneos-y-clasificacin)
- [E10. Equipo de DevOps, Despliegue y Observabilidad](#e10-equipo-de-equipo-de-devops-despliegue-y-observabilidad)
- [E11. Equipo de Streaming](#e11-equipo-de-equipo-de-streaming)
- [E12. Equipo de QA e Integración (transversal, propuesto)](#e12-equipo-de-equipo-de-qa-e-integracin-transversal-propuesto)
- [13. Plan de integración y cierre del proyecto](#13-plan-de-integración-y-cierre-del-proyecto)
- [14. Checklist final de despliegue en producción](#14-checklist-final-de-despliegue-en-producción)

---

## 0. Cómo usar este dosier

Este documento desgrana el Dosier técnico de S9 AI Arena (v1.0, julio 2026) en paquetes de trabajo ejecutables. Cada capítulo del dosier técnico queda cubierto por un equipo. Los equipos pueden trabajar en paralelo porque se comunican únicamente mediante los contratos versionados que produce el Equipo E1: mientras un contrato no cambie, ningún equipo bloquea a otro.

Cada tarea incluye un prompt autocontenido, pensado para entregarse tal cual a un desarrollador, a un agente de Claude Code o a un subequipo. Todos los prompts asumen tres entradas disponibles: (1) el repositorio monorepo s9-ai-arena con la estructura del capítulo 22, (2) el Dosier técnico v1.0 como contexto, y (3) el paquete de contratos publicado por E1. Si el contrato necesario aún no existe, la tarea se ejecuta contra el borrador de E1 y se marca como pendiente de reconciliación.

El resultado de cada tarea es siempre una pull request contra main que incluye código o documentos, las pruebas listadas en su Definition of Done implementadas y en verde, y la actualización de la documentación afectada en /docs.

**Convenciones de cada tarea**

- ID de tarea: Tx.y, donde x es el equipo e y el orden sugerido. Las tareas de un mismo equipo se ejecutan en orden salvo indicación contraria.
- Prompt de ejecución: texto literal a entregar al ejecutor de la tarea (persona o agente). No requiere contexto adicional más allá de las tres entradas comunes.
- Pruebas / Definition of Done: lista de verificaciones objetivas. La tarea solo se considera terminada cuando todas están automatizadas (cuando aplique) y pasan en CI.
- Sección de mejoras (x.M): carencias, ambigüedades o riesgos detectados en el capítulo correspondiente del dosier técnico, con la propuesta concreta de resolución. Deben resolverse dentro del mismo hito que las tareas del equipo.
- Cada equipo mantiene un archivo /docs/equipos/Ex-estado.md con tareas terminadas, decisiones tomadas y desviaciones respecto al dosier técnico.

**Regla de cierre**

> El proyecto se declara terminado cuando los seis hitos del capítulo 13 tienen su puerta de salida en verde y el checklist de despliegue del capítulo 14 está completo. No hay criterio de fin subjetivo: todo criterio es una prueba ejecutable o una verificación documentada.

---

## 0.1 Mapa de equipos y dependencias

Doce equipos. E1 a E11 corresponden a los bloques A–L del capítulo 7 del dosier técnico (reagrupados por afinidad); E12 es un equipo transversal de QA e integración que este dosier añade como mejora, porque el documento original define criterios de aceptación (cap. 28) pero no asigna a nadie su automatización.

| Equipo | Capítulos | Depende de |
|---|---|---|
| **E1 · Equipo de Contratos y Especificación** | 3, 7, 8, 15.2, 25 (Fase 0) y 27.1 | ninguna (arranca primero) |
| **E2 · Equipo de Motor de Simulación** | 9, 12 y la parte de cálculo del 11 | E1 (contratos y ADR-000) |
| **E3 · Equipo de Sistema Modular de Vehículos** | 10, 11 (catálogo de sensores) y 12 (catálogo de armas) | E1 (esquema de módulos) |
| **E4 · Equipo de Mapas y Generación Procedural** | 14 | E1 (esquema de mapa), E2 (clearances y navegación) |
| **E5 · Equipo de Protocolo y SDKs de Bots** | 15 | E1 (esquemas de protocolo), E2 (motor con bucle) |
| **E6 · Equipo de Seguridad y Ejecución de Código** | 17.1 (estados de validación), 18 | E5 (protocolo/SDK), E10 (imágenes base) |
| **E7 · Equipo de Plataforma Web y API** | 16, 17, 23 | E1 (OpenAPI), E3 (validador de loadouts), E6 (pipeline de builds) |
| **E8 · Equipo de Visor y Replays** | 20 | E2 (snapshots/eventos), E7 (API/gateway) |
| **E9 · Equipo de Torneos y Clasificación** | 13 (reglas de modos), 19 y 20.3 (ratings) | E7 (API/BD), E6 (artefactos firmados), E2 (motor), E8 (replays/stats) |
| **E10 · Equipo de DevOps, Despliegue y Observabilidad** | 6, 22, 24 | E1 (para nombres/contratos); da servicio a todos desde el día 1 |
| **E11 · Equipo de Streaming** | 21 | E8 (visor), E10 (Compose/secretos) |
| **E12 · Equipo de QA e Integración (transversal, propuesto)** | 26.1 y 28 (este equipo no existe en el dosier: es una mejora) | todos |

**Orden de arranque recomendado**

- Semana 0: E1 en solitario (Fase 0). Nadie escribe código de producto hasta que E1 publique contratos v0.1 y el documento de decisiones cerradas.
- A partir de contratos v0.1: arrancan en paralelo E2 (motor), E3 (módulos), E4 (mapas), E5 (protocolo/SDK), E7 (plataforma) y E10 (DevOps, que monta CI y Compose de desarrollo desde el primer día).
- Cuando E2 emite snapshots y E5 tiene SDK Python: arrancan E8 (visor/replays) y E6 (seguridad/builds).
- Cuando E7 tiene API de bots y E6 tiene pipeline de builds: arranca E9 (torneos).
- E11 (streaming) arranca cuando E8 tiene el visor estable. E12 (QA) trabaja desde el hito M1 en paralelo con todos.

---

## E1. Equipo de Contratos y Especificación

*Ámbito: capítulos 3, 7, 8, 15.2, 25 (Fase 0) y 27.1 del dosier técnico. Entradas: ninguna (arranca primero). Salida hacia: todos los equipos.*

Convierte el dosier técnico en contratos formales y decisiones cerradas. Es el único equipo cuyo retraso bloquea a los demás, por lo que su alcance es deliberadamente pequeño: esquemas, decisiones y versionado. No implementa lógica.

### T1.1 — Cerrar las decisiones pendientes del capítulo 27.1

El dosier deja nueve decisiones abiertas que bloquean al motor, al protocolo y a los módulos. Esta tarea las cierra con valores concretos y justificados.

**Prompt de ejecución**

```
Redacta /docs/decisiones/ADR-000-decisiones-fundacionales.md cerrando las nueve decisiones del capítulo 27.1 del dosier técnico. Para cada una: valor elegido, justificación, alternativas descartadas e impacto. Propuesta de partida a validar: mundo en metros con 1 unidad = 1 m y arena MVP de 120×80 m; tick de simulación a 30 Hz y decisión de bots a 10 Hz (1 orden cada 3 ticks); movimiento arcade con aceleración e inercia simples sin fuerzas realistas; motor en TypeScript/Node con Rapier2D compat (versión determinista) fijada por checksum; protocolo v1 en JSON sobre WebSocket con envelope que reserva migración a binario; daño simplificado por sectores sin penetración por materiales en MVP; presupuesto de loadout de 1000 créditos, masa y energía según catálogo E3; niebla de guerra total con radio de equipo de 32 bytes por mensaje y 2 mensajes/s; código de bots privado por defecto con opción de publicarlo. Cada decisión debe ser modificable solo mediante un nuevo ADR.
```

**Pruebas y Definition of Done**

- [ ] Existe ADR-000 con las nueve decisiones, cada una con valor, justificación e impacto.
- [ ] E2, E3 y E5 han revisado y firmado el documento (registro de revisión en la PR).
- [ ] Ninguna decisión queda redactada de forma ambigua: cada una es citable como constante (p. ej. TICK_HZ = 30).
- [ ] Las constantes derivadas están exportadas en packages/game-rules/constants.ts con test que verifica coherencia (p. ej. decisión múltiplo del tick).

### T1.2 — Esquemas del protocolo motor–bot

**Prompt de ejecución**

```
Crea packages/protocol con JSON Schema (draft 2020-12) para los seis mensajes del capítulo 15.2: HELLO, WELCOME, OBSERVATION, COMMAND, EVENT y SHUTDOWN, más un envelope común { proto: 'arena/1', type, tick, seq, payload }. Define en OBSERVATION la estructura de estado propio (pose, energía, estado de módulos) y detecciones por sensor; en COMMAND las órdenes de movimiento, torreta, disparo, mina, módulo on/off y mensaje de radio, todas opcionales. Genera tipos TypeScript desde los esquemas y publica el paquete como @arena/protocol con versionado semántico. Añade una carpeta examples/ con al menos tres mensajes válidos y tres inválidos por tipo, y un validador CLI (arena-protocol validate <file>).
```

**Pruebas y Definition of Done**

- [ ] Los 6 esquemas validan sus ejemplos válidos y rechazan los inválidos (test automatizado en CI).
- [ ] Los tipos TypeScript se generan desde los esquemas en build, sin duplicación manual.
- [ ] El envelope incluye versión de protocolo y el esquema rechaza versiones desconocidas.
- [ ] CHANGELOG y política de compatibilidad escritos: cambio incompatible = major, campo opcional nuevo = minor.

### T1.3 — Esquemas de módulos, loadouts y mapas

**Prompt de ejecución**

```
Crea packages/module-catalog/schema con el JSON Schema de definición de módulo: id estable, versión inmutable, categoría (chasis, movimiento, energía, sensor, arma, munición, mina, blindaje, radio, utilidad), masa, coste, consumo, propiedades por categoría según el capítulo 10.3, y compatibilidades (ranura, tamaño S/M/L/XL, chasis admitidos). Crea también el esquema de loadout: chasis + lista de módulos instalados con ranura asignada. En packages/map-schema define el formato interno de mapa del capítulo 14.2: schemaVersion, id, versión inmutable, checksum sha256 del contenido, capas (suelo, muros, destructibles, zonas, spawns, bases, banderas, navegación), materiales con vida y bloqueo de visión, metadatos (autor, licencia, modos compatibles, miniatura). Incluye ejemplos válidos/ inválidos y validadores CLI para ambos.
```

**Pruebas y Definition of Done**

- [ ] Esquema de módulo cubre las 9 categorías del catálogo con sus propiedades principales.
- [ ] Un loadout de ejemplo del MVP (chasis medio, orugas, batería, lidar, cañón, blindaje) valida correctamente.
- [ ] El checksum del mapa es reproducible: serialización canónica documentada y testeada.
- [ ] Los esquemas rechazan IDs duplicados y versiones regresivas (tests incluidos).

### T1.4 — Contrato OpenAPI de la plataforma

**Prompt de ejecución**

```
Redacta apps/api/openapi.yaml (OpenAPI 3.1) con los recursos del capítulo 16, 17 y 23: auth (registro, login, refresh, revocación, 2FA), users, teams, bots (con estados del 17.1 y transiciones como acciones explícitas: submit, publish, freeze, suspend, retire), bot-versions, loadouts, builds, maps, map-versions, module-definitions, rulesets, tournaments, entries, matches, battles, replays, standings y audit-log. Define esquemas de error uniformes, paginación por cursor, y marca cada operación con el rol mínimo requerido (visitante a administrador, cap. 16) mediante una extensión x-min-role. No implementes nada: solo el contrato, con ejemplos por endpoint. Añade lint con Spectral en CI y generación de un cliente TypeScript que debe compilar.
```

**Pruebas y Definition of Done**

- [ ] openapi.yaml pasa spectral lint sin errores.
- [ ] El cliente TypeScript generado compila y se publica como @arena/api-client.
- [ ] Cada endpoint tiene x-min-role y la matriz rol×operación exportada es legible por E7 para sus tests RBAC.
- [ ] Las transiciones de estado de bot del capítulo 17.1 existen como operaciones y las ilegales están documentadas como 409.

### E1.M — Mejoras y carencias detectadas en el dosier técnico

- El capítulo 27.1 debería resolverse en Fase 0 y el dosier no asigna responsable: este dosier lo asigna a E1/T1.1 con valores de partida concretos para no bloquear.
- El dosier propone 'JSON Schema/Protobuf' sin decidir: se fija JSON Schema en v1 con envelope preparado para binario; adoptar Protobuf solo si el perfil de latencia lo exige (medirlo en M2).
- Falta una política de compatibilidad de contratos entre servicios: se añade semver por paquete y una tabla de compatibilidad motor↔protocolo↔SDK mantenida por E1 en /docs/compatibilidad.md.
- No hay proceso de cambio de contrato: se propone RFC ligera (issue + revisión de los equipos afectados + bump de versión) antes de fusionar cualquier cambio en packages/*.

---

## E2. Equipo de Motor de Simulación

*Ámbito: capítulos 9, 12 y la parte de cálculo del 11 del dosier técnico. Entradas: E1 (contratos y ADR-000). Salida hacia: E5, E8, E9.*

Construye el núcleo autoritativo y determinista: tick fijo, física, armas, daño, sensores y modos de juego. Todo headless y testeable sin plataforma, sin visor y sin bots reales (usa bots simulados internos hasta que E5 entregue el protocolo).

### T2.1 — Núcleo de tick fijo, RNG con semilla y bucle de batalla

**Prompt de ejecución**

```
Implementa en apps/arena-engine el núcleo del capítulo 9: bucle de tick fijo a TICK_HZ (ADR-000) que ejecuta los 9 pasos del 9.2 en orden estable, un PRNG con semilla (xoshiro o PCG, sin Math.random) inyectado a todo el motor, y un BattleConfig (mapa mínimo hardcodeado, reglas, semilla, participantes). Los bots de esta fase son BotStub internos con comportamientos fijos (quieto, avanzar, girar en círculo). Prohibido leer el reloj del sistema para lógica de juego: añade una regla de lint que bloquee Date.now, performance.now y Math.random en src/sim/. Al final de la batalla el motor emite un BattleResult con ganador, duración en ticks y un hash sha256 del estado final serializado canónicamente. Expón un CLI: arena-engine run --seed N --config file --ticks M.
```

**Pruebas y Definition of Done**

- [ ] 1000 ejecuciones con la misma semilla y configuración producen el mismo hash de estado final (test de CI, puede muestrear 100 en cada PR y 1000 en nightly).
- [ ] Semillas distintas producen hashes distintos en un escenario con aleatoriedad.
- [ ] La regla de lint anti-reloj/anti-Math.random falla el build si se viola (test que lo demuestra).
- [ ] El CLI corre una batalla de 3000 ticks en menos de 5 segundos en la máquina de CI (headless acelerado, cap. 9.4).

### T2.2 — Física con Rapier: movimiento, colisiones y raycasts

**Prompt de ejecución**

```
Integra Rapier2D (build determinista, versión y checksum del WASM fijados en ADR-000) en el motor: cuerpos rígidos para vehículos con el modelo de movimiento arcade decidido (aceleración, velocidad máxima, giro), muros estáticos, y raycasts para línea de visión. El paso de física se ejecuta dentro del paso 4 del bucle con timestep fijo. Añade colisiones vehículo–vehículo y vehículo–muro con respuesta simple. Crea tres escenarios golden (persecución, choque frontal, slalom entre muros) cuyos replays de referencia (secuencia de poses por tick) se guardan en el repo; cualquier cambio de resultado exige regenerarlos explícitamente en la PR.
```

**Pruebas y Definition of Done**

- [ ] Los tres escenarios golden reproducen exactamente sus replays de referencia en CI (comparación por hash por tick).
- [ ] El checksum del WASM de Rapier se verifica en arranque y el motor se niega a arrancar si no coincide.
- [ ] Un vehículo no atraviesa muros a velocidad máxima (test de túnel con el timestep elegido).
- [ ] El BattleResult registra versión de motor, de Rapier y de reglas (cap. 8, 'versión fija').

### T2.3 — Armas, proyectiles, minas y daño por sectores y módulos

**Prompt de ejecución**

```
Implementa el capítulo 12: torretas con arco y velocidad de giro, armas con cadencia, dispersión (usando el PRNG del motor) y cooldown; proyectiles como entidades simuladas con velocidad y vida; minas creadas por el servidor previa validación de posición, inventario, cooldown y límites (12.3); explosiones con radio y caída de daño. Resolución de impactos contra sectores (frontal, laterales, trasero) con blindaje por sector, y daño a módulos con los cinco estados del 12.2 (operativo, dañado, crítico, destruido, desconectado). Un chasis a 0 destruye el vehículo; un vehículo puede quedar vivo pero inmóvil, ciego o desarmado. Toda la tabla de efectos por estado debe vivir en packages/game-rules como datos, no como código disperso.
```

**Pruebas y Definition of Done**

- [ ] Matriz de pruebas de daño: impacto en cada sector con y sin blindaje produce los valores esperados de la tabla de game-rules.
- [ ] Un vehículo con movimiento destruido no se desplaza pero sigue girando torreta y percibiendo (test de estados combinados).
- [ ] Una solicitud de mina inválida (sin inventario, en cooldown, dentro de un muro) se rechaza y genera evento, sin crear la entidad.
- [ ] Los escenarios golden de T2.2 se amplían con uno de combate y siguen siendo deterministas.

### T2.4 — Sensores, niebla de guerra y observaciones privadas

**Prompt de ejecución**

```
Implementa el capítulo 11 sobre los raycasts de T2.2: lidar (abanico de rayos con distancia y tipo de impacto), radar (contactos con posición aproximada y error usando el PRNG), proximidad, acústico (dirección de disparos/motores recientes) y posicionamiento propio. En cada tick de decisión el motor genera una OBSERVATION distinta por bot (esquema @arena/protocol) que contiene exclusivamente lo que sus sensores instalados y operativos permiten. Implementa la radio del 11.2: mensajes limitados en tamaño y frecuencia (ADR-000), validados por radio operativa y alcance. Regla dura: los datos no observables jamás entran en el objeto de observación, ni siquiera marcados como ocultos.
```

**Pruebas y Definition of Done**

- [ ] Test de fuga: se serializa la OBSERVATION de un bot y se verifica que no contiene ninguna entidad fuera de su percepción (fuzzing sobre 200 posiciones aleatorias con semilla).
- [ ] Un bot sin lidar no recibe el bloque lidar; con el lidar en estado destruido, tampoco (tests por estado de módulo).
- [ ] Mensaje de radio que excede tamaño o frecuencia se descarta con evento; receptor fuera de alcance no lo recibe.
- [ ] El cálculo de sensores de 4 bots en el mapa MVP cabe en el presupuesto de tick a 30 Hz (benchmark en CI con umbral).

### T2.5 — Modos de juego: deathmatch, TDM, captura de bandera y zonas

**Prompt de ejecución**

```
Implementa un motor de reglas conectable (interfaz GameMode con hooks en los pasos 5–6 del bucle) y los cuatro modos del MVP según el capítulo 13: deathmatch, team deathmatch con fuego amigo configurable y respawn, captura de bandera con la máquina de estados completa del 13.1 (en base, transportada, caída, retornando, capturada) y reglas configurables (capturas para ganar, tiempo de retorno, necesidad de bandera propia), y control de zonas con puntuación continua. Las condiciones de victoria, límites de tiempo y respawn se leen de un ruleset (packages/game-rules) validado por esquema. Añade escenarios guionizados con BotStubs para cada modo.
```

**Pruebas y Definition of Done**

- [ ] Máquina de estados de bandera: test que recorre todas las transiciones válidas y rechaza las inválidas (p. ej. capturar sin bandera propia en base cuando la regla lo exige).
- [ ] Escenario guionizado CTF 2v2 termina con el marcador exacto esperado, de forma determinista.
- [ ] Fuego amigo on/off cambia el resultado del escenario TDM guionizado como se espera.
- [ ] Un ruleset inválido se rechaza al cargar la batalla con error descriptivo.

### T2.6 — Emisión de eventos, snapshots y hash de estado para replays

**Prompt de ejecución**

```
Añade al motor la salida para espectadores y replays (base para E8): un flujo de eventos tipados (impacto, daño, muerte, captura, mina, mensaje) y snapshots completos del estado público a frecuencia configurable (por defecto 10 Hz para espectador), más un snapshot privado por bot solo si el modo depuración lo pide. Cada K ticks (configurable) el motor emite un hash de estado para verificación de replays. Serializa todo con versión de esquema. El motor escribe opcionalmente a disco un archivo de batalla: cabecera (config, semilla, versiones, checksum de mapa) + comandos recibidos + eventos + snapshots keyframe, en JSONL comprimido con zstd.
```

**Pruebas y Definition of Done**

- [ ] Un archivo de batalla re-simulado desde cabecera+comandos reproduce el mismo BattleResult y los mismos hashes intermedios (test de round-trip).
- [ ] Los snapshots de espectador no contienen observaciones privadas de bots (test de fuga).
- [ ] El tamaño del archivo de una batalla MVP de 5 minutos es inferior a 5 MB (umbral en test, ajustable por ADR).
- [ ] La frecuencia de snapshot es configurable sin afectar al determinismo de la simulación (mismo hash final con 5 Hz y 30 Hz de snapshot).

### E2.M — Mejoras y carencias detectadas en el dosier técnico

- El dosier no define la 'acción segura' del paso 2 del bucle: se fija como 'mantener última orden de movimiento con arma en no disparar', registrada en game-rules y modificable por ruleset.
- No se especifica qué ocurre si un bot se desconecta a mitad de batalla (cap. 9/15): se propone ventana de gracia de G ticks (ADR) con acción segura y descalificación pasada la ventana, siempre como evento sin alterar el orden de simulación.
- El determinismo de Rapier entre plataformas no es automático: exige compilación con la opción determinista y la misma build WASM. Se añade verificación de checksum en arranque (T2.2) y las batallas oficiales solo corren en la imagen Docker oficial del motor.
- El dosier menciona calor en armas y energía pero no define ninguna regla: se recomienda excluir el calor del MVP explícitamente (decisión para ADR) o definir una regla mínima; este dosier asume exclusión.
- Se añade un presupuesto de milisegundos por tick con métrica exportada (para el cap. 24) que el dosier pide medir pero no dimensiona.

---

## E3. Equipo de Sistema Modular de Vehículos

*Ámbito: capítulos 10, 11 (catálogo de sensores) y 12 (catálogo de armas) del dosier técnico. Entradas: E1 (esquema de módulos). Salida hacia: E2, E7.*

Define el catálogo de módulos como datos, el validador de ensamblaje y la resolución de capacidades que consume el motor. El principio central del proyecto (el hardware determina lo que el código puede hacer) se materializa aquí.

### T3.1 — Catálogo de módulos v1 del MVP

**Prompt de ejecución**

```
Crea packages/module-catalog/data con las definiciones JSON (conformes al esquema de E1/T1.3) de todos los módulos del MVP según el capítulo 26: chasis ligero, medio y pesado; ruedas y orugas; batería y generador básicos; lidar frontal, lidar 360 y radar básico; ametralladora y cañón con sus municiones estándar; mina explosiva; blindaje frontal, lateral y trasero en dos materiales; radio corta. Cada módulo con id estable (p. ej. chassis.medium@1), masa, coste en créditos, consumo, propiedades de su categoría (cap. 10.3) y compatibilidades. Los valores numéricos iniciales deben formar un sistema coherente con el presupuesto, masa y energía de ADR-000: documenta en /docs/balance/v1.md la lógica de cada número.
```

**Pruebas y Definition of Done**

- [ ] Todos los módulos validan contra el esquema de E1 en CI.
- [ ] Existe al menos un loadout legal por chasis dentro de presupuesto, masa y energía (test constructivo).
- [ ] Ningún módulo referencia compatibilidades inexistentes (test de integridad referencial).
- [ ] El documento de balance explica cada valor; los números no aparecen sin justificación.

### T3.2 — Validador de ensamblaje de loadouts

**Prompt de ejecución**

```
Implementa en packages/module-catalog el validador de las ocho reglas del capítulo 10.2: ranuras (tipo, tamaño y posición según chasis), masa total contra carga estructural y del sistema de movimiento, energía (generación + batería cubren consumo permitido y picos), compatibilidad arma–torreta–munición–chasis, volumen S/M/L/XL, presupuesto de créditos, límites de duplicados y restricciones por modo/torneo (lista de categorías prohibidas inyectable). El validador devuelve una lista de violaciones con código, módulo implicado y explicación legible; nunca solo un booleano. Debe ser una función pura utilizable por la API (E7), el motor (E2) y el editor web.
```

**Pruebas y Definition of Done**

- [ ] Suite con al menos 25 loadouts: cada inválido falla exactamente por la regla esperada (asserts sobre el código de violación).
- [ ] Test de propiedad (fast-check): generando loadouts aleatorios, ninguno aceptado viola masa, energía o presupuesto.
- [ ] El validador es determinista y sin E/S: mismo input, misma salida, sin acceso a red o disco.
- [ ] La API y el motor usan la misma función (import compartido verificado, sin duplicación).

### T3.3 — Resolución de capacidades: de loadout a vehículo simulable

**Prompt de ejecución**

```
Implementa la función resolveVehicle(loadout, catálogo) que produce la ficha efectiva que consume el motor: masa total, velocidad y giro resultantes (movimiento + masa), pools de energía, lista de sensores con sus parámetros, armas montadas con torreta asignada, blindaje por sector, radio y utilidades. Incluye la degradación por estado de módulo del 12.2: la ficha expone las prestaciones actuales dadas las salud de cada módulo, y el motor la reconsulta cuando cambia un estado. Congela el resultado con la versión del catálogo usada, para que una batalla registre exactamente qué números aplicaron (cap. 10.4).
```

**Pruebas y Definition of Done**

- [ ] Golden files: 6 loadouts de referencia producen fichas exactas versionadas en el repo.
- [ ] Dañar el motor de movimiento a 'crítico' reduce velocidad según la tabla de game-rules (test integrado con E2).
- [ ] La ficha registra id y versión del catálogo; dos versiones de catálogo distintas producen fichas distintas trazables.
- [ ] Rendimiento: resolver 100 loadouts < 50 ms (se usa en validación masiva de torneos).

### T3.4 — Balance inicial por simulación espejo

**Prompt de ejecución**

```
Monta un banco de balance: usando el motor headless de E2 y los BotStubs, enfrenta arquetipos de loadout (ligero-explorador, medio-polivalente, pesado-artillero) en mapas espejo, alternando lados, con 200 batallas por emparejamiento y semillas registradas. Genera un informe (/docs/balance/informe-v1.md) con winrate por emparejamiento, daño medio, duración y supervivencia por módulo. Ajusta los valores del catálogo (creando versiones nuevas, nunca sobrescribiendo, cap. 10.4) hasta que ningún emparejamiento salga del rango 45–55 % de winrate. El banco debe quedar como comando reutilizable: arena-balance run --matrix arquetipos.json.
```

**Pruebas y Definition of Done**

- [ ] El comando de balance corre la matriz completa y produce el informe de forma reproducible por semilla.
- [ ] Todos los emparejamientos de arquetipos MVP quedan en winrate 45–55 % (con intervalo de confianza reportado).
- [ ] Cada ajuste de valores creó una versión nueva de módulo; las versiones anteriores permanecen intactas (test de inmutabilidad).
- [ ] El banco corre en nightly CI y alerta si un cambio de motor o catálogo saca algún emparejamiento del rango.

### E3.M — Mejoras y carencias detectadas en el dosier técnico

- El dosier no define la economía de créditos: este dosier fija 1000 créditos de presupuesto MVP en ADR-000 y exige documentar el coste de cada módulo en el doc de balance.
- El capítulo 10.4 habla de administración de módulos por operadores pero no de tooling: se propone que la carga/edición del catálogo en la plataforma (E7) sea por importación de estos JSON versionados desde el repo, evitando un editor de módulos en el MVP.
- No existe criterio de equilibrio en el dosier: se introduce el banco de simulación espejo (T3.4) con umbral 45–55 % como criterio objetivo y automatizado.
- Falta definir qué pasa con módulos 'desconectados' voluntariamente y la energía: se propone que desconectar elimina consumo pero exige N ticks para reactivar (valor en game-rules).

---

## E4. Equipo de Mapas y Generación Procedural

*Ámbito: capítulos 14 del dosier técnico. Entradas: E1 (esquema de mapa), E2 (clearances y navegación). Salida hacia: E2, E7, E9.*

Cadena completa de mapas: edición en Tiled, importación al formato interno, validación exhaustiva, servicio de mapas versionado y generación procedural reproducible.

### T4.1 — Importador de Tiled al formato interno

**Prompt de ejecución**

```
Implementa en apps/map-service el importador Tiled→formato interno (esquema E1/T1.3): lee el JSON exportado por Tiled (formato oficial documentado en doc.mapeditor.org), mapea las capas acordadas del capítulo 14.1 (suelo, muros, obstáculos destructibles, zonas, spawns, bases, banderas, decoración, navegación) y las propiedades personalizadas (vida, material, bloqueo de visión, reglas de zona) a los campos del esquema. Calcula el checksum sha256 sobre la serialización canónica. Crea maps/mvp-arena-01.tmx, el mapa MVP de 120×80 m con muros, zona de daño, obstáculos destructibles, dos bases y dos banderas, y su versión importada de referencia en el repo. El importador es un CLI: map-service import <tmx> --out <json>.
```

**Pruebas y Definition of Done**

- [ ] El mapa MVP importa sin errores y su JSON coincide con la referencia del repo (golden file).
- [ ] El checksum es estable entre ejecuciones y sistemas operativos (test de canonicalización).
- [ ] Propiedades personalizadas desconocidas producen warning listado, no fallo silencioso.
- [ ] Un TMX con capa obligatoria ausente falla con error que indica la capa.

### T4.2 — Validador de mapas

**Prompt de ejecución**

```
Implementa el validador con las seis comprobaciones de la tabla del capítulo 14.3: geometría (sin solapes inválidos, spawns fuera de obstáculos), navegación (existencia de ruta entre spawns, bases y banderas para cada tamaño de chasis admitido, usando un grid de navegación con clearance por tamaño), jugabilidad (anchos mínimos de pasillo y zonas abiertas parametrizados), equilibrio (distancias spawn–objetivo comparables entre lados con tolerancia configurable, cobertura simétrica aproximada), modo (bases/banderas/zonas presentes y bien colocadas para los modos declarados) y destrucción (los muros destructibles no son la única ruta salvo permiso explícito, verificado recalculando navegación con los destructibles eliminados y sin ellos). Salida: informe estructurado con errores y warnings por comprobación. Crea un corpus tests/maps-broken/ con al menos 10 mapas rotos, uno por tipo de defecto.
```

**Pruebas y Definition of Done**

- [ ] Cada mapa del corpus roto falla exactamente en la comprobación esperada.
- [ ] El mapa MVP pasa las seis comprobaciones para los tres chasis.
- [ ] La comprobación de destrucción detecta un mapa donde la única ruta a la bandera atraviesa un muro destructible.
- [ ] El validador es invocable como librería (lo usará el generador y la API) y como CLI, con el mismo resultado.

### T4.3 — Servicio de mapas: API, versionado inmutable y miniaturas

**Prompt de ejecución**

```
Completa apps/map-service como servicio interno (cap. 6.2): endpoints para importar (recibe TMX o JSON interno, valida con T4.2, rechaza si hay errores), publicar (asigna versión inmutable y congela contenido+checksum), listar/consultar por id y versión, y descargar el JSON exacto por checksum. Genera miniatura PNG en la publicación. Persistencia: archivos en el volumen arena_maps con índice en PostgreSQL (tablas maps y map_versions del cap. 23). Publicado = inmutable: cualquier cambio crea versión nueva; el servicio rechaza reescrituras. Autenticación por token interno de servicio (lo emite la API de E7).
```

**Pruebas y Definition of Done**

- [ ] Publicar dos veces el mismo contenido devuelve la misma versión (idempotencia por checksum).
- [ ] Intentar modificar una versión publicada devuelve 409 y queda auditado.
- [ ] El motor puede descargar un mapa por checksum y verificar que coincide antes de la batalla (test de integración con E2).
- [ ] Un mapa inválido nunca llega a estado publicado (test que intenta forzarlo por la API).

### T4.4 — Generador procedural con semilla

**Prompt de ejecución**

```
Implementa el pipeline del capítulo 14.3: parámetros (tamaño, densidad de muros, simetría, modo) + semilla → generador de topología (sugerencia: BSP o cellular automata con simetría especular para CTF) → colocación de terreno, muros, destructibles, spawns, bases y banderas → validación con T4.2 → evaluación de equilibrio → publicación o regeneración con semilla derivada (registrando los intentos). Determinismo estricto: mismo parámetros+semilla ⇒ mismo mapa byte a byte (mismo checksum). CLI y endpoint: map-service generate --params file --seed N. Genera un set de 20 mapas procedurales de prueba para los otros equipos.
```

**Pruebas y Definition of Done**

- [ ] Misma semilla y parámetros producen el mismo checksum en 100 ejecuciones y en dos arquitecturas distintas de CI.
- [ ] De 100 semillas aleatorias, al menos 90 producen mapa válido a la primera o segunda iteración (métrica en CI nightly).
- [ ] Todos los mapas generados pasan el validador completo antes de publicarse (imposible publicar sin validar, test).
- [ ] Los mapas CTF generados son especularmente simétricos y la diferencia de distancia base–base entre lados es 0.

### E4.M — Mejoras y carencias detectadas en el dosier técnico

- El dosier no fija tamaño de celda ni clearance por chasis: se propone celda de navegación de 0,5 m y clearance = radio de colisión del chasis + 0,25 m, constantes en game-rules (decisión a ratificar en ADR).
- La 'evaluación de equilibrio' del 14.3 no tiene métrica: se define como (a) distancias a objetivos con tolerancia ≤10 % entre lados y (b) opcionalmente simulación espejo con bots de referencia del banco de E3.4 para mapas de torneo.
- El capítulo 14.4 pide semilla publicada tras el cierre pero no cómo demostrar que no se cambió: se propone commit-reveal (publicar hash de la semilla antes del cierre, revelar la semilla después), implementado por E9.
- Se recomienda añadir al esquema de mapa un campo de límites de conteo (máximo de entidades destructibles/minas) para proteger el presupuesto de tick del motor.

---

## E5. Equipo de Protocolo y SDKs de Bots

*Ámbito: capítulos 15 del dosier técnico. Entradas: E1 (esquemas de protocolo), E2 (motor con bucle). Salida hacia: E6, E12, usuarios finales.*

Implementa la puerta de entrada de los bots al motor y las herramientas para escribir bots: servidor de protocolo, SDK Python de referencia, SDK JavaScript, bots de ejemplo y simulador local.

### T5.1 — Servidor de protocolo en el motor

**Prompt de ejecución**

```
Implementa en arena-engine el servidor WebSocket del capítulo 15: acepta conexiones solo desde la red arena, realiza el handshake HELLO/WELCOME validando versión de protocolo y credencial de batalla (token de participación emitido al lanzar la batalla), entrega OBSERVATION en cada tick de decisión con deadline, acepta como máximo un COMMAND por tick de decisión (los extra se descartan con evento), emite EVENT y cierra con SHUTDOWN indicando motivo (final normal, error, descalificación). Un COMMAND que no llega antes del deadline dispara la acción segura y un evento de timeout (cap. 9.3); tres timeouts consecutivos configurables ⇒ descalificación por ruleset. Todo mensaje se valida contra @arena/protocol; los inválidos cuentan como ausentes. La desconexión aplica la política de ventana de gracia definida en la mejora E2.M.
```

**Pruebas y Definition of Done**

- [ ] Bot que no responde nunca: la batalla termina igualmente, con eventos de timeout y descalificación según ruleset (test).
- [ ] HELLO con versión de protocolo incompatible recibe SHUTDOWN con código específico y la conexión se cierra (test).
- [ ] Mensaje malformado no rompe el motor: se descarta, se registra y la simulación no diverge (test de fuzzing con 1000 payloads corruptos y verificación de hash final).
- [ ] El deadline de decisión se respeta: un COMMAND llegado tarde para el tick N no se aplica en N (test con relojes simulados).

### T5.2 — SDK Python de referencia y simulador local

**Prompt de ejecución**

```
Crea sdks/python (paquete arena-sdk): clase base ArenaBot con ciclo on_welcome/on_observation→command/on_event/on_shutdown, tipos de observación y comando generados o espejados de @arena/protocol, reconexión no incluida (el runner gestiona el proceso), y helpers de geometría (ángulo hacia un punto, distancia). Incluye un simulador local: arena-sim que levanta el motor real de E2 en un proceso (o su build publicada) con un mapa de práctica y permite conectar 1–4 bots locales sin Docker ni plataforma, replicando exactamente el protocolo real. Documenta en sdks/python/README.md el tutorial completo: instalar, escribir un bot en 30 líneas, correrlo contra un bot inmóvil.
```

**Pruebas y Definition of Done**

- [ ] Contract tests: cada mensaje que el SDK envía/parsea valida contra los esquemas de E1 (suite compartida entre SDKs).
- [ ] El bot del tutorial derrota al bot inmóvil de ejemplo en el simulador local (test E2E en CI).
- [ ] El simulador usa el motor real, no una imitación: mismo binario/paquete, verificado por versión reportada en WELCOME.
- [ ] El paquete instala con pip en un entorno limpio de CI y el tutorial se ejecuta con éxito de principio a fin.

### T5.3 — SDK JavaScript/TypeScript

**Prompt de ejecución**

```
Crea sdks/javascript (@arena/sdk): equivalente funcional del SDK Python usando los tipos de @arena/protocol directamente, con la misma interfaz conceptual (clase o funciones on_observation→command). Debe pasar la misma suite de contract tests que el SDK Python (extraer la suite a un formato agnóstico: carpeta de casos JSON entrada/salida esperada). Añade el tutorial equivalente y un bot de ejemplo en TypeScript.
```

**Pruebas y Definition of Done**

- [ ] La suite de contract tests compartida pasa en ambos SDKs desde los mismos casos JSON.
- [ ] El bot TypeScript de ejemplo completa una batalla en el simulador local sin descalificación.
- [ ] El paquete publica tipos correctos (tsc --noEmit en un proyecto consumidor de prueba).
- [ ] Paridad documentada: tabla en /docs/sdk-paridad.md con las capacidades de cada SDK y su versión de protocolo soportada.

### T5.4 — Bots de ejemplo oficiales

**Prompt de ejecución**

```
Implementa en example-bots/ los cuatro bots del capítulo 15.3, dos en Python y dos en JavaScript: explorador (patrulla, usa lidar 360, informa por radio), defensor (guarda la base/bandera, prioriza intrusos), artillero (cañón pesado, mantiene distancia, disparo predictivo simple sobre la velocidad observada) y minador (siembra minas en cuellos de botella del mapa usando los datos de navegación de la observación). Cada bot con su loadout de referencia (validado por E3) y README explicando su estrategia. Estos bots son también los bots de humo del pipeline de E6 y los de referencia del banco de balance de E3.
```

**Pruebas y Definition of Done**

- [ ] Los cuatro bots completan una batalla CTF 2v2 real (motor + protocolo, sin stubs) sin timeouts ni descalificaciones.
- [ ] Cada bot gana de forma consistente a un bot inmóvil (≥95 % en 100 semillas).
- [ ] Los loadouts de los cuatro validan contra el catálogo E3 vigente en CI (se rompe la build si un cambio de catálogo los invalida).
- [ ] El artillero acierta a un blanco en movimiento rectilíneo ≥60 % a media distancia (test de su heurística predictiva).

### E5.M — Mejoras y carencias detectadas en el dosier técnico

- El capítulo 15 no define reconexión ni latencia: se añade la política de ventana de gracia (ver E2.M) y se propone un mensaje opcional PING/PONG de diagnóstico fuera del ciclo de decisión.
- No se especifica cómo se autentica un bot ante el motor: se introduce el token de participación por batalla (emitido por bot-manager/API al lanzar), evitando que un contenedor se conecte a una batalla ajena.
- El dosier propone SDK Java y .NET tras estabilizar: se recomienda formalizar el 'kit de certificación de SDK' (la suite de contract tests agnóstica de T5.3) como entregable, para que terceros puedan escribir SDKs verificables.
- Se recomienda versionar los SDKs en lockstep con el protocolo (misma major.minor) para simplificar la tabla de compatibilidad de E1.

---

## E6. Equipo de Seguridad y Ejecución de Código

*Ámbito: capítulos 17.1 (estados de validación), 18 del dosier técnico. Entradas: E5 (protocolo/SDK), E10 (imágenes base). Salida hacia: E7, E9.*

Trata todo código de bot como hostil. Construye el pipeline de publicación (build reproducible, análisis, pruebas, firma) y el sandbox de ejecución con todos los controles del capítulo 18.2. Es el equipo con veto de seguridad sobre los demás.

### T6.1 — bot-manager: pipeline de build y publicación

**Prompt de ejecución**

```
Implementa apps/bot-manager con el flujo del capítulo 18.1 como pipeline de estados persistidos (tabla builds): subida → validación de estructura y tamaño (límites configurables) → análisis estático y extracción de lista de dependencias (bloqueo por lista de paquetes prohibidos; lockfile obligatorio) → build reproducible en contenedor aislado sin red salvo proxy de dependencias con allowlist → pruebas de protocolo (el artefacto arranca, hace HELLO válido y responde a una observación sintética) → partida de humo contra un bot de referencia de E5 en el motor real → medición de CPU, RAM y tiempo de arranque contra los límites → firma del artefacto (hash + firma con clave del servicio) y publicación. Cada etapa registra resultado y logs consultables por el dueño del bot. El fallo en cualquier etapa deja el bot en estado Rechazado con motivo.
```

**Pruebas y Definition of Done**

- [ ] Build reproducible: compilar dos veces el mismo commit produce artefactos con el mismo hash (test para Python y JS).
- [ ] Un bot con dependencia fuera de la allowlist queda Rechazado en la etapa de análisis, con el paquete señalado.
- [ ] La firma del artefacto se verifica antes de cada ejecución en batalla; un artefacto manipulado se rechaza (test).
- [ ] La partida de humo detecta un bot que compila pero incumple protocolo (caso de prueba incluido) y lo rechaza.
- [ ] Todo el pipeline de un bot Python sencillo termina en menos de 3 minutos (umbral de UX, medido en CI).

### T6.2 — Sandbox de ejecución de bots

**Prompt de ejecución**

```
Implementa el lanzamiento de contenedores bot-runtime-* con exactamente los controles de la tabla 18.2: usuario no root sin privilegios, todas las capabilities eliminadas, filesystem de solo lectura con /tmp limitado por tamaño, red únicamente hacia el endpoint del motor en la red arena (sin DNS externo, sin Internet), límites estrictos de CPU, memoria y PIDs, deadlines de arranque, perfil seccomp restrictivo, no-new-privileges, sin secretos montados y sin acceso al socket de Docker. El bot-manager es el único servicio con permiso para crear estos contenedores, a través de una API interna restringida; ni la web ni la API pública pueden hacerlo. Escribe la suite tests/sandbox-escape/ con bots maliciosos deliberados: intento de conexión a Internet, escritura fuera de /tmp, fork bomb, agotamiento de memoria, escaneo de la red interna, lectura de /proc sensible, intento de abrir docker.sock.
```

**Pruebas y Definition of Done**

- [ ] Los 7+ bots maliciosos de la suite fallan en su objetivo y quedan registrados; ninguno afecta al tick de una batalla concurrente (test integrado con métricas de E2).
- [ ] Un bot en bucle infinito consume solo su cuota de CPU y es descalificado por timeouts sin degradar el motor.
- [ ] Inspección automatizada de la configuración de los contenedores lanzados: cero capabilities, read-only, seccomp aplicado, no-new-privileges (test que lee la config real vía inspect).
- [ ] Escaneo en CI que falla si algún servicio del Compose monta docker.sock o corre privilegiado (criterio del cap. 28).

### T6.3 — Runtimes fijados por lenguaje

**Prompt de ejecución**

```
Construye en runtimes/ las imágenes base del capítulo 18.3 para el MVP: Python (versión fijada, con la lista de paquetes permitidos preinstalada y pip deshabilitado en ejecución) y Node.js (versión fijada, misma política). Las imágenes se versionan y se referencian por digest, no por tag mutable. Documenta la lista de paquetes permitidos y el proceso para solicitar añadir uno (issue + revisión de seguridad). El build de un bot solo puede usar la imagen de runtime declarada en su manifiesto.
```

**Pruebas y Definition of Done**

- [ ] Un bot que importa un paquete no incluido falla el build con mensaje que identifica el import (test).
- [ ] En ejecución, pip/npm install están inoperativos dentro del contenedor (test).
- [ ] Las imágenes se reconstruyen de forma reproducible y su digest está fijado en el repo (verificación en CI).
- [ ] El escaneo de vulnerabilidades de las imágenes corre en CI y bloquea severidad crítica.

### T6.4 — Auditoría, suspensión y hallazgos de seguridad

**Prompt de ejecución**

```
Añade la capa de auditoría del capítulo 18 conectada al esquema del 23 (audit_log, security_findings): todo evento del pipeline y del sandbox (rechazos, intentos de escape detectados, mediciones fuera de límite) genera un registro con bot, versión, usuario y correlation_id. Implementa la suspensión: un moderador o administrador puede pasar un bot a Suspendido (cap. 17.1) desde la API; el bot-manager rehúsa lanzar bots suspendidos y las inscripciones activas se marcan. Añade escaneo de secretos en el código subido (patrones de claves API, tokens, contraseñas) como etapa del pipeline, con hallazgo registrado y bloqueo de publicación.
```

**Pruebas y Definition of Done**

- [ ] Un intento de escape de la suite T6.2 genera un security_finding consultable por administradores y solo por ellos (test RBAC).
- [ ] Un bot suspendido no puede lanzarse aunque esté inscrito en un torneo; la batalla lo descalifica administrativamente (test).
- [ ] Código con una clave AWS de ejemplo queda bloqueado en publicación con el hallazgo registrado (test).
- [ ] El audit_log es de solo inserción: no existe endpoint ni permiso de borrado/edición (test).

### E6.M — Mejoras y carencias detectadas en el dosier técnico

- El dosier confía todo el aislamiento a Docker: se recomienda planificar gVisor o Kata Containers como endurecimiento del runtime de bots en una fase posterior, y mientras tanto mantener el stack en una VM dedicada de Proxmox (mitigación ya apuntada en el cap. 27).
- El 'proxy de dependencias controlado' del 18.2 no está especificado: se concreta como registro proxy con allowlist explícita de paquetes y lockfiles obligatorios (T6.1/T6.3).
- El dosier no contempla escaneo de secretos en el código subido: se añade en T6.4 (protege también a los propios usuarios).
- No se define límite de tamaño de código ni de artefacto: se propone 10 MB fuente / 200 MB artefacto como valores iniciales configurables.
- Se recomienda un ejercicio de pentesting interno del sandbox antes del hito M4 (juego de guerra con bots hostiles nuevos, no los de la suite conocida).

---

## E7. Equipo de Plataforma Web y API

*Ámbito: capítulos 16, 17, 23 del dosier técnico. Entradas: E1 (OpenAPI), E3 (validador de loadouts), E6 (pipeline de builds). Salida hacia: E8, E9, usuarios finales.*

Implementa la API de plataforma contra el contrato OpenAPI de E1, el modelo de datos PostgreSQL, la autenticación con RBAC real y el panel web (registro, editor de loadouts, gestión de bots, equipos y administración).

### T7.1 — Modelo de datos y migraciones

**Prompt de ejecución**

```
Implementa en apps/api el esquema PostgreSQL del capítulo 23 con una herramienta de migraciones (propuesta: Prisma Migrate o Knex; el dosier no fija ninguna, elegir y documentar en ADR): grupos identidad (users, roles, sessions, teams, team_members), bots (bots, bot_versions, bot_loadouts, builds, artifacts), contenido (maps, map_versions, module_definitions, rulesets), competición (tournaments, entries, matches, battles, participants), resultados (battle_stats, ratings, standings, achievements) y operación (jobs, audit_log, security_findings, api_usage). Aplica la política del 23.1: los eventos masivos de batalla viven en archivos comprimidos (replays de E8) y la BD guarda índice, hashes y referencias. Conexión por DATABASE_URL para soportar el PostgreSQL existente del servidor (cap. 6.2). Incluye seeds de desarrollo (usuarios de cada rol, catálogo E3 importado, mapa MVP).
```

**Pruebas y Definition of Done**

- [ ] Migraciones aplican y revierten limpiamente en una BD vacía (test up/down completo en CI).
- [ ] Los seeds crean un entorno funcional de desarrollo con un usuario por rol.
- [ ] Restricciones de integridad probadas: no se puede borrar un módulo referenciado por un loadout congelado, ni un usuario con bots publicados (tests).
- [ ] La importación del catálogo de E3 desde los JSON del repo es idempotente y respeta la inmutabilidad de versiones.

### T7.2 — Autenticación, RBAC y seguridad de cuenta

**Prompt de ejecución**

```
Implementa el capítulo 16.1: registro y login con contraseñas Argon2id, tokens de acceso de corta duración con refresh y revocación de sesiones, 2FA TOTP opcional, y recuperación de cuenta. RBAC con los siete roles de la tabla del 16 comprobado en la API mediante middleware que lee la matriz x-min-role del OpenAPI de E1 (la interfaz web solo oculta, nunca autoriza). Rate limiting por IP y por usuario en endpoints sensibles (login, registro, subida de código), cabeceras de seguridad y CORS restrictivo en el gateway. Auditoría de acciones administrativas y de publicación (cap. 16.1) hacia audit_log.
```

**Pruebas y Definition of Done**

- [ ] Test de matriz rol×endpoint generado automáticamente desde el OpenAPI: cada operación se prueba con un rol insuficiente (espera 403) y el mínimo (espera éxito).
- [ ] Un token revocado o expirado es rechazado en todos los endpoints (test).
- [ ] El rate limiting bloquea fuerza bruta de login (test: 20 intentos fallidos ⇒ bloqueo temporal y registro).
- [ ] Activación y uso de 2FA cubiertos por test E2E; la recuperación de cuenta no permite eludir el 2FA.

### T7.3 — Gestión de bots, loadouts y ciclo de estados

**Prompt de ejecución**

```
Implementa los recursos de bots del capítulo 17: CRUD de bot lógico con identidad, propietario y visibilidad; versiones de código y revisiones de loadout versionadas por separado pero congeladas juntas en cada inscripción (17.2); la máquina de estados completa del 17.1 (Borrador, En validación, Rechazado, Validado, Publicado, Congelado, Suspendido, Retirado) con transiciones como acciones explícitas de la API que delegan en bot-manager (E6) para la validación. Publicado y Congelado son inmutables. El validador de loadouts de E3 se ejecuta en servidor en cada guardado; los errores se devuelven con los códigos de violación de E3 para que el editor los muestre.
```

**Pruebas y Definition of Done**

- [ ] Test exhaustivo de la máquina de estados: toda transición ilegal devuelve 409; las legales quedan auditadas.
- [ ] Modificar una versión Publicada o Congelada es imposible por API (test), incluso para administradores (que deben crear versión nueva).
- [ ] Un cambio de loadout crea revisión nueva y no altera inscripciones congeladas (test del 17.2).
- [ ] Guardar un loadout inválido devuelve las violaciones exactas del validador E3 (test de integración).

### T7.4 — Panel web: registro, editor de loadout y gestión

**Prompt de ejecución**

```
Implementa apps/web (React o Vue, decidir en ADR; sugerencia: React + Vite por el ecosistema Phaser del visor) con: registro/login/2FA; panel de usuario con sus bots y estados; editor de loadout (selección de chasis y módulos con presupuesto, masa y energía en vivo usando el validador E3 compilado para navegador, y validación final en servidor); subida de código (archivo o pegado) con vista del resultado de cada etapa del pipeline de E6 y sus logs; gestión de equipos (crear, invitar, roles de capitán); y panel de administración (usuarios, roles, catálogo importado, hallazgos de seguridad, auditoría). Todo servido solo tras el gateway (cap. 6.2).
```

**Pruebas y Definition of Done**

- [ ] E2E Playwright: registro → crear bot → montar loadout válido → subir código de ejemplo → ver build Validado, completo en CI contra el stack de desarrollo.
- [ ] El editor impide en cliente superar presupuesto/masa/energía y el servidor lo re-verifica (test de bypass con petición manual).
- [ ] Un usuario no ve ni puede consultar bots privados ajenos ni logs de builds ajenos (tests de autorización de objeto, no solo de rol).
- [ ] El panel de administración es inaccesible e invisible para roles menores (test E2E).

### T7.5 — API pública de espectador y clasificaciones

**Prompt de ejecución**

```
Expón a través del gateway los recursos públicos del capítulo 16 (rol Visitante): batallas en directo (listado y ticket de conexión WebSocket al canal de espectador), replays publicados, clasificaciones y perfiles públicos de bots (sin código salvo que el dueño lo publique, según ADR-000). Añade caché HTTP en el gateway para clasificaciones y replays, y cuotas de uso anónimo (api_usage). Ningún endpoint público expone datos privados: observaciones de bots, código, logs de build, emails o auditoría.
```

**Pruebas y Definition of Done**

- [ ] Barrido automático de todos los endpoints públicos verificando que ninguna respuesta contiene campos marcados como privados en el OpenAPI (test de fuga a nivel de contrato).
- [ ] Un visitante anónimo puede ver una batalla en directo y un replay sin cuenta (test E2E).
- [ ] Las cuotas anónimas responden 429 al superarse y se registran en api_usage.
- [ ] La caché no sirve datos obsoletos de clasificación más de 60 s tras una actualización (test).

### E7.M — Mejoras y carencias detectadas en el dosier técnico

- El dosier no menciona rate limiting, CSRF/CORS ni algoritmo de hash de contraseñas: se fijan Argon2id, rate limiting por IP/usuario y CORS restrictivo (T7.2).
- No se fija herramienta de migraciones: se exige elegirla por ADR en T7.1 para que backups y staging (E10) trabajen contra algo concreto.
- La autorización del dosier es por roles; se añade explícitamente autorización a nivel de objeto (dueño/equipo) que la tabla del cap. 16 da por supuesta pero ningún criterio de aceptación cubría.
- Se recomienda exponer la API pública bajo /api/v1 con política de deprecación documentada, pensando en la 'API pública para ligas de terceros' del cap. 29.

---

## E8. Equipo de Visor y Replays

*Ámbito: capítulos 20 del dosier técnico. Entradas: E2 (snapshots/eventos), E7 (API/gateway). Salida hacia: E9, E11, público.*

Todo lo que ve el público: visor Phaser en tiempo real, servicio y formato de replays, reproductor con control temporal y pipeline de estadísticas.

### T8.1 — replay-service y formato de replay

**Prompt de ejecución**

```
Implementa apps/replay-service consumiendo el archivo de batalla de E2/T2.6: recibe del motor (o del worker) el replay al terminar la batalla, lo valida (cabecera con versiones, checksum de mapa, hashes intermedios), lo comprime con zstd y lo almacena en el volumen arena_replays con índice en BD (cap. 23). Sirve replays por HTTP con soporte de rango y un índice de keyframes para salto temporal. Implementa el comando replay-service verify <id> que re-simula el replay con la versión de motor registrada y comprueba que el resultado y los hashes coinciden con el oficial (criterio del cap. 28). Aplica la política de retención del 23.1 (replays temporales de pruebas caducan; los oficiales se conservan).
```

**Pruebas y Definition of Done**

- [ ] verify reproduce el resultado oficial de 50 batallas de regresión (test en nightly).
- [ ] El salto a un tick arbitrario de un replay de 5 minutos tarda < 1 s en el reproductor (keyframes funcionando, test de rendimiento).
- [ ] Un replay manipulado (un byte alterado) es detectado por checksum/hashes y marcado inválido (test).
- [ ] La retención elimina replays temporales caducados y nunca los oficiales (test con relojes simulados).

### T8.2 — Visor Phaser en tiempo real

**Prompt de ejecución**

```
Implementa en apps/web el visor del capítulo 20.1 con Phaser: consume el canal WebSocket de espectador vía gateway, renderiza los snapshots de 10 Hz del motor con interpolación en cliente, y ofrece vista global, seguimiento de bot, vista de equipo y niebla de guerra opcional (solo si el modo espectador lo permite en el ruleset). Overlay con salud, módulos dañados, estado de bandera, marcador y feed de eventos. Las capas de depuración (sensores, rutas, colisiones, alcances) existen pero solo se activan para roles autorizados mediante un flag firmado por la API. Reconexión automática del WebSocket con recuperación del estado por snapshot completo.
```

**Pruebas y Definition of Done**

- [ ] Cortar el WebSocket 10 s a mitad de batalla: el visor se reconecta y recupera el estado sin recargar la página (test E2E).
- [ ] Inspección del tráfico del espectador: nunca contiene observaciones privadas de bots ni capas de depuración sin autorización (test de fuga sobre el stream real, criterio del cap. 28).
- [ ] El visor mantiene 60 fps con 4 bots, 20 proyectiles y 50 obstáculos en un portátil de referencia (presupuesto documentado, test manual guionizado).
- [ ] La máquina de estados de bandera se refleja correctamente en el overlay en el escenario CTF guionizado de E2.

### T8.3 — Reproductor de replays

**Prompt de ejecución**

```
Extiende el visor para reproducir replays desde replay-service: cargar por id, reproducir/pausar, velocidad 0.5×–8×, salto por barra temporal usando los keyframes, y los mismos modos de cámara y overlays que el directo. En replay las capas de depuración pueden abrirse a todos si el dueño del replay lo permite. Añade enlaces compartibles con tick inicial (?t=1234).
```

**Pruebas y Definition of Done**

- [ ] Un replay oficial se reproduce y su marcador final coincide con el BattleResult almacenado (test E2E).
- [ ] El salto temporal aterriza en el tick pedido ±1 tick (test).
- [ ] El enlace compartido abre el replay en el instante correcto (test E2E).
- [ ] Reproducir a 8× no desincroniza eventos y snapshots (test de coherencia del feed de eventos).

### T8.4 — Pipeline de estadísticas

**Prompt de ejecución**

```
Implementa la agregación de estadísticas del capítulo 20.3 a partir de los eventos del replay (no de la BD de eventos, siguiendo la política 23.1): al finalizar cada batalla, un job procesa el archivo y escribe battle_stats con métricas por bot (daño, precisión, capturas, minas, supervivencia, CPU y turnos omitidos reportados por el motor), por módulo (uso, daño causado, fallos, eficiencia, supervivencia), por equipo y por mapa (duración, ventaja por lado, tasa de empate). Expón agregados por bot-versión y por catálogo para el balance de E3 y las clasificaciones de E9. El job es idempotente por battle_id.
```

**Pruebas y Definition of Done**

- [ ] Reprocesar la misma batalla dos veces no duplica estadísticas (test de idempotencia).
- [ ] Las métricas de una batalla guionizada conocida coinciden con los valores calculados a mano (golden test).
- [ ] Las estadísticas por módulo alimentan el informe de balance de E3 (integración verificada).
- [ ] El procesado de una batalla de 5 minutos tarda < 10 s (umbral de cola de torneos).

### E8.M — Mejoras y carencias detectadas en el dosier técnico

- El dosier no concreta el formato de replay: se fija JSONL+zstd con keyframes cada N ticks y hashes intermedios (T2.6/T8.1), y se documenta como formato versionado propio.
- No hay presupuesto de ancho de banda de espectador: se fija snapshot público a 10 Hz con objetivo < 100 KB/s por espectador y se mide en CI.
- La tabla de estadísticas incluye 'IA generadora' (modelo, prompt, coste): pertenece a la Fase 10; se recomienda diferirla explícitamente y dejar solo el hueco en el esquema.
- Se recomienda un modo 'espectador con retardo' configurable para torneos (anti-coaching en directo), no contemplado en el dosier.

---

## E9. Equipo de Torneos y Clasificación

*Ámbito: capítulos 13 (reglas de modos), 19 y 20.3 (ratings) del dosier técnico. Entradas: E7 (API/BD), E6 (artefactos firmados), E2 (motor), E8 (replays/stats). Salida hacia: público, E11.*

Automatiza la competición: cola de trabajos, worker de torneos, los seis formatos, ratings, justicia competitiva y auditoría completa de cada batalla.

### T9.1 — Cola de trabajos y tournament-worker

**Prompt de ejecución**

```
Implementa apps/tournament-worker con Redis como cola (cap. 8): trabajos idempotentes persistidos también en la tabla jobs (para sobrevivir a Redis), tipos de trabajo (generar calendario, ejecutar batalla, procesar resultado, actualizar clasificación), bloqueo distribuido para no ejecutar la misma batalla dos veces, y reintentos únicamente ante fallos clasificados como de infraestructura. Implementa la clasificación de errores del 19.2: distingue derrota deportiva (incluye timeout del código del bot: NO se reintenta) de fallo técnico (worker caído, motor no arrancó, mapa no descargable: SÍ se reintenta con límite). El worker lanza batallas pidiendo al bot-manager los contenedores y al motor la ejecución, según la estrategia de procesos del 9.4 (una batalla por worker, concurrencia según CPU/RAM configurada).
```

**Pruebas y Definition of Done**

- [ ] Matar el worker a mitad de un torneo de 20 batallas y reiniciarlo: el torneo se reanuda sin batallas duplicadas ni perdidas (test de caos, criterio del cap. 28).
- [ ] Una derrota por timeout del bot queda como derrota y no se reintenta (test con bot que se cuelga a propósito).
- [ ] Un fallo de infraestructura simulado (motor que muere al arrancar) se reintenta hasta el límite y luego marca la batalla para revisión manual (test).
- [ ] Dos workers concurrentes nunca ejecutan la misma batalla (test de carrera con bloqueo).

### T9.2 — Formatos de torneo

**Prompt de ejecución**

```
Implementa los seis formatos de la tabla del capítulo 19 como generadores puros de calendario (entradas → lista de rondas/emparejamientos): liga por temporadas, round robin, eliminatoria simple, doble eliminación, sistema suizo (emparejamiento por puntuación con evitación de repeticiones) y torneos por equipos con plantillas de varios bots. Cada formato con sus reglas de desempate documentadas. El flujo completo del 19.1: cerrar inscripciones congela versiones de bot+loadout (estado Congelado de E7), valida mapa, reglas, catálogo y semillas, genera emparejamientos, encola batallas, verifica resultados, actualiza clasificación, publica replays y marca la final para modo visible.
```

**Pruebas y Definition of Done**

- [ ] Golden brackets: cada formato con 4, 8 y 13 participantes (número impar incluido) genera el calendario exacto esperado.
- [ ] Propiedades: en round robin todos juegan contra todos exactamente una vez; en suizo nadie repite rival mientras sea evitable; en doble eliminación nadie queda fuera con una sola derrota (fast-check).
- [ ] El cierre de inscripciones congela versiones: un push posterior del participante no afecta al torneo (test E2E con E7/E6).
- [ ] Un torneo eliminatorio de 8 bots de ejemplo corre de principio a fin sin intervención humana y publica campeón, clasificación y replays.

### T9.3 — Ratings y clasificaciones

**Prompt de ejecución**

```
Implementa el sistema de rating (Elo con K configurable por liga; documentar en ADR la elección frente a Glicko-2 y dejar la interfaz preparada para cambiarlo) sobre battle_stats: actualización por batalla oficial, ratings separados por temporada y por modo de juego, standings materializados para la API pública (E7/T7.5) y historial de rating por bot-versión. Las batallas no oficiales (pruebas privadas) no afectan al rating.
```

**Pruebas y Definition of Done**

- [ ] Propiedad de suma: en un sistema cerrado la suma de Elo se conserva tras cada actualización (test).
- [ ] Reprocesar una batalla no aplica el rating dos veces (idempotencia por battle_id).
- [ ] Una batalla anulada por fallo técnico revierte su efecto en el rating (test).
- [ ] El historial permite reconstruir el rating de cualquier bot en cualquier fecha (test de replay del ledger).

### T9.4 — Justicia competitiva y auditoría de batallas

**Prompt de ejecución**

```
Implementa las medidas del 19.2 y 14.4: múltiples rondas con intercambio de lados en cada emparejamiento, semillas por batalla generadas mediante commit-reveal (el organizador publica el hash del lote de semillas antes del cierre de inscripciones y revela las semillas después; ambos quedan en la BD y son verificables públicamente), y registro en cada batalla de la versión exacta de motor, Rapier, reglas, catálogo, mapa (checksum), artefactos de bots (hash y firma) y semilla. Añade el endpoint público de auditoría: dado un battle_id, devuelve todo lo necesario para re-simular y verificar la batalla con replay-service verify.
```

**Pruebas y Definition of Done**

- [ ] El endpoint de auditoría de cualquier batalla oficial contiene todos los artefactos y versiones, y verify la reproduce (test E2E).
- [ ] El commit-reveal es verificable: hash publicado antes del cierre coincide con las semillas reveladas (test).
- [ ] Cada emparejamiento de liga juega el mismo número de veces por lado (test sobre el calendario generado).
- [ ] Un cambio de catálogo durante un torneo en curso no afecta a sus batallas (usa el catálogo congelado, test).

### E9.M — Mejoras y carencias detectadas en el dosier técnico

- El dosier pide 'semilla publicada tras el cierre' sin mecanismo de confianza: se añade commit-reveal (T9.4).
- La clasificación de fallos (deportivo vs. infraestructura) del 19.2 se formaliza como enumeración de códigos de error del motor/worker, porque el dosier la enuncia pero no la define.
- No se contempla la colusión entre bots del mismo dueño en formatos individuales: se propone al menos registrar propietario/equipo en el emparejamiento y evitar cruces tempranos entre bots del mismo dueño en eliminatorias.
- Se recomienda un 'modo simulacro' de torneo (dry-run con bots de ejemplo) como prueba previa de cada torneo público, ejecutable por el organizador.

---

## E10. Equipo de DevOps, Despliegue y Observabilidad

*Ámbito: capítulos 6, 22, 24 del dosier técnico. Entradas: E1 (para nombres/contratos); da servicio a todos desde el día 1. Salida hacia: todos; el operador del servidor.*

Monorepo, CI/CD, el stack Docker Compose único con perfiles y redes del capítulo 6, observabilidad, copias y recuperación. Es el equipo que hace verdad la promesa de 'una única aplicación desplegable'.

### T10.1 — Monorepo, CI y política de ramas

**Prompt de ejecución**

```
Monta el monorepo con la estructura exacta del capítulo 22.1 (apps, packages, sdks, runtimes, infrastructure, maps, example-bots, docs), tooling de workspace (pnpm o npm workspaces, decidir en ADR), y la CI del 22.3 en ocho etapas: lint+formato+tipos, unitarias, esquemas y compatibilidad de contratos, batallas deterministas de regresión (las suites de E2), build de imágenes, escaneo de dependencias e imágenes, despliegue a staging y humo con promoción manual. main protegida: PR con revisión obligatoria, y CODEOWNERS que exige revisión del equipo E6 en cambios de motor, protocolo, sandbox y runtimes (cap. 22.2). Versionado semántico por paquete con changesets o equivalente.
```

**Pruebas y Definition of Done**

- [ ] Un PR que rompe un esquema de E1 o una batalla golden de E2 queda bloqueado automáticamente (test del propio pipeline con un PR canario).
- [ ] CODEOWNERS impide fusionar cambios de seguridad sin revisión de E6 (verificado con la configuración del repositorio).
- [ ] La CI completa de un PR medio tarda < 15 minutos (presupuesto; las 1000 batallas van a nightly).
- [ ] Cada merge a main produce imágenes etiquetadas por versión y digest, publicadas en el registro.

### T10.2 — Stack Docker Compose único con perfiles y redes

**Prompt de ejecución**

```
Escribe infrastructure/docker-compose.yml con los doce servicios de la tabla 6.2 (gateway Nginx, web, api, arena-engine, tournament-worker, bot-manager, map-service, replay-service, queue Redis, postgres opcional, streamer opcional, plantilla bot-runtime), los perfiles development, production, bots y streaming (6.1), las cinco redes del 6.4 con sus reglas (solo gateway en public; bots solo en arena; builders sin acceso a datos), los seis volúmenes del 6.3, healthchecks en todos los servicios con depends_on condicionado, límites de recursos, secretos por archivos (nunca variables en claro para claves), y soporte de PostgreSQL externo vía DATABASE_URL desactivando el servicio postgres por perfil (nota del 6.2, para usar la instancia existente del servidor). Entrega también infrastructure/.env.example documentado y docs/despliegue.md con la instalación limpia en tres pasos.
```

**Pruebas y Definition of Done**

- [ ] docker compose --profile production up -d en una VM limpia (staging) deja la plataforma sana: todos los healthchecks verdes y el humo E2E de E12 pasa (criterio del cap. 28).
- [ ] Solo el gateway expone puertos al exterior: escaneo de puertos del host desde fuera encuentra únicamente 80/443 (test).
- [ ] Un contenedor de bot no alcanza postgres, redis ni la API: pruebas de conectividad desde dentro de la red arena fallan (test).
- [ ] Con DATABASE_URL externo definido, el servicio postgres no arranca y todo funciona igual (test de perfil).
- [ ] Ningún servicio corre privilegiado ni monta docker.sock salvo bot-manager por su API restringida documentada (escaneo automático, cap. 28).

### T10.3 — Observabilidad: logs, métricas y alertas

**Prompt de ejecución**

```
Implementa el capítulo 24 con un stack concreto (el dosier no lo fija; propuesta: Prometheus + Grafana + Loki, en perfil observability del mismo Compose): logging JSON estructurado en todos los servicios con battle_id, bot_id, user_id y correlation_id propagado desde el gateway; métricas de ticks/s y retraso de tick del motor, profundidad de colas, duración y resultado de builds, CPU/RAM por servicio, y errores por endpoint; dashboards de Grafana versionados en el repo; y alertas para motor bloqueado (tick estancado), cola acumulada, disco, BD caída y stream caído. Las alertas notifican por el canal que configure el operador (webhook/email).
```

**Pruebas y Definition of Done**

- [ ] Buscar un correlation_id en Loki devuelve la traza completa de una petición que cruza gateway→api→worker→motor (test guionizado).
- [ ] La alerta de motor bloqueado dispara en < 30 s al pausar artificialmente el bucle de tick (test de caos).
- [ ] Los dashboards se aprovisionan desde el repo en un despliegue limpio (sin clicks manuales).
- [ ] El perfil observability es opcional: la plataforma funciona sin él (test de arranque).

### T10.4 — Copias de seguridad y recuperación

**Prompt de ejecución**

```
Implementa la estrategia de copias del capítulo 24: backup lógico diario de PostgreSQL (pg_dump o pgBackRest, decidir en ADR) y copia de los volúmenes arena_maps, arena_bot_sources, arena_replays (solo oficiales, según retención) y secretos cifrados, con restic o equivalente hacia el almacenamiento que designe el operador (NAS/ZFS del servidor). Escribe docs/recuperacion.md con el runbook completo: recrear contenedores desde imágenes versionadas, restaurar BD y volúmenes, y verificar integridad (checksums de mapas y replays). Ejecuta y cronometra un simulacro real de recuperación total en staging.
```

**Pruebas y Definition of Done**

- [ ] El simulacro documentado: desde VM vacía + último backup hasta plataforma funcional con datos, con tiempo total registrado (objetivo < 2 h).
- [ ] La restauración pasa las verificaciones de integridad: checksums de mapas y replays oficiales válidos, migraciones al día (criterio del cap. 28).
- [ ] El backup corre en cron dentro del stack y alerta si falla o si no se ha completado en 26 h.
- [ ] Los secretos restaurados nunca aparecen en logs ni en el repositorio (revisión automatizada).

### E10.M — Mejoras y carencias detectadas en el dosier técnico

- El dosier no fija stack de observabilidad ni herramienta de backup: se proponen Prometheus+Grafana+Loki y pg_dump/pgBackRest+restic, a ratificar por ADR.
- No se mencionan healthchecks ni orden de arranque en Compose: se añaden como requisito de T10.2.
- Se recomienda que producción viva en una VM dedicada del Proxmox (yggdrasil) separada de staging, alineado con la mitigación de sandbox del cap. 27; el dimensionamiento (CPU/RAM para N batallas concurrentes) debe medirse en M3 y documentarse.
- Falta una política de actualización del stack en caliente: se propone despliegue por servicio (compose up -d servicio) con drenado de batallas en curso del motor antes de reiniciarlo, coordinado por la cola de E9.

---

## E11. Equipo de Streaming

*Ámbito: capítulos 21 del dosier técnico. Entradas: E8 (visor), E10 (Compose/secretos). Salida hacia: público (YouTube).*

Retransmisión a YouTube sin tocar jamás el motor: vista broadcast, contenedor streamer con Chromium+FFmpeg y operación de eventos. Estrictamente aislado del tick de batalla.

### T11.1 — Vista /broadcast

**Prompt de ejecución**

```
Implementa en apps/web la ruta /broadcast del capítulo 21: composición a 1920×1080 pensada para captura sin interacción, con el visor de E8 a pantalla completa, marcador, participantes con loadouts resumidos, ronda del torneo, ticker de eventos, branding configurable (logo, colores, nombre del evento vía parámetros) y pantallas de espera/entre batallas alimentadas por el estado del torneo (E9). La vista se autoconfigura por query (?battle=id o ?tournament=id con avance automático a la siguiente batalla). Sin controles visibles ni cursores.
```

**Pruebas y Definition of Done**

- [ ] La vista renderiza una batalla en directo a 1080p estable en Chromium headless durante 30 minutos sin fugas de memoria (test de larga duración con métricas).
- [ ] El modo torneo encadena automáticamente batallas con pantallas de espera entre ellas (test E2E con un torneo simulado).
- [ ] El branding cambia por parámetros sin redeploy (test).
- [ ] La vista solo usa el canal público de espectador: cero datos privados (mismo test de fuga de E8).

### T11.2 — Contenedor streamer y emisión RTMPS

**Prompt de ejecución**

```
Implementa el servicio streamer del Compose (perfil streaming): Chromium headless capturando /broadcast + FFmpeg codificando a YouTube RTMPS, con la clave de emisión como secreto del servicio (nunca en variables visibles ni logs, cap. 21). Codificación x264 por software como base; NVENC como opción si el host tiene GPU con passthrough (documentar el requisito de Proxmox). Añade control por API interna: start/stop de emisión sobre una URL de broadcast, reintentos ante corte de RTMPS y métrica de frames/bitrate hacia E10. Verifica con una emisión privada real de 30 minutos.
```

**Pruebas y Definition of Done**

- [ ] Emisión privada de prueba de 30 minutos a YouTube sin caídas, con bitrate estable (evidencia registrada en el runbook).
- [ ] Durante la emisión, las métricas del motor no muestran degradación del tick (test conjunto con E10/E2: el streaming no puede afectar a la batalla, cap. 21).
- [ ] La clave RTMPS no aparece en logs, inspect ni variables de entorno del contenedor (revisión automatizada).
- [ ] Un corte de red de 30 s durante la emisión se recupera con reintento sin intervención (test de caos).

### E11.M — Mejoras y carencias detectadas en el dosier técnico

- El dosier propone NVENC sin señalar que exige GPU passthrough en Proxmox: se documenta el requisito y se establece x264 como base para no bloquear el hito.
- Se propone añadir un modo 'solo grabación' (FFmpeg a archivo en arena_replays/video) para generar clips sin emitir, útil antes de tener canal.
- La 'etapa OBS en un PC' del dosier debe documentarse como runbook operativo (escena OBS apuntando a /broadcast), no como software del repo.
- Se recomienda un retardo de emisión configurable (30–60 s) para finales, coherente con la mejora anti-coaching de E8.

---

## E12. Equipo de QA e Integración (transversal, propuesto)

*Ámbito: capítulos 26.1 y 28 (este equipo no existe en el dosier: es una mejora) del dosier técnico. Entradas: todos. Salida hacia: puertas de los hitos M1–M5.*

El dosier define criterios de aceptación (cap. 28) y de éxito del MVP (26.1) pero no asigna su automatización. Este equipo convierte ambos capítulos en suites ejecutables, organiza pruebas de caos y es el dueño de las puertas de salida de los hitos.

### T12.1 — Suite E2E del criterio de éxito del MVP

**Prompt de ejecución**

```
Automatiza el capítulo 26.1 como una única suite E2E contra el stack de staging desplegado por Compose: (1) un usuario se registra, crea un bot, monta un loadout del catálogo MVP y sube el código de un bot de ejemplo; (2) el sistema lo construye y valida en aislamiento (pipeline E6 completo); (3) se lanza una partida CTF 2v2 con cuatro bots en el mapa MVP con muros, zona de daño y destructibles; (4) un espectador anónimo la ve en directo por el visor; (5) al terminar, el replay se reproduce y coincide con el resultado; (6) existen estadísticas por bot, equipo y módulo. La suite corre en la etapa de humo de la CI de despliegue (T10.1) y es la definición operativa de 'el MVP funciona'.
```

**Pruebas y Definition of Done**

- [ ] La suite completa pasa en verde contra staging en cada despliegue (integrada en CI).
- [ ] Cada uno de los 6 pasos tiene aserciones propias y produce evidencia (capturas, ids, hashes) archivada como artefacto de CI.
- [ ] La suite falla correctamente si se sabotea cualquier pieza (verificado con 6 sabotajes deliberados, uno por paso).
- [ ] Duración total < 20 minutos.

### T12.2 — Suite de criterios de aceptación del capítulo 28

**Prompt de ejecución**

```
Convierte la tabla del capítulo 28 en un pipeline ejecutable acceptance/ con un job por criterio: motor (1000 batallas de regresión sin divergencia por semilla y versión, nightly), rendimiento (tick estable con los bots del MVP, con umbral métrico), bots (bot malicioso/bloqueado no detiene el motor ni accede a secretos, reutilizando la suite de escape de E6), mapas (todo mapa publicado pasó validación: query de verificación en BD), web (recuperación de conexión del visor y ausencia de información privada, reutilizando tests de E8), torneos (reanudables y auditables tras reinicio, reutilizando el test de caos de E9), replay (reproduce resultado oficial y permite salto temporal), Docker (instalación limpia por variables y compose up, reutilizando T10.2), datos (copias restaurables y migraciones probadas, T10.4) y seguridad (sin privilegiados ni docker.sock expuesto). El informe final es una tabla verde/roja publicada como artefacto: es la puerta del hito M5.
```

**Pruebas y Definition of Done**

- [ ] Los 10 criterios tienen job propio con resultado binario y evidencia enlazada.
- [ ] El pipeline completo corre bajo demanda y en nightly sobre staging.
- [ ] Un fallo en cualquier criterio bloquea la promoción a producción (regla en CI).
- [ ] El informe es legible por el operador sin conocimientos del código (resumen en docs/aceptacion/ultimo-informe.md).

### T12.3 — Pruebas de caos y game days

**Prompt de ejecución**

```
Diseña y ejecuta un game day por hito desde M3: guiones de caos sobre staging que incluyen matar el motor a mitad de batalla de torneo, matar el worker con cola llena, llenar el disco de replays, caída de Redis, caída y recuperación de PostgreSQL, latencia artificial en la red arena, y un bot hostil nuevo no incluido en la suite conocida de E6. Cada guion define el comportamiento esperado (según los capítulos 9.4, 19.2 y 24) y el resultado observado; las desviaciones se convierten en issues con equipo asignado. Publica los guiones en docs/gamedays/ para que sean repetibles.
```

**Pruebas y Definition of Done**

- [ ] Al menos un game day ejecutado y documentado por hito desde M3, con acta y issues derivadas.
- [ ] Los 7 guiones base tienen comportamiento esperado definido antes de ejecutarse.
- [ ] Las issues de un game day se cierran antes de la puerta del hito siguiente (regla de proceso verificada en las puertas).
- [ ] El guion del bot hostil nuevo se ejecuta con un bot escrito por alguien ajeno a E6 (regla de independencia).

### E12.M — Mejoras y carencias detectadas en el dosier técnico

- El dosier carece de responsable de integración y de automatización de sus propios criterios de aceptación: este equipo lo resuelve.
- Se recomienda que E12 mantenga también el entorno de staging (datos de prueba, reseteo) en coordinación con E10.
- Propuesta de métrica de salud del proyecto: porcentaje de criterios del cap. 28 en verde, visible en un dashboard de Grafana desde M2.

---

## 13. Plan de integración y cierre del proyecto

Los hitos agrupan las fases 0–10 del capítulo 25 en seis puertas verificables. Un hito no se cruza hasta que su puerta está completa; las puertas reutilizan las suites de E12. Entre paréntesis, las fases del dosier técnico que cubre cada hito.

### M0 — Contratos cerrados (Fase 0)

Solo E1. Una semana objetivo. Nada de código de producto antes de esta puerta.

**Puerta de salida del hito**

- [ ] ADR-000 firmado por E2, E3 y E5 (T1.1).
- [ ] Paquetes @arena/protocol, module-catalog/schema, map-schema y openapi.yaml publicados en v0.1 con CI verde (T1.2–T1.4).
- [ ] Tabla de compatibilidad y proceso de cambio de contratos publicados (E1.M).

### M1 — Motor demostrable (Fases 1–2)

Batalla reproducible por semilla y dos bots externos visibles en navegador.

**Puerta de salida del hito**

- [ ] Suite de determinismo de E2 (T2.1–T2.2) en verde con batallas golden.
- [ ] Dos bots del SDK Python juegan una batalla real por protocolo y se ven en el visor en directo (E5/T5.1–T5.2 + E8/T8.2).
- [ ] CI y Compose de desarrollo operativos (E10/T10.1).

### M2 — Juego completo (Fases 3–5)

Mapas reales, vehículos modulares con daño por módulos, y partida CTF 2v2 completa.

**Puerta de salida del hito**

- [ ] Mapa MVP importado, validado y versionado por map-service (E4/T4.1–T4.3).
- [ ] Loadouts del catálogo MVP validados y con capacidades reales en batalla, incluida degradación por daño (E3 completo, E2/T2.3–T2.5).
- [ ] Escenario CTF 2v2 con los cuatro bots de ejemplo termina correctamente y su replay verifica (E5/T5.4, E8/T8.1, E2/T2.6).
- [ ] Informe de balance v1 con winrates 45–55 % (E3/T3.4).

### M3 — Plataforma y sandbox (Fases 6–7)

Flujo de usuario de extremo a extremo con código no confiable ejecutado bajo controles.

**Puerta de salida del hito**

- [ ] Suite E2E del MVP (E12/T12.1) en verde: registro → loadout → código → build → batalla → replay → estadísticas.
- [ ] Suite de escape del sandbox en verde y escaneo de configuración Docker limpio (E6/T6.2, T10.2).
- [ ] Matriz RBAC completa en verde y auditoría operativa (E7/T7.2, E6/T6.4).
- [ ] Primer game day ejecutado con issues cerradas (E12/T12.3).

### M4 — Competición automática (Fases 8–9)

Torneo completo sin intervención humana y mapas procedurales.

**Puerta de salida del hito**

- [ ] Torneo eliminatorio de 8 bots corre de principio a fin, sobrevive a un reinicio de worker y publica campeón, ratings, replays y auditoría verificable (E9 completo).
- [ ] Generador procedural determinista con ≥90 % de mapas válidos y simetría CTF exacta (E4/T4.4).
- [ ] Estadísticas por bot/módulo/equipo/mapa alimentando clasificaciones públicas (E8/T8.4, E7/T7.5).

### M5 — Público y producción (Fase 10 + cierre)

Streaming operativo, criterios de aceptación completos y despliegue de producción.

**Puerta de salida del hito**

- [ ] Emisión privada de 30 minutos a YouTube sin afectar al tick (E11 completo).
- [ ] Pipeline de aceptación del capítulo 28 (E12/T12.2): 10 de 10 criterios en verde.
- [ ] Simulacro de recuperación total completado bajo el objetivo de tiempo (E10/T10.4).
- [ ] Checklist final de despliegue (capítulo 14 de este dosier) completo y firmado por el operador.

---

## 14. Checklist final de despliegue en producción

Verificación final sobre el servidor de producción (VM dedicada en el Proxmox yggdrasil). Se ejecuta una sola vez, tras la puerta M5, y se archiva firmada en docs/despliegue/acta-produccion.md.

- [ ] VM de producción creada y dimensionada según las mediciones de M3; separada de staging.
- [ ] DNS y certificados TLS activos en el gateway; HTTPS forzado y solo 80/443 expuestos (escaneo externo adjunto).
- [ ] .env de producción completo desde .env.example; DATABASE_URL apunta al PostgreSQL designado; perfil postgres desactivado si se usa el existente.
- [ ] Secretos (BD, firma de artefactos, RTMPS) provisionados como secretos de archivo, ausentes de logs y del repositorio.
- [ ] docker compose --profile production up -d ejecutado; todos los healthchecks verdes durante 24 h.
- [ ] Suite E2E del MVP (T12.1) en verde contra producción con datos de humo, y datos de humo eliminados después.
- [ ] Pipeline de aceptación (T12.2) en verde contra producción.
- [ ] Backups programados verificados: primer backup real restaurado con éxito en staging.
- [ ] Alertas conectadas al canal del operador y probadas (alerta de prueba recibida).
- [ ] Runbooks entregados: despliegue, recuperación, operación de torneos, operación de streaming y actualización de servicios.
- [ ] Versionado congelado del release: tabla de versiones (motor, protocolo, SDKs, catálogo, mapas) publicada en docs/releases/v1.0.md.
- [ ] Primer torneo público programado con simulacro (dry-run) previo completado.

**Declaración de fin de proyecto**

> Con los doce puntos anteriores verificados, S9 AI Arena v1.0 queda desplegada y el proyecto definido por el Dosier técnico v1.0 se declara terminado. Cualquier trabajo posterior pertenece a la evolución futura (capítulo 29 del dosier técnico) y requiere un nuevo ciclo de planificación.

---

## 15. Ronda 2 — Remediación, integración, evolución y retirada de v1

*Añadido el 2026-07-16 tras la auditoría consolidada. Esta parte amplía el dosier con el
trabajo que va **después** de tener E1–E12 implementados: corregir los errores detectados,
cerrar la integración, mejorar producto y gráficos, añadir modos de combate, retirar el
prototipo v1 y, en último lugar, todo lo que solo puede probarse con la plataforma desplegada.*

**Documento hermano obligatorio:** [auditoria-consolidada-2026-07-16.md](auditoria-consolidada-2026-07-16.md).
Cada tarea de aquí cita los `ERR-*`/`MEJ` de ese documento, donde está el detalle técnico y el
`archivo:línea`. Este dosier dice **quién lo hace y cómo se prueba**; el otro, **qué está mal y
por qué**.

### 15.0 Cómo usar esta ronda

- **Convenciones idénticas al resto del dosier:** cada tarea tiene ID `Rx.y`, un prompt
  autocontenido y una lista de Pruebas / Definition of Done objetiva. Una tarea solo se cierra
  cuando sus pruebas están automatizadas y en verde.
- **Prioridad = orden de bandas.** Se ejecutan por bandas: **R-P0** (errores bloqueantes) →
  **R-P1** (integración y robustez) → **R-P2** (producto, gráficos y modos baratos) → **R-P3**
  (evolución avanzada). Dentro de una banda las tareas de equipos distintos van en paralelo.
- **Regla de oro de esta ronda (la que explica casi todos los P0):** *toda ruta que no se
  pueda verificar debe **fallar cerrada** y reportarse como **omitida**, nunca como superada.*
  El pipeline no debe devolver `passed`, la CI no debe decir `OK` ni el estado ser `validated`
  cuando la etapa no se ejecutó.
- **Lo que necesita despliegue se deja para el final, a propósito.** Las bandas R-P0…R-P3 están
  diseñadas para completarse **en local / CI sin desplegar la v2**. Todo lo que solo puede
  probarse con la plataforma en marcha se agrupa en la banda final **R-DEPLOY**. Antes de
  R-DEPLOY se ejecuta **R-V1** (sacar el prototipo v1 del camino).
- **Nuevos roles de esta ronda:** se reutilizan los equipos E1–E12 y se añade **EA · Arte y
  Dirección Visual** (assets, sprites, efectos y HUD del visor), que en el dosier original no
  existía porque el MVP se dibujaba con primitivas.

**Mapa de bandas**

| Banda | Objetivo | ¿Necesita despliegue? |
|---|---|---|
| **R-P0** | Errores bloqueantes: funcionales y de seguridad | No (local/CI) |
| **R-P1** | Integración, robustez, CI honesta, tipos en verde | No (local/CI) |
| **R-P2** | Producto usable, gráficos, HUD, modos de combate baratos | No (local/CI) |
| **R-P3** | Modos avanzados y evolución que toca el motor | No (local/CI) |
| **R-V1** | Retirar el prototipo v1 del despliegue y del repo activo | No |
| **R-DEPLOY** | Todo lo verificable solo con la v2 desplegada | **Sí** |

---

### Banda R-P0 · Errores bloqueantes

*Nada de abrir la plataforma a terceros ni jugar torneos "de verdad" hasta cerrar esta banda.
Contiene los dos críticos funcionales (los bots no disparan; el acústico no oye) y los tres
críticos de seguridad (secreto JWT, sandbox que no se ejecuta, docker.sock).*

#### R1.1 — Propagar la munición del loadout al motor (ERR-ENG-08 / issue #15) · Equipo E3+E2

**Prompt de ejecución**

```
Corrige resolveVehicle (packages/module-catalog/resolve/index.ts) para que lea entry.ammo de
cada módulo-arma del loadout canónico y materialice el módulo de munición correspondiente en el
VehicleSpec resuelto, de forma que el motor (combat.ts ammoFor/fire) encuentre munición y el
disparo no salga como "no_ammo". Elimina el "doble-ammo" de los fixtures resolve/archetypes.ts
(el módulo ammo_main añadido a mano) y regenera los golden de resolve/ para que reflejen la
forma canónica real (munición como propiedad del arma), no la pre-expandida. Añade una prueba
vertical obligatoria que recorra loadout persistido → resolveVehicle → inicio de batalla →
consumo de munición → disparo → impacto → daño registrado, usando el loadout de ejemplo real
(loadout-medium-gunner.json), sin fixtures que dupliquen munición.
```

**Pruebas y Definition of Done**

- [ ] Un bot construido desde `loadout-medium-gunner.json` dispara y hace daño en una batalla real (test que asevera daño > 0, no solo que haya campeón).
- [ ] Los golden de `resolve/` se comparan contra la salida real de `resolveVehicle`, sin `ammo_main` pre-expandido.
- [ ] El E2E de torneo (`tournament-e2e.test.ts`) verifica que al menos un disparo impacta; falla si algún bot resuelve sin munición.
- [ ] Prueba de regresión: un loadout sin `ammo` en un arma que la exige se rechaza en validación con el código de violación de E3, no en runtime.

#### R1.2 — Reparar el sensor acústico y su test vacuo (ERR-ENG-01) · Equipo E2

**Prompt de ejecución**

```
Corrige el doble borrado de sonidos en arena-engine/src/sim/battle.ts: implementa doble búfer
de sonidos de forma que las observaciones de un ciclo de decisión reciban los sonidos
acumulados durante el ciclo ANTERIOR, e intercambia los búferes DESPUÉS de construir todas las
observaciones, no antes. Unifica las dos rutas de observación (el bucle interno y
observationFor()) para que vean exactamente el mismo conjunto de sonidos. Endurece
sensors-fog.test.ts para que EXIJA que un vehículo con sensor.acoustic perciba un disparo
cercano (sources.length > 0), eliminando el guard condicional que hoy hace que el test pase con
el array vacío.
```

**Pruebas y Definition of Done**

- [ ] Test que dispara cerca de un vehículo con acústico y asevera que su observación contiene la fuente (dirección aproximada); falla si `sources` está vacío.
- [ ] Las dos rutas de observación producen el mismo bloque acústico para el mismo tick (test de coherencia).
- [ ] La corrección no altera el hash de estado de las batallas golden existentes (el sonido no entra en el hash; regenerar solo si cambia deliberadamente).

#### R1.3 — Publicar los sensores que faltan en el catálogo (ERR-ENG-01 dependiente) · Equipo E3

**Prompt de ejecución**

```
Añade a packages/module-catalog/data los JSON de sensor.acoustic y sensor.proximity conformes
al esquema de E1, con masa, coste, consumo y parámetros coherentes con el balance v1 (el motor
ya los implementa en sensors.ts; hoy ningún vehículo puede montarlos porque no existen como
datos). Documenta sus valores en docs/balance/. Requiere R1.2 cerrado para que el acústico
funcione de verdad.
```

**Pruebas y Definition of Done**

- [ ] Ambos sensores validan contra el esquema de E1 y son montables en un loadout legal.
- [ ] Un bot con `sensor.acoustic` percibe disparos en una batalla real (integra con R1.2).
- [ ] El balance documenta cada valor.

#### R1.4 — Secreto JWT: fallar cerrado y leer por archivo (ERR-SEC-01) · Equipo E7

**Prompt de ejecución**

```
Elimina el literal "dev-only-jwt-secret" de apps/api/src/auth/tokens.ts. Implementa la lectura
de secretos por archivo (JWT_SECRET_FILE con precedencia sobre JWT_SECRET) y haz que el arranque
FALLE si no hay secreto explícito, sin depender de NODE_ENV (invierte la lógica: exigir secreto
salvo que se declare explícitamente un modo desarrollo). Separa el secreto de firma de tickets
de espectador del de sesión, y asigna audience/issuer distintos por tipo de token; verifica el
algoritmo explícitamente en jwt.verify.
```

**Pruebas y Definition of Done**

- [ ] Arrancar la API sin secreto configurado lanza y no levanta el servidor (test).
- [ ] Un ticket de espectador firmado con el secreto de sesión (o viceversa) es rechazado por `audience` (test).
- [ ] `JWT_SECRET_FILE` tiene precedencia y el literal ya no existe en el repo (grep en CI).
- [ ] `jwt.verify` fija algoritmo; un token con `alg` distinto se rechaza.

#### R1.5 — Sandbox: fallar cerrado sin runner (ERR-SEC-03) · Equipo E6

**Prompt de ejecución**

```
Cambia el pipeline de bot-manager para que la ausencia de agentResolver (las etapas que ejecutan
el bot: protocol_test, smoke_battle, resource_limits) RECHACE el build en vez de aprobarlo.
Distingue en el tipo de retorno de cada etapa entre "superada", "fallida" y "no ejecutable", y
trata "no ejecutable" como bloqueante para cualquier transición a validated. Mientras no exista
entorno con Docker, el estado terminal de un bot cuyo sandbox no se pudo ejecutar debe ser
rejected o un estado explícito "no verificable", nunca validated. Añade el resolver real de
sandbox como dependencia obligatoria en producción.
```

**Pruebas y Definition of Done**

- [ ] Un build sin `agentResolver` termina en `rejected`/"no verificable", nunca en `validated` (test).
- [ ] Las tres etapas de ejecución, si no corren, cuentan como bloqueantes (test por etapa).
- [ ] Ningún camino de código lleva un bot a `validated` sin haber ejecutado el sandbox (test de la máquina de estados).

#### R1.6 — CI del sandbox: dejar de pasar en verde sin probar (ERR-SEC-04) · Equipo E6+E10

**Prompt de ejecución**

```
Reescribe tests/sandbox-escape/run-escape-suite.sh y el job de .github/workflows/e6-security.yml
para que: capturen el código de salida de docker run por separado y ABORTEN con error si el
contenedor no llegó a ejecutarse (nada de "|| true" que trague fallos); exijan que cada bot
hostil emita un marcador positivo de "intenté el ataque y fui bloqueado", de modo que el silencio
se interprete como fallo; rechacen digests placeholder reutilizando el guard digest-guard.ts; y
marquen el job como SKIPPED (no passed) mientras no haya runner con Docker y digests reales.
```

**Pruebas y Definition of Done**

- [ ] Con la imagen `@sha256:PENDIENTE`, el job termina en `skipped` o `failed`, jamás en `passed` (verificado forzando el caso).
- [ ] Un contenedor que no arranca hace fallar el job (test del script con un digest inválido).
- [ ] Cada uno de los 7 vectores de escape produce un marcador positivo de bloqueo; su ausencia falla el job.

#### R1.7 — Retirar el montaje de docker.sock (ERR-SEC-02) · Equipo E6+E10

**Prompt de ejecución**

```
Elimina el montaje directo de /var/run/docker.sock del servicio bot-manager en
infrastructure/docker-compose.yml. Interpón un proxy de API de Docker que exponga solo
crear/arrancar/parar/inspeccionar con una allowlist estricta de parámetros que rechace
privileged, bind-mounts, --network host y cambios de usuario; o migra a Docker rootless o a un
runtime con aislamiento de kernel (gVisor/Kata/sysbox). Retira la excepción del bot-manager en
scan-compose.mjs y alinéalo con complianceViolations de container-runner.ts como única fuente de
verdad, de modo que cualquier servicio que monte docker.sock haga fallar el escáner. Aísla el
nodo de build/ejecución de bots sin acceso a PostgreSQL, backups, secretos ni red administrativa.
```

**Pruebas y Definition of Done**

- [ ] El escáner de Compose falla si algún servicio monta `docker.sock` directamente (test, sin excepciones).
- [ ] El bot-manager lanza contenedores a través del proxy con allowlist; un intento de `privileged`/bind-mount es rechazado por el proxy (test).
- [ ] El nodo de bots no tiene ruta de red a la BD ni a los secretos (verificación de segmentación).

#### R1.8 — Rate-limit y bloqueo de login tras proxy (ERR-SEC-05) · Equipo E7

**Prompt de ejecución**

```
Configura la confianza de proxy en Express de forma ACOTADA (declarando el salto/rango del
gateway, no genérica) para que req.ip sea la IP real del cliente y no la del gateway. Verifica la
coherencia con el modo "detrás del proxy de VM104" (dos saltos). Asegura que la cuota anónima y
la clave de bloqueo de fuerza bruta (${ip}|${email}) usan la IP real. Añade un test que confirme
que una X-Forwarded-For inyectada por un cliente externo NO altera la clave de límite.
```

**Pruebas y Definition of Done**

- [ ] Con dos peticiones desde IPs distintas tras el gateway, la cuota anónima las cuenta por separado (test).
- [ ] Una `X-Forwarded-For` falsificada desde fuera del gateway no cambia `req.ip` (test).
- [ ] El bloqueo de login se aplica por IP+email real, no `<gateway>|email` (test que demuestra que no se puede bloquear una cuenta ajena desde una sola IP externa con XFF falsa).

#### R1.9 — `zone_control` jugable + King of the Hill (ERR-ENG-03 / MEJ-modo) · Equipo E2

**Prompt de ejecución**

```
Corrige zone_control en modes.ts: separa propiedad de puntuación de modo que solo se puntúe con
presencia real de un equipo en la zona (elimina el caso teamsInside.size == 0 como puntuable), o
introduce decaimiento/neutralización tras N ticks sin nadie dentro. Incluye id y posición de cada
zona en objectives() para que un bot con más de una zona pueda decidir a cuál ir (la posición es
pública por definición del modo). Con eso hecho, registra el modo King of the Hill como una
configuración de zone_control con una sola zona y puntuación solo por presencia, más su ruleset.
```

**Pruebas y Definition of Done**

- [ ] Un equipo que toca una zona y se marcha NO gana; solo puntúa mientras hay presencia (test guionizado).
- [ ] Con dos zonas, `objectives()` entrega id y posición distintos para cada una (test).
- [ ] Un escenario de King of the Hill 2v2 termina con el marcador esperado de forma determinista.

---

### Banda R-P1 · Integración, robustez y CI honesta

*Cerrar la deuda que no bloquea la seguridad pero impide que "verde" signifique lo que dice.
Todo local/CI, sin desplegar.*

#### R2.1 — Tipos en verde y CI bloqueante (ERR-GES-02 / ERR-GES-03) · Equipo E7+E10

**Prompt de ejecución**

```
Separa el typecheck de apps/web del resto: excluye apps/web del tsconfig.json raíz (o dale su
propio proyecto de typecheck con jsx), de modo que npx tsc --noEmit sobre el tsconfig raíz deje
de emitir los ~230 falsos errores de JSX. Corrige los 38 errores de tsc genuinos restantes
(query params string|string[] en routes/bots.ts, battles.ts, standings.ts, catalog.ts;
supportedModes en maps.ts; los 2 de battle.ts de E2; pipeline.ts, streamer/main.ts,
redis-signal.ts). Luego RETIRA continue-on-error: true del paso de tipos en ci.yml para que el
typecheck rompa la CI. Sustituye el paso "Formato" (hoy un echo) por un formateador real y añade
un paso de cobertura.
```

**Pruebas y Definition of Done**

- [ ] `npx tsc --noEmit` sobre el tsconfig raíz y sobre `apps/web` da **0 errores**.
- [ ] La CI **falla** si se introduce un error de tipos (verificado con un error deliberado).
- [ ] El paso de formato ejecuta un formateador real y falla ante código sin formatear.
- [ ] Se publica un informe de cobertura como artefacto de CI.

#### R2.2 — CI con semáforo verde/amarillo/rojo (ERR-GES-05) · Equipo E10

**Prompt de ejecución**

```
Reestructura los workflows para distinguir tres resultados: verde (todo ejecutado y aprobado),
amarillo (pruebas correctas pero entorno externo no disponible, p.ej. sin STAGING_HOST o sin
Docker) y rojo (fallo funcional o de seguridad). deploy-staging y smoke-and-promote no deben
presentar un despliegue omitido como éxito: si STAGING_HOST no está configurado, el resultado es
amarillo explícito, no verde. Haz bloqueantes los pasos de tipos (R2.1) y de seguridad.
```

**Pruebas y Definition of Done**

- [ ] Una ejecución que omite staging por falta de secreto se marca amarilla, no verde (verificado).
- [ ] Un fallo de seguridad (escáner de Compose, Trivy crítico) pone la CI en rojo y bloquea la promoción.
- [ ] El estado que ve el operador refleja sin ambigüedad qué se ejecutó de verdad.

#### R2.3 — Robustez de la suite en Windows y separación por dependencia de BD (ERR-GES-04) · Equipo E7+E12

**Prompt de ejecución**

```
Etiqueta los tests que exigen PostgreSQL (los 22 ficheros que hoy fallan en Windows por
embedded-postgres/pg_ctl) para poder ejecutarlos por separado del resto. Documenta en
docs/getting-started el requisito y ofrece una ruta alternativa (PostgreSQL en contenedor o
servicio local vía DATABASE_URL) para desarrolladores en Windows, de modo que npm test sin BD
ejecute la parte pura en verde y la parte con BD se corra aparte. No cambies la lógica de los
tests; es un problema de entorno y de organización de la suite.
```

**Pruebas y Definition of Done**

- [ ] `npm test` sin BD ejecuta la parte pura del motor/validadores/SDK en verde en Windows.
- [ ] Los tests con BD corren en verde apuntando a un PostgreSQL por `DATABASE_URL` (documentado).
- [ ] La documentación explica ambos caminos y el motivo.

#### R2.4 — Endurecer análisis estático y auth (ERR-SEC-06/07/08/11) · Equipo E6+E7

**Prompt de ejecución**

```
(E6) Amplía la lista de módulos peligrosos con os, importlib, pickle, marshal, pty, runpy, code,
shutil y equivalentes de proceso/FFI/serialización; saca os y process de las listas de builtins
permitidos; sustituye el parseo por regex por análisis del AST real de cada runtime (detecta
imports dinámicos, eval/exec, acceso a __builtins__). (E7) Exige reautenticación fuerte
(contraseña + TOTP/recuperación) para desactivar 2FA y revoca el resto de sesiones al cambiar el
estado; implementa detección de reutilización de refresh tokens por familias (revocar la familia
ante un token ya rotado) con vida máxima absoluta y rate-limit; ejecuta siempre Argon2id contra
un hash señuelo cuando el email no existe en login (anti-enumeración).
```

**Pruebas y Definition of Done**

- [ ] Un bot que importa `os`/`__import__` dinámico es detectado por el AST y bloqueado (tests).
- [ ] Desactivar 2FA sin reautenticación fuerte devuelve 401/403 (test).
- [ ] Presentar un refresh token ya rotado revoca toda la familia y audita (test).
- [ ] El tiempo de respuesta de login es indistinguible entre email existente e inexistente (test estadístico).

#### R2.5 — Encolar builds y firma verificable (ERR-SEC-12/15/14) · Equipo E6+E7

**Prompt de ejecución**

```
Convierte submitBotVersion en encolado real: persiste el trabajo en la tabla jobs (patrón ya
usado en batallas), devuelve 202 y que el worker de bot-manager lo consuma, sacando el pipeline
del proceso de la API. Aplica rate-limit por usuario a la creación de versiones/builds. Carga la
clave privada de firma de artefactos desde el almacén de secretos (no efímera), publica la
pública y verifica la firma antes de cada lanzamiento. Traslada el estado de rate-limit/bloqueo a
un almacén compartido (Redis/tabla api_usage) con expiración y cota de claves.
```

**Pruebas y Definition of Done**

- [ ] Subir una versión devuelve 202 y el build corre en el worker, no en la API (test).
- [ ] La firma de un artefacto se verifica con la clave pública publicada; un artefacto manipulado se rechaza (test).
- [ ] El rate-limit sobrevive a un reinicio del proceso (test contra el almacén compartido).

#### R2.6 — Saneado de subidas y cabeceras (ERR-SEC-09/10/16) · Equipo E7

**Prompt de ejecución**

```
Valida el paquete de código subido con esquema estricto (ajv): rechaza toda ruta que no sea
relativa, normalizada y contenida bajo el directorio del paquete (sin .., sin absolutos, sin
control), exige el manifiesto en la raíz exacta y limita el número de ficheros. Sanea
source_filename (base, allowlist, longitud) y emite Content-Disposition con la codificación
estándar de parámetros, con nombre por defecto derivado del id de versión. Corrige los flecos:
transportar el ticket de espectador fuera de la URL y exigir wss en producción; mover HSTS al
gateway; corregir SERVICE_ENTRY de la API (server.ts, no main.ts) para que el contenedor arranque.
```

**Pruebas y Definition of Done**

- [ ] Un paquete con `path` `../x` o absoluto es rechazado en decodificación (test).
- [ ] Un `source_filename` con comillas/CRLF no rompe la cabecera ni permite spoofing (test).
- [ ] El contenedor de la API arranca con el `SERVICE_ENTRY` corregido (verificado en `docker compose config` + arranque en R-DEPLOY).

#### R2.7 — Hash de estado y lint de determinismo completos (ERR-ENG-02/04/05/06/07) · Equipo E2

**Prompt de ejecución**

```
Invierte el lint de determinismo (lint-determinism.mjs) para vigilar todo src/ con una lista de
exclusión explícita y comentada (protocol-server.ts, cli.ts), de modo que rng.ts, replay.ts y
cualquier fichero nuevo queden vigilados por defecto. Añade al hash canónico de estado el número
de cuerpos despiertos y el conteo de contactos de Rapier, y expón hashEveryNTicks como parámetro
del ruleset. Mueve el heading del chasis a un campo de Vehicle (elimina el headingCache global).
Purga radioSentThisSecond con un contador por vehículo y añade guard de longitud a radioQueue.
Haz que deathmatch rechace en construcción una lista de participantes donde dos compartan equipo.
```

**Pruebas y Definition of Done**

- [ ] Un `Math.random()` introducido en `rng.ts` hace fallar el lint (test).
- [ ] El hash detecta una divergencia del solver que antes era invisible (test con escenario construido).
- [ ] `dm_practice` con dos vehículos del mismo equipo se rechaza al construir la batalla (test).
- [ ] La fuga de `radioSentThisSecond` no crece en una batalla de 5 min (test de memoria).

---

### Banda R-P2 · Producto, gráficos y modos de combate baratos

*Lo que convierte un visualizador técnico en un producto. Todo local/CI. Introduce el equipo EA
de arte. Incluye los cuatro modos de combate que no tocan el motor.*

#### R3.1 — El replay interpola como el directo (ERR-VIS-01) · Equipo E8

**Prompt de ejecución**

```
Corrige ReplayPage/PhaserViewer para que el reproductor de replay empuje snapshots con
pushSnapshot usando el instante derivado del playhead (no performance.now()) y use resetTo solo
tras un seek, de modo que el interpolador funcione igual en directo y en replay y el replay deje
de verse a 10 saltos por segundo. Idealmente, que la escena acepte un "tiempo de reproducción"
explícito compartido por ambas rutas.
```

**Pruebas y Definition of Done**

- [ ] El replay a 1× se ve interpolado, no a saltos (test de que se llama a `pushSnapshot` por frame y `resetTo` solo tras seek).
- [ ] Un seek reposiciona sin arrastrar interpolación del tramo anterior.
- [ ] Directo y replay comparten la misma ruta de interpolación (sin duplicación).

#### R3.2 — Interpolación, cámara y transporte robustos (ERR-VIS-06/07/08) · Equipo E8

**Prompt de ejecución**

```
Interpola sobre delta de ticks (no tiempo de llegada) con un reloj de reproducción y delay-buffer
de ~2 intervalos; simula los proyectiles balísticos localmente entre snapshots; filtra la niebla
DESPUÉS de interpolar con fundido de alfa e histéresis. Añade serverTimeMs al snapshot. Suaviza la
cámara (amortiguación crítica sobre centro y zoom, deadzone en follow, clamp a los límites del
mapa) y añade interacción (rueda para zoom, arrastre para pan, teclas 1–4 para seguir bots).
Configura escala RESIZE + devicePixelRatio; fuerza WebGL con SwiftShader en el streamer; fija el
FPS objetivo por vista. Reconexión con backoff exponencial + jitter, heartbeat/watchdog y ruteo
del fallo inicial al bucle de reconexión; buffer circular de eventos.
```

**Pruebas y Definition of Done**

- [ ] Los proyectiles rápidos se ven como trayectorias, no parpadeos (prueba visual + unitaria de la simulación balística local).
- [ ] Un enemigo que entra/sale de niebla aparece/desaparece con fundido, sin teletransporte (test de histéresis).
- [ ] La cámara no da tirones al cambiar de modo ni muestra el vacío fuera del mapa (test de clamp).
- [ ] Tras cortar y restaurar el gateway, el visor reconecta con backoff y sin estampida (test).

#### R3.3 — Rendimiento del front y medición (ERR-VIS-09/11) · Equipo E8

**Prompt de ejecución**

```
Sustituye Shapes/Text por Sprites de un atlas de texturas (batcheables) con setTint por equipo y
BitmapText; hornea la capa estática del mapa a una RenderTexture; pon techo al pool de
proyectiles; elimina las asignaciones por frame en frameOf/applyCamera reutilizando mapas. Saca
el tick del replay de React (ref con throttling ~4 Hz), prefetch del chunk N+1 fuera del bucle de
RAF, y seek al soltar el slider con AbortController. Añade un contador de FPS y una prueba de
rendimiento en CI (Playwright headless) que mida 60 fps en el visor y 1080p30 en /broadcast.
```

**Pruebas y Definition of Done**

- [ ] Los draw calls por frame bajan de ~35 a un puñado (medido con el contador).
- [ ] El replay ya no re-renderiza React a 60 fps (test del throttling).
- [ ] La prueba de rendimiento en CI verifica 60 fps sostenidos con 8 bots y proyectiles densos.

#### R3.4 — Dirección artística y sprites modulares (ERR-VIS-05 / MEJ-gráficos) · Equipo EA+E8

**Prompt de ejecución**

```
Define una dirección artística única (estética táctica/industrial, paleta S9, tipografía) y
produce un atlas de texturas con: chasis por tipo, torreta, arma, proyectil, banderas, iconos de
módulo y partículas (humo/chispa). Integra en el visor sprites modulares derivados del loadout
(un espectador debe distinguir explorador/artillero/pesado de un vistazo), coloreados por equipo
con setTint desde el ruleset (no colores hardcodeados; equipos distintos de red/blue deben tener
color propio). Sustituye el id crudo por el nombre del bot en BitmapText. Todo consumiendo solo el
snapshot público y los eventos que ya llegan.
```

**Pruebas y Definition of Done**

- [ ] El vehículo se dibuja con sprite según su chasis y se colorea por equipo desde el ruleset (test visual + de que no hay colores hardcodeados).
- [ ] El nombre del bot (no el UUID) aparece sobre el vehículo.
- [ ] El atlas es un solo asset batcheable (verificado en el contador de draw calls de R3.3).

#### R3.5 — Efectos, daño visible y objetivos dibujados (ERR-VIS-05 / MEJ-gráficos) · Equipo EA+E8

**Prompt de ejecución**

```
Añade efectos reproducibles desde eventos (nunca afectan a la simulación): fogonazo de disparo,
trazadoras/estelas de proyectil, impactos y explosiones en vehicle_destroyed/mine_triggered,
humo creciente conforme baja el casco, decals persistentes en RenderTexture. Representa el daño
visible coincidiendo exactamente con el estado público (blindaje roto, módulos destruidos,
torreta bloqueada). Dibuja los objetivos que hoy se ignoran pese a llegar al overlay: banderas
CTF, bases y zonas de captura con su estado/animación, y minas visibles según permisos de
espectador.
```

**Pruebas y Definition of Done**

- [ ] Cada evento (disparo, impacto, destrucción, mina) produce su efecto y ninguno altera el hash de la batalla (test de no-interferencia).
- [ ] El estado visible de daño coincide con el estado público del motor (test de correspondencia).
- [ ] Banderas, bases y zonas se dibujan en el canvas con su estado (test visual).

#### R3.6 — HUD completo y minimapa (MEJ-gráficos) · Equipo EA+E8

**Prompt de ejecución**

```
Construye un HUD completo sobre los datos que el overlay ya mantiene: marcador superior, reloj y
fase, objetivo actual, panel de bots por equipo con vida y módulos, kill feed, estado de banderas
y control de zonas, y un minimapa real (segunda cámara de Phaser con setViewport + ignore(), sin
duplicar entidades). Añade indicadores de fin de partida sobre el canvas. Mantén el HUD legible en
el visor interactivo y en /broadcast.
```

**Pruebas y Definition of Done**

- [ ] El minimapa muestra posiciones de vehículos y objetivos con una sola cámara adicional (test).
- [ ] El HUD refleja marcador, vida y estado de objetivos en vivo (test contra un snapshot conocido).
- [ ] El fin de partida se anuncia sobre el canvas, no solo en el feed HTML.

#### R3.7 — Panel: torneos, batallas, sesión y editor (ERR-VIS-02/03/04/10) · Equipo E7 (web)

**Prompt de ejecución**

```
Añade al panel las pantallas que faltan: torneos (crear/ver/seguir con cuadro visual, cola,
batallas en curso), batallas e historial, con enlaces desde bot → batallas → replay (hoy el
visor solo se abre tecleando un UUID en el hash). Persiste la sesión (cookie httpOnly emitida por
la API) con interceptor único de 401 (refresh o limpieza + redirección con mensaje). Corrige el
editor de loadout para que cargue la revisión vigente del bot (key={bot.id} para remontar,
duplicar/comparar), con selección explícita de munición y sin non-null assertions; añade un error
boundary global. Corrige la accesibilidad base: formularios con onSubmit (envío con Enter),
labels visibles, role="alert"/aria-live en errores y feed, :focus-visible, responsive y estados
de carga/error por recurso (nunca lista vacía cuando la carga falló).
```

**Pruebas y Definition of Done**

- [ ] Se puede crear y seguir un torneo y abrir su directo/replay desde la UI sin teclear UUIDs (E2E).
- [ ] Recargar (F5) mantiene la sesión; un 401 se maneja sin romper cada pantalla (test).
- [ ] El editor carga el loadout guardado de un bot y permite editarlo; el catálogo incompleto no tumba la pantalla (test con error boundary).
- [ ] Los formularios se envían con Enter y los errores se anuncian a lectores de pantalla (tests de a11y).

#### R3.8 — Modos de combate baratos: rondas, Domination, Juggernaut (MEJ-modos) · Equipo E2+E9

**Prompt de ejecución**

```
Implementa, sin tocar el núcleo de simulación salvo lo imprescindible, tres modos nuevos como
clases de GameMode + rulesets: (1) Eliminación por rondas / Last Man Standing, introduciendo un
nivel "match" de N batallas con semillas derivadas mediante rng.fork() (hoy sin usar) y cambio de
lado; (2) Domination con varias zonas permanentes y ritmo de puntuación por nº de zonas
controladas (reutiliza zone_control corregido de R1.9); (3) Juggernaut/VIP con un vehículo
marcado (campo por vehículo al estilo carryingFlag) al que el resto puntúa destruir. Registra cada
modo con metadatos (mapas compatibles, equipos mín/máx, respawn, desempate).
```

**Pruebas y Definition of Done**

- [ ] Cada modo tiene un escenario guionizado 2v2/FFA que termina con el marcador esperado de forma determinista.
- [ ] Eliminación por rondas reproduce el mismo resultado por semilla a través de las rondas (test de `rng.fork`).
- [ ] El registro de modos por metadatos rechaza una combinación mapa/modo incompatible (test).

---

### Banda R-P3 · Evolución avanzada (toca el motor)

*Modos que introducen estado nuevo de simulación. La regla de oro manda: toda entidad nueva debe
entrar en el hash y el snapshot.*

#### R4.1 — Zonas mutables y Battle Royale (MEJ-modos) · Equipo E2

**Prompt de ejecución**

```
Expón zonas mutables en ModeContext (posición y radio modificables por el modo) e incorpora la
geometría de la zona al hash canónico de estado y al snapshot público (es ahora estado de
simulación). Implementa Battle Royale con algoritmo de cierre de zona, spawns distribuidos,
loadout inicial equilibrado y reglas antiocultación, reutilizando el daño de zona existente.
```

**Pruebas y Definition of Done**

- [ ] Dos batallas Battle Royale con la misma semilla producen el mismo hash, con la zona encogiéndose igual (test de determinismo).
- [ ] Un cambio de geometría de zona que no entrara en el hash haría fallar un test guardián (test negativo).
- [ ] Una partida de 20 vehículos termina con un único superviviente dentro del presupuesto de tick.

#### R4.2 — Entidades dinámicas neutrales: Payload / Escolta (MEJ-modos) · Equipo E2

**Prompt de ejecución**

```
Añade al motor un cuerpo dinámico neutral (no vehículo) con su entrada en el hash y en el
snapshot público, y las rutas/checkpoints necesarios. Implementa Payload: una carga neutral que
avanza por una ruta cuando el atacante controla su entorno, con bloqueo/retroceso, spawns
dinámicos y overtime.
```

**Pruebas y Definition of Done**

- [ ] El payload entra en el hash y el replay lo reproduce en la misma posición (test).
- [ ] La carga avanza/retrocede según control de entorno de forma determinista (escenario guionizado).
- [ ] El overtime se dispara y resuelve según la regla publicada (test).

#### R4.3 — Extracción de recursos y Horda PvE (MEJ-modos) · Equipo E2+E3

**Prompt de ejecución**

```
Introduce objetos recogibles con capacidad de carga y puntos de extracción (con su estado en
hash/snapshot) para el modo Extracción. Para Horda PvE, añade IA neutral controlada por el
servidor y un generador de oleadas determinista con dificultad escalada. Ambos requieren R4.1
(patrón de entidad de estado en el hash) como base.
```

**Pruebas y Definition of Done**

- [ ] Recoger, transportar y perder recursos al morir es determinista y reproducible por replay (test).
- [ ] El generador de oleadas produce las mismas oleadas por semilla (test).
- [ ] La dificultad escala según la regla publicada y la partida es auditable.

#### R4.4 — Gobierno de seguridad y determinismo cross-entorno (ERR-GES-08 / MEJ-motor) · Equipo E10+E2

**Prompt de ejecución**

```
Añade SECURITY.md con proceso privado de reporte de vulnerabilidades, Dependabot/Renovate,
protección de main gateada por CI, acciones de terceros fijadas a SHA y SBOM por imagen. Separa
la documentación pública del inventario privado de infraestructura (IPs/VMs fuera del repo
público). Amplía la verificación de determinismo para comparar hashes entre versiones de Node,
hosts y nº de núcleos y tras serializar/restaurar snapshot; cuantiza lo que decide
colisiones/puntuación. Versiona los reglamentos como inmutables por combate.
```

**Pruebas y Definition of Done**

- [ ] `main` está protegida y requiere CI verde + revisión de CODEOWNERS (verificado).
- [ ] El hash de una batalla coincide entre dos versiones compatibles de Node y tras restaurar un snapshot (test nightly).
- [ ] La documentación pública no contiene inventario de infraestructura interna (revisión).

---

### Banda R-V1 · Retirar el prototipo v1 del camino

*Se ejecuta antes de R-DEPLOY para que el despliegue de la v2 no pueda confundirse con el
prototipo. No borra la historia: la archiva y la desconecta del despliegue.*

#### R5.1 — Archivar el prototipo v1 y separarlo del despliegue · Equipo E10

**Prompt de ejecución**

```
Mueve el prototipo v1 fuera de la ruta activa sin perder la historia: traslada docker-compose.yml
de la raíz, apps/arena-server, apps/arena-viewer (Phaser 3) y bots/bot-red, bots/bot-blue a
archive/v1-prototype/ (o etiqueta un release git v1-final y los retira de la raíz). Deja en la
raíz un README breve que apunte a infrastructure/docker-compose.yml como único stack canónico.
Añade una comprobación en CI que impida reintroducir en la raíz un compose o servicios del
prototipo, y que falle si el compose canónico referencia artefactos de v1. Confirma que ningún
servicio v2 depende de arena-server/arena-viewer.
```

**Pruebas y Definition of Done**

- [ ] No existe `docker-compose.yml` de prototipo en la raíz; el único stack es `infrastructure/docker-compose.yml`.
- [ ] La CI falla si se reintroduce un servicio del prototipo en la raíz (test).
- [ ] La historia de v1 se conserva (archivada o en tag) y está documentada como legacy.

#### R5.2 — Plan de corte de producción v1 → v2 · Equipo E10 (coordinado con el operador)

**Prompt de ejecución**

```
Redacta y prepara el runbook de corte de la v1 en producción (VM108, tras el proxy de VM104): qué
URL/puertos deja de servir arena-server/arena-viewer, cómo el proxy de VM104 pasa a apuntar al
gateway de la v2, y el orden de arranque/parada para que no haya ventana de doble sistema activo.
La ejecución real del corte pertenece a R-DEPLOY (requiere la v2 desplegada y verificada); esta
tarea deja el plan escrito, revisado y con criterio de rollback a v1 si la v2 falla el humo.
```

**Pruebas y Definition of Done**

- [ ] Runbook de corte revisado con pasos, responsables y criterio de rollback.
- [ ] El plan no crea ventana de doble sistema sirviendo la misma URL.
- [ ] Rollback a v1 documentado y probado en seco.

---

### Banda R-DEPLOY · Solo verificable con la v2 desplegada (lo último)

*Todo lo que exige Docker con salida a internet y la plataforma en marcha. Es el camino crítico
histórico del proyecto. No empezar hasta cerrar R-P0 y tener R-V1 preparada. Reutiliza las
suites de E12 y las puertas de los hitos M3–M5 del capítulo 13.*

#### R6.1 — Construir imágenes y fijar digests reales (ERR-GES-06) · Equipo E10

**Prompt · DoD:** Construir las imágenes de runtime en un entorno con Docker+red, fijar los
**digests reales** en `DIGESTS.lock`, y verificar que el guard rechaza placeholders, `latest` e
imágenes sin firma/SBOM. **DoD:** `DIGESTS.lock` sin `sha256:000…0`; el despliegue rechaza una
imagen sin firmar (test); Trivy sin críticas.

#### R6.2 — Verificación viva del sandbox (ERR-SEC-03/04 cierre real) · Equipo E6+E12

**Prompt · DoD:** Ejecutar la suite de escape (R1.6) contra contenedores **vivos**, `docker
inspect` contra la tabla 18.2 y Trivy; añadir los vectores que faltaban (abuso del endpoint del
motor, verificación del propio seccomp, `noexec` del tmpfs, agotamiento de disco/inodos, escape
post-arranque). **DoD:** los 7+ vectores fallan su objetivo con marcador de bloqueo; `docker
inspect` confirma cero capabilities, read-only, seccomp y no-new-privileges; puerta M3 cruzada.

#### R6.3 — Desplegar la v2 de extremo a extremo en staging (ERR-SEC-16 arranque incluido) · Equipo E10+E12

**Prompt · DoD:** `docker compose up` del stack v2 completo con migraciones, secretos reales y
healthchecks; una batalla automática visible en directo, con replay, estadísticas, torneo,
backup y restauración, verificada **desde una máquina distinta** al servidor. **DoD:** la suite
E2E del MVP (T12.1) en verde contra staging; el contenedor de la API arranca con el
`SERVICE_ENTRY` corregido; evidencia archivada.

#### R6.4 — Staging real y semáforo de promoción (ERR-GES-05 cierre) · Equipo E10

**Prompt · DoD:** Configurar `STAGING_HOST` y hacer que cada versión candidata despliegue por
digest, ejecute migraciones, lance una batalla con dos bots, abra el espectador, genere replay y
stats, verifique métricas y ejecute rollback. **DoD:** `deploy-staging` deja de ser stub; la
promoción a producción exige el pipeline de aceptación (T12.2) 10/10 en verde.

#### R6.5 — Ejecutar el corte v1 → v2 en producción (R5.2) · Equipo E10

**Prompt · DoD:** Ejecutar el runbook de corte: el proxy de VM104 apunta al gateway v2, se para
el prototipo v1, sin ventana de doble sistema. **DoD:** producción sirve solo la v2; healthchecks
verdes 24 h; rollback disponible; acta firmada.

#### R6.6 — Streaming real, recuperación y checklist de producción (puerta M5) · Equipo E11+E10+E12

**Prompt · DoD:** Emisión privada de 30 min a YouTube sin afectar al tick; simulacro de
recuperación total cronometrado bajo objetivo; checklist del capítulo 14 completo. **DoD:** las
tres puertas de M5 en verde; `cpuMs` (H5) rellenado con medición real del runner; declaración de
producción firmada.

---

### 15.1 Puerta de salida de la Ronda 2

> La Ronda 2 se declara terminada cuando: **(a)** la banda R-P0 está cerrada (los dos críticos
> funcionales y los tres de seguridad), **(b)** `tsc` da 0 y la CI es honesta (verde/amarillo/rojo),
> **(c)** el prototipo v1 está fuera del despliegue, y **(d)** la cadena completa —crear bot →
> loadout → subir → **sandbox real valida** → publicar → torneo → combate → directo → replay →
> stats → clasificación → restaurar y reproducir— corre en verde sobre la **v2 desplegada en
> staging**, con la puerta M5 y el checklist del capítulo 14 completos. A partir de ahí, R-P2/R-P3
> continúan como evolución de producto sin bloquear la apertura de la plataforma.
