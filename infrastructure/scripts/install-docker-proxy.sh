#!/usr/bin/env bash
# R-DEPLOY · R2 — instala/valida/revierte el proxy de la API de Docker como
# unidad systemd en el HOST (VM108). Debe ejecutarse con privilegios (sudo).
#
# ÚNICO proceso autorizado a tocar /var/run/docker.sock (R1.7 · ERR-SEC-02).
# Ningún contenedor del stack monta el socket.
#
# Uso:
#   sudo bash infrastructure/scripts/install-docker-proxy.sh install
#   sudo bash infrastructure/scripts/install-docker-proxy.sh validate
#   sudo bash infrastructure/scripts/install-docker-proxy.sh rollback
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/s9-ai-arena}"
ETC_DIR="/etc/s9-ai-arena"
UNIT="s9-docker-proxy.service"
UNIT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/systemd/${UNIT}"
ENV_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/systemd/docker-proxy.env.example"
PROXY_USER="s9proxy"

need_root() { [ "$(id -u)" = "0" ] || { echo "Ejecuta con sudo/root."; exit 1; }; }

install_proxy() {
  need_root
  echo "==> usuario de servicio '${PROXY_USER}' (sin login, en grupo docker)"
  id -u "$PROXY_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$PROXY_USER"
  usermod -aG docker "$PROXY_USER"

  echo "==> config en ${ETC_DIR}/docker-proxy.env (no se sobrescribe si existe)"
  mkdir -p "$ETC_DIR"
  [ -f "${ETC_DIR}/docker-proxy.env" ] || install -m 0640 "$ENV_SRC" "${ETC_DIR}/docker-proxy.env"

  echo "==> unidad systemd"
  install -m 0644 "$UNIT_SRC" "/etc/systemd/system/${UNIT}"
  systemctl daemon-reload
  systemctl enable --now "$UNIT"
  echo "==> hecho. Revisa: sudo systemctl status ${UNIT}"
  echo "   (ajusta ${ETC_DIR}/docker-proxy.env y APP_DIR=${APP_DIR} antes de fiarte del arranque)"
}

validate_proxy() {
  need_root
  echo "==> estado de la unidad"
  systemctl is-active "$UNIT" || { echo "NO activo"; exit 1; }
  # shellcheck disable=SC1091
  . "${ETC_DIR}/docker-proxy.env"
  local url="http://${DOCKER_PROXY_BIND:-172.17.0.1}:${DOCKER_PROXY_PORT:-2375}"
  echo "==> ping a la API de Docker a través del proxy (${url}/_ping)"
  if command -v curl >/dev/null; then
    curl -fsS "${url}/_ping" && echo " OK"
  else
    echo "instala curl para la comprobación viva; revisa 'journalctl -u ${UNIT}'"
  fi
  echo "==> últimos logs (decisiones JSON)"
  journalctl -u "$UNIT" -n 20 --no-pager || true
}

rollback_proxy() {
  need_root
  echo "==> parando y deshabilitando ${UNIT}"
  systemctl disable --now "$UNIT" 2>/dev/null || true
  rm -f "/etc/systemd/system/${UNIT}"
  systemctl daemon-reload
  echo "==> unidad retirada. Config y usuario se conservan:"
  echo "   rm -rf ${ETC_DIR} && userdel ${PROXY_USER}   # opcional, borrado total"
}

case "${1:-}" in
  install) install_proxy ;;
  validate) validate_proxy ;;
  rollback) rollback_proxy ;;
  *) echo "Uso: $0 {install|validate|rollback}"; exit 2 ;;
esac
