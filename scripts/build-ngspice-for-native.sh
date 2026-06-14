#!/usr/bin/env bash
set -euo pipefail

scripts_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root_directory="$(cd "$scripts_directory/.." && pwd)"
ngspice_source_root="$repository_root_directory/third_party/ngspice"
native_build_directory="$ngspice_source_root/build-native"

regenerate_configure_script_if_missing() {
	if [ -f "$ngspice_source_root/configure" ]; then
		return
	fi
	(cd "$ngspice_source_root" && ./autogen.sh)
}

run_native_configure() {
	if [ -f "$native_build_directory/Makefile" ]; then
		return
	fi
	mkdir -p "$native_build_directory"
	cd "$native_build_directory"
	../configure \
		--with-ngshared \
		--enable-shared --disable-static \
		--disable-debug \
		--disable-openmp \
		--disable-xspice \
		--with-readline=no \
		CFLAGS="-std=gnu89 -O2 -fPIC" \
		CPPFLAGS="-Devent_auto_incr=0"
}

build_ngspice_shared_library_for_native() {
	cd "$native_build_directory"
	make -j"$(nproc)"
}

regenerate_configure_script_if_missing
run_native_configure
build_ngspice_shared_library_for_native

echo
echo "ngspice (sharedspice) for native built successfully."
echo "  shared library: $native_build_directory/src/.libs/libngspice.so"
echo "  header:         $ngspice_source_root/src/include/ngspice/sharedspice.h"
