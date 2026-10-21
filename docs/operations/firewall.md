# Firewall del host

## Resumen

Reglas de firewall del host, versionadas como código (`infrastructure/firewall/s9-firewall.sh`), que
forman la **capa (b)** de la defensa del proxy de Docker ([docker-proxy.md](docker-proxy.md)):

1. El puerto del proxy (2375) **sólo** se acepta si el paquete entra por el bridge dedicado
   `s9-botctl0`, con origen en `10.89.250.0/24` y destino `10.89.250.1`. Cualquier otro origen
   (docker0, otras redes de Docker, LAN, Tailscale, loopback del host) se descarta.
2. Desde los bridges de Docker (redes internas incluidas, y por tanto los bots) **no** se alcanza el
   sshd del host por la IP del bridge ([TD-053](../roadmap/technical-debt.md)).

Estado: **DESIGN_ONLY en producción** (no se ha aplicado en ningún host productivo); verificado en un
netns aislado con conexiones reales.

## Índice

- [Qué es](#qué-es)
- [Cómo funciona](#cómo-funciona)
- [Uso](#uso)
- [Configuración](#configuración)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Qué es

El proxy de Docker corre en el host y escucha en el gateway de la red Docker dedicada `bot-control`
(`10.89.250.1:2375`). Que la red sea `internal` no basta: **una IP propiedad del host es alcanzable
desde cualquier contenedor con ruta por defecto** (redes no internas, como la del gateway público o
la del backup) aunque no compartan red, y también desde la LAN si alguien enruta hacia el host. Este
firewall cierra esa conectividad residual por **interfaz de entrada**, que un contenedor no puede
falsificar (la IP de origen sí).

Las tres capas son independientes y cada una tiene su propia prueba:

| Capa | Qué impide | Dónde |
|---|---|---|
| (a) red | que un no consumidor comparta red con el proxy | `infrastructure/docker-compose.yml` ([networking.md](networking.md)) |
| (b) firewall | que llegue al puerto un paquete que no entra por `s9-botctl0` | este documento |
| (c) proxy | clientes fuera de `10.89.250.0/24`, imágenes fuera de la allowlist, contenedores ajenos | [docker-proxy.md](docker-proxy.md) |

## Cómo funciona

- **Sólo iptables.** El host usa Docker con backend iptables (iptables-nft) y el servicio `nftables`
  del sistema está **deshabilitado**. El script **nunca** invoca `nft`, nunca recarga ni vacía
  ficheros de reglas y nunca toca las cadenas de Docker ni de Tailscale.
- **Cadena propia** `S9-HOST-GUARD`, enganchada como **regla 1 de INPUT** con
  `-m comment --comment s9-host-guard`. Debe ir delante de `ts-input` de Tailscale, que acepta todo
  lo que entra por `tailscale0`.
- Contenido (IPv4):

  ```text
  -A S9-HOST-GUARD -s 10.89.250.0/24 -d 10.89.250.1/32 -i s9-botctl0 -p tcp -m tcp --dport 2375 -j RETURN
  -A S9-HOST-GUARD -p tcp -m tcp --dport 2375 -j DROP
  -A S9-HOST-GUARD -i br-+ -p tcp -m tcp --dport 22 -j DROP
  -A S9-HOST-GUARD -i docker0 -p tcp -m tcp --dport 22 -j DROP
  -A S9-HOST-GUARD -i s9-botctl0 -p tcp -m tcp --dport 22 -j DROP
  ```

  En IPv6 (si `ip6tables` funciona) se aplican los mismos DROP; no hay aceptación porque el proxy es
  sólo IPv4. `s9-firewall.sh print` muestra las reglas exactas de la configuración efectiva.
- **Idempotente y sin ventana.** `apply` compara el estado con el deseado; si difiere, monta una
  cadena nueva y la engancha arriba antes de retirar la vieja. Las reglas propias se borran siempre
  por especificación, **nunca por número** (otro actor puede insertar a la vez).
- **Persistencia** con tres unidades systemd:
  - `s9-firewall.service` (oneshot): se aplica al arrancar, después de Docker y de Tailscale y antes
    del proxy; con `PartOf=docker.service tailscaled.service` se vuelve a aplicar cuando se reinicia
    cualquiera de ellos (tailscaled reinserta `ts-input` en la regla 1 al arrancar). **Parar la
    unidad no retira las reglas.**
  - `s9-firewall-reassert.timer` → `s9-firewall-reassert.service`: cada 5 minutos ejecuta `apply`,
    que no cambia nada si no hay deriva y la corrige (y lo registra) si la hay.
- La unidad ejecuta una copia **propiedad de root** (`/usr/local/sbin/s9-firewall`), no el script del
  clon, que es escribible por el usuario de despliegue.

## Uso

Comprobar sin cambiar nada (root):

```bash
sudo bash infrastructure/firewall/s9-firewall.sh print   # reglas deseadas (no necesita root)
sudo /usr/local/sbin/s9-firewall check                    # rc=0 conforme, rc=1 deriva (explicada)
```

Instalar y aplicar:

> **DANGER** — cambia el firewall del host en caliente.
> **PRECONDITION** — red `bot-control` desplegada y proxy con `DOCKER_PROXY_BIND=10.89.250.1`; acceso
> al host por la LAN o Tailscale (el sshd sólo se cierra a los bridges de Docker); `sshd -T | grep
> ^port` coincide con `S9FW_SSH_PORTS`; ventana con la sonda de red preparada.
> **EFFECT** — inserta la cadena `S9-HOST-GUARD` como regla 1 de INPUT y habilita las tres unidades.
> No toca nftables, ni las cadenas de Docker o Tailscale.
> **ROLLBACK** — `sudo /usr/local/sbin/s9-firewall uninstall` (retira las unidades y sólo las reglas
> propias, por especificación).

```bash
sudo bash infrastructure/firewall/s9-firewall.sh install
sudo /usr/local/sbin/s9-firewall check
```

Después, medir el efecto desde los contenedores con la sonda de red ([networking.md](networking.md)):
los consumidores del proxy conectan; el gateway, el backup y cualquier contenedor de bot reciben
TIMEOUT en 2375; desde la red `arena` el sshd del host (`<gateway de arena>:22`) da TIMEOUT.

## Configuración

Opcional, en `/etc/s9-ai-arena/firewall.env` (plantilla: `infrastructure/firewall/firewall.env.example`).
Los valores por defecto son las constantes del contrato; sólo cambian si cambia el contrato.

| Variable | Defecto | Validación |
|---|---|---|
| `S9FW_BRIDGE` | `s9-botctl0` | nombre de interfaz; nunca `docker0`, `lo` ni comodín |
| `S9FW_SUBNET` | `10.89.250.0/24` | dirección de red, prefijo /16 a /30 |
| `S9FW_PROXY_IP` | `10.89.250.1` | dentro de `S9FW_SUBNET` |
| `S9FW_PROXY_PORT` | `2375` | 1-65535 |
| `S9FW_SSH_PORTS` | `22` | lista de puertos |
| `S9FW_SSH_BLOCK_IFACES` | `br-+ docker0 s9-botctl0` | nunca `lo` |
| `S9FW_IPV6` | `auto` | `auto`, `on` u `off` |

Una configuración inválida termina con rc=2 **sin tocar** las reglas.

## Errores / limitaciones

- **Loopback también se descarta.** Un proceso del host que conecte a `10.89.250.1:2375` sale con
  origen `10.89.250.1`, que está dentro de la subred admitida por el proxy; por eso la capa (b) lo
  corta. `install-docker-proxy.sh validate` comprueba la escucha con `ss`, no con `curl` desde el host.
- **Sólo cubre 2375 y sshd.** Otros servicios del host que escuchen en `0.0.0.0` siguen siendo
  alcanzables por la IP de un bridge; inventariarlos con `ss -ltn` antes de dar la capa por cerrada.
- La reinserción de `ts-input` por Tailscale sin reinicio del servicio queda cubierta como mucho a los
  5 minutos (timer). `check` la detecta al instante.
- Si Docker pasa a `firewall-backend: nftables`, estas reglas siguen en la tabla `ip filter` de
  iptables-nft y se evalúan igual; reevaluar entonces el diseño.

## Estado actual

- **FUNCIONA ACTUALMENTE (aislado):** `apply`/`check`/`remove`, idempotencia, corrección de deriva y
  rechazo de configuración insegura, probados con conexiones reales en un netns aislado.
- **PENDIENTE:** aplicación en producción (decisión del operador, ventana propia) y ensayo con Docker
  rootful en la CI (contenedor → proxy, carril de E2E).

## Documentación relacionada

[docker-proxy.md](docker-proxy.md) · [networking.md](networking.md) ·
[installation.md](installation.md#imágenes-de-runtime-de-los-bots) ·
[../technical/security.md](../technical/security.md) ·
[../roadmap/technical-debt.md](../roadmap/technical-debt.md).

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| Sin reglas, todos los orígenes conectan a 2375 y 22 (control negativo) | RUNTIME_VERIFIED (netns aislado) | `infrastructure/firewall/tests/netns-harness.sh`, fase `control` |
| Con reglas, sólo `s9-botctl0` alcanza 2375; docker0, otro bridge, LAN, Tailscale, loopback y origen falsificado → TIMEOUT | RUNTIME_VERIFIED (netns aislado) | mismo arnés, fase `applied` |
| sshd: TIMEOUT desde los bridges, CONNECT desde LAN y Tailscale | RUNTIME_VERIFIED (netns aislado) | mismo arnés, fase `applied` |
| `apply` es idempotente; corrige la reinserción de `ts-input` y un RETURN inyectado | RUNTIME_VERIFIED (netns aislado) | fases `idem`, `ts-drift`, `body-drift` |
| Nunca invoca `nft` ni muta cadenas ajenas; `remove` deja el estado ajeno idéntico | RUNTIME_VERIFIED (netns aislado) | fases `shim` y `remove` |
| El arnés se exige completo en la suite | CODE_VERIFIED | `infrastructure/firewall/firewall.test.ts` |
| Persistencia tras arranque y reinicio de Docker/Tailscale | DESIGN_ONLY | `infrastructure/systemd/s9-firewall.service` (`PartOf=`, `WantedBy=`); no ensayado con systemd real |
| Aplicado en producción | DESIGN_ONLY | no aplicado (RC2: PRODUCTION CHANGES = NONE) |
