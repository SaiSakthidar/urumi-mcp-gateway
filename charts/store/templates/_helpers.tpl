{{- define "store.labels" -}}
app.kubernetes.io/part-of: urumi
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{- define "store.host" -}}
shop.{{ .Values.domain }}
{{- end }}

{{- define "store.url" -}}
{{ .Values.scheme }}://{{ include "store.host" . }}
{{- end }}

{{/* DB + site env shared by WordPress and the setup Job (wp-config.php reads these). */}}
{{- define "store.wordpressEnv" -}}
- name: WORDPRESS_DB_HOST
  value: mariadb
- name: WORDPRESS_DB_NAME
  value: {{ .Values.mariadb.database }}
- name: WORDPRESS_DB_USER
  value: {{ .Values.mariadb.user }}
- name: WORDPRESS_DB_PASSWORD
  valueFrom:
    secretKeyRef: { name: {{ .Values.secrets.db }}, key: password }
# Pin the site URL to the Ingress host, and trust X-Forwarded-Proto
# from Traefik so https works behind the proxy in prod.
- name: WORDPRESS_CONFIG_EXTRA
  value: |
    define('WP_HOME', '{{ include "store.url" . }}');
    define('WP_SITEURL', '{{ include "store.url" . }}');
    if (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') { $_SERVER['HTTPS'] = 'on'; }
{{- end }}

{{/* NetworkPolicy egress rule: DNS lookups via CoreDNS (same labels on kind and k3s). */}}
{{- define "store.dnsEgress" -}}
- to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
      podSelector:
        matchLabels:
          k8s-app: kube-dns
  ports:
    - { protocol: UDP, port: 53 }
    - { protocol: TCP, port: 53 }
{{- end }}

{{/* NetworkPolicy egress rule: public internet on 80/443 only; private, link-local
     (cloud metadata) and loopback ranges are excluded. */}}
{{- define "store.internetEgress" -}}
- to:
    - ipBlock:
        cidr: 0.0.0.0/0
        except:
          - 10.0.0.0/8
          - 172.16.0.0/12
          - 192.168.0.0/16
          - 169.254.0.0/16
          - 100.64.0.0/10
          - 127.0.0.0/8
  ports:
    - { protocol: TCP, port: 443 }
    - { protocol: TCP, port: 80 }
{{- end }}
