#!/usr/bin/env bash
set -euo pipefail

# Compile ngspice's sharedspice API surface as a single WebAssembly module
# loaded from project/web/ngspice_worker.js. Produces two artifacts in the
# `build-emscripten/` directory at the script root:
#
#   ngspice.js     ES-module loader (Emscripten MODULARIZE output)
#   ngspice.wasm   raw wasm
#
# Caller is expected to have an active emsdk (i.e. `source emsdk_env.sh`).

scripts_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root_directory="$(cd "$scripts_directory/.." && pwd)"
ngspice_source_root="$repository_root_directory/third_party/ngspice"
emscripten_build_directory="$ngspice_source_root/build-emscripten"

if ! command -v emcc >/dev/null 2>&1; then
    echo "emcc not on PATH — source emsdk_env.sh before running this script" >&2
    exit 1
fi

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
    # event_auto_incr is a static counter that collides under emscripten's
    # event_loop emulation; force it to 0 so the wasm build links cleanly.
    emconfigure ../configure \
        --build="$(gcc -dumpmachine)" \
        --host=wasm32-unknown-emscripten \
        --with-ngshared \
        --enable-static \
        --disable-shared \
        --disable-debug \
        --disable-openmp \
        --disable-xspice \
        --with-readline=no \
        CFLAGS="-std=gnu89 -O2" \
        CPPFLAGS="-Devent_auto_incr=0"
}

compile_ngspice_static_library() {
    cd "$emscripten_build_directory"
    emmake make -j"$(nproc)"
}

bundle_emscripten_module() {
    cd "$emscripten_build_directory"
    local libngspice_static_archive="src/.libs/libngspice.a"
    if [ ! -f "$libngspice_static_archive" ]; then
        echo "Expected $libngspice_static_archive after emmake but it is missing" >&2
        exit 1
    fi
    emcc \
        -O2 \
        -sMODULARIZE=1 \
        -sEXPORT_ES6=0 \
        -sEXPORT_NAME=createNgspiceModule \
        -sENVIRONMENT=worker \
        -sALLOW_TABLE_GROWTH=1 \
        -sALLOW_MEMORY_GROWTH=1 \
        -sNO_EXIT_RUNTIME=1 \
        -sASSERTIONS=1 \
        -sRESERVED_FUNCTION_POINTERS=16 \
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
            "addFunction",
            "ccall",
            "cwrap",
            "getValue",
            "setValue",
            "stringToUTF8",
            "UTF8ToString",
            "lengthBytesUTF8",
            "HEAPU8",
            "HEAPU32",
            "HEAPF64"
        ]' \
        --no-entry \
        "$libngspice_static_archive" \
        -o ngspice.js
}

regenerate_configure_script_if_missing
run_emscripten_configure
compile_ngspice_static_library
bundle_emscripten_module

echo
echo "ngspice for emscripten built successfully."
echo "  $emscripten_build_directory/ngspice.js"
echo "  $emscripten_build_directory/ngspice.wasm"
