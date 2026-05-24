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

## CI / deploy

Pushes to `main` build a web export and publish it to GitHub Pages — see
[`.github/workflows/`](./.github/workflows/).

## License

See [`LICENSE.md`](./LICENSE.md).
