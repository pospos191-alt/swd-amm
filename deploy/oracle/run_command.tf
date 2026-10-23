# Console "Run command" needs the VM to be allowed to fetch commands.
# Identity resources must be created in the home region.

data "oci_identity_region_subscriptions" "home" {
  tenancy_id = var.tenancy_ocid

  filter {
    name   = "is_home_region"
    values = ["true"]
  }
}

provider "oci" {
  alias  = "home"
  region = data.oci_identity_region_subscriptions.home.region_subscriptions[0].region_name
}

locals {
  runcmd_name = "zetaphy-runcmd-${substr(md5(oci_core_instance.zetaphy.id), 0, 8)}"
}

resource "oci_identity_dynamic_group" "runcmd" {
  count    = var.enable_run_command ? 1 : 0
  provider = oci.home

  compartment_id = var.tenancy_ocid
  name           = local.runcmd_name
  description    = "ZETAPHY node (Run command)"
  matching_rule  = "instance.id = '${oci_core_instance.zetaphy.id}'"
}

resource "oci_identity_policy" "runcmd" {
  count    = var.enable_run_command ? 1 : 0
  provider = oci.home

  compartment_id = local.compartment_id
  name           = local.runcmd_name
  description    = "ZETAPHY node may receive Run command jobs"
  statements = [
    "Allow dynamic-group ${oci_identity_dynamic_group.runcmd[0].name} to use instance-agent-command-execution-family in compartment id ${local.compartment_id}",
  ]
}
