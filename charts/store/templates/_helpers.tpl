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
