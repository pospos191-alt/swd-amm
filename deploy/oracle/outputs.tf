output "public_ip" {
  description = "Public IP of the ZETAPHY node."
  value       = oci_core_instance.zetaphy.public_ip
}

output "instance_ocid" {
  description = "OCID of the instance."
  value       = oci_core_instance.zetaphy.id
}

output "next_steps" {
  description = "What to do next."
  value       = "Wait ~5 minutes for the install to finish (รอประมาณ 5 นาที). Then read the runner address with the console's Run command on the instance (sudo zetaphy-runner address), or from Cloud Shell: ssh ubuntu@${oci_core_instance.zetaphy.public_ip} sudo zetaphy-runner address"
}
