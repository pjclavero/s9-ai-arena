# Plantilla de Alertmanager. El entrypoint del servicio sustituye
# __ALERT_WEBHOOK_URL__ por $ALERT_WEBHOOK_URL de infrastructure/.env
# (alertmanager no expande variables de entorno por sí mismo).
# El canal lo elige el operador: webhook (Slack/Matrix/ntfy) y/o email
# añadiendo aquí un receiver email_configs con su SMTP.
route:
  receiver: operador
  group_by: [alertname]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h

receivers:
  - name: operador
    webhook_configs:
      - url: "__ALERT_WEBHOOK_URL__"
        send_resolved: true
