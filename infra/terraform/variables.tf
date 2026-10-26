variable "region" {
  description = "AWS region. ap-southeast-2 is the region this account's organization policy allows EC2 in."
  type        = string
  default     = "ap-southeast-2"
}

variable "name" {
  description = "Name prefix for every resource."
  type        = string
  default     = "urumi"
}

variable "instance_type" {
  description = "2 vCPU / 8 GiB runs the platform plus one or two provisioned stores (each store adds ~1 CPU / 1.5 GiB). m7i-flex.large is used because this account's plan only allows free-tier-eligible types, and it matches a t3.large on size and architecture."
  type        = string
  default     = "m7i-flex.large"
}

variable "root_volume_gb" {
  description = "Root disk. Images, WordPress and MariaDB volumes (k3s local-path) live here."
  type        = number
  default     = 40
}

variable "ssh_public_key_path" {
  description = "Public half of the key Ansible uses. Generate one just for this: ssh-keygen -t ed25519 -f ~/.ssh/urumi-aws"
  type        = string
  default     = "~/.ssh/urumi-aws.pub"
}

variable "ssh_cidrs" {
  description = "Who may SSH in. Set to your address, e.g. [\"203.0.113.7/32\"]. Never 0.0.0.0/0."
  type        = list(string)
}

variable "web_cidrs" {
  description = "Who may reach ports 80 and 443 (dashboard, storefront, MCP endpoint). Keep it to your address while testing; open to [\"0.0.0.0/0\"] for the demo or when Let's Encrypt must validate."
  type        = list(string)
}
