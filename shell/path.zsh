typeset -gU path fpath

export DOTNET_ROOT="$HOME/.dotnet"

# Earlier entries win. Tool installers (LM Studio, nub, grok, opencode,
# Windsurf) append their own PATH lines to .zshrc: fold them in here instead.
path=(
  "$HOME/.codeium/windsurf/bin"
  "$HOME/.opencode/bin"
  "$HOME/.grok/bin"
  "$HOME/.nub/bin"
  "$DOTNET_ROOT"
  "$DOTFILES/tools/git-fuzzy/bin"
  "$HOME/.local/bin"
  $path
  ${(s.:.)DOTFILES_EXTRA_PATHS}
  "$HOME/.lmstudio/bin"
)

# Drop missing and relative entries (/etc/paths.d can add a literal "~/...").
path=(${^${(M)path:#/*}}(N-/))
