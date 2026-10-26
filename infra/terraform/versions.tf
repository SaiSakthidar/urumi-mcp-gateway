terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region

  # Everything this config creates carries these tags, so it is easy to find and to see in a bill.
  default_tags {
    tags = {
      Project   = "urumi"
      ManagedBy = "terraform"
    }
  }
}
