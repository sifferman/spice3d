#!/usr/bin/env bash
set -euo pipefail

# Build ngspice's sharedspice library (--with-ngshared) for emscripten.
# Outputs in `third_party/ngspice/build-emscripten/`:
#
#   ngspice.js     MODULARIZE'd module loader (createNgspiceModule)
#   ngspice.wasm   raw wasm
#
# Caller must have an active emsdk on PATH (i.e. `source emsdk_env.sh`).

scripts_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root_directory="$(cd "$scripts_directory/.." && pwd)"
ngspice_source_root="$repository_root_directory/third_party/ngspice"
emscripten_build_directory="$ngspice_source_root/build-emscripten"
collected_objects_list_file="$emscripten_build_directory/all_objects.list"

if ! command -v emcc >/dev/null 2>&1; then
    echo "emcc not on PATH — source emsdk_env.sh before running this script" >&2
    exit 1
fi

apply_configure_patches_for_emscripten() {
    cd "$ngspice_source_root"
    if grep -q 'AC_CHECK_FUNCS(\[times getrusage\])' configure.ac; then
        sed -i 's/AC_CHECK_FUNCS(\[times getrusage\])/AC_CHECK_FUNCS([times])/g' configure.ac
        # A prior native build in the same checkout may have already run
        # autogen.sh against the unpatched configure.ac and left a stale
        # ./configure behind. Drop it so regenerate_configure_script_if_missing
        # rebuilds it from the just-patched configure.ac.
        rm -f "$ngspice_source_root/configure"
    fi
}

regenerate_configure_script_if_missing() {
    if [ -f "$ngspice_source_root/configure" ]; then
        return
    fi
    (cd "$ngspice_source_root" && ./autogen.sh)
}

run_emscripten_configure() {
    if [ -f "$emscripten_build_directory/Makefile" ]; then
        return
    fi
    mkdir -p "$emscripten_build_directory"
    cd "$emscripten_build_directory"
    emconfigure ../configure \
        --build="$(gcc -dumpmachine)" \
        --host=wasm32-unknown-emscripten \
        --with-ngshared \
        --enable-shared --disable-static \
        --disable-debug \
        --disable-openmp \
        --disable-xspice \
        --with-readline=no \
        CFLAGS="-std=gnu89 -O2" \
        CPPFLAGS="-Devent_auto_incr=0"
}

force_libtool_to_emit_shared_objects_under_emscripten() {
    # Generated libtool decides at configure time that wasm32-unknown-emscripten
    # can't build shared libraries (build_libtool_libs=no). With --with-ngshared
    # the ngspice Makefile passes -shared to libtool, which then aborts via
    # func_fatal_configuration "cannot build a shared library". Flip the gate so
    # libtool proceeds; we link the final wasm ourselves below from the per-TU
    # .o files it emits.
    cd "$emscripten_build_directory"
    sed -i 's/^build_libtool_libs=no$/build_libtool_libs=yes/' libtool
}

compile_ngspice_per_translation_unit_objects() {
    cd "$emscripten_build_directory"
    # The link step ultimately fails (libtool can't shape the emcc command for
    # a wasm "shared library"), but by then every .c has been compiled to a .o
    # under .libs/. We salvage those objects and link them ourselves.
    if emmake make -j"$(nproc)" 2>&1 | tail -20; then
        true
    fi
}

collect_object_files_skipping_libtool_archive_extraction_copies() {
    cd "$emscripten_build_directory"
    # libtool also extracts every member of every static dependency into
    # `.libs/libngspice.lax/<lib>/`; those are duplicates of the per-TU objects
    # so excluding them avoids "duplicate symbol" link errors.
    find . -path "*/.libs/*.o" \
        -not -path "*tests*" \
        -not -path "*regression*" \
        -not -path "*libngspice.lax*" \
        | sort > "$collected_objects_list_file"
}

link_collected_objects_into_emscripten_module() {
    cd "$emscripten_build_directory"
    emcc \
        -O2 \
        -sMODULARIZE=1 \
        -sEXPORT_ES6=0 \
        -sEXPORT_NAME=createNgspiceModule \
        -sALLOW_TABLE_GROWTH=1 \
        -sALLOW_MEMORY_GROWTH=1 \
        -sNO_EXIT_RUNTIME=1 \
        -sASSERTIONS=1 \
        -sRESERVED_FUNCTION_POINTERS=16 \
        -sINVOKE_RUN=0 \
        --no-entry \
        -sEXPORTED_FUNCTIONS='[
            "_ngSpice_Init",
            "_ngSpice_Init_Sync",
            "_ngSpice_Command",
            "_ngSpice_Circ",
            "_ngSpice_AllVecs",
            "_ngGet_Vec_Info",
            "_ngSpice_running",
            "_malloc",
            "_free"
        ]' \
        -sEXPORTED_RUNTIME_METHODS='[
            "FS",
            "ccall",
            "cwrap",
            "addFunction",
            "getValue",
            "setValue",
            "stringToUTF8",
            "UTF8ToString",
            "lengthBytesUTF8",
            "HEAPU8",
            "HEAPU32",
            "HEAPF64"
        ]' \
        "@$collected_objects_list_file" \
        -o ngspice.js
}

apply_configure_patches_for_emscripten
regenerate_configure_script_if_missing
run_emscripten_configure
force_libtool_to_emit_shared_objects_under_emscripten
compile_ngspice_per_translation_unit_objects
collect_object_files_skipping_libtool_archive_extraction_copies
link_collected_objects_into_emscripten_module

echo
echo "ngspice (sharedspice) for emscripten built successfully."
echo "  $emscripten_build_directory/ngspice.js"
echo "  $emscripten_build_directory/ngspice.wasm"
