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
rm -rf "$APP"
cp -R "$BUILT_APP" "$APP"

# 4. Launch once so Safari picks up the updated extension (stays enabled).
open "$APP"

printf 'Done. Installed app: %s\n' "$APP"
