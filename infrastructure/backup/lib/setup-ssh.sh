# setup_ssh — prepara ~/.ssh para el backend `sftp:` de restic.
#
# Compartido por backup.sh (fix/backup-sftp-scheduled-runtime) y restore.sh
# (fix/restore-sftp-bootstrap): AMBOS corren dentro de un contenedor efímero
# que no comparte ~/.ssh del host ni de ningún otro contenedor. Antes de este
# fichero, `restore.sh` no sabía nada del backend sftp: en producción
# "funcionaba" de rebote porque backup.sh ya había dejado ~/.ssh listo en la
# capa de escritura de ESE MISMO contenedor — un contenedor de recuperación
# NUEVO (el escenario real que este runbook debe cubrir) nunca había
# ejecutado backup.sh y fallaba con "Host key verification failed".
# Factorizado a un único fichero para que ambos scripts usen EXACTAMENTE el
# mismo bootstrap SSH y no diverjan con el tiempo.
#
# Contrato de entrada (el llamador debe definir todo esto ANTES de invocar
# setup_ssh; este fichero no valida su presencia, ver el preflight de cada
# script):
#   - HOME                        directorio de trabajo de ~/.ssh
#   - RESTIC_REPOSITORY           para decidir si aplica (sólo sftp:*)
#   - RESTIC_SSH_KEY_FILE         ruta a la clave privada (secreto montado)
#   - RESTIC_SSH_KNOWN_HOSTS_FILE ruta al known_hosts con huella verificada
#   - log()                       función de logging JSON del script llamador
#     (backup.sh y restore.sh definen cada uno su propio log() con el mismo
#     contrato `log LEVEL MSG`, sólo cambia el campo "service"; setup_ssh usa
#     el que esté en el ámbito de quien lo invoca, deliberadamente, para que
#     el log de cada fallo aparezca con el servicio correcto)
#
# Los secretos de Docker se montan SIEMPRE de sólo lectura y con permisos
# 0444 (root:root) en /run/secrets/*: `ssh` rechaza una clave privada con
# permisos de grupo/otros ("UNPROTECTED PRIVATE KEY FILE"), así que la clave
# NO puede usarse directamente desde /run/secrets — hay que copiarla a un
# sitio escribible del contenedor (la capa de escritura, efímera) con 0600
# antes de invocarla. known_hosts no tiene esa restricción de permisos, pero
# se copia igual para mantener todo en un único ~/.ssh gestionado aquí.
#
# IMPORTANTE: el chmod 600 se aplica SIEMPRE a la COPIA LOCAL en ~/.ssh,
# NUNCA al fichero de secreto original montado (RESTIC_SSH_KEY_FILE) — ese
# fichero es de sólo lectura por diseño y no se toca.
#
# `IdentitiesOnly yes` evita que ssh pruebe otras identidades (agent, claves
# por defecto) que no existen en este contenedor pero cuyo intento ralentiza
# o, en teoría, podría filtrar información en un ssh-agent reenviado por
# error. `StrictHostKeyChecking yes` + `UserKnownHostsFile` explícito es la
# verificación de huella exigida por el operador: sin una entrada que
# coincida en known_hosts, ssh aborta la conexión en vez de aceptar
# silenciosamente cualquier host. NUNCA se sustituye por
# StrictHostKeyChecking=no: sin verificación de huella, un MITM/DNS spoofing
# en la red del backup podría suplantar el destino y recibir (o entregar, en
# el caso de restore) el dump completo de PostgreSQL.
setup_ssh() {
  [[ "$RESTIC_REPOSITORY" == sftp:* ]] || return 0
  mkdir -p "$HOME/.ssh"
  chmod 700 "$HOME/.ssh"
  if ! cp "$RESTIC_SSH_KEY_FILE" "$HOME/.ssh/id_backup" 2>/dev/null; then
    log error "no se pudo copiar la clave SSH desde RESTIC_SSH_KEY_FILE=$RESTIC_SSH_KEY_FILE"
    return 1
  fi
  chmod 600 "$HOME/.ssh/id_backup"
  if ! cp "$RESTIC_SSH_KNOWN_HOSTS_FILE" "$HOME/.ssh/known_hosts" 2>/dev/null; then
    log error "no se pudo copiar known_hosts desde RESTIC_SSH_KNOWN_HOSTS_FILE=$RESTIC_SSH_KNOWN_HOSTS_FILE"
    return 1
  fi
  chmod 644 "$HOME/.ssh/known_hosts"
  {
    printf 'Host *\n'
    printf '  IdentityFile %s/.ssh/id_backup\n' "$HOME"
    printf '  IdentitiesOnly yes\n'
    printf '  UserKnownHostsFile %s/.ssh/known_hosts\n' "$HOME"
    printf '  StrictHostKeyChecking yes\n'
  } > "$HOME/.ssh/config"
  chmod 600 "$HOME/.ssh/config"
  return 0
}
