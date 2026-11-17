# Reglas de batalla, modos y desempates

> GENERADO desde el registro de reglas (`packages/game-rules/battle-rules.ts`) con `npx tsx scripts/generate-rules-doc.ts`. No editar a mano: `packages/game-rules/rules-doc.test.ts` falla si este fichero no coincide con el código. Versión del motor: **0.4.0**. Datos estructurados: [`rules.json`](rules.json).

## Reapariciones (`maxRespawns`)

maxRespawns es el número de veces que un bot puede REAPARECER después de morir. Vidas totales = maxRespawns + 1.

| `maxRespawns` | Vidas totales |
|---|---|
| 0 | 1 |
| 1 | 2 (vida inicial + 1) |
| 2 | 3 (vida inicial + 2) |

- sin reaparición: 1 vida
- limitada: maxRespawns entre 0 y 10
- ilimitada

### Munición al reaparecer (`rearmPolicy = all_alive_participants`)

- la munición (rondas de cañón y ametralladora, cargas de minas) es de cada vehículo y no hay reabastecimiento en la arena
- con reaparición (limitada o ilimitada): cada vez que un vehículo reaparece, él y TODOS los vehículos vivos de la batalla, de cualquier bando, vuelven a su munición máxima
- el rearme rellena hasta el máximo, nunca por encima: si reaparecen varios en el mismo instante se rearma una sola vez
- el rearme no repara módulos, no recarga energía ni reinicia la cadencia de disparo
- sin reaparición la munición es finita: si se agota, la batalla sigue hasta el tiempo máximo y se resuelve por el desempate del modo

## Desempates

Deterministas: sólo dependen del estado de la batalla en el último tick. Se aplican en orden; el primer criterio que distingue decide.

| Familia | Orden |
|---|---|
| Eliminación (sin reaparición) | 1. más bots vivos · 2. más vidas/reapariciones restantes · 3. más bajas · 4. empate |
| Respawn limitado | 1. más puntos · 2. más bots vivos · 3. más reapariciones restantes · 4. más bajas · 5. empate |
| Team Deathmatch / reaparición ilimitada | 1. más puntos · 2. más bajas · 3. empate |
| Capturar la bandera | 1. más capturas · 2. si empatan al acabar el tiempo: prórroga con el mismo estado (no se reinician bots, banderas ni posiciones) · 3. en la prórroga, la siguiente captura gana · 4. la prórroga no tiene límite de tiempo competitivo: dura hasta la siguiente captura |

La familia la decide el tipo de reaparición: sin reaparición ⇒ Eliminación; limitada ⇒ Respawn limitado; ilimitada ⇒ Team Deathmatch; y Capturar la bandera tiene su propia regla. Los presets y el personalizado usan la misma tabla. «Bajas» = vehículos ENEMIGOS destruidos (el fuego amigo y las muertes por zona de daño no cuentan).

## Capturar la bandera (base `ctf@1`)

- cada equipo tiene bandera y base
- tocar la bandera rival a distancia válida (2 m) la recoge
- el portador puede seguir combatiendo
- si el portador muere o lo descalifican, la bandera cae donde estaba
- un enemigo puede recoger una bandera caída; un compañero del equipo propietario puede devolverla tocándola
- una bandera caída que nadie toca vuelve sola a su base tras el retorno automático configurado
- llevar la bandera rival a la base propia puntúa una captura
- por defecto, la bandera propia debe estar en su base para puntuar
- al capturar, la bandera rival vuelve a su base
- si hay empate al acabar el tiempo: prórroga con el mismo estado (no se reinician bots, banderas ni posiciones); la siguiente captura gana; la prórroga no tiene límite de tiempo competitivo
- salvaguarda TÉCNICA (no es una regla de juego): si tras 20 minutos de prórroga nadie ha capturado, la batalla se detiene «por límite técnico» SIN resultado deportivo: no es empate, victoria ni derrota y no cuenta en V-D-E, clasificaciones ni Elo

## Presets oficiales

Versionados e inmutables: si cambia una regla se crea `id@(versión+1)`; la versión anterior no se edita. Las batallas y torneos guardan la versión con la que se crearon.

### Duelo · `duel@1`

Una vida. Sin reaparición.

- Formato: 1 contra 1
- Reaparición: Sin reaparición (1 vida)
- Victoria: eliminación
- Tiempo máximo: 5 min
- Desempate: más bots vivos → más vidas/reapariciones restantes → más bajas → empate

Gana el último bot operativo. Límite de 5 minutos; si se agota: gana el bot vivo; si siguen los dos, más bajas; si no, empate.

### Combate · `combat@1`

Reapariciones y límite de bajas.

- Formato: 1 contra 1
- Reaparición: Reaparición ilimitada
- Espera de reaparición: 5 s
- Victoria: 5 bajas
- Tiempo máximo: 10 min
- Desempate: más puntos → más bajas → empate

Reaparición ilimitada a los 5 s. Gana el primero en llegar a 5 bajas. Límite de seguridad de 10 minutos: más puntos, luego más bajas; si no, empate.

### Resistencia · `endurance@1`

Gana quien consiga más puntos antes de terminar el tiempo.

- Formato: 1 contra 1
- Reaparición: Reaparición ilimitada
- Espera de reaparición: 5 s
- Victoria: más puntos al acabar el tiempo
- Duración: 5 min
- Desempate: más puntos → más bajas → empate

5 minutos fijos con reaparición ilimitada a los 5 s. Al acabar: más puntos, luego más bajas; si no, empate.

### Eliminación por equipos · `team_elimination@1`

Sin reaparición. Pierde el equipo que se queda sin vehículos.

- Formato: 2v2 / 3v3 / 4v4
- Reaparición: Sin reaparición (1 vida)
- Victoria: eliminación
- Tiempo máximo: 8 min
- Fuego amigo: desactivado
- Desempate: más bots vivos → más vidas/reapariciones restantes → más bajas → empate

Cada bot tiene una sola vida. Gana el equipo que conserve algún vehículo operativo. Límite de 8 minutos: más bots vivos, luego más vidas restantes, luego más bajas; si no, empate.

### Respawn limitado · `team_limited_respawn@1`

2 reapariciones por bot (3 vidas). Gana el último equipo en pie.

- Formato: 2v2 / 3v3 / 4v4
- Reaparición: 2 reapariciones por bot (3 vidas en total)
- Espera de reaparición: 5 s
- Victoria: eliminación
- Tiempo máximo: 10 min
- Fuego amigo: desactivado
- Desempate: más puntos → más bots vivos → más reapariciones restantes → más bajas → empate

Cada bot puede reaparecer 2 veces (maxRespawns = 2: 3 vidas en total) a los 5 s. Gana el equipo que conserve vidas. Límite de 10 minutos: más puntos, luego más bots vivos, luego más reapariciones restantes, luego más bajas; si no, empate.

### Team Deathmatch · `team_deathmatch@1`

Reaparición ilimitada. Gana el primer equipo en llegar a 10 bajas.

- Formato: 2v2 / 3v3 / 4v4
- Reaparición: Reaparición ilimitada
- Espera de reaparición: 5 s
- Victoria: 10 bajas
- Tiempo máximo: 8 min
- Fuego amigo: desactivado
- Desempate: más puntos → más bajas → empate

Reaparición ilimitada a los 5 s; cada baja enemiga es un punto. Gana el primer equipo en llegar a 10. Límite de seguridad de 8 minutos: más puntos, luego más bajas; si no, empate.

### Resistencia por equipos · `team_endurance@1`

Tiempo fijo. Gana el equipo con más puntos al terminar.

- Formato: 2v2 / 3v3 / 4v4
- Reaparición: Reaparición ilimitada
- Espera de reaparición: 5 s
- Victoria: más puntos al acabar el tiempo
- Duración: 5 min
- Fuego amigo: desactivado
- Desempate: más puntos → más bajas → empate

5 minutos fijos con reaparición ilimitada a los 5 s. Al acabar: más puntos, luego más bajas; si no, empate.

### Capturar la bandera · `ctf@1`

3 capturas para ganar. Empate al tiempo ⇒ prórroga: la siguiente captura gana.

- Formato: 2v2 / 3v3 / 4v4
- Reaparición: Reaparición ilimitada
- Espera de reaparición: 5 s
- Victoria: 3 capturas
- Tiempo máximo: 5 min
- Retorno automático de la bandera: 10 s
- Bandera propia en base para puntuar: sí
- Prórroga: con el mismo estado, la siguiente captura gana (sin límite de tiempo competitivo)
- Fuego amigo: desactivado
- Desempate: más capturas → si empatan al acabar el tiempo: prórroga con el mismo estado (no se reinician bots, banderas ni posiciones) → en la prórroga, la siguiente captura gana → la prórroga no tiene límite de tiempo competitivo: dura hasta la siguiente captura

Cada equipo tiene bandera y base. Tocar la bandera rival la recoge; el portador puede seguir combatiendo; si muere, la bandera cae: un rival puede recogerla y un compañero del dueño devolverla; si nadie la toca vuelve sola a su base a los 10 s. Llevar la bandera rival a tu base puntúa si la tuya está en su base. Gana quien llegue a 3 capturas o tenga más al acabar los 5 minutos. Empate ⇒ prórroga con el mismo estado: la siguiente captura gana, sin límite de tiempo competitivo. Reaparición ilimitada a los 5 s; sin fuego amigo.

## Personalizado

Sólo parámetros competitivos:

- participantes: 1v1, 2v2, 3v3 o 4v4 (2 bandos de exactamente N bots)
- reaparición: ninguna, limitada (maxRespawns) o ilimitada
- espera de reaparición (segundos)
- tiempo máximo (minutos)
- objetivo: bajas para ganar o capturas para ganar (CTF)
- condición de victoria: eliminación, límite de bajas o más puntos al acabar el tiempo
- créditos máximos por bot y presupuesto total por equipo (reparto libre entre bots)
- masa máxima por bot y por equipo
- fuego amigo (sólo por equipos)
- CTF: capturas para ganar, retorno automático de la bandera y si se exige la bandera propia en base

No se pueden alterar: multiplicadores de daño, gravedad, velocidad, vida (HP), sensores, munición infinita ni parámetros físicos internos.

| Parámetro | Mínimo | Máximo |
|---|---|---|
| `teamSize` | 1 | 4 |
| `maxRespawns` | 0 | 10 |
| `delaySeconds` | 1 | 30 |
| `scoreLimit` | 1 | 100 |
| `captures` | 1 | 10 |
| `timeLimitMinutes` | 1 | 30 |
| `flagReturnSeconds` | 1 | 60 |
| `botCredits` | 200 | 5000 |
| `teamCredits` | 200 | 20000 |
| `botMassKg` | 500 | 10000 |
| `teamMassKg` | 500 | 40000 |

Presupuesto de equipo: el total se reparte como se quiera entre los bots. Ejemplo con 3500 cr: ATK-1 1000, ATK-2 1000, SCOUT 600, DEF 900. El tope por bot es opcional y no puede superar al del equipo. Coste = chasis + módulos; masa = la física del motor.

## Mapas compatibles por modo

| Modo | El mapa necesita |
|---|---|
| Deathmatch | al menos 2 spawns |
| Deathmatch por equipos | spawns de al menos 2 bandos |
| Capturar la bandera | base Y bandera de al menos 2 equipos; cada bando de la batalla debe tener las suyas (rojo/azul) |
| Control de zona | al menos una zona de captura |

Además, el autor del mapa debe declarar el modo. «Nueva batalla» sólo ofrece mapas compatibles y explica por qué los demás no aparecen.

## Directo de torneos (retardo anti-coaching)

En torneos, el directo para espectadores va con 30 s de retardo (anti-coaching), salvo las batallas marcadas como visibles (la final). Las batallas creadas con «Nueva batalla» van sin retardo. El retardo no cambia la simulación.

## Copia inmutable

Las reglas se copian de forma INMUTABLE en cada batalla y en cada torneo al crearlos. Cambiar después un preset (o crear su versión siguiente) no altera batallas ni torneos existentes.
