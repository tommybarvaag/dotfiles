# Completion. Every fpath entry must be added before compinit runs.
fpath=(
  "$DOTFILES/shell/completions"
  "$HOMEBREW_PREFIX/share/zsh/site-functions"
  "$HOME/.grok/completions/zsh"
  $fpath
)
fpath=(${^fpath}(N-/))

zmodload zsh/complist
autoload -Uz compinit

# Reuse the dump with `compinit -C` (no security audit, no fpath scan) until a
# completion dir changes, e.g. when brew links or unlinks a formula.
() {
  local dump=$ZSH_CACHE_DIR/zcompdump-$ZSH_VERSION dir
  for dir in $fpath; do
    if [[ $dir -nt $dump ]]; then
      command rm -f $dump $dump.zwc
      break
    fi
  done
  if [[ -e $dump ]]; then
    compinit -C -d $dump
  else
    compinit -i -d $dump
  fi
  [[ $dump.zwc -nt $dump ]] || zcompile $dump
}

setopt auto_menu complete_in_word always_to_end
unsetopt menu_complete

bindkey -M menuselect '^o' accept-and-infer-next-history
zstyle ':completion:*:*:*:*:*' menu select
zstyle ':completion:*' matcher-list 'm:{[:lower:][:upper:]}={[:upper:][:lower:]}' 'r:|=*' 'l:|=* r:|=*'
zstyle ':completion:*' special-dirs true
zstyle ':completion:*' list-colors ${(s.:.)LS_COLORS}
zstyle ':completion:*:*:kill:*:processes' list-colors '=(#b) #([0-9]#) ([0-9a-z-]#)*=01;34=0=01'
zstyle ':completion:*:*:*:*:processes' command "ps -u $USERNAME -o pid,user,comm -w -w"
zstyle ':completion:*:cd:*' tag-order local-directories directory-stack path-directories
zstyle ':completion:*' use-cache yes
zstyle ':completion:*' cache-path $ZSH_CACHE_DIR
zstyle ':completion:*:*:*:users' ignored-patterns '_*' daemon nobody
zstyle '*' single-ignored show
