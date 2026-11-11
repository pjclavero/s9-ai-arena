# Contratos compartidos del motor v2 (Engine hardening + Module Catalog v2)

## Resumen

Contrato mínimo que fija el Equipo 0 antes de la OLA 2 del roadmap de hardening del motor y del
catálogo modular v2. Define **forma, invariantes y propiedad** de Effect, Deployable, Trigger,
Interference, DamageType, Guidance, PublicEntityId y VisibilityEpoch; fija la frontera
`SIMULATION STATE → INTERNAL EXACT STATE → PROJECTION → VIEWER-SPECIFIC SANITIZED STATE` y el
punto del código donde vive; y reparte la propiedad de los ficheros críticos entre los equipos.

No implementa nada. Los tipos son declarativos y nadie los importa todavía:

- `packages/projection/contracts.ts`: ids, audiencia, relación, visibilidad, epoch, política de
  divulgación, clave de proyección, frontera y proyectores de daño y torreta.
- `packages/module-catalog/contracts/engine-v2.ts`: primitivas (DamageType y capa de daño,
  Interference, Effect, Trigger, Deployable, Guidance, sensores, acciones), esqueleto del tick,
  RNG y hash.

Base revisada: `origin/main` en `787fae9`, más los informes de investigación de los equipos A-E.
Sin compatibilidad hacia atrás (pre-release): se pueden romper replays, hashes, ids y fixtures
antiguos. Nunca usuarios, cuentas, configuración, secretos ni código de bots.

## Índice

- [1. Estado actual que condiciona el contrato](#1-estado-actual-que-condiciona-el-contrato)
- [2. La frontera](#2-la-frontera)
- [3. Identidad: PublicEntityId y espacios de ids](#3-identidad-publicentityid-y-espacios-de-ids)
- [4. Audiencia, VisibilityEpoch y clave de proyección](#4-audiencia-visibilityepoch-y-clave-de-proyección)
- [5. Política de divulgación](#5-política-de-divulgación)
- [6. DamageType y capa de daño](#6-damagetype-y-capa-de-daño)
- [7. Torreta](#7-torreta)
- [8. Effect](#8-effect)
- [9. Interference](#9-interference)
- [10. Trigger y Deployable](#10-trigger-y-deployable)
- [11. Guidance](#11-guidance)
- [12. Sensores, acciones y utility](#12-sensores-acciones-y-utility)
- [13. Esqueleto del tick, RNG, hash y replay](#13-esqueleto-del-tick-rng-hash-y-replay)
- [14. Protocolo arena/2](#14-protocolo-arena2)
- [15. Propiedad de ficheros y orden](#15-propiedad-de-ficheros-y-orden)
- [16. Decisiones tomadas y decisiones del propietario](#16-decisiones-tomadas-y-decisiones-del-propietario)
- [17. Cambios de contrato](#17-cambios-de-contrato)

## 1. Estado actual que condiciona el contrato

| Hecho (787fae9) | Dónde | Consecuencia para el contrato |
|---|---|---|
| Tres productores de salida leen la simulación directamente | `battle.ts` `publicSnapshot()` (l. 885), `sensors.ts` `buildObservation()` (l. 45), `battle.ts` `emit()` (l. 285) | No hay estado interno exacto separado: se crea (§2) |
| El directo y el replay público siguen caminos distintos | `apps/api/src/spectate/gateway.ts` `pump()` (l. 362) envía `battle.snapshots` tal cual; `apps/api/src/replay-projection.ts` `projectSnapshot()` (l. 144) sólo lo aplica el replay | Un único paquete de proyección (§2) |
| Proyectiles y minas comparten `entitySeq`; `fire()` consume id aunque no cree proyectil | `battle.ts` l. 175, 645, 673 | Los huecos de `proj_N` delatan minas ocultas (#261) |
| El radar y la radio entregan el id interno del vehículo | `sensors.ts` l. 145 y 200 | Espacio de ids propio del bot (§3) |
| La semilla es pública (commit-reveal y auditoría) | lectura de auditoría de la batalla | Ningún id ni ruido de proyección puede derivar de la semilla ni del RNG |
| Ticket de espectador sin audiencia firmada; broadcast usa el mismo feed que el espectador | API de tickets y gateway | Audiencia firmada (§4) |
| Respuestas públicas de replay con `immutable` | ruta de descarga pública | No invalidan ante cambio de política: dejan de ser `immutable` (§4) |
| Snapshot con `hullHp`/`hullHpMax`/`turretHeading` exactos y nombres de ranura; `hit_dealt` con daño efectivo exacto al atacante | `battle.ts` l. 895-910 y 850 | Estado público de daño y torreta (§6, §7) |
| Las zonas de daño restan casco fuera de `applyDamage` | `battle.ts` `resolveZoneDamage` | Puerta única con tipo `environmental` (§6) |
| El loadout es público según ADR-000 D9, PRE-1 lo quitó del replay público y las estadísticas siguen dando el `moduleId` de cada módulo | ADR-000, `replay-projection.ts`, `apps/replay-service/src/stats.ts` | Política de divulgación como dato (§5) |
| Hardcodes `ttlTicks: 90`, `detectable: true`, `MAX_MINES_PER_VEHICLE = 3` y defaults `??` | `combat.ts` l. 198, 258; `battle.ts` l. 51 | Pasan a datos de catálogo (§10, §11) |
| Un solo flujo de RNG, que también consumen las observaciones | `rng.ts`, `sensors.ts`, `battle.ts` `observationFor()` | Flujos con nombre (§13) |
| `stateHash()` no cubre todo el estado vivo; `verify()` no compara el resultado | `battle.ts` l. 929; `replay.ts` `verify()` | Hash por componentes y verify v2 (§13) |
| Eventos filtrados por lista negra de claves | `replay-projection.ts` `FORBIDDEN_PROJECTION_KEYS` | Lista blanca por tipo y campo (§2) |
| El catálogo importa la spec del motor | `packages/module-catalog/resolve/index.ts` importa `ModuleSpec` de `sim/vehicle.ts` | El motor sigue siendo dueño de `ModuleSpec`; los bloques nuevos viven en `contracts/engine-v2.ts` |
| `effect-status.ts` llama «effect» al estado de un campo | `packages/module-catalog/effect-status.ts` | Se renombra a `FieldStatus` (ACTIVE, VALIDATION_ONLY, FUTURE, REMOVE) |
| `packages/protocol/src/index.ts` son tipos legados sin relación con los esquemas | `packages/protocol/src/index.ts` | REMOVE o regenerar desde los esquemas (D) |

## 2. La frontera

```text
SIMULATION STATE          Battle (campos privados), Vehicle, PhysicsWorld, Rng. Mutable.
        ↓  captureInternalFrame()            ← ÚNICO lector de la simulación para salida
INTERNAL EXACT STATE      InternalFrame por tick: estado exacto con InternalEntityId,
                          eventos internos, lecturas de sensor, DamageRecord, pista de
                          torreta y metadatos de visibilidad. Inmutable. Nunca se publica.
        ↓  projectFrame(frame, ctx: ProjectionContext)   ← LA FRONTERA
PROJECTION                pura, determinista, sin E/S, sin RNG; llama a los proyectores
                          puros de B (daño, torreta) con el mismo contexto
        ↓
VIEWER-SPECIFIC SANITIZED SanitizedFrame<Body> con PublicEntityId (o BotEntityRef para el bot)
        ↓
bot · public_live · broadcast · public_replay · owner · team · staff
```

**Decisión: camino A2 (frame interno), no A1.** El motor deja de emitir un snapshot «público» y
emite `InternalFrame`; el paquete de proyección deriva cada audiencia. A1 (mapper sobre el
snapshot público existente) no sirve cuando unas audiencias ven entidades que otras no ven: no se
puede derivar una vista por audiencia desde una ya saneada. A2 encaja con el replay v2 del Equipo
D: el crudo es sólo la receta y los artefactos públicos se derivan en la ingesta re-simulando
(§13). A puede usar A1 como paso intermedio dentro de su rama, pero lo que se integra es A2.

**Punto exacto del código.**

- Entrada a la etapa interna: `captureInternalFrame()` en `apps/arena-engine/src/sim/`
  (fichero nuevo, Equipo A), llamado desde el paso 8 de `Battle.step()`. Es el único código que
  lee la simulación para producir salida.
- La frontera: `projectFrame()` en el paquete nuevo **`packages/projection/`** (Equipo A). Lo
  importan el motor (observación del bot), el gateway de espectador (que corre dentro del
  worker), la API de replays, el replay-service (ingesta) y el broadcast (vía gateway con ticket
  `broadcast`). Es puro: no importa la base de datos ni Express.
- La autorización (quién es el visor, `rawReplayAllowed`) se queda en la API; el paquete recibe
  el `ProjectionContext` ya construido.

Desaparecen como productores públicos: `Battle.publicSnapshot()`/`getPublicSnapshot()`;
`buildObservation()` se parte en percepción interna (C) y proyección para el bot (A); `emit()`
pasa a eventos internos proyectados por audiencia con lista blanca por tipo **y por campo**;
`apps/api/src/replay-projection.ts` deja de construir la proyección y delega en el paquete;
`gateway.ts` recibe `SanitizedFrame` por audiencia, nunca `battle.snapshots`.

**Invariantes de la frontera.**

- F1. Ningún `InternalEntityId` ni tipo interno aparece en un `SanitizedFrame`.
- F2. Todo consumidor externo acepta sólo `SanitizedFrame` (el tipo lleva marca).
- F3. La proyección no consume RNG de simulación ni muta estado: proyectar 0 o N veces no cambia
  `finalStateHash`.
- F4. Lista blanca: un campo o un tipo de evento nuevo no sale hasta que la política lo declara.
- F5. `raw` no es una audiencia de proyección; el crudo nunca es la base de una respuesta
  pública.
- F6. La salida depende de audiencia, entidad observada, relación, perfil, políticas,
  visibilidad y epoch; nada de eso viene del cliente.
- F7. Los proyectores de B (`ProjectDamageForViewer`, `ProjectTurret`) reciben vistas de sólo
  lectura (`InternalDamageView`, `PublicTurretTrack`), nunca `Vehicle`.

## 3. Identidad: PublicEntityId y espacios de ids

| Espacio | Quién lo ve | ¿Es simulación? | Asignación |
|---|---|---|---|
| `InternalEntityId` | motor y proyección | sí | `spawn(kind)` con `seq` de un contador único (§13); puede ser secuencial |
| `BotEntityRef` (arena/2) | el bot | **sí** (hash) | `own`: `<prefijo>_<n>` por propietario; `roster`: mapper `bot_team:<team>`, estable toda la batalla; `contact`: `c_<n>` por observador, nuevo en cada adquisición, con caducidad |
| `PublicEntityId` de proyección | resto de audiencias | **no** | denso por prefijo, en orden de primera visibilidad para esa audiencia |

Hay dos espacios visibles porque el bot manda comandos que referencian entidades (`radio.to`,
`detonate`, blanco de guidance) y el replay los graba tal cual: esa resolución tiene que ser
función del estado de simulación. Los ids de espectador, en cambio, no pueden influir en la
simulación (F3) ni usarse en un comando.

**Mapper de proyección** (`PublicIdMapper` en `packages/projection/contracts.ts`):

- Una instancia por (battleId, AudienceKey); nunca compartida (M3). Lleva un `mappingId` opaco
  que viaja con cada frame para que el cliente detecte el cambio de audiencia.
- Sin secreto y **sin derivar de la semilla** (que es pública). Densidad por primera visibilidad:
  la secuencia sólo contiene lo que la audiencia ya ve, así que no hay huecos que revelen
  entidades ocultas.
- Empates en un mismo frame por clave pública (prefijo, x, y cuantizadas, id público del dueño
  si lo es), nunca por orden interno.
- Vehículos `v_1..v_n` por el orden público de la nómina, no por id interno.
- Ids de mapa (muros, destructibles, bases, zonas del mapa) pasan por lista blanca explícita.
- Nuevo episodio de visibilidad ⇒ id nuevo, salvo `identityContinuity` en la política.
- Replay público: mapping calculado una vez sobre todo el stream desde el tick 0; cualquier
  segmento usa los mismos ids que el documento completo.

**Invariantes.** I1 ningún id interno sale (M1). I2 el prefijo es la clase pública (`v`, `p`,
`d`, `z`, `c`), nunca un subtipo de catálogo (`mine_`, `emp_`, `smoke_` prohibidos). I3 lo que una
audiencia no ve no consume número. I4 estabilidad mientras dura el episodio (el visor interpola
por id). I5 un `contact` caducado, ajeno o inventado en un comando ⇒ `rejected_action`. I6 los
contadores `own` y `contact` entran en el hash; los de proyección no. I7 todo id cabe en
`common.schema.json#/$defs/entityId` sin cambiar el patrón.

**Propiedad.** A (mapper, `BotEntityRef`, tabla de contactos); D (contadores en el hash, esquema);
C (usa `BotEntityRef` en `detonate` y guidance).

## 4. Audiencia, VisibilityEpoch y clave de proyección

**Audiencia** (`AudienceClass`, cerrada): `bot_team`, `public_live`, `broadcast`,
`public_replay`, `owner`, `team`, `staff` y `raw` (sólo para distinguir en claves). `AudienceKey`
añade el detalle mínimo (`owner:<userId>`, `team:<teamId>`, `bot_team:<team>`); es interna y no
sale al cliente. `public_live` y `broadcast` se separan aunque hoy proyecten lo mismo.

**Relación** (`ViewerRelation`): `self`, `owner`, `team`, `enemy`, `none`. Se recalcula en el
backend en cada petición o conexión desde `participants` y la autenticación.

**Ticket de espectador v2** (`SpectateTicketClaimsV2`): la audiencia va **firmada** en `aud`
(`public_live`, `broadcast` o `staff`); el gateway separa feeds, mapper e historial del retardo
por audiencia; un ticket sin `aud` se rechaza. El historial guarda mensajes ya proyectados.

**VisibilityEpoch.** `VisibilityLevel` = `hidden` | `detected` | `revealed`. El epoch es el
número de episodio de (entidad, audiencia), forma canónica `hidden` | `visible#k`; sube en cada
cambio de nivel o de componentes revelados (p. ej. clase de arma tras disparar) y nunca baja.
Es función determinista del stream de frames internos, pero **no es simulación**: no entra en el
hash, no consume RNG y no influye en el resultado. Quién lo produce: el paquete de proyección,
a partir de los metadatos de visibilidad del frame interno (que salen de
`DeployableVisibilityDef`, sensores y política del ruleset).

**Clave de proyección** (`ProjectionKey`), construida por **una sola función**,
`buildProjectionKey()` en `packages/projection/` (A), que también usa B:
`battleId, audience, observed, relation, resolvedProfile, spectatorPolicy, disclosurePolicy,
visibilityEpochDigest, projectionVersion, renderTarget`. Regla: una proyección (frame, nómina,
composición o mapping) no sobrevive a una transición que cambie lo que la audiencia puede
observar.

| Transición | Cambia en la clave | Efecto |
|---|---|---|
| hidden → revealed | epoch | entrada nueva; id nuevo |
| revealed → hidden | epoch | la entidad desaparece; el id no se recicla |
| visor A → B | audience, relation | otro mapper y otro `mappingId` |
| owner → anonymous | audience, relation, profile | nada privilegiado se reutiliza |
| team → outsider | relation, audience | igual |
| spectator → broadcast | audience | feeds e historial separados |
| raw → public replay | audience | la proyección parte del frame interno |
| cambio de política | `spectatorPolicy`, `disclosurePolicy` | entradas nuevas |

**HTTP** (`ProjectedHttpCachePolicy`): las respuestas públicas proyectadas dejan de ser
`immutable`; su `ETag` (o la URL) incluye `projectionVersion` y las dos versiones de política.

Mutantes que E debe matar: M1 public id = internal id; M2 sin epoch en la clave; M3 mapping de A
reutilizado en B; M4 pre-reveal servido tras el reveal; M5 sin entidad/bot observado; M6 sin
relación.

**Propiedad.** A.

## 5. Política de divulgación

`DisclosurePolicy` es un **dato** versionado: mapa `campo canónico → audiencia → nivel`, con
`FieldVisibility` = `PUBLIC` | `SANITIZED` | `PRIVATE` | `ACCEPTED_RESIDUAL`. Lista blanca: un
campo sin entrada no sale. Un campo `PRIVATE` que cambie el flujo público es un error de la
política, y lo detecta un test diferencial (mismo combate con el campo privado alterado ⇒ mismo
flujo público).

El régimen es parte del dato (`DisclosureRegime`):

- **R1**: ADR-000 D9 vigente. Loadout público en competición; se protege sólo el estado dinámico
  exacto (hp, absorción, rotura, torreta exacta).
- **R2**: equipamiento privado. Además se sanean loadout, nómina (chasis) y estadísticas
  post-batalla (`perModule.moduleId`).

**La elección R1/R2 es la decisión D-B1 del propietario y sigue abierta.** La implementación no
depende de ella: B diseña para R2 (superconjunto) y la política la hace configurable. Los
residuales inherentes (masa → velocidad, impactos hasta matar, velocidad de proyectil, cadencia)
se declaran `ACCEPTED_RESIDUAL`, no se esconden.

**Propiedad.** A la estructura y su aplicación; B las filas de daño y torreta; el régimen, el
propietario.

## 6. DamageType y capa de daño

Tipos en `engine-v2.ts`: `DamageTypeId`, `DamageTypeProfile`, `ArmorProfile`, `DamagePacket`,
`DamageRecord`, `ResolveDamage`. En `packages/projection/contracts.ts`: `InternalDamageView`,
`PublicDamageState`, `ImpactClass`, `ProjectDamageForViewer`.

```text
Effect damage/explosion (C) · zona del mapa · deployable
  → DamagePacket{amount, type, penetration, from, owner|null, sourceKind, seq}
  → resolveDamage(packet, target, profiles)          (B, única puerta, flujo RNG combat)
  → DamageRecord (INTERNAL, exacto)  → muta el estado, va al damageLog derivado
  → projectDamageForViewer(view, ctx) → PUBLIC_DAMAGE_STATE por visor {alive, hullLevel, …}
```

- **Tipos de daño**: registro de datos con perfiles `kinetic`, `explosive`, `thermal`,
  `electronic` y `environmental` en `packages/game-rules` (B). Añadir uno es una fila de datos.
  `thermal` y `electronic` no tienen contenido: sólo perfiles y fixtures.
- **Fórmula** (determinista, monótona, acotada): sector si `usesSector`; `rBase` de
  `ArmorProfile.resist[type] ?? resist.default` si `armorApplies` y el sector tiene hp
  (`degradation: linear` lo escala por hp restante); `reduction = clamp(rBase − penetration, 0,
  R_MAX)`; `effective = max(minFraction·amount, amount·(1 − reduction))`; desgaste
  `absorbed·armorWearFactor`; reparto `hullShare`/`moduleShare`; un `weighted` sobre candidatos
  ordenados por slot. Muerte y `onKill` en un solo sitio.
- **Equivalencia**: `armor.reduction → resist.default`, munición sin tipo → `kinetic` con
  penetración 0, zonas → `environmental` con `armorApplies: false` y `moduleShare: 0`. Con esos
  perfiles se reproduce el combate actual (test de caracterización contra el golden de combate).
- **Daño base**: vive en el catálogo de weapon/ammo (`weapon.damage`, `ammo.damageMultiplier`);
  `resolveVehicle()` lo materializa en `ProjectileDef.onImpact` como efectos `damage` con su tipo.
  El motor nunca lee `weapon.damage`.
- **Effect → paquete**: el handler de `damage` emite un paquete al blanco directo; el de
  `explosion` uno por vehículo en el radio (falloff y línea de visión); `penetration` suma su
  `strength` a los paquetes de los efectos de daño hermanos de la misma lista.
- **Blindaje**: fuente única; el módulo de blindaje es el sector (desaparece la doble
  representación de `vehicle.ts`).
- **Eventos**: `hit_taken` sigue exacto para `self`; `hit_dealt.damage` se sustituye por
  `hit_dealt.impact` (`ImpactClass`: `hit` | `critical` | `kill`); las zonas no emiten
  `hit_dealt`.
- **damageLog**: no se guarda en el crudo (es derivable re-simulando); se produce en la ingesta
  como artefacto derivado restringido y alimenta las estadísticas, que se proyectan por
  audiencia según la política.
- **Prohibido** `if (type === …)` y `if (moduleId === …)`: sólo tablas con `safeLookup`/`emptyDict`.

**Propiedad.** B (perfiles, `resolveDamage`, proyector de daño, estadísticas); C (bloque `armor`
del esquema, materialización en `resolveVehicle()`, handlers que emiten paquetes); D
(`hit_dealt.impact` en el protocolo, damageLog derivado).

## 7. Torreta

La simulación sigue exacta, normaliza el ángulo a (−π, π] y **limita el giro al arco** (hoy sólo
se comprueba al disparar). Lo público es `PublicTurretState`, que calcula `ProjectTurret` desde
una `PublicTurretTrack` que produce el motor una vez por tick (estado derivado, fuera del hash,
igual en todas las audiencias). La forma de la pista depende de D-B2:

- **M (montura)**: `TurretMountDef` en la ranura del chasis, pública; `weapon.turretRateRads` y
  `weapon.turretArcRad` pasan a REMOVE. Nada que ocultar.
- **E (envolvente)**: la tasa sigue en el arma y la pista pública es una envolvente con
  corrección al disparar; residual declarado.

Test común: la cinemática pública de la torreta es función sólo de datos `PUBLIC`.

**Propiedad.** B (pista, proyector, regla de arco); C (`TurretMountDef` en el esquema de chasis).

## 8. Effect

Tipo: `EffectDef` (unión discriminada por `primitive`), `ActiveEffectState`, `Stacking`,
`TargetFilter`, `Falloff`.

Campos comunes: `primitive`, `strength`, `radiusM`, `durationTicks`, `falloff` (obligatorio si
hay radio), `targets` (relación, clase de entidad, línea de visión), `stacking` (`none` |
`replace` | `max` | `add`), `stackKey`, `maxStacks`. Propios: `damageType`, `profile`, `repairs`,
`stat`, `channels`. Primitivas: `damage`, `explosion`, `penetration`, `interference`, `repair`,
`statusModifier`, `sensorModifier`, `communicationModifier`. Una acción, munición o deployable
lleva una lista ordenada de efectos.

- E1. Despacho por registro `Record<EffectPrimitive, handler>` creado con `emptyDict()`; jamás por
  `moduleId`, arma o munición.
- E2. Primitiva desconocida o campo no consumido = error al validar o resolver (fail-closed).
- E3. Los efectos se encolan con `EffectOrderKey` y se aplican en la fase 5e en ese orden total.
- E4. Un efecto persistente es `ActiveEffectState` y entra completo en el hash.
- E5. `targets` se evalúa contra el estado de batalla, nunca contra el comando; el ruleset puede
  restringir, nunca ampliar.
- E6. Un módulo destruido u offline no emite efectos nuevos.
- E7. `repair` nunca resucita un módulo destruido.

**Propiedad.** C (registro, cola, primitivas no de daño); B (handlers de daño, vía §6).

## 9. Interference

Tipos: `InterferenceChannel`, `ChannelModifier`, `InterferenceProfile`, `InterferenceZoneState`,
`InterferenceQuery`, `InterferenceSample`. Canales: `lidar`, `radar`, `proximity`, `acoustic`,
`radio`, `optical`. Humo y jammer son **datos** del perfil, no motores separados.

- N1. Consulta única `interferenceAt(query)` para sensores, radio y guidance.
- N2. Combinación `1 − Π(1 − sᵢ·fᵢ)`, conmutativa, evaluada en orden de `seq` y cuantizada.
- N3. Un canal sin consumidor registrado (`optical` hoy) lo rechaza el validador
  (AVAILABLE_PRIMITIVE_WITHOUT_CONTENT, no un campo silencioso).
- N4. Interferencia en un canal no afecta a otro (mutante de E).
- N5. Las zonas son estado de simulación (hash); su visibilidad la decide la proyección.
- N6. Interferir la radio exige cablear su alcance (hoy no se usa): cambio de comportamiento a
  aprobar (§16).

**Propiedad.** C.

## 10. Trigger y Deployable

Tipos: `TriggerDef` (`proximity`, `contact`, `timer`, `remote`, `event`), `DeployableDef`,
`DeployableVisibilityDef`, `Signature`, `DeployableState`, `DeployableLifecycle`.

La mina es un `DeployableDef` de un módulo `mine`: `maxActivePerOwner` sustituye a
`MAX_MINES_PER_VEHICLE`; `visibility.signature` a `Mine.detectable = true`; el trigger
`proximity` a `triggerRadiusM`; la explosión pasa a `effects`.

- T1. Ningún trigger se evalúa antes de `armedAtTick`; `timer` cuenta desde el armado.
- T2. Orden: deployables por `seq`; candidatos por `seq`.
- T3. **Owner**: el vehículo que lo creó, del estado de batalla; `remote` sólo lo acciona el
  dueño con su `BotEntityRef own`; `ownership.friendlyTrigger` (`inherit` = ruleset) es dato.
- T4. Disparo idempotente dentro del tick; `consumeOnTrigger` decide si se consume.
- T5. Todos los campos de `DeployableState` entran en el hash.
- T6. **Visibility**: el dueño siempre `revealed`; aliados, enemigos y espectador según
  `DeployableVisibilityDef`; un sensor detecta si su canal tiene firma > 0. El motor publica estos
  metadatos en el frame interno; la proyección fija el epoch.
- T7. Id interno propio por `spawn()`, separado del de proyectil; eventos con prefijo `d`, nunca
  el subtipo.

**Propiedad.** C (con A para T6).

## 11. Guidance

Tipos: `GuidanceDef` (`none`, `target`, `waypoint`), `LockRequirements`, `GuidanceState`,
`ProjectileDef`, `ProjectileState`.

- G1. `ProjectileDef.lifetimeTicks` sustituye a `ttlTicks: 90`; lo resuelve `resolveVehicle()`.
- G2. Blanco desde un `BotEntityRef` del tirador o por adquisición en `acquisitionRangeM`, en orden
  de `seq`, desempate por distancia cuantizada y `seq`.
- G3. `trackingErrorRad` del flujo `guidance` (o ruido sin estado por entidad y tick);
  `Math.random` prohibido.
- G4. El lock depende del canal de `lockRequirements` y la interferencia lo puede romper.
- G5. El estado de guiado entra en el hash del proyectil.
- G6. Sólo fixtures; ningún misil de contenido.

**Propiedad.** C (con D para hash y RNG).

## 12. Sensores, acciones y utility

- Sensores: `SensorPrimitiveKind` es el registro de primitivas; `SensorVariantDef` son sólo
  parámetros. Primitiva nueva = entrada de registro + canal + rama de esquema; variantes =
  catálogo. Salida `SensorContactInternal` con ids internos; la observación es su proyección. Un
  sensor sólo lee si su módulo no está destruido ni offline.
- Acciones: `ActionDef` (`fire`, `deploy`, `activate`, `trigger`) con coste, cooldown y producto
  (`projectile`, `deployable` o `effects`), y una única validación de activación para arma, mina y
  utility.
- Utility: deja `effect/magnitude/durationTicks` y declara `actions`. Drone deployer = FUTURE.
- Campos: `FieldStatus` sustituye a `EffectStatus`; FUTURE en un módulo lo rechaza el validador;
  REMOVE se borra del esquema.
- WELCOME: `specs` se proyecta (audiencia `bot_team`, relación `self`/`team`): sólo campos de
  catálogo ACTIVE o VALIDATION_ONLY de módulos propios o aliados, nunca valores internos derivados.
- Fixtures: id `test.fixture_<nombre>` (cabe en el patrón actual), en
  `packages/module-catalog/test-fixtures/`, fuera de `loadCatalog()`.

**Propiedad.** C; A la proyección de la observación y del WELCOME.

## 13. Esqueleto del tick, RNG, hash y replay

**Fases del paso 5** (`CombatPhase`): `5a_actions`, `5b_triggers`, `5c_guidance`,
`5d_projectiles`, `5e_effects`, `5f_expirations`, `5g_ambient`. Cada fase recorre por `seq` y
encola; sólo 5e aplica. Cascadas en el mismo tick con `CascadeLimits` (rebasar = descartar y
contar). Visibilidad y proyección van después del paso 8 y no son simulación.

**`spawn()` único** (`EntityAllocatorState`): toda entidad nace con `seq` de un contador de
simulación en el hash, junto con los contadores `own` y `contact` del bot. Sustituye a
`entitySeq` y a `proj_${seq}`/`mine_${seq}`; no se consume id si no se crea la entidad.

**RNG**: flujos `combat`, `sensors`, `effects`, `guidance`, `latency`, derivados por etiqueta sin
consumir del padre, todos en el hash. El número de tiradas no depende de parámetros de catálogo.
`observationFor()` fuera del bucle y la proyección reciben un RNG de sólo lectura que falla si se
consume.

**Hash por componentes** (`StateHashComponent`): `stateHash` = sha256 de los hashes de
componente. Cubre todo el estado vivo que determina el futuro, incluido lo que hoy queda fuera
(`lastMove`, `lastTurretTarget`, timeouts, `respawnAtTick`, contadores de radio,
`reactivateAtTick`, `pendingLatencyCommands`, `radioQueue`, `teamKills`, estado interno de modos)
y lo nuevo (deployables, efectos, cola, zonas, guidance, contadores del bot). Nada de proyección.

**Replay v2**: `formatVersion: 2`; se rechazan otras versiones. El crudo es receta e integridad:
cabecera con catálogo y su digest, runtime, cadencias, flujos RNG y esquema de ids; comandos;
hashes; resultado. Los artefactos públicos (`public_replay`, `broadcast`) se derivan una vez en
la ingesta con `projectFrame` y llevan `derivedFrom`. `verify()` v2 compara también `winner`,
`endReason`, `score`, `disqualified` y versiones, y rechaza con motivo explícito si cambian motor,
catálogo o runtime.

Garantía: misma versión de motor + mismo catálogo + misma semilla + mismos comandos = mismo
resultado, mismo hash y mismos artefactos públicos byte a byte.

**Propiedad.** D; A, B y C insertan su lógica en su fase.

## 14. Protocolo arena/2

`arena/1` → `arena/2`, sin compatibilidad:

- Comandos: `fire: [{slot, aim?}]` con `aim` = `{point}` | `{target}` | `{waypoints}`;
  `deployMine` → `deploy {slot, armDelayTicks?, offset?}`; `detonate {ids}` (sólo ids `own`);
  `utility` → `activate {slot, action?, target?}`. Todo `entityId` de un comando es del espacio
  del bot.
- Eventos: `deployable_deployed` (dueño), `deployable_triggered` (posición, prefijo `d`),
  `deployable_expired` (dueño), `effect_received` (afectado, clase de primitiva, sin fuente salvo
  que la perciba), `zone_appeared`/`zone_ended` (según visibilidad), `hit_dealt.impact`; `mine_*`
  desaparece. Lista blanca por campo.
- Observación: contactos con `BotEntityRef`; `self` exacto. WELCOME según §12.
- `packages/protocol/src/index.ts`: REMOVE o regenerado desde los esquemas.

**Propiedad.** D escribe esquemas y ejemplos; A y C piden los cambios.

## 15. Propiedad de ficheros y orden

Regla: cada fichero crítico tiene **un** dueño en cada momento. Si dos equipos lo necesitan, el
segundo espera a que se integre el PR del primero y rebasa; los demás piden el cambio al dueño.
Las pruebas pesadas van en serie.

| Fichero | Dueño | Otros (orden) |
|---|---|---|
| `packages/projection/contracts.ts`, `packages/module-catalog/contracts/engine-v2.ts`, este documento | 0 | cambios sólo por §17 |
| `packages/projection/*` (paquete nuevo: audiencia, mapper, `buildProjectionKey`, `projectFrame`) | A | **A → B** (B añade `damage.ts`/`turret.ts` puros y filas de política) |
| `apps/arena-engine/src/sim/battle.ts` | D (esqueleto) | **D → A → B → C** (abajo) |
| `apps/arena-engine/src/sim/internal-frame.ts` (nuevo, `captureInternalFrame`) | A | B y C añaden sus campos tras A |
| `apps/arena-engine/src/sim/combat.ts` | B | **B → C** |
| `apps/arena-engine/src/sim/damage.ts` (nuevo, `resolveDamage`) | B | — |
| `apps/arena-engine/src/sim/vehicle.ts` | C | **C → B** (C forma de la spec; B blindaje único y torreta) |
| `apps/arena-engine/src/sim/sensors.ts` | A | **A → C** |
| `apps/arena-engine/src/sim/{effects,interference,deployables,guidance}.ts` (nuevos) | C | B sólo los handlers de daño en `effects.ts`, tras C |
| `apps/arena-engine/src/rng.ts`, `replay.ts`, `checkpoint.ts`, `engine-deps.json`, `engine-compat.ts` | D | — |
| `apps/arena-engine/src/protocol-server.ts` | A | **A → D** |
| `apps/arena-engine/src/fixtures.ts` | C | D y E regeneran golden después |
| `apps/arena-engine/src/inspector.ts` | A | — |
| `packages/module-catalog/{types.ts, schema/*, validator/*, resolve/*, effect-status.ts, equipment-doc.ts, loadCatalog.ts, data/*, test-fixtures/*}` | C | B pide `armor` y `TurretMountDef` a C |
| `packages/game-rules/constants.ts` y tabla de perfiles de daño (nueva) | B | C pide constantes a B |
| `packages/protocol/schemas/*`, `examples/*`, `src/index.ts` | D | A y C piden |
| `apps/api/src/replay-projection.ts` | A | **A → D** |
| `apps/api/src/spectate/gateway.ts`, `apps/api/src/auth/tokens.ts` (`aud`), ticket de espectador | A | — |
| `apps/api/src/routes/battles.ts` | A (caché HTTP, tickets) | **A → B** (B saneado de stats) |
| `apps/api/src/routes/replays.ts`, `apps/replay-service/src/*` salvo `stats.ts` | D | **D → A** (ruta de proyección) |
| `apps/replay-service/src/stats.ts` | B | tras D (damageLog derivado) |
| `apps/tournament-worker/src/engine-executor.ts` (`attachBattle`) | A | D si cambia el replay |
| `apps/web/src/viewer/*`, broadcast (sólo adaptar al cuerpo nuevo, sin Visual FASE 1) | A | B para daño y torreta |
| Tests de caracterización y mutantes (`*/baseline/*`, runner) | E | cada equipo invierte sus `LEAK_BASELINE` en su PR |
| Tests unitarios de cada módulo | dueño del módulo | E revisa |
| `docs/technical/engine.md` | 0 | al cierre |
| `docs/technical/equipment.md`, `docs/user/equipment*.md` | C | al cierre |
| `docs/technical/replays.md` | D | al cierre |
| `docs/technical/security.md` | A | al cierre |

**Orden en `battle.ts`.**

1. **D**: esqueleto sin lógica nueva: fases 5a-5g llamando a lo existente, `spawn()` único,
   flujos RNG, hash por componentes. Cambia hashes (permitido); no cambia daño, orden de eventos
   ni resultados observables (lo vigilan los tests de caracterización de E).
2. **A**: `captureInternalFrame()` en el paso 8, eventos internos en lugar de `emit()`, retirada de
   `publicSnapshot()`.
3. **B**: `damageVehicle` sobre `DamagePacket`/`resolveDamage`, zonas por la puerta única, regla de
   arco y pista de torreta.
4. **C**: deployables en lugar de `mines`/`resolveMines`, cola de efectos en 5e, guidance en 5c,
   acciones en 5a.

Cada uno limita su diff en `battle.ts` a insertar llamadas a su módulo; la lógica vive en sus
ficheros.

**Rama base.** `hardening/e-baseline` (tests `LEAK_BASELINE`) y `hardening/contracts` son la base
común de A-D. Lo limpio es integrarlas en `main` antes de abrir las ramas de OLA 2; sin esa
autorización, cada rama de OLA 2 sale de `hardening/e-baseline` y se rebasa sobre los contratos
cuando se integren.

## 16. Decisiones tomadas y decisiones del propietario

**Tomadas por este contrato** (cerradas salvo objeción del propietario):

| Pregunta | Decisión |
|---|---|
| A1 o A2 | A2: el motor emite `InternalFrame` (§2) |
| Paquete de proyección | `packages/projection/`, único, puro (§2) |
| Ids públicos | densos por primera visibilidad por audiencia, sin secreto ni semilla (§3) |
| Ids del bot | espacio propio `own`/`roster`/`contact`, en el hash (§3) |
| Audiencias | cerradas: `bot_team`, `public_live`, `broadcast`, `public_replay`, `owner`, `team`, `staff`, `raw` (§4) |
| Ticket WS | `aud` firmada (§4) |
| Clave de proyección | constructor único `buildProjectionKey()`, compartido con B (§4) |
| HTTP público | sin `immutable`; ETag versionado (§4) |
| `arena/1` → `arena/2` | sí (§14) |
| Esqueleto del paso 5 y `spawn()` | fijado aquí; D lo implementa primero (§13, §15) |
| WELCOME `specs` | proyección de campos de catálogo ACTIVE/VALIDATION_ONLY propios y aliados (§12) |
| Daño base | en weapon/ammo; `resolveVehicle()` lo materializa en efectos con tipo (§6) |
| Tipos de daño | registro de datos con `environmental`; zonas por la puerta única (§6) |
| `hit_dealt` | `impact` en vez de `damage` (§6) |
| damageLog | derivado en la ingesta, restringido; no en el crudo (§6) |
| Comandos y eventos | `fire[{slot,aim}]`, `deploy`, `detonate`, `activate`, `deployable_*`, `effect_received`, `zone_*` (§14) |
| Fixtures | `test.fixture_<nombre>` en `test-fixtures/` (§12) |
| `packages/protocol/src/index.ts` | REMOVE o regenerar (D) |
| `verify()` | compara resultado y versiones (§13) |
| Eventos | lista blanca por tipo y campo (§2) |

**Para el propietario** (no las decide un equipo):

- **D-B1 DISCLOSURE_REGIME (bloquea el contenido de la política, no la implementación).** R1 =
  ADR-000 D9 vigente (loadout público) o R2 = equipamiento privado (enmendar D9 y sanear
  estadísticas y nómina). El contrato lo deja como dato (§5).
- **D-B2 Torreta**: M (montura pública, recomendada por B), E (envolvente) o exacto publicado.
- **D-B3** Variación de daño por impacto para emborronar «impactos hasta matar» (regla de juego).
- **D-B4** Rotura del blindaje: privada o visual pública; degradación `binary` o `linear`.
- **D-B5** Granularidad de `hullLevel` (N = 10 o 20).
- **D-B6** HE: doble daño (directo + explosión) o sólo explosión.
- **P-1** Ids de vehículo por audiencia: el contrato usa `v_k` por nómina pública, igual en todas
  las audiencias. Ocultar quién es quién exigiría ids por audiencia también para vehículos.
- **P-2** Cambios de comportamiento de C: alcance de radio activo, `weapon.rangeM` como alcance,
  `terrain` REMOVE o FUTURE.
- **P-3** Merge de `hardening/contracts` y `hardening/e-baseline` antes de la OLA 2.

## 17. Cambios de contrato

Los ficheros de contratos y este documento sólo los cambia el Equipo 0. Un equipo que necesite
otra forma abre la petición con: tipo afectado, motivo, equipos consumidores y mutante o test que
lo cubre. Mientras no se acepte, se implementa contra el contrato vigente. Ningún equipo cambia
una interfaz compartida (esquemas de protocolo, `ModuleSpec`, `SanitizedFrame`, formato de
replay, `ProjectionKey`) fuera de su turno de la tabla de §15.
