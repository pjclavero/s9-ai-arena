# 00 · Resumen ejecutivo

Sujeto: main 8f380eb · Fecha: 2026-11-19 · Estado: FASE 1 (estática) — FASE 2 pendiente

Este resumen coincide con el capítulo 1 del [informe maestro](FINAL-PRODUCT-AUDIT.md).


> Capítulo de síntesis, pensado para leerse solo. El análisis detallado de cada área, con su solución técnica, está en los capítulos 2 a 13.

## 1. Qué es S9 AI Arena

S9 AI Arena es una plataforma de combates entre bots. Cada jugador escribe un pequeño programa (en Python o JavaScript) que controla un vehículo, lo equipa con chasis, armas, sensores o radio, y lo enfrenta a los de otros jugadores en una arena 2D. El motor de simulación es **determinista**: en la misma plataforma, la misma batalla da siempre el mismo resultado, de modo que se puede repetir, verificar y ver de nuevo como *replay*.

La plataforma incluye:
- Una web para jugadores y administradores.
- Batallas individuales y por equipos.
- Torneos, clasificaciones y estadísticas.
- Espectador en directo, con retardo para no adelantar el resultado.
- Retransmisión a YouTube.
- Exportación e importación de bots y equipos.
- Despliegue con Docker en un único servidor: 13 servicios, con copias de seguridad en un almacenamiento externo.

## 2. En qué estado se encuentra

Se ha auditado la rama principal del código (`main`, versión `8f380eb`, motor 0.5.0, del 18-nov-2026). Ese código **funciona en sus pruebas automáticas**. Las pruebas que se ejecutan en cada cambio están en verde, e incluyen un recorrido completo en navegador real: registro, bot propio, compilación aislada, batalla y replay.

Según su propio informe, el operador reinstaló la producción desde cero con esa versión el 19-nov. **La auditoría no ha podido comprobarlo**: ese día la producción seguía en plena migración (importando y compilando los bots de los usuarios) y, por norma, no se tocó. Que las pruebas automáticas estén en verde **no demuestra** que la producción funcione.

| Parte | Estado |
|---|---|
| Motor, reglas, equipamiento, batallas 1v1 y por equipos, torneos, ranking, replays | **Implementado y cubierto por pruebas**, con huecos concretos: un caso de torneo atascado sin salida, replays de motores anteriores que no se abren y estadísticas sin control de versión. En la matriz figura como PARCIAL |
| Compilación y ejecución aislada de bots | **Implementado**. El aislamiento de red no está demostrado (ver 1.5) |
| Web de jugador y de administración | **Implementada en lo esencial**, con carencias de uso (ver 1.6) |
| Streaming a YouTube (V1) | **Integrado en el código**. La emisión real está documentada por el operador, no verificada. Sin prueba de emisiones largas: función *experimental* |
| Streaming V2 / Broadcast Manager, nuevas visualizaciones | **Sólo diseño** |
| Recuperación de contraseña, notificaciones, correo, moderación | **Pendiente** o a medias |
| Instalación por terceros, release publicada, licencia | **Pendiente** |

Matriz completa en el [capítulo 2](FINAL-PRODUCT-AUDIT.md#2-estado-actual-del-proyecto).

## 3. Principales fortalezas

- **Un motor serio.** Es reproducible en la misma plataforma (no se ha probado entre procesadores distintos) y está protegido contra fuentes de azar no controladas. Los replays van atados a la versión exacta del motor. Esto hace creíbles los resultados y los torneos.
- **Ejecutar código ajeno con cuidado.** El contenedor de cada bot no tiene privilegios, su disco es de sólo lectura y sus llamadas al sistema están filtradas. Ningún servicio tiene acceso libre a Docker: un *proxy* sólo permite las operaciones necesarias.
- **Una base de servidor sólida.** La cola de trabajos tiene reintentos y rescate de tareas colgadas. El contrato de la API no puede desincronizarse del código. Todas las migraciones de base de datos tienen vuelta atrás, aunque algunas pierden datos al revertirse.
- **Una cultura de pruebas exigente.** Hay miles de pruebas. En las revisiones se usaron *mutantes* (fallos introducidos a propósito) para comprobar que las pruebas detectan errores reales, aunque no se ejecutan de forma automática.

Detalle en el [capítulo 3](FINAL-PRODUCT-AUDIT.md#3-puntos-fuertes-del-proyecto).

## 4. Principales debilidades

Las debilidades no están en el núcleo técnico, sino en **todo lo que lo rodea**:
- Instalarlo.
- Empezar a jugar.
- Recuperar una cuenta.
- Saber qué falla.
- Publicarlo.

Y en la **fiabilidad de algunas señales**: una prueba de seguridad que no puede fallar y una batería de pruebas nocturna rota desde agosto. La rotura estaba anotada como deuda, pero nada la bloquea y se ha normalizado. Detalle en el [capítulo 4](FINAL-PRODUCT-AUDIT.md#4-puntos-débiles-y-riesgos).

## 5. Problemas importantes

| # | Problema | Por qué importa |
|---|---|---|
| 1 | **La instalación documentada no juega batallas** (OPS-01) | Quien siga la guía obtiene un sistema que parece sano pero donde ninguna batalla arranca. Falta configurar un componente del servidor que la guía presenta como «opcional». |
| 2 | **No hay licencia** en un repositorio público | Legalmente nadie puede usar, modificar ni contribuir al código. Bloquea cualquier presentación. |
| 3 | **El README dice que el producto «no funciona»** | La portada del proyecto describe la situación de octubre, 586 cambios atrás. |
| 4 | **La prueba de aislamiento de red de los bots no puede fallar** (REV-01) | Se ejecuta en una red vacía, así que siempre sale bien. En la red real, los bots comparten red con servicios internos. No se ha demostrado un ataque, pero tampoco la protección. |
| 5 | **La batería nocturna lleva rota desde el 4 de agosto** | Último resultado verde el 4 de agosto; desde entonces, 111 fallos en las últimas 129 ejecuciones. Los errores que sólo detectan las pruebas lentas pueden estar pasando desapercibidos. El arreglo es pequeño. |
| 6 | **Registro abierto a cualquiera, sin interruptor, y sin recuperación de contraseña** | Quien instale el sistema lo deja abierto sin saberlo, y quien olvide su contraseña pierde la cuenta salvo que el operador edite la base de datos. |
| 7 | **El primer administrador se crea con SQL** y la plantilla de configuración trae valores erróneos y datos de la instalación del operador | Una persona ajena no sabría hacerlo, y la plantilla la lleva a errores. |
| 8 | **Una instalación nueva está vacía y la primera batalla exige dos bots propios** | Un recién llegado no puede jugar enseguida. |

## 6. Preguntas clave

- **¿Se puede instalar fácilmente?** **No, hoy no.** La documentación es extensa y honesta, pero no lleva a un sistema que juegue. Además exige conocimientos que no explica: instalar un componente en el servidor como administrador, un cortafuegos, Node y SQL. Con el trabajo del grupo A, la respuesta debería ser «sí, con conocimientos básicos de Linux y Docker», y debe demostrarlo una persona ajena. No se ha medido cuánto se tarda. Ver el [capítulo 8](FINAL-PRODUCT-AUDIT.md#8-instalación-configuración-y-administración).
- **¿Está preparado para nuevos usuarios?** **No del todo.** La web explica el juego y tiene ayuda y primeros pasos, pero faltan rivales de práctica, recuperación de cuenta, notificaciones y un editor de código cómodo. No se ha probado con personas reales. Ver el [capítulo 7](FINAL-PRODUCT-AUDIT.md#7-web-usabilidad-y-experiencia-del-jugador).
- **¿Parece suficientemente estable?** **El código sí, en sus pruebas.** La estabilidad en producción, bajo carga, en torneos largos y en emisiones largas **no está medida**. Los errores conocidos de torneos atascados y tiempos de espera están corregidos en el código; queda un caso raro sin salida, el torneo `closed` atascado. Ver los capítulos [6](FINAL-PRODUCT-AUDIT.md#6-backend-api-y-base-de-datos) y [11](FINAL-PRODUCT-AUDIT.md#11-pruebas-y-ci).

## 7. Evaluación global: **NO LISTO**

Hay bloqueantes concretos para presentar el producto (tabla 1.5). Además, la producción, la instalación medida, la restauración de backups y el streaming real están en **EVIDENCIA INSUFICIENTE** hasta que se ejecute la segunda fase de la auditoría en laboratorio. El veredicto por áreas está en el [capítulo 15](FINAL-PRODUCT-AUDIT.md#15-veredicto-final-de-la-auditoría).

## 8. Qué falta para una versión presentable

Se recomienda la **opción A+**: una versión mínima pero honesta, presentada como *software autoalojable v0.x, en español, para un solo servidor*, con registro por invitación y streaming marcado como experimental. En resumen, hace falta:

1. **Decisiones del propietario**: licencia (la primera), política de registro, alcance del streaming, cierre de los PR de revisión y publicación de versiones.
2. **Instalación que funcione a la primera**:
   - plantilla de configuración correcta;
   - guía con todos los pasos obligatorios;
   - instalador del servidor;
   - versión publicada con sus componentes;
   - comando para crear el administrador;
   - comprobador que juegue una batalla de prueba.
3. **Protección por defecto**: registro cerrado o por invitación, cabeceras de seguridad de la web, reset de contraseña por el administrador y cambio de contraseña por el usuario.
4. **Primer uso sin fricción**: bots de práctica en toda instalación nueva.
5. **Evidencia fiable**:
   - arreglar la batería nocturna (7 noches seguidas en verde);
   - rehacer la prueba de aislamiento de red para que pueda fallar;
   - escanear las imágenes de los servicios.
6. **Escaparate**: README veraz con capturas, repositorio limpio y limitaciones escritas.
7. **Demostración en laboratorio**: un ensayo de restauración de backup y **una persona ajena que lo instale sólo con la documentación hasta jugar una batalla**.

Esfuerzo estimado, como suma de estimaciones y no como medición: **23 a 62 días de trabajo de una persona**, repartibles en siete líneas paralelas. A eso se suma el calendario: decisiones, siete noches de pruebas y el ensayo con una persona ajena. Plan en el [capítulo 14](FINAL-PRODUCT-AUDIT.md#14-plan-para-cerrar-una-versión-presentable).

## Conclusión ejecutiva

S9 AI Arena tiene un **núcleo técnico de calidad**. El motor, el aislamiento de los bots, el servidor y las pruebas están por encima de lo habitual en un proyecto de este tamaño, y **no necesitan rediseño**. Lo que lo separa de un producto estable, fácil de instalar y presentable es, sobre todo, **trabajo de producto y de verificación**, no de reescritura:
- que la instalación documentada funcione de verdad;
- que una instalación nueva sea segura por defecto;
- que un recién llegado pueda jugar sin programar dos bots;
- que las pruebas que dan confianza puedan efectivamente fallar;
- que el proyecto tenga licencia, versión publicada y una portada veraz.

El camino más corto y seguro empieza por:
1. Las decisiones del propietario, empezando por la licencia.
2. La segunda fase de esta auditoría en laboratorio.
3. Los 26 trabajos del grupo A, en paralelo.
4. Una versión congelada y demostrada con los 21 criterios de la [Definition of Done](12-RELEASE-DEFINITION-OF-DONE.md), incluida una instalación real por alguien ajeno al proyecto.

Streaming V2 y las mejoras visuales deben esperar a después del lanzamiento.