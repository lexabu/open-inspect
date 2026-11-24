# =============================================================================
# GitHub Bot Configuration
# =============================================================================

variable "enable_github_bot" {
  description = "Enable the GitHub bot worker. Requires github_webhook_secret and github_bot_username."
  type        = bool
  default     = false

  validation {
    condition     = var.enable_github_bot == false || (length(var.github_webhook_secret) > 0 && length(var.github_bot_username) > 0)
    error_message = "When enable_github_bot is true, github_webhook_secret and github_bot_username must be non-empty."
  }
}

variable "github_webhook_secret" {
  description = "Shared secret for verifying GitHub webhook signatures (generate with: openssl rand -hex 32)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "github_bot_username" {
  description = "GitHub App bot username for @mention detection (e.g., 'my-app[bot]')"
  type        = string
  default     = ""
}

variable "github_bot_command" {
  description = "Optional short command that also calls the GitHub bot: `/<command>` anywhere in a PR comment, or `<command>` at the start of a line (e.g., 'npai'). Empty for none."
  type        = string
  default     = ""

  validation {
    condition     = can(regex("^([A-Za-z0-9][A-Za-z0-9-]*)?$", var.github_bot_command))
    error_message = "github_bot_command must be empty, or letters, digits and hyphens starting with a letter or digit."
  }
}

variable "github_bot_default_model" {
  description = "Model the GitHub bot starts a session with when the repository's integration config does not pin one. A canonical \"provider/model\" id, or a bare \"claude-\"/\"gpt-\" id the bots normalize into that provider's namespace."
  type        = string
  default     = "anthropic/claude-haiku-4-5"
  nullable    = false

  # Each side of the id must name something, and name it without whitespace:
  # "anthropic/", "claude-" and "/x" all pass a naive prefix or slash check
  # while naming no model, and "anthropic/ claude-haiku-4-5" survives a
  # trimspace check with the space still in the value. Either shape reaches the
  # model provider verbatim. The same rule rejects a blank value, so an unset
  # CI variable fails at plan time instead of deploying a bot that cannot start
  # a session.
  validation {
    condition = can(regex(
      "^(?:[^/[:space:]]+/[^/[:space:]]+|(?:claude-|gpt-)[^/[:space:]]+)$",
      var.github_bot_default_model
    ))
    error_message = "github_bot_default_model must be a canonical \"provider/model\" id such as \"anthropic/claude-haiku-4-5\", or a bare \"claude-\"/\"gpt-\" id, naming a model with no whitespace on each side of any slash."
  }
}
