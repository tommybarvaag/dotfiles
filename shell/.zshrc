# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.zshrc.
# Initialization code that may require console input (password prompts, [y/n]
# confirmations, etc.) must go above this block; everything else may go below.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

# Resolve the repo from this file's real path so any checkout or worktree works.
export DOTFILES="${${(%):-%x}:A:h:h}"
export DOTFILES_LOCAL_ENV="${XDG_CONFIG_HOME:-$HOME/.config}/dotfiles/.env"

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

: ${HOMEBREW_PREFIX:=/opt/homebrew}
ZSH_CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/zsh"
[[ -d "$ZSH_CACHE_DIR" ]] || mkdir -p "$ZSH_CACHE_DIR"

# PATH first: every PATH change empties zsh's command hash.
source "$DOTFILES/shell/path.zsh"
source "$DOTFILES/shell/options.zsh"
source "$DOTFILES/shell/completion.zsh"

# Source a tool's generated init script from a cache. The file name includes
# the binary's resolved path, which changes on every Homebrew upgrade.
_cached_init() {
  local bin=${commands[$1]:A}
  [[ -n $bin ]] || return 0
  local cache="$ZSH_CACHE_DIR/init-${${:-$bin $*}//[^[:alnum:]]/_}.zsh"
  if [[ ! -s $cache ]]; then
    command rm -f "$ZSH_CACHE_DIR"/init-*_bin_$1_*(N)
    "$@" >| $cache || return
    zcompile $cache
  fi
  source $cache
}

_cached_init zoxide init zsh
_cached_init fzf --zsh

export FZF_DEFAULT_COMMAND='fd --type f --strip-cwd-prefix'
export FZF_CTRL_T_COMMAND="$FZF_DEFAULT_COMMAND"
export FZF_DEFAULT_OPTS='--height=40% --preview="bat --color=always --style=numbers --line-range=:200 {} 2>/dev/null" --preview-window=right:60%:wrap'
export FZF_CTRL_T_OPTS="--preview 'bat -n --color=always --line-range=:200 {} 2>/dev/null || eza --tree --icons --color=always --level=2 {} 2>/dev/null'"
export FZF_CTRL_R_OPTS='--preview-window=hidden'
export FZF_ALT_C_OPTS="--preview 'eza --tree --icons --color=always --level=2 {} 2>/dev/null'"
export GF_PREFERRED_PAGER="delta"
export GF_BAT_STYLE="numbers"

# fnm costs ~14 ms per shell and leaves a symlink behind each time, so it only
# starts in a directory its cd hook would act on, or when `fnm` is run. Until
# then the default Node is on PATH directly.
if (( $+commands[fnm] )); then
  export FNM_DIR="${FNM_DIR:-$HOME/.local/share/fnm}"
  path=("$FNM_DIR/aliases/default/bin" $path)

  _fnm_init() {
    chpwd_functions=(${chpwd_functions:#_fnm_lazy})
    unfunction fnm _fnm_init _fnm_lazy
    path=(${path:#${(b)FNM_DIR}/aliases/default/bin})
    # Run from / so fnm env doesn't switch Node itself and announce it (only
    # quiet hides that); _fnm_lazy does the switch at the level it's given.
    eval "$(builtin cd -q / && command fnm env --use-on-cd --shell zsh)"
  }
  _fnm_lazy() {
    [[ -f .node-version || -f .nvmrc || -f package.json ]] || return 0
    _fnm_init
    command fnm --log-level=${1:-info} use --silent-if-unchanged
  }
  fnm() {
    _fnm_init
    command fnm "$@"
  }

  chpwd_functions+=(_fnm_lazy)
  # p10k's instant prompt flags any output during startup; keep errors only.
  _fnm_lazy error
fi

source "$DOTFILES/shell/aliases.zsh"
source "$DOTFILES/shell/functions.zsh"

if [[ -r "$HOMEBREW_PREFIX/share/powerlevel10k/powerlevel10k.zsh-theme" ]]; then
  # p10k forks `who -m` (~4 ms) to spot SSH sessions that lost their SSH_*
  # variables. A local terminal can tell it up front.
  if [[ -z "$SSH_CONNECTION$SSH_CLIENT$SSH_TTY" ]]; then
    typeset -gix P9K_SSH=0
    typeset -gx _P9K_SSH_TTY=$TTY
  fi
  source "$HOMEBREW_PREFIX/share/powerlevel10k/powerlevel10k.zsh-theme"
  source "$DOTFILES/shell/.p10k.zsh"
fi
