#!/bin/sh
set -eu

# Rebuild and reinstall the Safari extension after code changes, using a free
# Apple ID "Personal Team" for local signing. No paid developer account needed.
#
# The team is passed to xcodebuild on the command line so it survives the
# `--force` project regeneration done by build-safari.sh.

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
VERSION="${VERSION:-26.2.17.0}"
DEVELOPMENT_TEAM="${DEVELOPMENT_TEAM:-9LMPV4ZRP8}"
DERIVED="$ROOT_DIR/builds/xcode-derived"
BUILT_APP="$DERIVED/Build/Products/Release/Yomitan Safari.app"
INSTALL_DIR="${INSTALL_DIR:-/Applications}"
APP="$INSTALL_DIR/Yomitan Safari.app"

# 1. Rebuild the JS/extension bundle and regenerate the web extension + Xcode project.
npm run build
"$ROOT_DIR/build-safari.sh" --version "$VERSION"

# 2. Compile + sign the app (signing supplied here, not stored in the project).
xcodebuild \
    -project "$ROOT_DIR/builds/yomitan-safari-app/Yomitan Safari/Yomitan Safari.xcodeproj" \
    -scheme "Yomitan Safari" \
    -configuration Release \
    -derivedDataPath "$DERIVED" \
    -destination 'platform=macOS' \
    DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" \
    CODE_SIGN_STYLE=Automatic \
    build

# 3. Install into a stable location so the app doesn't depend on the build folder.
#
# Update the bundle IN PLACE rather than `rm -rf` + `cp`. Removing the installed
# app makes Safari treat the extension as UNINSTALLED, and Safari purges the
# extension's website data (IndexedDB) on uninstall -- which discards imported
# dictionaries on every rebuild. Syncing into the existing bundle keeps the
# extension registered, so Safari treats it as an update and preserves the data.
#
# Safari must not be running while the bundle it has loaded is swapped, otherwise
# it can observe a partially-updated app and re-register (also purging data). Quit
# it gracefully first, then relaunch the app afterwards so the new code loads.
if pgrep -xq Safari; then
    osascript -e 'tell application "Safari" to quit' || true
    # Wait for Safari to fully exit before touching the bundle.
    while pgrep -xq Safari; do sleep 1; done
fi

mkdir -p "$APP"
# rsync makes $APP byte-identical to the freshly signed build (incl. _CodeSignature),
# removing stale files, without ever deleting the bundle directory itself.
rsync -a --delete "$BUILT_APP/" "$APP/"

# 4. Unregister the DerivedData build copy from LaunchServices. xcodebuild's output
# bundle is otherwise auto-registered, so Safari would list a SECOND Yomitan
# extension (one in the build folder, one in /Applications). Keep only the
# installed copy registered.
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$LSREGISTER" -u "$BUILT_APP" 2>/dev/null || true
"$LSREGISTER" -f "$APP" 2>/dev/null || true

# 5. Launch once so Safari picks up the updated extension (stays enabled).
open "$APP"

printf 'Done. Installed app: %s\n' "$APP"
printf 'If this was the first in-place rebuild, re-import your dictionary once;\n'
printf 'it should now survive subsequent rebuilds.\n'
