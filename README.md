## Dotfiles

Simple Mac setup: clone the repo, run the installer, and keep secrets local.

### Use

1. If needed, create an SSH key:

```bash
curl -fsSL https://raw.githubusercontent.com/tommybarvaag/dotfiles/main/ssh.sh | bash -s "<your-email>"
```

Append `--eddsa` if you specifically want an Ed25519 key instead of the default RSA key.

2. Clone the repo:

```bash
git clone git@github.com:tommybarvaag/dotfiles.git ~/.dotfiles
```

3. Run the installer:

```bash
~/.dotfiles/install.sh
```

This also manages `~/.agents` by symlinking it to `~/.dotfiles/.agents`.

4. Restart the terminal.
5. Restore `~/.config/dotfiles/.env` and `~/.gitconfig.local` if you use them.
6. If VS Code extensions are missing, run `~/.dotfiles/vscode.sh`.

### Non-interactive

```bash
DOTFILES_AUTO=1 ~/.dotfiles/install.sh
```

Use `DOTFILES_RUN_MACOS=1` as well if you want macOS defaults applied in auto mode.

### Neovim

LazyVim is preinstalled under `config/nvim/` and symlinked to `~/.config/nvim`. The `lang.typescript.tsgo` and `lang.typescript.oxc` extras wire up the Go port of tsserver plus oxlint/oxfmt for TypeScript work. The `tsgo` LSP binary ships via npm and is not installed by the script; run this once after your first shell reload (Node must be active via `fnm`):

```bash
npm i -g @typescript/native-preview
```

Launch `nvim` once to let lazy.nvim install plugins, then `git add config/nvim/lazy-lock.json` and commit to pin plugin versions.

### Notes

- Secrets and machine-specific paths live in `~/.config/dotfiles/.env`
- Use `shell/.env.example` as the template
- Machine-specific Git overrides live in `~/.gitconfig.local`
- This repo manages zsh, git, Homebrew, Ghostty, Neovim (LazyVim), global agent skills via `~/.agents`, and macOS defaults
