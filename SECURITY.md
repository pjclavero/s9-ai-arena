# Política de seguridad

## Versiones con soporte

Mientras el proyecto no tenga versiones etiquetadas (semver), se da soporte de seguridad
únicamente a la rama `main` y a la última versión publicada en el registro de imágenes.

| Versión | Soporte |
|---|---|
| `main` / última versión publicada | Sí |
| Anteriores | No |

## Cómo informar de una vulnerabilidad

**No abras un issue ni un PR públicos con detalles explotables.**

Usa «Report a vulnerability» en la pestaña *Security* de este repositorio
(Private vulnerability reporting de GitHub). Incluye, si puedes:

- qué componente afecta (API, motor, bot-manager, visor, streamer, runtimes de bots, infraestructura);
- versión o commit;
- pasos para reproducirlo en un entorno aislado y su impacto;
- cualquier mitigación que conozcas.

No incluyas credenciales reales ni datos personales de terceros. No pruebes contra
instalaciones que no sean tuyas.

## Qué puedes esperar (plazos objetivo, mejor esfuerzo)

| Fase | Plazo |
|---|---|
| Acuse de recibo | 5 días laborables |
| Valoración inicial (confirmada / no / más datos) | 15 días |
| Corrección o mitigación de severidad alta o crítica | 30 días desde la confirmación |
| Corrección de severidad media o baja | 90 días |
| Divulgación coordinada | Tras publicar la corrección, de acuerdo contigo |

Somos un proyecto pequeño: son objetivos, no garantías contractuales. Si hay un riesgo
activo te lo diremos en la valoración inicial.

## Alcance

Dentro de alcance: el código de este repositorio (API, motor determinista, gestor de bots y
su sandbox, visor, streamer, SDK, runtimes y su publicación), los contratos (OpenAPI,
esquemas) y la configuración de despliegue que se publica aquí; en especial: salto del
sandbox de bots, autorización (acceso a datos o acciones de otros usuarios o torneos),
fuga de información privada (código de bots, equipamiento privado, credenciales de
retransmisión), inyección y denegación de servicio por entrada de usuario.

Fuera de alcance: instalaciones de terceros y su configuración; ataques que requieran
acceso físico o credenciales de administrador ya concedidas; ingeniería social;
denegación de servicio por volumen; informes de escáneres automáticos sin prueba de
impacto; vulnerabilidades en dependencias sin ruta alcanzable desde el proyecto
(avísanos igualmente por el canal privado si tienes dudas).

## Reconocimiento

Si lo deseas, te citaremos en las notas de la corrección. No hay programa de recompensas.
