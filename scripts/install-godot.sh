#!/usr/bin/env bash
set -euo pipefail

# Mirrors the Godot 4.4.1-stable install that pages.yml performs in CI:
# downloads the linux x86_64 editor binary to $HOME/godot and the
# matching export templates to ~/.local/share/godot/export_templates/4.4.1.stable/.
# Idempotent: skips download steps for artifacts that already exist.

godot_release_version_number="4.4.1"
godot_release_status="stable"
godot_release_full_version="${godot_release_version_number}-${godot_release_status}"
godot_release_download_base_url="https://github.com/godotengine/godot/releases/download/${godot_release_full_version}"

godot_editor_install_path="$HOME/godot"
godot_export_templates_directory="$HOME/.local/share/godot/export_templates/${godot_release_version_number}.${godot_release_status}"

download_workspace_directory="$(mktemp -d)"
trap 'rm -rf "$download_workspace_directory"' EXIT

if [ -x "$godot_editor_install_path" ]; then
	echo "[install-godot] editor already present at $godot_editor_install_path"
else
	echo "[install-godot] downloading editor zip from $godot_release_download_base_url"
	curl -fsSL "${godot_release_download_base_url}/Godot_v${godot_release_full_version}_linux.x86_64.zip" \
			-o "$download_workspace_directory/godot.zip"
	echo "[install-godot] unzipping editor"
	unzip -q "$download_workspace_directory/godot.zip" -d "$download_workspace_directory"
	mv "$download_workspace_directory/Godot_v${godot_release_full_version}_linux.x86_64" \
			"$godot_editor_install_path"
	chmod +x "$godot_editor_install_path"
	echo "[install-godot] editor installed at $godot_editor_install_path"
fi

if [ -d "$godot_export_templates_directory" ] && [ -n "$(ls -A "$godot_export_templates_directory" 2>/dev/null)" ]; then
	echo "[install-godot] export templates already populated at $godot_export_templates_directory"
else
	echo "[install-godot] downloading export templates from $godot_release_download_base_url"
	curl -fsSL "${godot_release_download_base_url}/Godot_v${godot_release_full_version}_export_templates.tpz" \
			-o "$download_workspace_directory/templates.tpz"
	echo "[install-godot] unzipping export templates"
	unzip -q "$download_workspace_directory/templates.tpz" -d "$download_workspace_directory"
	mkdir -p "$godot_export_templates_directory"
	mv "$download_workspace_directory"/templates/* "$godot_export_templates_directory/"
	echo "[install-godot] export templates installed at $godot_export_templates_directory"
fi

"$godot_editor_install_path" --version
echo
echo "[install-godot] done. Either symlink $godot_editor_install_path onto PATH"
echo "[install-godot] or set GODOT_EXECUTABLE_PATH=$godot_editor_install_path when invoking"
echo "[install-godot] scripts/serve-local-web-export.sh. The serve script also auto-falls back"
echo "[install-godot] to \$HOME/godot when no godot is found on PATH."
