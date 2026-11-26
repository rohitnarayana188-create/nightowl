#!/bin/zsh
# Double-click this file to launch Nightowl.
cd "$(dirname "$0")"
export PATH="$HOME/.local/node/bin:$PATH"
exec ./node_modules/.bin/electron . "$@"
