# Shell behaviour carried over from oh-my-zsh's lib/ (history, directories,
# misc, key-bindings, termsupport, theme-and-appearance).

# History
HISTSIZE=50000
SAVEHIST=10000
setopt extended_history hist_expire_dups_first hist_ignore_dups hist_ignore_space
setopt hist_verify share_history

# Directories and jobs
setopt auto_cd auto_pushd pushd_ignore_dups pushdminus
setopt multios long_list_jobs interactive_comments prompt_subst
unsetopt flow_control

# Pager and colours
export PAGER=${PAGER:-less}
export LESS=${LESS:--R}
export LSCOLORS="Gxfxcxdxbxegedabagacad"
export LS_COLORS=${LS_COLORS:-"di=1;36:ln=35:so=32:pi=33:ex=31:bd=34;46:cd=34;43:su=30;41:sg=30;46:tw=30;42:ow=30;43"}

# Keys: emacs mode, with terminfo-aware bindings for Home/End/PgUp/PgDn etc.
bindkey -e
WORDCHARS=''

if (( ${+terminfo[smkx]} && ${+terminfo[rmkx]} )); then
  zle-line-init() { echoti smkx }
  zle-line-finish() { echoti rmkx }
  zle -N zle-line-init
  zle -N zle-line-finish
fi

autoload -Uz up-line-or-beginning-search down-line-or-beginning-search edit-command-line
zle -N up-line-or-beginning-search
zle -N down-line-or-beginning-search
zle -N edit-command-line

bindkey '^[[A' up-line-or-beginning-search
bindkey '^[[B' down-line-or-beginning-search
[[ -z ${terminfo[kcuu1]} ]] || bindkey ${terminfo[kcuu1]} up-line-or-beginning-search
[[ -z ${terminfo[kcud1]} ]] || bindkey ${terminfo[kcud1]} down-line-or-beginning-search
[[ -z ${terminfo[kpp]} ]] || bindkey ${terminfo[kpp]} up-line-or-history
[[ -z ${terminfo[knp]} ]] || bindkey ${terminfo[knp]} down-line-or-history
[[ -z ${terminfo[khome]} ]] || bindkey ${terminfo[khome]} beginning-of-line
[[ -z ${terminfo[kend]} ]] || bindkey ${terminfo[kend]} end-of-line
[[ -z ${terminfo[kcbt]} ]] || bindkey ${terminfo[kcbt]} reverse-menu-complete
bindkey ${terminfo[kdch1]:-'^[[3~'} delete-char
bindkey '^?' backward-delete-char
bindkey '^[[3;5~' kill-word
bindkey '^[[1;5C' forward-word
bindkey '^[[1;5D' backward-word
bindkey '\ew' kill-region
bindkey -s '\el' '^q ls\n'
bindkey ' ' magic-space
bindkey '^x^e' edit-command-line
bindkey '^[m' copy-prev-shell-word

# Escape ? & etc. in URLs as they are typed or pasted.
autoload -Uz bracketed-paste-magic url-quote-magic
zle -N bracketed-paste bracketed-paste-magic
zle -N self-insert url-quote-magic

# Tab title and working directory (OSC 1/2/7) for terminals without their own
# shell integration: Rex shows both. Ghostty's integration already sends them.
# Same escapes as oh-my-zsh, without its two subshells per prompt.
_term_title() {
  # Never run $(...) from a command line while building its title.
  setopt localoptions nopromptsubst
  case $TERM in
    screen*|tmux*)
      print -Pn "\e]2;${2:q}\e\\"
      print -Pn "\ek${1:q}\e\\"
      ;;
    *)
      print -Pn "\e]2;${2:q}\a"
      print -Pn "\e]1;${1:q}\a"
      ;;
  esac
}
_term_precmd() {
  _term_title "%15<..<%~%<<" "%n@%m:%~"
}
_term_preexec() {
  emulate -L zsh
  setopt extended_glob
  _term_title "${1[(wr)^(*=*|sudo|ssh|mosh|rake|-*)]:gs/%/%%}" "%100>...>${2:gs/%/%%}%<<"
}
_term_cwd() {
  emulate -L zsh
  local url=$PWD c hex
  if [[ -n ${PWD//[[:alnum:]\/._~-]/} ]]; then
    local LC_ALL=C
    url=
    for c in ${(s::)PWD}; do
      if [[ $c == [[:alnum:]/._~-] ]]; then
        url+=$c
      else
        printf -v hex '%%%02X' "'$c"
        url+=$hex
      fi
    done
  fi
  printf '\e]7;file://%s%s\e\\' $HOST $url
}

# Unique hook lists, so re-sourcing the config doesn't register hooks twice.
typeset -gU precmd_functions preexec_functions chpwd_functions

if [[ $TERM_PROGRAM != ghostty && -z $INSIDE_EMACS && $TERM == (xterm*|screen*|tmux*) ]]; then
  precmd_functions+=(_term_precmd)
  preexec_functions+=(_term_preexec)
  [[ -n $SSH_CLIENT$SSH_TTY ]] || precmd_functions+=(_term_cwd)
fi
