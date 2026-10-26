# One Ubuntu 24.04 server for k3s, in the account's default VPC. It deliberately does not
# touch anything else in the account (there are other instances here that are not ours).

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

# Canonical's current Ubuntu 24.04 LTS (amd64), looked up rather than hard-coded so the AMI
# id never goes stale.
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_key_pair" "this" {
  key_name   = "${var.name}-key"
  public_key = file(pathexpand(var.ssh_public_key_path))
}

resource "aws_security_group" "this" {
  name        = "${var.name}-k3s"
  description = "urumi k3s node: SSH from the operator, web from the allowed ranges"
  vpc_id      = data.aws_vpc.default.id

  # No rule exposes the Kubernetes API (6443): operate it over SSH instead.
  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.ssh_cidrs
  }
  ingress {
    description = "HTTP (ingress and Lets Encrypt HTTP-01)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.web_cidrs
  }
  ingress {
    description = "HTTPS (ingress)"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.web_cidrs
  }
  egress {
    description = "Everything out: image pulls, wordpress.org, the LLM API"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "this" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  subnet_id              = data.aws_subnets.default.ids[0]
  key_name               = aws_key_pair.this.key_name
  vpc_security_group_ids = [aws_security_group.this.id]

  # IMDSv2 only: a compromised pod cannot trivially read instance credentials.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_gb
    encrypted             = true
    delete_on_termination = true
  }

  tags = {
    Name = "${var.name}-k3s"
  }

  lifecycle {
    # A newer Ubuntu AMI must not replace (and wipe) a running server.
    ignore_changes = [ami]
  }
}

# A fixed address, because the site names (<ip>.sslip.io) are derived from it. An Elastic IP
# costs nothing while attached to a running instance.
resource "aws_eip" "this" {
  instance = aws_instance.this.id
  domain   = "vpc"
  tags = {
    Name = "${var.name}-k3s"
  }
}
