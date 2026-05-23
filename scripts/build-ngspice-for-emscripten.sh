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

apply_configure_patches_for_emscripten() {
    cd "$ngspice_source_root"
    # getrusage isn't available under wasi-libc; the AC_CHECK_FUNCS test
    # passes via emscripten's stub but the actual call fails at link.
    # Drop it so HAVE_GETRUSAGE stays undefined in config.h.
    if grep -q 'AC_CHECK_FUNCS(\[times getrusage\])' configure.ac; then
        sed -i 's/AC_CHECK_FUNCS(\[times getrusage\])/AC_CHECK_FUNCS([times])/g' configure.ac
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
    # --with-ngshared invokes libtool in shared-library mode, which fails
    # on wasm32-unknown-emscripten with "func__fatal_error: command not
    # found" (libtool's host case branch has no emscripten entry). We
    # build the CLI binary instead and drive it from the worker via
    # Emscripten FS until that's patched. event_auto_incr is a static
    # counter that collides under emscripten's event_loop emulation;
    # force it to 0.
    emconfigure ../configure \
        --build="$(gcc -dumpmachine)" \
        --host=wasm32-unknown-emscripten \
        --disable-debug \
        --disable-openmp \
        --disable-xspice \
        --with-readline=no \
        CFLAGS="-std=gnu89 -O2" \
        CPPFLAGS="-Devent_auto_incr=0"
}

compile_ngspice_binary() {
    cd "$emscripten_build_directory"
    # ngspice's main() expects to run as a CLI program; we want to call
    # it later via Module.callMain(['-b', '/foo.cir']) from the worker
    # and write the netlist via Module.FS.writeFile first, so re-export
    # both. INVOKE_RUN=0 prevents Emscripten from running main() at
    # module load.
    local ngspice_emscripten_link_flags=(
        -sEXPORTED_RUNTIME_METHODS='["FS","callMain"]'
        -sINVOKE_RUN=0
        -sALLOW_MEMORY_GROWTH=1
        -sNO_EXIT_RUNTIME=1
    )
    emmake make -j"$(nproc)" LDFLAGS="${ngspice_emscripten_link_flags[*]}"
}

stage_emscripten_artifacts() {
    cd "$emscripten_build_directory"
    local ngspice_emscripten_binary="src/ngspice"
    if [ ! -f "$ngspice_emscripten_binary" ]; then
        echo "Expected $ngspice_emscripten_binary after emmake but it is missing" >&2
        exit 1
    fi
    cp "$ngspice_emscripten_binary" ngspice.js
    if [ ! -f "${ngspice_emscripten_binary}.wasm" ] && [ -f "src/ngspice.wasm" ]; then
        cp src/ngspice.wasm ngspice.wasm
    elif [ -f "${ngspice_emscripten_binary}.wasm" ]; then
        cp "${ngspice_emscripten_binary}.wasm" ngspice.wasm
    fi
    if [ ! -f ngspice.wasm ]; then
        echo "Could not locate the produced ngspice.wasm next to the binary" >&2
        exit 1
    fi
}

apply_configure_patches_for_emscripten
regenerate_configure_script_if_missing
run_emscripten_configure
compile_ngspice_binary
stage_emscripten_artifacts

echo
echo "ngspice for emscripten built successfully."
echo "  $emscripten_build_directory/ngspice.js"
echo "  $emscripten_build_directory/ngspice.wasm"
