variable "env" {
  description = "Environment name, supplied by the pipeline."
  type        = string
}

variable "product" {
  description = "Product name, supplied by the pipeline."
  type        = string
}

variable "component" {
  description = "Component name, supplied by the pipeline."
  type        = string
  default     = "github-metrics"
}

variable "common_tags" {
  description = "Tags applied to every resource, supplied by the pipeline."
  type        = map(string)
}

variable "subscription_id" {
  description = "Subscription this deploys into, supplied by the pipeline from ARM_SUBSCRIPTION_ID."
  type        = string
}

variable "aks_subscription_id" {
  description = "Subscription holding the network the flexible server joins, supplied by the pipeline."
  type        = string
}

variable "jenkins_AAD_objectId" {
  description = "Object ID of the identity running this, granted admin on the server. Supplied by the pipeline."
  type        = string
}

variable "location" {
  description = "Azure region."
  type        = string
  default     = "uksouth"
}
