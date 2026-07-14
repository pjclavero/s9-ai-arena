# Bots de ejemplo oficiales (Python): Explorador y Defensor

Dos de los cuatro bots oficiales de S9 AI Arena (los otros dos, Artillero y
Minador, están en [`example-bots/javascript/`](../javascript/)). Ambos usan
[`arena-sdk`](../../sdks/python/) y el catálogo real de E3.

## Explorador (`explorer.py`)

**Estrategia, en un párrafo.** Patrulla en círculo amplio mientras esquiva
obstáculos con su lidar frontal (un cono de 90°, no 360° — el arquetipo `scout`
real no monta un lidar omnidireccional, ver `docs/balance/v1.md`); en cuanto un
rayo detecta un vehículo, avisa una vez por radio a su equipo con el rumbo y la
distancia, gira a perseguirlo y dispara con su ametralladora si lo tiene a tiro.
Su ventaja es la velocidad (ruedas) y el bajo coste: es el ojo barato del equipo,
no su mayor amenaza.

Loadout de referencia: arquetipo `scout` (`packages/module-catalog/resolve/archetypes.ts`).

## Defensor (`defender.py`)

**Estrategia, en un párrafo.** Ronda cerca de su propia base (leída de
`WELCOME.map.bases`), y en cuanto su lidar de 360° (el arquetipo `heavy` real
lleva `sensor.lidar360`, no radar — cobertura completa en vez de alcance largo
con error, mejor para vigilar un perímetro) detecta un intruso, decide si
avanzar a interceptarlo o quedarse plantado disparando según lo lejos que esté
de casa. Es el más lento y el más duro de matar: su trabajo no es perseguir,
es que nadie capture la bandera por su lado.

Loadout de referencia: arquetipo `heavy` (`packages/module-catalog/resolve/archetypes.ts`).

## Tests

```bash
cd sdks/python && .venv/Scripts/activate   # o el venv que hayas creado, ver sdks/python/README.md
pytest ../../example-bots/python/test_bots.py -v -s
```

`-s` para ver el winrate exacto impreso de cada bot (20 batallas contra un stub
inmóvil, semilla distinta cada vez; se exige ≥95%, sin redondear).

Para la validación de loadouts y la batalla CTF 2v2 cross-lenguaje (los cuatro
bots oficiales juntos, sin stubs), ver
[`example-bots/loadouts.test.ts`](../loadouts.test.ts) y
[`example-bots/ctf-integration.test.ts`](../ctf-integration.test.ts).
