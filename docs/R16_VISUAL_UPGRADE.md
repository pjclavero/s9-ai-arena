# R16 · Visual upgrade (mejoras gráficas)

> Documentación y plan por fases. **No implementa** nada todavía. **Empieza por lo básico**, NO por
> WebGL avanzado ni CDN. Bloque separado. No toca motor/determinismo, seguridad ni VM108.

## Principio

El motor y el determinismo **no** dependen de lo visual. R16 mejora la **presentación** (viewer/render)
sin tocar el tick lógico ni el `finalStateHash`. Puede empezar **antes** que R14 (WebRTC).

## Roadmap por fases

| Fase | Contenido | Riesgo rendimiento |
|---|---|---|
| **R16.1** | Sprites básicos y siluetas: tanque con orugas/torreta/cañón; siluetas por tipo (scout, gunner, miner). | bajo |
| **R16.2** | Efectos de disparo/explosión: destello de cañón, explosiones con spritesheet, partículas simples. | bajo/medio |
| **R16.3** | Panel de estadísticas: daño infligido/recibido, precisión, feedback táctico. | bajo |
| **R16.4** | Sonido básico: disparos, explosiones, motores. | bajo |
| **R16.5** | Texturas de terreno: suelo, hierba, arena, agua. | medio |
| **R16.6** | Niebla/sombreado **determinista**: niebla movida por viento determinista, sombreado según hora del día. | medio |
| **R16.7** | Shaders/post-processing: shaders de partículas/niebla, bloom, motion blur. | **alto** |
| **R16.8** | Sprite atlas, lazy loading por mapa, carga desde CDN (**solo opción futura**). | medio/alto |

## Detalle de assets

- **Vehículos**: sprites de tanque (orugas, torreta, cañón); siluetas diferenciadas por módulo dominante.
- **Ambiente**: sombreado dinámico por hora; niebla determinista por viento; texturas suelo/hierba/arena/agua.
- **UI**: panel de estadísticas (daño ±, precisión) y feedback táctico.
- **Efectos**: explosiones (spritesheet), destello de cañón, partículas.
- **Sonido**: disparos, explosiones, motores.
- **Técnicas gráficas** (fases altas): shaders personalizados, bloom, motion blur, sprite atlas,
  lazy loading por mapa, CDN (futuro).

## Restricciones

- **No** empezar por WebGL avanzado ni CDN. Primero R16.1–R16.4 (sprites/efectos/panel/sonido básicos).
- Cualquier "niebla/sombreado" que **afecte a la jugabilidad** debe ser **determinista** (derivada del
  seed/estado), no aleatoria de cliente. Lo puramente cosmético puede vivir solo en el viewer.
- Vigilar **rendimiento**: presupuesto de frame; las fases R16.7/R16.8 pueden degradar en equipos modestos.
- CDN/lazy loading: respetar CSP; nada de assets que rompan el aislamiento del viewer.

## Definición de done (por fase, cuando se autorice)

Cada fase es su **propia PR**: assets + render + test de humo del viewer; sin regresión de determinismo
(el motor no cambia); sin secretos; sin dependencia obligatoria de red externa hasta R16.8 (y esa,
opcional/gateada).
