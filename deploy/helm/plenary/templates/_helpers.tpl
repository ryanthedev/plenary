{{/*
Expand the name of the chart.
*/}}
{{- define "plenary.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "plenary.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "plenary.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "plenary.labels" -}}
helm.sh/chart: {{ include "plenary.chart" . }}
{{ include "plenary.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
plenary.dev/mode: {{ .Values.mode | quote }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "plenary.selectorLabels" -}}
app.kubernetes.io/name: {{ include "plenary.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use.
*/}}
{{- define "plenary.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "plenary.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Secret name (external or chart-managed).
*/}}
{{- define "plenary.secretName" -}}
{{- if .Values.secrets.existingSecret }}
{{- .Values.secrets.existingSecret }}
{{- else }}
{{- include "plenary.fullname" . }}
{{- end }}
{{- end }}

{{/*
PVC name (external or chart-managed).
*/}}
{{- define "plenary.pvcName" -}}
{{- if .Values.persistence.existingClaim }}
{{- .Values.persistence.existingClaim }}
{{- else }}
{{- printf "%s-data" (include "plenary.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Effective replica count: single mode defaults to 1; HA mode defaults to 3 unless replicaCount is explicitly set.
*/}}
{{- define "plenary.replicaCount" -}}
{{- if eq .Values.mode "single" -}}
1
{{- else if .Values.replicaCount -}}
{{- .Values.replicaCount -}}
{{- else -}}
3
{{- end -}}
{{- end }}

{{/*
Validate chart mode and invariants.
*/}}
{{- define "plenary.validateValues" -}}
{{- if and (ne .Values.mode "single") (ne .Values.mode "ha") -}}
{{- fail (printf "Invalid mode %q: must be \"single\" or \"ha\"." .Values.mode) -}}
{{- end -}}
{{- if and (eq .Values.mode "single") .Values.replicaCount (gt (int .Values.replicaCount) 1) -}}
{{- fail "Single-node mode (mode: single) uses SQLite and cannot run with replicaCount > 1. Switch to mode: ha for multiple replicas." -}}
{{- end -}}
{{- if and (eq .Values.mode "ha") (not .Values.secrets.existingSecret) -}}
{{- if not .Values.secrets.cookieKey -}}
{{- fail "HA mode requires COOKIE_KEY: set secrets.existingSecret or secrets.cookieKey (>= 32 bytes)." -}}
{{- end -}}
{{- if not .Values.secrets.databaseUrl -}}
{{- fail "HA mode requires DATABASE_URL: set secrets.existingSecret or secrets.databaseUrl." -}}
{{- end -}}
{{- if not .Values.secrets.natsUrl -}}
{{- fail "HA mode requires NATS_URL: set secrets.existingSecret or secrets.natsUrl." -}}
{{- end -}}
{{- end -}}
{{- if and (eq .Values.mode "ha") (ne .Values.config.blobsMode "local-disk") (not .Values.config.s3.endpoint) -}}
{{- fail "HA mode requires S3 blob storage (config.s3.endpoint + credentials) or config.blobsMode: local-disk (single-gateway only)." -}}
{{- end -}}
{{- if and (eq .Values.config.blobsMode "local-disk") .Values.config.s3.endpoint -}}
{{- fail "Cannot set both config.blobsMode=local-disk and config.s3.endpoint; pick one." -}}
{{- end -}}
{{- if and (eq .Values.mode "ha") .Values.config.s3.endpoint -}}
{{- if or (not .Values.config.s3.bucket) (not .Values.config.s3.region) -}}
{{- fail "S3 blob storage requires config.s3.bucket and config.s3.region when config.s3.endpoint is set." -}}
{{- end -}}
{{- if and (not .Values.secrets.existingSecret) (or (not .Values.secrets.s3AccessKeyId) (not .Values.secrets.s3SecretAccessKey)) -}}
{{- fail "HA mode with config.s3.endpoint requires S3 credentials: set secrets.existingSecret or secrets.s3AccessKeyId and secrets.s3SecretAccessKey." -}}
{{- end -}}
{{- end -}}
{{- if and .Values.config.oidc.issuerUrl (or .Values.secrets.googleClientId .Values.secrets.googleClientSecret) -}}
{{- fail "Cannot configure both Generic OIDC (config.oidc.issuerUrl) and Google Workspace SSO (secrets.googleClientId/Secret); pick one." -}}
{{- end -}}
{{- end }}
