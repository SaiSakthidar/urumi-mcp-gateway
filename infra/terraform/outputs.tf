output "public_ip" {
  value = aws_eip.this.public_ip
}

output "ssh" {
  value = "ssh -i ~/.ssh/urumi-aws ubuntu@${aws_eip.this.public_ip}"
}

output "dashboard_url" {
  value = "http://app.${aws_eip.this.public_ip}.sslip.io"
}

output "storefront_url" {
  value = "http://shop.${aws_eip.this.public_ip}.sslip.io"
}

output "instance_id" {
  value = aws_instance.this.id
}
