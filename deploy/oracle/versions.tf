# Oracle Resource Manager runs Terraform 1.5.x, so stay compatible with it.
terraform {
  required_version = ">= 1.5.0"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 6.37.0"
    }
  }
}

# Resource Manager signs in for us; only the region is needed.
provider "oci" {
  region = var.region
}
