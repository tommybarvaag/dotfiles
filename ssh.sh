#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'usage: %s <email>\n' "$(basename "$0")" >&2
  exit 1
fi

email="$1"
key_path="$HOME/.ssh/id_ed25519"
config_file="$HOME/.ssh/config"

mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"

if [[ ! -f "$key_path" ]]; then
  echo "Generating a new SSH key for GitHub..."
  ssh-keygen -t ed25519 -C "$email" -f "$key_path"
else
  echo "SSH key already exists at $key_path"
fi

eval "$(ssh-agent -s)" >/dev/null
ssh-add --apple-use-keychain "$key_path"

touch "$config_file"
chmod 600 "$config_file"

if ! grep -q '^Host github\.com$' "$config_file"; then
  cat >>"$config_file" <<'EOF'

Host github.com
  AddKeysToAgent yes
  UseKeychain yes
  IdentityFile ~/.ssh/id_ed25519
EOF
  echo "Added GitHub host block to $config_file"
else
  echo "GitHub host block already present in $config_file"
fi

if command -v pbcopy >/dev/null 2>&1; then
  pbcopy < "${key_path}.pub"
  echo "Public key copied to clipboard."
else
  echo "Run: cat ${key_path}.pub"
fi

echo "Add the public key to GitHub:"
echo "https://github.com/settings/keys"
