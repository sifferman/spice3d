#!/usr/bin/env bash
set -euo pipefail

# Runs the GUT test suite headless and fails the script if Godot
# printed any `ERROR:` lines during the run. GUT itself reports a
# successful suite when only GDScript asserts pass, but a regression
# in the GDExtension can still call core/object error paths whose
# messages go straight to stderr. Catching those is the whole point
# of running tests in CI without browser access.

scripts_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root_directory="$(cd "$scripts_directory/.." && pwd)"
godot_executable_path="${GODOT_EXECUTABLE_PATH:-godot}"

cd "$repository_root_directory/project"
godot_test_output_log_file="$(mktemp)"
trap 'rm -f "$godot_test_output_log_file"' EXIT

"$godot_executable_path" --headless \
		-s addons/gut/gut_cmdln.gd \
		-gdir=res://test/unit \
		-gexit \
		2>&1 | tee "$godot_test_output_log_file"

if grep -E '^ERROR:' "$godot_test_output_log_file"; then
	echo
	echo "Godot printed ERROR: lines during the test run — failing." >&2
	exit 1
fi
echo "No ERROR: lines printed during the test run."
