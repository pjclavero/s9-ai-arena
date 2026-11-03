# Eventos

Un **evento** (`EVENT`) te avisa de algo que acaba de ocurrir. Llega a tu hook `on_event` / `onEvent` **antes** de la siguiente observación. Los eventos no son un canal secreto: llevan la misma niebla de guerra que todo lo demás. Sólo recibes los que te conciernen (un impacto que sufres, un rechazo de tu orden, una captura de tu equipo) o que has podido percibir.

```python
def on_event(self, event):
    if event["kind"] == "hit_taken":
        self.me_disparan = True
```

## Campos

Siempre llegan `tick` y `kind`. El resto depende del tipo y puede faltar:

| Campo | Qué es |
|---|---|
| `sector` | `front`, `left`, `right` o `rear`: por dónde entró un impacto. |
| `slot` | La ranura implicada (el arma que se rechazó, el módulo que cambió de estado). |
| `state` | Nuevo estado de un módulo (`operational`, `damaged`, `critical`, `destroyed`, `offline`). |
| `damage` | Daño causado o recibido. |
| `sourceId`, `targetId` | Quién y a quién, **sólo si podías percibirlo**. Un disparo de un enemigo que no has detectado no te dice quién es. |
| `team` | Bando implicado. |
| `position` | Posición, solo si es pública o la has percibido. |
| `score` | Marcador tras el evento. |
| `reason` | Motivo corto de un rechazo (abajo). |
| `ticksRemaining` | Ticks que faltan (por ejemplo, para el final de una ronda). |

## Tipos de evento

| `kind` | Cuándo |
|---|---|
| `hit_taken` | Has recibido un impacto (con `sector` y `damage`). |
| `hit_dealt` | Has impactado a otro vehículo. |
| `module_state_changed` | Uno de tus módulos ha cambiado de estado. |
| `vehicle_destroyed` | Un vehículo ha sido destruido. |
| `respawned` | Has reaparecido. |
| `mine_deployed` | Has soltado una mina. |
| `mine_triggered` | Ha explotado una mina. |
| `flag_taken`, `flag_dropped`, `flag_returned`, `flag_captured` | Lo que le pasa a una bandera. |
| `zone_captured` | Una zona ha cambiado de dueño. |
| `score_changed` | El marcador ha cambiado. |
| `radio_dropped` | Uno de tus mensajes de radio no salió (con `reason`). |
| `rejected_action` | Una acción tuya no se pudo hacer (con `reason`). |
| `decision_timeout` | No llegó tu orden a tiempo en un ciclo. |
| `round_ending` | La ronda está a punto de terminar. |

Tu código debe **ignorar los tipos que no conozca**: el contrato puede añadir más.

## Motivos de un rechazo (`reason`)

Para `rejected_action`:

| `reason` | Qué significa |
|---|---|
| `cooldown`, `no_ammo`, `no_energy`, `module_destroyed`, `critical_failure`, `out_of_arc` | Un disparo no salió ([Armas y munición](armas-y-municion.md#por-qué-se-rechaza-un-disparo)). |
| `no_charges`, `limit_exceeded`, `invalid_position` | Una mina no se pudo soltar (sin cargas, demasiadas activas, posición sobre un muro). |
| `reactivating`, `unknown_slot` | No se pudo encender un módulo (aún se está reactivando, o esa ranura no existe). |
| `invalid_command: <campo> <regla>` | Tu orden estaba mal formada y se descartó entera. |
| `extra_command_discarded` | Mandaste más de una orden en el mismo ciclo. |
| `timeout_disqualified` | Te han descalificado por perder demasiadas decisiones seguidas. |

Para `radio_dropped`: `no_radio`, `too_large`, `rate_limited` y `queue_full` ([Radio](radio.md)). El contrato reserva además el motivo `out_of_range` (radio fuera de alcance), que hoy no se emite porque la radio no tiene alcance.

## Para qué usarlos

- **Depurar**: cuenta los `rejected_action` en `on_event` y verás enseguida si disparas sin munición o con órdenes mal formadas. Las estadísticas de la batalla también los muestran en el [diagnóstico de tu bot](../statistics.md#diagnóstico-de-tus-bots).
- **Reaccionar**: un `hit_taken` por el sector trasero indica que alguien te ataca por detrás aunque tu radar no lo vea.
- No necesitas los eventos para saber tu estado: la observación ya trae tu vida, tus módulos y tu munición.

Siguiente: [Probar tu bot](probar.md).
