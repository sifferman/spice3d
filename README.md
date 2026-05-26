# spice3d

A real-time, interactive SPICE circuit simulator that runs in the browser.
Built on Godot (C++ GDExtension), [libngspice](https://ngspice.sourceforge.io/)
compiled to WebAssembly, and [xschem](https://xschem.sourceforge.io/) for
schematic input.

This README documents how to build/run what's in *this* repository.

## Status

Early scaffolding. The running progress log lives in each PR's description.

## Layout

| Path | Contents |
|---|---|
| `src/` | C++ source for the `spice3d` GDExtension |
| `project/` | Godot project — what gets exported to web / native |
| `godot-cpp/` | godot-cpp git submodule (run `git submodule update --init` once) |
| `SConstruct`, `CMakeLists.txt` | Two build entry points; both produce the same shared library |

## Build

```bash
# one-time
git submodule update --init

# native
scons platform=linux target=template_debug

# web (Emscripten must be in PATH; nothreads build per godot-cpp convention)
scons platform=web target=template_debug
```

After building, the shared library is copied into `project/bin/<platform>/`
and picked up automatically via `project/bin/spice3d.gdextension`.

## Debug the web build locally

The deployed GitHub Pages build can take several minutes to land
(push → CI → deploy → hard-refresh in a browser that may have
cached an old `index.wasm`). For the inner debugging loop where
that latency hurts, re-export and serve the same artifacts from
localhost:

```bash
scripts/serve-local-web-export.sh
```

Prerequisites — these are the same artifacts the CI build needs,
just produced locally one time:

1. `scripts/build-ngspice-for-emscripten.sh` — produces
   `third_party/ngspice/build-emscripten/ngspice.{js,wasm}`.
2. `scons -j"$(nproc)" target=template_release platform=web arch=wasm32 precision=single threads=no`
   — produces the web template-release GDExtension wasm.
3. A Godot 4.4.1 binary on `PATH` as `godot` (override with
   `GODOT_EXECUTABLE_PATH=...`).

The script exports the project to `build-web-local/`, copies the
ngspice bridge + worker JS, copies the ngspice wasm artifacts,
injects the bridge `<script>` tag into `index.html`, and serves
the directory via `python3 -m http.server` on port `8000`
(override with `SPICE3D_LOCAL_HTTP_SERVER_PORT=...`). Open the URL
in a Private Window to avoid Firefox reusing a stale `index.wasm`
from an earlier session.

## CI / deploy

Pushes to `main` build a web export and publish it to GitHub Pages — see
[`.github/workflows/`](./.github/workflows/).

## License

See [`LICENSE.md`](./LICENSE.md).
