# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.zshrc.
# Initialization code that may require console input (password prompts, [y/n]
# confirmations, etc.) must go above this block; everything else may go below.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

export DOTFILES="$HOME/.dotfiles"
export DOTFILES_LOCAL_ENV="${DOTFILES}/.env"

if [[ -f "$DOTFILES_LOCAL_ENV" ]]; then
  source "$DOTFILES_LOCAL_ENV"
fi

export PROJECTS_DIR="${PROJECTS_DIR:-$HOME/src}"
export EDITOR="nvim"
export LC_ALL="en_US.UTF-8"
export LANG="en_US.UTF-8"
export LESSSECURE=1
export LESS_TERMCAP_md=$'\E[1;35m'
export LESS_TERMCAP_me=$'\E[0m'
export LESS_TERMCAP_so=$'\E[01;33m'
export LESS_TERMCAP_se=$'\E[0m'
export LESS_TERMCAP_us=$'\E[1;36m'
export LESS_TERMCAP_ue=$'\E[0m'
export PATH="$DOTFILES/tools/git-fuzzy/bin:$HOME/.local/bin:$PATH"

if [[ -n "${DOTFILES_EXTRA_PATHS:-}" ]]; then
  export PATH="$PATH:$DOTFILES_EXTRA_PATHS"
fi

export ZSH="$HOME/.oh-my-zsh"
export ZSH_CUSTOM="$DOTFILES/shell"
ZSH_THEME=""
HIST_STAMPS="dd/mm/yyyy"

source "$ZSH/oh-my-zsh.sh"

if [[ -r /opt/homebrew/share/powerlevel10k/powerlevel10k.zsh-theme ]]; then
  source /opt/homebrew/share/powerlevel10k/powerlevel10k.zsh-theme
elif [[ -r /usr/local/share/powerlevel10k/powerlevel10k.zsh-theme ]]; then
  source /usr/local/share/powerlevel10k/powerlevel10k.zsh-theme
fi

[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh

if command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env --use-on-cd)"
fi

if command -v zoxide >/dev/null 2>&1; then
  eval "$(zoxide init zsh)"
fi

if [[ -s "$HOME/.bun/_bun" ]]; then
  source "$HOME/.bun/_bun"
fi

if [[ -f "$HOME/.fzf.zsh" ]]; then
  source "$HOME/.fzf.zsh"
fi

export FZF_DEFAULT_COMMAND='fd --type f --strip-cwd-prefix'
export FZF_CTRL_T_COMMAND="$FZF_DEFAULT_COMMAND"
export FZF_DEFAULT_OPTS='--height=40% --preview="bat --color=always --style=numbers --line-range=:200 {} 2>/dev/null" --preview-window=right:60%:wrap'
export FZF_CTRL_T_OPTS="--preview 'bat -n --color=always --line-range=:200 {} 2>/dev/null || eza --tree --icons --color=always --level=2 {} 2>/dev/null'"
export GF_PREFERRED_PAGER="delta"
export GF_BAT_STYLE="numbers"
