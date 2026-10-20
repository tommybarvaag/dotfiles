# Shortcuts
alias reloadshell='source "$HOME/.zshrc"'
alias reloaddns="dscacheutil -flushcache && sudo killall -HUP mDNSResponder"
alias shrug="echo '¯\_(ツ)_/¯' | pbcopy"
alias c="clear"
alias compile="commit 'compile'"
alias version="commit 'version'"

# Directories
alias root='cd "$HOME"'
alias dotfiles='cd "$DOTFILES"'
alias library='cd "$HOME/Library"'
alias src='cd "${PROJECTS_DIR:-$HOME/src}"'
alias ..="cd .."
alias ...="cd ../.."
alias ....="cd ../../.."
alias gr='cd "$(git rev-parse --show-cdup || echo .)"'

# Carried over from oh-my-zsh
alias -- -='cd -'
alias 1='cd -1' 2='cd -2' 3='cd -3' 4='cd -4' 5='cd -5' 6='cd -6' 7='cd -7' 8='cd -8' 9='cd -9'
alias -g .....='../../../..'
alias -g ......='../../../../..'
alias rd=rmdir
alias lsa='ls -lah'
alias _='sudo '


# JS
alias nfresh="rm -rf node_modules/ package-lock.json && npm install"
alias nwatch="npm run watch"

# Git
alias gst="git status"
alias gb="git branch"
alias gc="git checkout"
alias gl="git log --oneline --decorate --color"
alias amend="git add . && git commit --amend --no-edit"
alias commit="git add . && git commit -m"
alias gd="git diff"
alias force="git push --force-with-lease"
alias nuke="git clean -df && git reset --hard"
alias pop="git stash pop"
alias pull="git pull"
alias push="git push"
alias resolve="git add . && git commit --no-edit"
alias stash="git stash -u"
alias unstage="git restore --staged ."
alias wip="commit wip"

# ZSH
alias zshconfig="code $HOME/.zshrc"
alias zshreload="source $HOME/.zshrc"
alias diskusage="du -sh * | sort -h"
alias l="eza --icons --hyperlink -l --group-directories-first"
alias ll="eza --icons --hyperlink -l --tree --level=2 --group-directories-first"
alias la="eza --icons --hyperlink -la --group-directories-first"
alias rgweb="rg --type-add 'web:*.{html,css,js}'"
alias pi="pnpm install"
alias pup="pnpm update --interactive --latest --recursive"
alias pugl="pnpm --interactive --latest --loglevel=silent"
alias pbuild="pnpm build"
alias pstart="pnpm start"
alias ptest="pnpm test"
alias pdev="pnpm dev"
alias hosts='sudo "$EDITOR" /etc/hosts'
alias cleanup_dsstore="find . -name '*.DS_Store' -type f -ls -delete"
alias where=which
alias gf="git fuzzy"
alias gfs="git fuzzy status"
alias gfl="git fuzzy log"
alias gfb="git fuzzy branch"
alias gfd="git fuzzy diff"
alias brewup="brew update && brew upgrade && brew cleanup"
alias path='print -l ${(s/:/)PATH}'
alias kkk='nvim $(fzf --preview="bat --color=always --style=numbers --line-range=:200 {}")'

# Overrides of standard commands, for people only. Agent shells (Claude Code
# sets CLAUDECODE) get the plain commands: `rm -i` silently keeps files when
# stdin isn't a terminal, and bat/eza output and flags differ from cat/ls.
if [[ -z $CLAUDECODE ]]; then
  alias cat="bat"
  alias ls="eza --icons --hyperlink -l --group-directories-first"
  alias mv='mv -v'
  alias cp='cp -v'
  alias rm='rm -i -v'
  alias grep='grep --color=auto --exclude-dir={.bzr,CVS,.git,.hg,.svn,.idea,.tox,.venv,venv}'
  alias egrep='grep -E'
  alias fgrep='grep -F'
fi
