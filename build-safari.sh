#!/bin/sh
set -eu

usage() {
    cat <<'EOF'
Usage: ./build-safari.sh [--version VERSION] [--app-name NAME] [--bundle-identifier ID] [--project-location PATH]

Builds a Safari-ready WebExtension bundle in ./builds/yomitan-safari-web-extension and
generates a macOS Safari app-extension Xcode project with `xcrun safari-web-extension-converter`.
EOF
}

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
VERSION=0.0.0.0
APP_NAME="Yomitan Safari"
BUNDLE_IDENTIFIER="dev.yomitan.safari"
PROJECT_LOCATION="$ROOT_DIR/builds/yomitan-safari-app"
WEB_EXTENSION_DIR="$ROOT_DIR/builds/yomitan-safari-web-extension"

while [ "$#" -gt 0 ]; do
    case "$1" in
        --version)
            VERSION="$2"
            shift 2
            ;;
        --app-name)
            APP_NAME="$2"
            shift 2
            ;;
        --bundle-id|--bundle-identifier)
            BUNDLE_IDENTIFIER="$2"
            shift 2
            ;;
        --project-location)
            PROJECT_LOCATION="$2"
            shift 2
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            printf 'Unknown argument: %s\n\n' "$1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

python3 - "$ROOT_DIR" "$WEB_EXTENSION_DIR" "$VERSION" <<'PY'
import copy
import json
import os
import shutil
import sys
from pathlib import Path


def get_object_parent(root, path):
    current = root
    for item in path[:-1]:
        current = current[item]
    return current, path[-1]


def apply_modification(manifest, modification):
    action = modification["action"]
    path = modification["path"]

    if action == "set":
        parent, key = get_object_parent(manifest, path)
        parent[key] = copy.deepcopy(modification["value"])
    elif action == "replace":
        parent, key = get_object_parent(manifest, path)
        parent[key] = str(parent[key]).replace(modification["pattern"], modification["replacement"])
    elif action == "delete":
        parent, key = get_object_parent(manifest, path)
        if isinstance(parent, list):
            del parent[key]
        else:
            parent.pop(key, None)
    elif action == "remove":
        current = manifest
        for item in path:
            current = current[item]
        try:
            current.remove(modification["item"])
        except ValueError:
            pass
    elif action == "add":
        current = manifest
        for item in path:
            current = current[item]
        current.extend(copy.deepcopy(modification["items"]))
    elif action == "splice":
        current = manifest
        for item in path:
            current = current[item]
        start = modification["start"]
        delete_count = modification["deleteCount"]
        items = copy.deepcopy(modification["items"])
        current[start:start + delete_count] = items
    elif action in {"copy", "move"}:
        source_parent, source_key = get_object_parent(manifest, path)
        target_parent, target_key = get_object_parent(manifest, modification["newPath"])
        target_parent[target_key] = copy.deepcopy(source_parent[source_key])
        if action == "move":
            if isinstance(source_parent, list):
                del source_parent[source_key]
            else:
                source_parent.pop(source_key, None)
    else:
        raise RuntimeError(f"Unsupported manifest modification action: {action}")


root_dir = Path(sys.argv[1])
output_dir = Path(sys.argv[2])
version = sys.argv[3]

config = json.loads((root_dir / "dev/data/manifest-variants.json").read_text(encoding="utf-8"))
variant_map = {variant["name"]: variant for variant in config["variants"]}

variant = variant_map["safari"]
chain = []
seen = set()
while True:
    name = variant["name"]
    if name in seen:
        break
    seen.add(name)
    chain.insert(0, variant)
    inherit = variant.get("inherit")
    if not isinstance(inherit, str):
        break
    variant = variant_map[inherit]

manifest = copy.deepcopy(config["manifest"])
exclude_files = []
for variant in chain:
    for modification in variant.get("modifications", []):
        apply_modification(manifest, modification)
    for excluded in variant.get("excludeFiles", []):
        if excluded not in exclude_files:
            exclude_files.append(excluded)

# DEV/TEST ONLY: inject the loopback test bridge (ext/js/native/loopback-test-bridge.js) as a
# content script on 127.0.0.1/localhost so `npm run test:safari:e2e` can drive the installed
# extension over a loopback HTTP endpoint (see that runner and DEV.md). Gated on an env var so a
# normal build -- and therefore anything that ships -- never references it. Match patterns ignore the
# port, so this covers whichever port the runner picks.
if os.environ.get("YOMITAN_TEST_BRIDGE"):
    manifest.setdefault("content_scripts", []).append({
        "run_at": "document_idle",
        "matches": ["http://127.0.0.1/*", "http://localhost/*"],
        "all_frames": False,
        "js": ["js/native/loopback-test-bridge.js"],
    })

if output_dir.exists():
    shutil.rmtree(output_dir)
shutil.copytree(root_dir / "ext", output_dir)

for relative_path in exclude_files:
    target = output_dir / relative_path
    if target.is_dir():
        shutil.rmtree(target)
    elif target.exists():
        target.unlink()

manifest_text = json.dumps(manifest, indent=4) + "\n"
manifest_text = manifest_text.replace("$YOMITAN_VERSION", version)
(output_dir / "manifest.json").write_text(manifest_text, encoding="utf-8")
PY

# The engine bundle JavaScriptCore evaluates inside the app extension (plan/native-rewrite.md).
# Emitted into the web extension directory rather than into ext/, so the source tree stays clean
# and `safari-web-extension-converter --copy-resources` picks it up as an ordinary bundle
# resource -- which is what lets the Swift side find it with Bundle.url(forResource:withExtension:).
node "$ROOT_DIR/dev/bin/build-native-core.js" --out "$WEB_EXTENSION_DIR/yomitan-core.js"

xcrun safari-web-extension-converter \
    "$WEB_EXTENSION_DIR" \
    --project-location "$PROJECT_LOCATION" \
    --app-name "$APP_NAME" \
    --bundle-identifier "$BUNDLE_IDENTIFIER" \
    --swift \
    --macos-only \
    --copy-resources \
    --no-open \
    --no-prompt \
    --force

python3 - "$PROJECT_LOCATION" "$APP_NAME" "$BUNDLE_IDENTIFIER" "$ROOT_DIR" <<'PY'
import hashlib
import plistlib
import re
import shutil
import sys
from pathlib import Path

project_location = Path(sys.argv[1])
app_name = sys.argv[2]
bundle_identifier = sys.argv[3]
root_dir = Path(sys.argv[4])
native_source_dir = root_dir / "native/Sources/YomitanNative"
extension_bundle_identifier = f"{bundle_identifier}.extension"

project_root = project_location / app_name
pbxproj_path = project_root / f"{app_name}.xcodeproj" / "project.pbxproj"
view_controller_path = project_root / app_name / "ViewController.swift"
extension_root = project_root / f"{app_name} Extension"
app_info_plist_path = project_root / app_name / "Info.plist"
extension_info_plist_path = extension_root / "Info.plist"
anki_connect_js_path = extension_root / "Resources" / "js" / "comm" / "anki-connect.js"

pbxproj = pbxproj_path.read_text(encoding="utf-8")


def replace_bundle_identifier(match):
    line = match.group(0)
    value = line.split("=", 1)[1].rsplit(";", 1)[0].strip().strip('"')
    replacement = extension_bundle_identifier if value.endswith(".Extension") else bundle_identifier
    quoted = f'"{replacement}"' if '"' in line else replacement
    return f"PRODUCT_BUNDLE_IDENTIFIER = {quoted};"


pbxproj = re.sub(r"PRODUCT_BUNDLE_IDENTIFIER = [^;]+;", replace_bundle_identifier, pbxproj)
pbxproj = re.sub(
    r"(ENABLE_HARDENED_RUNTIME = YES;\n(\s+)ENABLE_USER_SELECTED_FILES = readonly;)",
    r"ENABLE_HARDENED_RUNTIME = YES;\n\2ENABLE_OUTGOING_NETWORK_CONNECTIONS = YES;\n\1",
    pbxproj,
    count=2,
)
pbxproj_path.write_text(pbxproj, encoding="utf-8")

view_controller = view_controller_path.read_text(encoding="utf-8")
view_controller = re.sub(
    r'let extensionBundleIdentifier = ".*"',
    f'let extensionBundleIdentifier = "{extension_bundle_identifier}"',
    view_controller,
)
view_controller_path.write_text(view_controller, encoding="utf-8")

# The native engine lives in the repository at native/Sources/YomitanNative and is copied into the
# generated project here. It is emphatically NOT edited in place: safari-web-extension-converter is
# run with --force on every build and rewrites the generated tree, so anything typed into
# builds/yomitan-safari-app is lost on the next build.
#
# The converter only knows about the single SafariWebExtensionHandler.swift it generates, so the
# other sources have to be registered in the project file by hand. That is what
# `add_swift_sources_to_extension_target` below does; it is 40 lines of pbxproj surgery, but the
# alternative is a checked-in Xcode project that the converter would fight with.
native_sources = sorted(native_source_dir.glob("*.swift"))
if not native_sources:
    raise RuntimeError(f"No Swift sources found in {native_source_dir}")
for source in native_sources:
    shutil.copyfile(source, extension_root / source.name)


def stable_object_id(name):
    """A 24-hex-digit pbxproj object id derived from the file name.

    Deterministic on purpose: a rebuild that changed nothing should produce a byte-identical project
    file, so `git diff` on the generated tree stays meaningful and Xcode does not see every build as
    a structural change.
    """
    return hashlib.md5(name.encode("utf-8")).hexdigest()[:24].upper()


def add_swift_sources_to_extension_target(pbxproj, names):
    """Registers additional .swift files in the app-extension target.

    Anchored on the generated SafariWebExtensionHandler.swift rather than on object ids, because the
    converter mints fresh ids on every run.
    """
    build_files = []
    file_references = []
    group_children = []
    sources_entries = []
    for name in names:
        file_id = stable_object_id(name)
        build_id = stable_object_id(f"{name}:build")
        build_files.append(
            f"\t\t{build_id} /* {name} in Sources */ = {{isa = PBXBuildFile; fileRef = {file_id} /* {name} */; }};\n"
        )
        file_references.append(
            f"\t\t{file_id} /* {name} */ = {{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; "
            f"path = {name}; sourceTree = \"<group>\"; }};\n"
        )
        group_children.append(f"\t\t\t\t{file_id} /* {name} */,\n")
        sources_entries.append(f"\t\t\t\t{build_id} /* {name} in Sources */,\n")

    def insert_after(text, pattern, addition, what):
        match = re.search(pattern, text)
        if match is None:
            raise RuntimeError(f"Could not find the {what} anchor in project.pbxproj")
        return text[: match.end()] + addition + text[match.end():]

    pbxproj = insert_after(
        pbxproj,
        r"[0-9A-F]{24} /\* SafariWebExtensionHandler\.swift in Sources \*/ = \{isa = PBXBuildFile;[^\n]*\n",
        "".join(build_files),
        "PBXBuildFile",
    )
    pbxproj = insert_after(
        pbxproj,
        r"[0-9A-F]{24} /\* SafariWebExtensionHandler\.swift \*/ = \{isa = PBXFileReference;[^\n]*\n",
        "".join(file_references),
        "PBXFileReference",
    )
    pbxproj = insert_after(
        pbxproj,
        r"\t{4}[0-9A-F]{24} /\* SafariWebExtensionHandler\.swift \*/,\n",
        "".join(group_children),
        "extension group",
    )
    pbxproj = insert_after(
        pbxproj,
        r"\t{4}[0-9A-F]{24} /\* SafariWebExtensionHandler\.swift in Sources \*/,\n",
        "".join(sources_entries),
        "Sources build phase",
    )
    return pbxproj


extra_sources = [source.name for source in native_sources if source.name != "SafariWebExtensionHandler.swift"]
pbxproj = pbxproj_path.read_text(encoding="utf-8")
pbxproj = add_swift_sources_to_extension_target(pbxproj, extra_sources)
pbxproj_path.write_text(pbxproj, encoding="utf-8")

anki_connect_js = anki_connect_js_path.read_text(encoding="utf-8")
anki_connect_js = re.sub(
    r"this\._nativeMessagingApplications = \[[^\]]*\];",
    f"this._nativeMessagingApplications = ['{extension_bundle_identifier}', '{bundle_identifier}', 'yomitan_anki'];",
    anki_connect_js,
    count=1,
)
anki_connect_js_path.write_text(anki_connect_js, encoding="utf-8")

for info_plist_path in (app_info_plist_path, extension_info_plist_path):
    with info_plist_path.open("rb") as file:
        info_plist = plistlib.load(file)
    app_transport_security = info_plist.setdefault("NSAppTransportSecurity", {})
    app_transport_security["NSAllowsLocalNetworking"] = True
    with info_plist_path.open("wb") as file:
        plistlib.dump(info_plist, file)
PY

printf 'Safari WebExtension bundle: %s\n' "$WEB_EXTENSION_DIR"
printf 'Safari Xcode project: %s\n' "$PROJECT_LOCATION/$APP_NAME/$APP_NAME.xcodeproj"
