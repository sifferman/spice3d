#!/usr/bin/env bash
set -euo pipefail

# Export the web build the same way pages.yml does, then serve it on
# localhost. Intended for the inner debugging loop — same code path as
# the deployed GitHub Pages build, but iteration time drops from
# several minutes (push -> CI -> deploy -> hard-refresh) to ~30s,
# and `python3 -m http.server` doesn't have any of the
# Firefox-caches-stale-wasm pitfalls the CDN deploy has.

repository_root_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project_directory="$repository_root_directory/project"
exported_web_build_directory="$repository_root_directory/build-web-local"
ngspice_wasm_build_directory="$repository_root_directory/third_party/ngspice/build-emscripten"
gdextension_web_release_binary_path="$project_directory/bin/web/libspice3d.web.template_release.wasm32.nothreads.wasm"

godot_executable_path="${GODOT_EXECUTABLE_PATH:-godot}"
local_http_server_port="${SPICE3D_LOCAL_HTTP_SERVER_PORT:-8000}"

if ! command -v "$godot_executable_path" >/dev/null 2>&1; then
	echo "FAIL: godot binary not on PATH (set GODOT_EXECUTABLE_PATH or install Godot 4.4.1)" >&2
	exit 1
fi
if [ ! -f "$ngspice_wasm_build_directory/ngspice.wasm" ]; then
	echo "FAIL: ngspice.wasm not found at $ngspice_wasm_build_directory" >&2
	echo "Run scripts/build-ngspice-for-emscripten.sh first." >&2
	exit 1
fi
if [ ! -f "$gdextension_web_release_binary_path" ]; then
	echo "FAIL: spice3d GDExtension web wasm not built ($gdextension_web_release_binary_path)" >&2
	echo "Run: scons -j\"\$(nproc)\" target=template_release platform=web arch=wasm32 precision=single threads=no" >&2
	exit 1
fi

echo "[serve-local] exporting web build to $exported_web_build_directory"
mkdir -p "$exported_web_build_directory"
(
	cd "$project_directory"
	"$godot_executable_path" --headless --export-release "Web" "$exported_web_build_directory/index.html"
)

echo "[serve-local] copying ngspice bridge + worker JS into export"
cp "$project_directory"/web/*.js "$exported_web_build_directory/"

echo "[serve-local] copying ngspice wasm artifacts into export"
cp "$ngspice_wasm_build_directory/ngspice.js" "$exported_web_build_directory/"
cp "$ngspice_wasm_build_directory/ngspice.wasm" "$exported_web_build_directory/"

echo "[serve-local] injecting ngspice_bridge.js <script> tag into index.html"
exported_web_build_directory_for_injection="$exported_web_build_directory" python3 - <<'PY'
import os
from pathlib import Path
exported_index_html_path = Path(os.environ['exported_web_build_directory_for_injection']) / 'index.html'
exported_html = exported_index_html_path.read_text()
ngspice_bridge_script_tag = '<script src="ngspice_bridge.js"></script>'
if ngspice_bridge_script_tag in exported_html:
    print('  already present')
else:
    exported_index_html_path.write_text(
        exported_html.replace('<head>', '<head>\n\t' + ngspice_bridge_script_tag, 1))
    print('  injected')
PY

echo
echo "[serve-local] serving http://localhost:$local_http_server_port/"
echo "[serve-local] open it in a fresh Private Window so Firefox does not"
echo "[serve-local] reuse a stale index.wasm from an earlier session."
echo
cd "$exported_web_build_directory"
exec python3 -m http.server "$local_http_server_port"
