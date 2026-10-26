# Operate the AWS deployment. Run from infra/:  make plan | up | deploy | verify | ssh | down
# `aws login` sessions are not read by Terraform directly, so hand it short-lived credentials from the CLI.
AWSENV := eval "$$(aws configure export-credentials --format env)" && AWS_DEFAULT_REGION=ap-southeast-2
TF  := $(AWSENV) terraform -chdir=terraform
IP   = $(shell terraform -chdir=terraform output -raw public_ip)

.PHONY: plan up inventory deploy verify ssh down
plan:      ## Show what Terraform would create (changes nothing)
	$(TF) plan
up:        ## Create the server (costs money while it runs)
	$(TF) apply -auto-approve
inventory: ## Write ansible/inventory.ini from the Terraform output
	printf '[k3s]\n%s ansible_user=ubuntu ansible_ssh_private_key_file=~/.ssh/urumi-aws\n' "$(IP)" > ansible/inventory.ini
deploy: inventory ## Install k3s and deploy Urumi (add EXTRA="-e enable_tls=true -e acme_email=you@example.com")
	cd ansible && ansible-playbook site.yml $(EXTRA)
verify: inventory ## Check the deployment from outside and inside
	cd ansible && ansible-playbook verify.yml
ssh:
	ssh -i ~/.ssh/urumi-aws ubuntu@$(IP)
down:      ## Destroy everything this config created
	$(TF) destroy
