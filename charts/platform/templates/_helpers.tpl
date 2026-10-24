{{- define "platform.labels" -}}
app.kubernetes.io/part-of: urumi
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{- define "platform.host" -}}
app.{{ .Values.domain }}
{{- end }}

{{/* Hardened container defaults. */}}
{{- define "platform.containerSecurityContext" -}}
runAsNonRoot: true
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
seccompProfile:
  type: RuntimeDefault
{{- end }}

{{/* NetworkPolicy egress rule: DNS lookups via CoreDNS (same labels on kind and k3s). */}}
{{- define "platform.dnsEgress" -}}
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
{{- define "platform.internetEgress" -}}
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
