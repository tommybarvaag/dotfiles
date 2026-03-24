#!/usr/bin/env bash

set -euo pipefail

DOTFILES="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
EXTENSIONS_FILE="$DOTFILES/vscode/extensions.txt"

find_code_cli() {
  if command -v code >/dev/null 2>&1; then
    command -v code
    return
  fi

  if [[ -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]]; then
    printf '%s\n' "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
  fi
}

main() {
  local code_cli

  if [[ ! -f "$EXTENSIONS_FILE" ]]; then
    echo "No VS Code extension list found at $EXTENSIONS_FILE"
    return
  fi

  code_cli="$(find_code_cli || true)"

  if [[ -z "$code_cli" ]]; then
    echo "Skipping VS Code extensions. Open Visual Studio Code once or install the 'code' shell command, then rerun ~/.dotfiles/vscode.sh"
    return
  fi

  echo "Installing VS Code extensions..."

  while IFS= read -r extension || [[ -n "$extension" ]]; do
    if [[ -z "$extension" || "$extension" == \#* ]]; then
      continue
    fi

    "$code_cli" --install-extension "$extension" --force
  done < "$EXTENSIONS_FILE"
}

main "$@"
