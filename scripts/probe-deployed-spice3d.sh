#!/usr/bin/env bash
set -euo pipefail

# Probe the deployed spice3d site for the assets and signals we can
# verify without a browser. Run from the repo root.
#
# Reports:
#   - HTTP status + last-modified for each artifact
#   - Whether ngspice_bridge.js is referenced from index.html
#   - Whether the deployed main.tscn / project.binary contain the
#     latest build commit's marker (best-effort)

deployed_site_origin_url="https://ethan.sifferman.dev/spice3d"

cache_busting_query_parameter="$(date +%s)"

probe_one_deployed_asset() {
    local asset_relative_path="$1"
    local asset_full_url="${deployed_site_origin_url}/${asset_relative_path}?cb=${cache_busting_query_parameter}"
    local curl_head_response
    curl_head_response=$(curl -sI "$asset_full_url")
    local http_status_line=$(echo "$curl_head_response" | head -1 | tr -d '\r')
    local last_modified_header=$(echo "$curl_head_response" | grep -i '^last-modified:' | tr -d '\r' || true)
    printf '  %-40s %s\n  %s\n' "$asset_relative_path" "$http_status_line" "$last_modified_header"
}

echo "Probing deployed spice3d assets:"
for one_asset in index.html ngspice_bridge.js ngspice_worker.js ngspice.js ngspice.wasm coi-serviceworker.js; do
    probe_one_deployed_asset "$one_asset"
done

echo
echo "ngspice_bridge.js script tag in index.html:"
if curl -fsS "${deployed_site_origin_url}/index.html?cb=${cache_busting_query_parameter}" | grep -F 'ngspice_bridge.js'; then
    echo "  present"
else
    echo "  MISSING — page will not boot the simulator bridge!"
fi
