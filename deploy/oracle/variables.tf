# Filled in automatically by Oracle Resource Manager.
variable "tenancy_ocid" {
  type = string
}

variable "region" {
  type = string
}

variable "compartment_ocid" {
  description = "Compartment for all resources. Empty = the tenancy (root) compartment."
  type        = string
  default     = ""
}

# What the owner chooses in the form.
variable "availability_domain" {
  description = "Availability domain name. Empty = the first one in the region."
  type        = string
  default     = ""
}

variable "shape" {
  description = "VM.Standard.A1.Flex (1 OCPU / 6 GB, Arm) or VM.Standard.E2.1.Micro (AMD). Both are Always Free."
  type        = string
  default     = "VM.Standard.A1.Flex"

  validation {
    condition     = contains(["VM.Standard.A1.Flex", "VM.Standard.E2.1.Micro"], var.shape)
    error_message = "shape must be VM.Standard.A1.Flex or VM.Standard.E2.1.Micro (Always Free only)."
  }
}

variable "ssh_public_key" {
  description = "Optional SSH public key for the ubuntu user. May be empty."
  type        = string
  default     = ""
}

variable "roles" {
  description = "Comma separated services to install: runner, agents, validator."
  type        = string
  default     = "runner"

  validation {
    condition = length(compact([for r in split(",", var.roles) : trimspace(r)])) > 0 && alltrue([
      for r in compact([for r in split(",", var.roles) : trimspace(r)]) : contains(["runner", "agents", "validator"], r)
    ])
    error_message = "roles must be a comma list of: runner, agents, validator."
  }
}

variable "enable_run_command" {
  description = "Create the IAM dynamic group + policy so the console's Run command works on this VM."
  type        = bool
  default     = true
}
