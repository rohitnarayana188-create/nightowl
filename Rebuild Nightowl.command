#!/bin/zsh
# Double-click after changing the code: rebuilds Nightowl.app and reinstalls it in /Applications.
set -e
cd "$(dirname "$0")"
export PATH="$HOME/.local/node/bin:$PATH"
osascript -e 'quit app "Nightowl"' 2>/dev/null || true
npx electron-packager . Nightowl --platform=darwin --arch=arm64 --icon=build/icon.icns \
  --app-bundle-id=app.nightowl.browser --app-version="$(node -p "require('./package.json').version")" \
  --extend-info=build/Info.extra.plist --out=dist --overwrite \
  --ignore='^/build' --ignore='^/dist' --ignore='\.command$' --ignore='^/README'
codesign --force --deep --sign - dist/Nightowl-darwin-arm64/Nightowl.app
rm -rf /Applications/Nightowl.app
ditto dist/Nightowl-darwin-arm64/Nightowl.app /Applications/Nightowl.app
xattr -cr /Applications/Nightowl.app
open /Applications/Nightowl.app
echo "✅ Nightowl rebuilt and installed."
