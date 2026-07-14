# Bots de ejemplo oficiales (JavaScript/TypeScript): Artillero y Minador

Dos de los cuatro bots oficiales de S9 AI Arena (los otros dos, Explorador y
Defensor, están en [`example-bots/python/`](../python/)). Ambos usan
[`@arena/sdk`](../../sdks/javascript/) y el catálogo real de E3.

## Artillero (`gunner.ts`)

**Estrategia, en un párrafo.** Mantiene distancia media (35 m, dentro del
alcance de 60 m del cañón): se acerca si el objetivo se aleja demasiado,
retrocede si se le echa encima. Su rasgo distintivo es el disparo predictivo:
en vez de apuntar a la posición actual del contacto de radar, usa su `velocity`
para calcular dónde estará cuando el proyectil llegue
(`posición + velocidad × distancia/velocidadDelProyectil`, con la velocidad del
proyectil leída de `WELCOME.vehicle.modules`, nunca asumida) — ver
`predictedAimPoint()` en el propio archivo.

Loadout de referencia: arquetipo `gunner` (`packages/module-catalog/resolve/archetypes.ts`).

## Minador (`miner.ts`)

**Estrategia, en un párrafo.** Avanza hacia la base rival sembrando minas cada
`MINE_INTERVAL_TICKS` a su paso, y responde con su ametralladora en cuanto su
lidar detecta a alguien. Nota honesta: el mapa de práctica CTF
(`ctfArena()` de E2) es deliberadamente abierto — sin cuellos de botella reales
que detectar —, así que este bot usa la alternativa que el propio encargo deja
explícita: sembrar en su ruta de avance conocida, no en un pasillo detectado.

Loadout de referencia: arquetipo `miner` (`packages/module-catalog/resolve/archetypes.ts`).

## Tests

```bash
npx vitest run example-bots/javascript/gunner.test.ts example-bots/javascript/miner.test.ts
```

Winrate (≥95% en 20 batallas contra un stub inmóvil, semilla distinta cada vez)
para los dos, más la prueba específica del artillero: ≥60% de acierto en al
menos 30 disparos contra un `ForwardBot` (movimiento rectilíneo constante) a
media distancia, contando aciertos reales por eventos `hit_dealt` y disparos
reales por consumo de munición (`observation.self.modules[].ammo`), no
estimados.

Para la validación de loadouts y la batalla CTF 2v2 cross-lenguaje (los cuatro
bots oficiales juntos, sin stubs), ver
[`example-bots/loadouts.test.ts`](../loadouts.test.ts) y
[`example-bots/ctf-integration.test.ts`](../ctf-integration.test.ts).
