#!/usr/bin/env bash
# Keep existing repository ownership and its existing Deploy Key identity.
repository_git() {
  local repository_uid repository_user
  repository_uid="$(stat -c %u .git)" || return 1
  if [[ "$EUID" == "$repository_uid" ]]; then
    command git "$@"
    return
  fi
  if [[ "$EUID" != 0 ]]; then
    printf '%s\n' 'Git must run as the repository owner or through the authorized root deployment.' >&2
    return 1
  fi
  repository_user="$(getent passwd "$repository_uid" | cut -d: -f1)"
  if [[ -z "$repository_user" ]] || ! command -v runuser >/dev/null; then
    printf '%s\n' 'Existing repository identity cannot be resolved; no trust configuration was changed.' >&2
    return 1
  fi
  runuser -u "$repository_user" -- git "$@"
}
