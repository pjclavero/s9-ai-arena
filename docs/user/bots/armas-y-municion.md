# Armas y munición

Las cifras de cada arma y de cada tipo de munición (daño, recarga, velocidad del proyectil, disparos…) están en el [Catálogo de equipamiento](../equipment-catalog.md#armas). Aquí, cómo se comportan cuando tu código ordena disparar.

## Cómo funciona un disparo

1. Ordenas `fire: ["turret_main"]` (la ranura de **tu** arma) y, normalmente, `turret` con el objetivo.
2. El motor comprueba, en este orden, que el arma esté operativa, que no esté en **recarga**, que haya **munición** y que haya **energía** para el disparo. Si falla alguna, la acción se rechaza (ver abajo) y el resto de tu orden sigue adelante.
3. Si todo va bien: se gasta **un disparo** de la munición y la energía de la acción, el arma empieza su recarga y sale un proyectil **hacia donde apunta la torreta en ese instante**, con una pequeña dispersión al azar.
4. El proyectil vuela a su velocidad y **choca con lo primero que encuentra**: un muro, una caja o un vehículo. Dura un tiempo limitado en vuelo, así que no llega al infinito.

Por eso lo importante es **apuntar bien antes de disparar**: la torreta gira despacio (rad/s según el arma) y un cañón tarda más que una ametralladora. Mira si `self.turretHeading` ya coincide con el ángulo al blanco antes de pedir fuego, o pide fuego igualmente y acepta que fallarás mientras gira.

## Daño

- El daño de un impacto es el **daño del arma × el multiplicador de la munición**, y baja si el arma está dañada.
- El **blindaje** del sector por el que entra el golpe lo reduce (un sector se decide por el ángulo del impacto respecto al morro: frontal, lateral o trasero). Nunca baja del 10 % del daño original, y el blindaje se desgasta con lo que absorbe.
- El daño que entra se reparte entre el casco (la mayor parte) y **un módulo** elegido al azar. Un módulo que pierde vida pasa por los estados `damaged`, `critical` y `destroyed`, y rinde cada vez menos ([La observación](observaciones.md#los-módulos-selfmodules)). Si el módulo destruido es tu arma, no podrás disparar; si es tu radar, te quedas ciego.
- La munición **explosiva** hace daño en un radio alrededor del impacto: cae con la distancia al centro y no atraviesa muros.
- **Fuego amigo**: si las reglas lo desactivan (lo normal en las batallas por equipos), tus proyectiles **atraviesan a tus compañeros** sin dañarlos. `welcome.rules.friendlyFire` lo dice.

## La munición

- La munición es un módulo que se monta junto al arma (ranura `ammo_main`). Cada tipo tiene un número de **disparos** y un multiplicador de daño distintos.
- Un arma sólo usa **munición compatible** (un cañón no dispara munición estándar, una ametralladora no dispara perforante). El editor de loadout lo valida al guardar.
- Cuántos disparos te quedan: `ammo` del módulo de munición en `self.modules`. Cuando llega a 0, tus disparos se rechazan con `no_ammo` y **no hay forma de recargar** dentro de la batalla; si reapareces, vuelves con la munición llena.
- Ahorra munición: dispara sólo cuando tengas un blanco, no en cada ciclo.

## Por qué se rechaza un disparo

Recibes un evento `rejected_action` con `slot` y `reason`. Los motivos de las armas son:

| `reason` | Qué pasa | Qué hacer |
|---|---|---|
| `cooldown` | El arma sigue recargando (`cooldownTicks` en `self.modules`). | Esperar; no es un error. |
| `no_ammo` | Sin munición compatible. | Cambiar de estrategia; no volverás a disparar. |
| `no_energy` | La reserva de energía no llega al coste del disparo. | Esperar a que se recargue, apagar módulos que no uses. |
| `module_destroyed` | El arma está destruida o apagada (o la ranura no es un arma). | Revisa el nombre de la ranura. |
| `critical_failure` | El arma está en estado `critical` y falló en este ciclo. | Insistir en el siguiente. |
| `out_of_arc` | La torreta no puede apuntar ahí. Hoy ninguna torreta tiene límite de arco. | — |

## La energía

Todos los módulos consumen energía pasiva cada segundo, y disparar o soltar una mina gasta además un poco por acción. Tu reserva sube con la generación y baja con el consumo (`self.energy.netFlowEUs` dice cuánto por segundo). Si el consumo supera a la generación durante mucho tiempo te quedarás sin energía para disparar. El editor de loadout avisa de un déficit de energía al guardar.

## Minas

La mina explosiva se suelta con [`deployMine`](comandos.md#minas-deploymine). Se arma tras un retardo, explota cuando un vehículo **enemigo** entra en su radio (cualquiera, si hay fuego amigo) y caduca pasado un tiempo. Tu sensor de proximidad ve las minas, también las tuyas. Cargas, daño y radios: [Minas](../equipment-catalog.md#minas).

Siguiente: [Radio](radio.md).
