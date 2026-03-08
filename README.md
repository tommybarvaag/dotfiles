## Dotfiles

Simple Mac setup: clone the repo, run the installer, and keep secrets local.

### Use

1. If needed, create an SSH key:

```bash
curl -fsSL https://raw.githubusercontent.com/tommybarvaag/dotfiles/main/ssh.sh | bash -s "<your-email>"
```

2. Clone the repo:

```bash
git clone git@github.com:tommybarvaag/dotfiles.git ~/.dotfiles
```

3. Run the installer:

```bash
~/.dotfiles/install.sh
```

4. Restart the terminal.
5. Restore `~/.config/dotfiles/local.env` and `~/.gitconfig.local` if you use them.
6. If VS Code extensions are missing, run `~/.dotfiles/vscode.sh`.

### Non-interactive

```bash
DOTFILES_AUTO=1 ~/.dotfiles/install.sh
```

Use `DOTFILES_RUN_MACOS=1` as well if you want macOS defaults applied in auto mode.

### Notes

- Secrets and machine-specific paths live in `~/.config/dotfiles/local.env`
- Use `shell/local.env.example` as the template
- Machine-specific Git overrides live in `~/.gitconfig.local`
- This repo manages zsh, git, Homebrew, Ghostty, and macOS defaults
