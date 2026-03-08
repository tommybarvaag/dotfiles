typeset -U path
path=(
  "node_modules/.bin"
  "vendor/bin"
  "$HOME/.node/bin"
  $path
)
export PATH
