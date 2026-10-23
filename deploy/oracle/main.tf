# ZETAPHY node on Oracle Cloud Always Free.
#
# "Out of host capacity" = Oracle has no free machine left right now, nothing is broken.
#   Just press Apply again later (or pick another availability domain / the Micro size).
# "Out of host capacity" = Oracle has no free machine right now; nothing is broken.
#   Click Apply again later (or pick another availability domain / the Micro size).

locals {
  compartment_id = var.compartment_ocid != "" ? var.compartment_ocid : var.tenancy_ocid
  is_flex        = var.shape == "VM.Standard.A1.Flex"
  roles          = distinct(compact([for r in split(",", var.roles) : trimspace(r)]))
  ad_name        = var.availability_domain != "" ? var.availability_domain : data.oci_identity_availability_domains.ads.availability_domains[0].name
  installer_url  = "https://raw.githubusercontent.com/pospos191-alt/swd-amm/main/install.sh"

  # Public script only: never put secrets here (user_data is readable in the console).
  user_data = <<-EOT
    #!/bin/bash
    set -uo pipefail
    exec >>/var/log/zetaphy-install.log 2>&1
    echo "=== zetaphy install start $(date -u) ==="
    export HOME=/root DEBIAN_FRONTEND=noninteractive
    ${join("\n", [for r in local.roles : "curl -fsSL --retry 10 --retry-delay 15 --retry-all-errors ${local.installer_url} | bash -s -- ${r} || echo \"role ${r} failed\""])}
    echo "=== zetaphy install end $(date -u) ==="
  EOT
}

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.tenancy_ocid
}

data "oci_core_images" "ubuntu" {
  compartment_id           = local.compartment_id
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = var.shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

resource "oci_core_vcn" "zetaphy" {
  compartment_id = local.compartment_id
  cidr_blocks    = ["10.10.0.0/16"]
  display_name   = "zetaphy-vcn"
  dns_label      = "zetaphy"
}

resource "oci_core_internet_gateway" "zetaphy" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.zetaphy.id
  display_name   = "zetaphy-igw"
  enabled        = true
}

resource "oci_core_route_table" "zetaphy" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.zetaphy.id
  display_name   = "zetaphy-rt"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.zetaphy.id
  }
}

# Only SSH in; everything out.
resource "oci_core_security_list" "zetaphy" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.zetaphy.id
  display_name   = "zetaphy-sl"

  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }

  ingress_security_rules {
    source   = "0.0.0.0/0"
    protocol = "6" # TCP

    tcp_options {
      min = 22
      max = 22
    }
  }

  # A validator: P2P (26656) and its public HTTPS RPC (80 for the certificate, 443).
  dynamic "ingress_security_rules" {
    for_each = contains(local.roles, "validator") ? [26656, 80, 443] : []
    content {
      source   = "0.0.0.0/0"
      protocol = "6"
      tcp_options {
        min = ingress_security_rules.value
        max = ingress_security_rules.value
      }
    }
  }
}

resource "oci_core_subnet" "public" {
  compartment_id             = local.compartment_id
  vcn_id                     = oci_core_vcn.zetaphy.id
  cidr_block                 = "10.10.1.0/24"
  display_name               = "zetaphy-public"
  dns_label                  = "public"
  route_table_id             = oci_core_route_table.zetaphy.id
  security_list_ids          = [oci_core_security_list.zetaphy.id]
  prohibit_public_ip_on_vnic = false
}

resource "oci_core_instance" "zetaphy" {
  compartment_id      = local.compartment_id
  availability_domain = local.ad_name
  display_name        = "zetaphy-node"
  shape               = var.shape

  dynamic "shape_config" {
    for_each = local.is_flex ? [1] : []
    content {
      ocpus         = 1
      memory_in_gbs = 6
    }
  }

  # Lets the console's "Run command" reach the VM (policy in run_command.tf).
  agent_config {
    plugins_config {
      name          = "Compute Instance Run Command"
      desired_state = "ENABLED"
    }
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public.id
    assign_public_ip = true
    display_name     = "zetaphy-vnic"
  }

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu.images[0].id
    boot_volume_size_in_gbs = 50 # Always Free allows 200 GB in total
  }

  metadata = merge(
    { user_data = base64encode(local.user_data) },
    trimspace(var.ssh_public_key) != "" ? { ssh_authorized_keys = trimspace(var.ssh_public_key) } : {}
  )

  # Delete the disk with the VM so Destroy leaves nothing behind.
  preserve_boot_volume = false

  lifecycle {
    precondition {
      condition     = length(data.oci_core_images.ubuntu.images) > 0
      error_message = "No Ubuntu 24.04 image found for this shape in this region."
    }
    # A newer image or edited roles must not wipe a running node.
    # To change roles: Destroy, then Apply.
    ignore_changes = [source_details[0].source_id, metadata]
  }
}
