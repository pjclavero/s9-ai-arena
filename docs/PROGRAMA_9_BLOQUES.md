# Programa de 9 bloques — consolidación final

**Estado: COMPLETADO.** 9/9 bloques con GATE-PASS. Veredicto global: **PROGRAM-A**.
Ejecutado del 2026-07-19 al 2026-07-20. Main al cierre: `cc1842c`.

Este documento es el índice del programa: qué se hizo en cada bloque, dónde vive el
detalle y qué quedó deliberadamente sin hacer. No repite el contenido de los documentos
por bloque; los enlaza.

## Método

Cada bloque siguió el mismo ciclo, sin excepciones: auditoría del estado real de `main`
→ diseño mínimo → rama y worktree propios desde main fresco → implementación → tests →
**mutaciones de no-vacuidad** → revisión de un **Supervisor independiente** (nunca el
mismo agente que implementó) → corrección de observaciones → PR con CI verde → merge sin
bypass administrativo → verificación de la CI de `main` posterior al merge.

Dos mecanismos hicieron el trabajo pesado de control de calidad:

**Mutaciones de no-vacuidad.** Antes de dar un test por bueno, se rompe a propósito el
código que debería proteger y se comprueba que el test falla. Un test que sigue verde con
la lógica rota no prueba nada. Este protocolo destapó dos defectos reales que habrían
pasado desapercibidos: en B4, que el "apagado por defecto" de la flag de espectador
público no estaba realmente verificado, y en B7, un test de expiración tautológico que se
corrigió antes del merge.

**Supervisor independiente.** Revisor que parte de cero, en su propio worktree, sin ver el
razonamiento del implementador, y que aplica sus propias mutaciones. Emitió
`SUPERVISOR-CONFORME` en cinco bloques, `CONFORME-CON-OBSERVACIONES` en tres (todas las
observaciones corregidas antes del merge) y ningún `NO-CONFORME`. En B9 se usó además un
**DESIGN-GATE**: revisión del diseño *antes* de escribir código, que evitó añadir un
método innecesario al motor al detectar que la API pública existente ya cubría el caso.

## Los nueve bloques

| # | Bloque | Dictamen | PR | Merge en main | Detalle |
|---|---|---|---|---|---|
| B1 | Tooling nightly | BLOCK-1-VERIFIED | [#57](https://github.com/pjclavero/s9-ai-arena/pull/57) | `32ef49f` | — |
| B2 | Consolidación documental | BLOCK-2-VERIFIED | [#58](https://github.com/pjclavero/s9-ai-arena/pull/58) | `b716aa4` | `ESTADO_ACTUAL.md` |
| B3 | R13.1 Runtime Inspector | R13.1-A | [#59](https://github.com/pjclavero/s9-ai-arena/pull/59) | `2a04c7c` | `R13_1_RUNTIME_INSPECTOR.md` |
| B4 | R11 Espectador público | R11-A | [#60](https://github.com/pjclavero/s9-ai-arena/pull/60) | `6f96d9e` | `R11_SPECTATOR.md` |
| B5 | R13.2 Hardening runtime/espectador | R13.2-A | [#61](https://github.com/pjclavero/s9-ai-arena/pull/61) | `20bbfdb` | `R13_2_HARDENING.md` |
| B6 | R12 Bracket de torneo | R12-A | [#62](https://github.com/pjclavero/s9-ai-arena/pull/62) | `65b3c33` | `R12_BRACKET_SLICE1.md` |
| B7 | R16 Visual upgrade | R16-A | [#63](https://github.com/pjclavero/s9-ai-arena/pull/63) | `fa5c14a` | `R16_VISUAL_SLICE1.md` |
| B8 | R14 WebRTC | **R14-ADR: no se implementa** | [#64](https://github.com/pjclavero/s9-ai-arena/pull/64) | `e14e3cc` | `R14_ADR_WEBRTC.md` |
| B9 | R13.5 Save/Sharding | R13.5-A | [#65](https://github.com/pjclavero/s9-ai-arena/pull/65) | `cc1842c` | `R13_5_SAVE_SHARDING.md` |

### Qué aportó cada bloque

**B1 · Tooling nightly.** Reparación de la suite lenta nocturna (venv de Python
multiplataforma) y reejecución en main para comprobar que el arreglo era real, no un
verde de rama.

**B2 · Consolidación documental.** Alineación de `ESTADO_ACTUAL.md` con lo realmente
desplegado, para que los bloques siguientes partieran de un mapa correcto.

**B3 · R13.1 Runtime Inspector.** Inspector HTTP de solo lectura (`--inspect`, apagado por
defecto, escuchando en 127.0.0.1) y `--speed`, que altera únicamente la cadencia de reloj
de pared: se verificó que el hash final de la batalla no cambia, es decir, que el tick
lógico y el determinismo quedan intactos.

**B4 · R11 Espectador público.** `GET /public/battles/live` y la página `#/live`, ambos
tras la flag `S9_PUBLIC_SPECTATE_ENABLED`, apagada por defecto y sin tocar la base de
datos cuando está apagada. Proyección explícita de campos públicos. Reutiliza el gateway
WebSocket ya existente: ningún transporte nuevo.

**B5 · R13.2 Hardening.** Cuota anónima en el endpoint público (cierra el TODO que dejó
B4), timeouts y límite de conexiones en el inspector con exposición remota solo por
opt-in explícito, y en el gateway WebSocket un tope de payload de 64 KiB y un máximo de
100 espectadores por batalla. Ese tope es el que después justifica la decisión de B8.
La etiqueta original del roadmap mencionaba métricas Prometheus: **no** se implementaron,
y así quedó anotado en vez de dar por hecho algo que no existe.

**B6 · R12 Bracket de torneo.** `GET /tournaments/{id}/matches` y la página de bracket,
estrictamente de solo lectura: ni un POST, ni un job, ni ejecución automática de batallas.
La ejecución real de torneos sigue gateada.

**B7 · R16 Visual upgrade.** Torretas por chasis, fogonazo y explosión animada, todo
procedural dentro del atlas existente: sin assets binarios, sin dependencias nuevas, sin
CDN y sin `Math.random` (el determinismo visual también importa cuando se reproduce un
replay).

**B8 · R14 WebRTC — resuelto por ADR, no implementado.** Ver más abajo.

**B9 · R13.5 Save/Sharding.** Checkpoint por resimulación determinista: guardar es la
cabecera del replay más los comandos hasta el tick N más el hash de estado en N;
restaurar es re-simular hasta N y verificar ese hash bit a bit, fallando con error
explícito si no coincide — nunca continuando en silencio. Sin serializar el mundo físico
y sin tocar el bucle de simulación.

## Las dos decisiones de no hacer

El programa produjo dos rechazos razonados. Son resultados de pleno derecho, no bloques
fallidos, y están documentados para que nadie los reabra por inercia.

**WebRTC (B8) no está justificado.** Al tope autorizado de 100 espectadores por batalla
—fijado precisamente en B5— el fan-out de snapshots JSON por WebSocket es trivial. El P2P
rompería la autoridad del servidor, porque un cliente podría reenviar frames manipulados a
otros. TURN/STUN exigiría puertos e infraestructura externa que las reglas del proyecto
prohíben. Y la señalización sería superficie de ataque nueva justo después de un bloque de
hardening. La alternativa aprobada es una escalera servidor-side sobre el gateway actual:
subir el tope medido, luego réplicas tras nginx particionadas por `battleId`, luego
throttling de snapshots, y SSE solo si hiciera falta. Reapertura condicionada a demanda
medida más autorización expresa de infraestructura.

**El sharding intra-batalla (B9) se rechaza.** El sharding real del proyecto ya existe y
es inter-batalla: cada batalla corre en su propio contenedor y se escala añadiendo
batallas en paralelo. Partir *una* batalla en workers rompería el orden secuencial del
tick y pondría en riesgo el hash canónico por orden de operaciones en coma flotante, sin
que exista ningún problema de rendimiento medido que lo justifique. Reapertura solo con
perfiles reales y una prueba de equivalencia de hash.

## Invariantes respetadas

Durante los nueve bloques no se tocó VM108 ni VM104, no se desplegó nada, no se abrieron
puertos ni se cambiaron dominios. No se introdujo `privileged: true`, `network_mode: host`
ni montaje de `/var/run/docker.sock`. No hubo `git push --force`, ni merges con CI roja,
ni bypass administrativo, ni tests falseados con skips o catches vacíos.

Las funcionalidades sensibles añadidas siguen **apagadas por defecto** y su activación es
decisión del operador, no del programa: `S9_PUBLIC_SPECTATE_ENABLED` (espectador público)
y `S9_ENABLE_REAL_BATTLE_RUNS` (ejecución real de batallas desde la UI).

El contrato de API quedó en **0.5.0 con 60 operaciones**. El motor de simulación no
cambió: los golden replays y los candados de regresión R13.0 siguen verdes sin regenerar
ni un solo hash.

## Qué queda pendiente

Ninguno de estos puntos bloquea nada; son continuaciones con diseño propio.

- **R10 slice 2**: persistencia backend del editor de mapas.
- **R11/R12**: estado público por batalla, `#/ranking`, matchmaking y prepare-battle. La
  ejecución automática real sigue gateada a validación en VM108.
- **R13.5 slice 2 (opcional)**: serialización nativa del mundo Rapier, condicionada a un
  spike que demuestre que `solverFingerprint()` se reproduce bit-exacto tras
  `restoreSnapshot()`. No se promete.
- **Latencia simulada**: pendiente, con la restricción de no alterar el tick lógico.
- **Métricas Prometheus**: slice independiente, nunca implementado pese a la etiqueta
  original de R13.2.
- **R16.3+**: fases visuales posteriores.
- **Evaluación de upgrade de Rapier**: sigue siendo rama de evaluación separada, sin merge.
