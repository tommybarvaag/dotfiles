# Shortcuts
alias copyssh='pbcopy < "$HOME/.ssh/id_ed25519.pub"'
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
alias force="git push --force"
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
alias ohmyzsh="code $HOME/.oh-my-zsh"
alias p10k="code $HOME/.p10k.zsh"
alias diskusage="du -sh * | sort -h"
alias cat="bat"
alias ls="eza --icons --hyperlink --group-directories-first"
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
alias mv='mv -v'
alias cp='cp -v'
alias rm='rm -i -v'
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
