#!/usr/bin/env bash
set -euo pipefail

# Validate every .github/workflows/*.yml as YAML before pushing.
# An unquoted colon inside a workflow step name breaks the file at
# the YAML-parse layer; GitHub then can't load the workflow and the
# run shows up with the file path as its name with a generic failure.

scripts_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root_directory="$(cd "$scripts_directory/.." && pwd)"
workflows_directory="$repository_root_directory/.github/workflows"

for workflow_file_path in "$workflows_directory"/*.yml; do
	echo "Validating: $workflow_file_path"
	python3 -c "
import sys, yaml
with open('$workflow_file_path') as f:
    yaml.safe_load(f)
"
done

echo "All workflow YAML files parse cleanly."
