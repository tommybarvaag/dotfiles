#!/usr/bin/env bash

set -euo pipefail

usage() {
  printf 'usage: %s <email> [--eddsa|eddsa]\n' "$(basename "$0")" >&2
}

cleanup() {
  rm -f "${managed_block_file:-}" "${tmp_file:-}"
}

managed_github_block() {
  cat <<EOF
# dotfiles-github start
Host github.com
  AddKeysToAgent yes
  UseKeychain yes
  IdentityFile $identity_file
# dotfiles-github end
EOF
}

replace_managed_blocks() {
  awk -v block_file="$managed_block_file" -v start_marker="$start_marker" -v end_marker="$end_marker" '
    BEGIN {
      while ((getline line < block_file) > 0) {
        block[++block_count] = line
      }
      close(block_file)
    }
    $0 == start_marker {
      if (!inserted) {
        for (i = 1; i <= block_count; i++) {
          print block[i]
        }
        inserted = 1
      }
      skipping = 1
      next
    }
    skipping {
      if ($0 == end_marker) {
        skipping = 0
      }
      next
    }
    {
      print
    }
  ' "$config_file" > "$tmp_file"
}

find_legacy_block_start() {
  local candidate_line block next_line

  while IFS=: read -r candidate_line _; do
    block="$(sed -n "${candidate_line},$((candidate_line + 3))p" "$config_file")"
    next_line="$(sed -n "$((candidate_line + 4))p" "$config_file")"

    if [[ ( "$block" == "$legacy_ed25519_block" || "$block" == "$legacy_rsa_block" ) && ( -z "$next_line" || "$next_line" == Host* || "$next_line" == Match* ) ]]; then
      printf '%s\n' "$candidate_line"
      return 0
    fi
  done < <(grep -n '^Host github\.com$' "$config_file" || true)

  return 1
}

replace_range_with_block() {
  local start_line="$1"
  local end_line="$2"

  awk -v block_file="$managed_block_file" -v start_line="$start_line" -v end_line="$end_line" '
    BEGIN {
      while ((getline line < block_file) > 0) {
        block[++block_count] = line
      }
      close(block_file)
    }
    NR == start_line {
      for (i = 1; i <= block_count; i++) {
        print block[i]
      }
    }
    NR < start_line || NR > end_line {
      print
    }
  ' "$config_file" > "$tmp_file"
}

upsert_github_block() {
  local legacy_start_line action

  touch "$config_file"
  chmod 600 "$config_file"

  managed_block_file="$(mktemp "${TMPDIR:-/tmp}/dotfiles-ssh-block.XXXXXX")"
  tmp_file="$(mktemp "${TMPDIR:-/tmp}/dotfiles-ssh-config.XXXXXX")"
  managed_github_block > "$managed_block_file"

  if grep -Fq "$start_marker" "$config_file"; then
    replace_managed_blocks
    action="Updated"
  elif legacy_start_line="$(find_legacy_block_start)"; then
    replace_range_with_block "$legacy_start_line" "$((legacy_start_line + 3))"
    action="Updated"
  else
    cp "$config_file" "$tmp_file"
    if [[ -s "$tmp_file" && -n "$(tail -n 1 "$tmp_file")" ]]; then
      printf '\n' >> "$tmp_file"
    fi
    cat "$managed_block_file" >> "$tmp_file"
    action="Added"
  fi

  mv "$tmp_file" "$config_file"
  tmp_file=""
  echo "$action GitHub host block in $config_file"
}

if [[ $# -eq 1 && ( "$1" == "-h" || "$1" == "--help" ) ]]; then
  usage
  exit 0
fi

if [[ $# -lt 1 || $# -gt 2 || -z "$1" || "$1" == "--eddsa" || "$1" == "eddsa" ]]; then
  usage
  exit 1
fi

email="$1"
key_path="$HOME/.ssh/id_rsa"
identity_file="~/.ssh/id_rsa"
key_label="RSA (4096-bit)"
keygen_args=(-t rsa -b 4096)
config_file="$HOME/.ssh/config"
start_marker="# dotfiles-github start"
end_marker="# dotfiles-github end"
legacy_ed25519_block=$'Host github.com\n  AddKeysToAgent yes\n  UseKeychain yes\n  IdentityFile ~/.ssh/id_ed25519'
legacy_rsa_block=$'Host github.com\n  AddKeysToAgent yes\n  UseKeychain yes\n  IdentityFile ~/.ssh/id_rsa'
managed_block_file=""
tmp_file=""

if [[ $# -eq 2 ]]; then
  case "$2" in
    --eddsa|eddsa)
      key_path="$HOME/.ssh/id_ed25519"
      identity_file="~/.ssh/id_ed25519"
      key_label="Ed25519"
      keygen_args=(-t ed25519)
      ;;
    *)
      usage
      exit 1
      ;;
  esac
fi

trap cleanup EXIT

mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"

if [[ ! -f "$key_path" ]]; then
  echo "Generating a new $key_label SSH key for GitHub..."
  ssh-keygen "${keygen_args[@]}" -C "$email" -f "$key_path"
else
  echo "SSH key already exists at $key_path"
fi

eval "$(ssh-agent -s)" >/dev/null
ssh-add --apple-use-keychain "$key_path"

upsert_github_block

if command -v pbcopy >/dev/null 2>&1; then
  pbcopy < "${key_path}.pub"
  echo "Public key copied to clipboard."
else
  echo "Run: cat ${key_path}.pub"
fi

echo "Add the public key to GitHub:"
echo "https://github.com/settings/keys"
