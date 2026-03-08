unalias md 2>/dev/null

md() {
  if [[ $# -ne 1 ]]; then
    print "usage: md <directory>"
    return 1
  fi

  mkdir -p -- "$1" && cd -- "$1"
}

gz() {
  if [[ $# -ne 1 || ! -f "$1" ]]; then
    print "usage: gz <file>"
    return 1
  fi

  local origsize gzipsize ratio
  origsize=$(wc -c < "$1")
  gzipsize=$(gzip -c "$1" | wc -c)
  ratio=$(awk "BEGIN { printf \"%.2f\", (${gzipsize} * 100) / ${origsize} }")

  printf 'orig: %d bytes\ngzip: %d bytes\nratio: %s%%\n' "$origsize" "$gzipsize" "$ratio"
}

extract() {
  if [[ $# -ne 1 || ! -f "$1" ]]; then
    print "usage: extract <archive>"
    return 1
  fi

  case "$1" in
    *.tar.bz2|*.tbz2) tar xjf "$1" ;;
    *.tar.gz|*.tgz) tar xzf "$1" ;;
    *.tar.xz) tar xJf "$1" ;;
    *.bz2) bunzip2 "$1" ;;
    *.gz) gunzip "$1" ;;
    *.tar) tar xf "$1" ;;
    *.zip) unzip "$1" ;;
    *.Z) uncompress "$1" ;;
    *.7z)
      if command -v 7z >/dev/null 2>&1; then
        7z x "$1"
      else
        print "7z is required to extract '$1'"
        return 1
      fi
      ;;
    *)
      print "'$1' cannot be extracted"
      return 1
      ;;
  esac
}
