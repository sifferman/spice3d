#!/usr/bin/env bash
set -euo pipefail

scripts_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root_directory="$(cd "$scripts_directory/.." && pwd)"
ngspice_source_root="$repository_root_directory/third_party/ngspice"
native_build_directory="$ngspice_source_root/build-native"

detected_host_kernel="$(uname -s)"
detected_shared_library_extension="so"
detected_shared_library_filename_pattern="src/.libs/libngspice.so"
if [[ "$detected_host_kernel" == "Darwin" ]]; then
	detected_shared_library_extension="dylib"
	detected_shared_library_filename_pattern="src/.libs/libngspice.dylib"
elif [[ "$detected_host_kernel" == MINGW* || "$detected_host_kernel" == MSYS* || "$detected_host_kernel" == CYGWIN* ]]; then
	detected_shared_library_extension="dll"
	detected_shared_library_filename_pattern="src/.libs/libngspice-0.dll"
fi

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
	make -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"
}

generate_mingw_import_library_if_missing() {
	# On MinGW, libtool sometimes emits only the DLL (libngspice-0.dll) and
	# skips the matching import library (libngspice.dll.a). Without it,
	# MinGW's `ld -lngspice` can't resolve the link step. Reconstruct the
	# import library from the DLL via gendef + dlltool when it's missing.
	if [[ "$detected_host_kernel" != MINGW* && "$detected_host_kernel" != MSYS* ]]; then
		return
	fi
	local dot_libs_directory="$native_build_directory/src/.libs"
	if [ -f "$dot_libs_directory/libngspice.dll.a" ]; then
		return
	fi
	local dll_path="$dot_libs_directory/libngspice-0.dll"
	if [ ! -f "$dll_path" ]; then
		echo "libngspice-0.dll missing under $dot_libs_directory; cannot reconstruct import library" >&2
		exit 1
	fi
	(cd "$dot_libs_directory" && gendef libngspice-0.dll && dlltool -d libngspice-0.def -l libngspice.dll.a)
}

list_built_shared_library_artifacts() {
	echo "--- contents of $native_build_directory/src/.libs/ ---"
	ls -la "$native_build_directory/src/.libs/" || true
}

regenerate_configure_script_if_missing
run_native_configure
build_ngspice_shared_library_for_native
generate_mingw_import_library_if_missing
list_built_shared_library_artifacts

echo
echo "ngspice (sharedspice) built successfully (host $detected_host_kernel)."
echo "  shared library: $native_build_directory/$detected_shared_library_filename_pattern"
echo "  header:         $ngspice_source_root/src/include/ngspice/sharedspice.h"
