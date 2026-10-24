# Urumi: MCP Gateway on Kubernetes
# Usage: make up            (local kind cluster, everything)
#        make deploy ENV=prod

ENV        ?= local
CLUSTER    ?= urumi
TAG        ?= dev
APPS       := woo-mcp gateway dashboard everything-mcp

.PHONY: up down cluster secrets build load deploy deploy-store deploy-mcp deploy-platform status lint

up: cluster secrets build load deploy ## Full local bring-up

cluster: ## Create kind cluster + Traefik ingress
	./scripts/kind-up.sh $(CLUSTER)

down: ## Delete the kind cluster
	kind delete cluster --name $(CLUSTER)

secrets: ## Create namespaces + Kubernetes Secrets from .secrets/$(ENV).env
	./scripts/create-secrets.sh $(ENV)

build: ## Build all images
	@for app in $(APPS); do docker build -t urumi/$$app:$(TAG) apps/$$app || exit 1; done

load: ## Load images into kind
	@for app in $(APPS); do kind load docker-image urumi/$$app:$(TAG) --name $(CLUSTER) || exit 1; done

deploy: deploy-store deploy-mcp deploy-platform ## helm upgrade --install all three releases

deploy-store:
	# The setup Job (post-install hook) downloads WooCommerce, so allow extra time.
	helm upgrade --install store charts/store -n store -f charts/store/values-$(ENV).yaml --timeout 15m

deploy-mcp:
	helm upgrade --install mcp charts/mcp-servers -n mcp -f charts/mcp-servers/values-$(ENV).yaml

deploy-platform:
	helm upgrade --install platform charts/platform -n platform -f charts/platform/values-$(ENV).yaml

status: ## Show what is running
	kubectl get pods,svc,ingress,pvc -n store
	kubectl get pods,svc,networkpolicy -n mcp
	kubectl get pods,svc,ingress,pvc -n platform

lint: ## helm lint all charts
	helm lint charts/store -f charts/store/values-$(ENV).yaml
	helm lint charts/mcp-servers -f charts/mcp-servers/values-$(ENV).yaml
	helm lint charts/platform -f charts/platform/values-$(ENV).yaml
