#!/usr/bin/env bash

set -euo pipefail

DOTFILES="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
AUTO="${DOTFILES_AUTO:-0}"
RUN_MACOS="${DOTFILES_RUN_MACOS:-0}"
LOCAL_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/dotfiles"
LOCAL_ENV_FILE="$LOCAL_CONFIG_DIR/.env"
TIMESTAMP="$(date +%Y%m%d%H%M%S)"

log_step() {
  printf '\n==> %s\n' "$1"
}

prompt_or_default() {
  local prompt="$1"
  local default="$2"
  local reply

  if [[ "$AUTO" == "1" ]]; then
    printf '%s\n' "$default"
    return
  fi

  read -r -p "$prompt [$default]: " reply
  printf '%s\n' "${reply:-$default}"
}

confirm_or_default() {
  local prompt="$1"
  local default="$2"
  local reply

  if [[ "$AUTO" == "1" ]]; then
    [[ "$default" =~ ^[Yy]$ ]]
    return
  fi

  read -r -p "$prompt [$default]: " reply
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy]$ ]]
}

ensure_xcode_cli() {
  if xcode-select -p >/dev/null 2>&1; then
    return
  fi

  log_step "Installing Xcode Command Line Tools"
  xcode-select --install || true

  if [[ "$AUTO" == "1" ]]; then
    echo "Complete the Xcode Command Line Tools installation, then rerun install.sh."
    exit 1
  fi

  until xcode-select -p >/dev/null 2>&1; do
    sleep 5
  done
}

ensure_homebrew() {
  if ! command -v brew >/dev/null 2>&1; then
    log_step "Installing Homebrew"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  fi

  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
}

ensure_oh_my_zsh() {
  if [[ -d "$HOME/.oh-my-zsh" ]]; then
    return
  fi

  log_step "Installing Oh My Zsh"
  RUNZSH=no CHSH=no KEEP_ZSHRC=yes sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/HEAD/tools/install.sh)"
}

backup_target() {
  local target="$1"
  local backup="${target}.backup.${TIMESTAMP}"

  mv "$target" "$backup"
  printf 'Backed up %s to %s\n' "$target" "$backup"
}

link_file() {
  local source="$1"
  local target="$2"
  local current

  mkdir -p "$(dirname "$target")"

  if [[ -L "$target" ]]; then
    current="$(readlink "$target")"
    if [[ "$current" == "$source" ]]; then
      return
    fi
  fi

  if [[ -e "$target" || -L "$target" ]]; then
    backup_target "$target"
  fi

  ln -s "$source" "$target"
}

ensure_local_env() {
  mkdir -p "$LOCAL_CONFIG_DIR"
  chmod 700 "$LOCAL_CONFIG_DIR"

  if [[ ! -f "$LOCAL_ENV_FILE" ]]; then
    cp "$DOTFILES/shell/.env.example" "$LOCAL_ENV_FILE"
  fi

  chmod 600 "$LOCAL_ENV_FILE"
}

upsert_export() {
  local file="$1"
  local name="$2"
  local value="$3"

  python3 - "$file" "$name" "$value" <<'PY'
from pathlib import Path
import sys

file_path, name, value = sys.argv[1:]
path = Path(file_path)
lines = path.read_text().splitlines()
needle = f"export {name}="
escaped = value.replace("\\", "\\\\").replace('"', '\\"')
replacement = f'export {name}="{escaped}"'

for index, line in enumerate(lines):
    if line.startswith(needle):
        lines[index] = replacement
        break
else:
    if lines and lines[-1] != "":
        lines.append("")
    lines.append(replacement)

path.write_text("\n".join(lines) + "\n")
PY
}

install_brew_bundle() {
  log_step "Installing Homebrew bundle"
  brew update
  if ! brew bundle --file "$DOTFILES/Brewfile"; then
    echo "Warning: some Homebrew packages failed to install."
    echo "Run 'brew bundle --file ~/.dotfiles/Brewfile' to retry."
  fi

  # if [[ -f "$DOTFILES/Brewfile.mas" ]]; then
  #   log_step "Installing Mac App Store apps"
  #   if ! brew bundle --file "$DOTFILES/Brewfile.mas"; then
  #     echo "Warning: some Mac App Store apps failed to install."
  #     echo "Ensure you are signed into the App Store, then run:"
  #     echo "  brew bundle --file ~/.dotfiles/Brewfile.mas"
  #   fi
  # fi
}

install_node_lts() {
  if ! command -v fnm >/dev/null 2>&1; then
    return
  fi

  log_step "Installing latest Node LTS with fnm"
  eval "$(fnm env --shell bash)"
  fnm install --lts
}

ensure_git_fuzzy() {
  mkdir -p "$DOTFILES/tools"

  if [[ -d "$DOTFILES/tools/git-fuzzy/.git" ]]; then
    return
  fi

  log_step "Cloning git-fuzzy"
  git clone https://github.com/bigH/git-fuzzy.git "$DOTFILES/tools/git-fuzzy"
}

install_vscode_extensions() {
  if [[ ! -x "$DOTFILES/vscode.sh" ]]; then
    return
  fi

  "$DOTFILES/vscode.sh"
}

configure_local_settings() {
  local projects_dir
  local computer_name

  ensure_local_env

  projects_dir="$(prompt_or_default "Project directory" "$HOME/src")"
  upsert_export "$LOCAL_ENV_FILE" "PROJECTS_DIR" "$projects_dir"
  mkdir -p "$projects_dir/personal" "$projects_dir/work"

  computer_name="$(prompt_or_default "Computer name" "$(scutil --get ComputerName 2>/dev/null || hostname -s)")"

  if [[ "$AUTO" == "1" && "$RUN_MACOS" != "1" ]]; then
    return
  fi

  if confirm_or_default "Run macOS defaults now?" "Y"; then
    "$DOTFILES/macos.sh" "$computer_name"
  fi
}

ensure_hushlogin() {
  touch "$HOME/.hushlogin"
}

main() {
  ensure_xcode_cli
  ensure_homebrew
  ensure_oh_my_zsh

  log_step "Linking managed dotfiles"
  link_file "$DOTFILES/shell/.zprofile" "$HOME/.zprofile"
  link_file "$DOTFILES/shell/.zshrc" "$HOME/.zshrc"
  link_file "$DOTFILES/shell/.p10k.zsh" "$HOME/.p10k.zsh"
  link_file "$DOTFILES/git/.gitconfig" "$HOME/.gitconfig"
  link_file "$DOTFILES/git/.gitignore_global" "$HOME/.gitignore_global"
  link_file "$DOTFILES/.agents" "$HOME/.agents"
  link_file "$DOTFILES/config/ghostty/config" "$HOME/.config/ghostty/config"

  install_brew_bundle
  install_vscode_extensions
  install_node_lts
  ensure_git_fuzzy
  configure_local_settings
  ensure_hushlogin

  echo
  echo "Done. Restart your terminal, then restore ~/.gitconfig.local if you use one."
  echo "Local secrets live in $LOCAL_ENV_FILE"
  if [[ "$AUTO" == "1" && "$RUN_MACOS" != "1" ]]; then
    echo "macOS defaults were skipped. Run DOTFILES_RUN_MACOS=1 ~/.dotfiles/install.sh to apply them."
  fi
}

main "$@"
