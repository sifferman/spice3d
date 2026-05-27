#!/usr/bin/env bash
set -euo pipefail

# Reject `%e` and `%g` in any tracked .gd file under project/.
# Why: GDScript's `%` operator only supports %s %c %d %o %x %X %f %v.
# %e (scientific) and %g (general) silently fail with "String
# formatting error: unsupported format character" AND return the
# format string verbatim. The raw %e then flows downstream — into
# ngspice circbyline, into print logs — and the next failure looks
# like it's coming from somewhere else.

scripts_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root_directory="$(cd "$scripts_directory/.." && pwd)"

matches="$(
	grep -rnE '%[eg][^a-zA-Z_]' \
		"$repository_root_directory/project" \
		--include='*.gd' \
		|| true
)"

if [ -n "$matches" ]; then
	echo "FAIL: found unsupported GDScript format specifier(s) (%e or %g)." >&2
	echo "GDScript's % operator silently fails on these; use %s + str()." >&2
	echo >&2
	echo "$matches" >&2
	exit 1
fi

echo "No %e/%g format specifiers in project/*.gd."
