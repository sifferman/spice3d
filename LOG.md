# spice3d work log

A running log of what's been learned, decided, and completed while building spice3d.
Newest entries at the top.

---

## 2026-05-22 — session wrap

### Done this session (4 commits on `claude`)
1. **Template rename**: `EXTENSION-NAME` → `spice3d`, `example_library_init`
   → `spice3d_library_init`, `ExampleClass` → `Spice3DNode` (namespaced),
   project files renamed, `compatibility_minimum=4.3`.
2. **GitHub Pages deploy** (`.github/workflows/pages.yml`): builds the
   GDExtension for web → installs Godot 4.3-stable + templates → runs
   `--headless --export-release "Web"` → injects coi-serviceworker → deploys.
3. **Ngspice dual-backend scaffold** (`src/sim/`): platform-agnostic
   `SpiceSimulator` interface with native (libngspice) and web
   (JavaScriptBridge) impls. v0 ingress via mutex-guarded sample queue;
   SAB-backed ring buffer later.
4. **Parser wrapper around xschem2spice** (`src/scene/schematic_loader.*`)
   + smoke test + `parser-test` CI job. **Verified end-to-end** against
   button_test and 3bit_counter examples.

### Next clear targets (in rough priority)
- **Verify pages.yml runs green in CI**. The `~/.local/share/godot/export_templates/4.3.stable/` path and the `.tpz` extraction layout are educated guesses; first run will say if they're right.
- **Get libngspice actually linked on native**. The hard part is the build, not the integration — once `sharedspice.h` is on the include path and `-lngspice` resolves, `SPICE3D_HAVE_LIBNGSPICE` flips on and the existing scaffold runs unchanged.
- **Build the ngspice WASM module**. `spice3d_notes/references/ngspice_example/Dockerfile` is the reference. Output goes alongside `project/web/ngspice_worker.js`; `pages.yml` already stages those files.
- **Extend xschem2spice to retain L/B/P/A/T drawing primitives** so the renderer can draw actual transistor bodies, not just bounding boxes. User owns the repo; cleanest place to add this.
- **Schematic→Godot scene generator**. With the loader returning components+pins+wires, write a `SchematicView` Godot scene that drops Line3D / MeshInstance3D nodes for each wire and a CSGBox3D per component. Sky's the limit from there.

### Risks / things that may bite on first CI run
- `godot_cpp/classes/java_script_bridge.hpp` may not exist verbatim in
  godot-cpp 4.3 — header naming convention is `snake_case` from the
  underlying class, but Godot has historically renamed JavaScriptBridge
  back and forth. If the web build fails to find the header, swap
  conditionally to whatever name godot-cpp generates.
- xschem2spice depends on `unistd.h` indirectly (libgen.h). On Emscripten
  this should be fine; on MSVC, the project doesn't ship POSIX libgen.
  Native Windows builds will need a polyfill or to drop those calls. Not
  a concern for CI's ubuntu-22.04 + emscripten paths.
- `parser-test` clones `sifferman/spice3d_notes` from CI — that repo must
  be public or the workflow needs a PAT.

---

## 2026-05-22 — xschem parser via xschem2spice

### Decision: don't reimplement, reuse
Per the design doc and user direction, spice3d parses `.sch` / `.sym` files by
linking [xschem2spice](https://github.com/sifferman/xschem2spice) directly
into the GDExtension. xschem2spice already mirrors xschem 3.4.7's parsing
pipeline (distilled in `parser.c` and `netlist.c`) and is LVS-verified
against the real `xschem` binary in its own CI. Reimplementing the L/B/P/A/T
walker in C++ would be a year of bugs xschem2spice has already fixed.

Submodule lives at `third_party/xschem2spice/` (https URL — git@ would
require SSH credentials on every clone).

### Surface
- `src/scene/schematic_loader.{h,cpp}` — pure C++/STL, no godot-cpp
  dependency. Takes a `.sch` path + optional xschemrc, returns a
  `SchematicLoadResult { ok, error, Schematic { wires, components } }`.
  Component pins are pre-transformed into global coords via
  `xs_transform_pin_to_global`.
- `Spice3DNode::load_schematic(sch_path, xschemrc_path)` — Godot-callable
  shim that returns a `Dictionary` with the same data. GDScript-friendly.

### What's *missing* in xschem2spice for the renderer
xschem2spice keeps the netlisting view — wires (N records) and instances
(C records) — but discards the .sym drawing primitives (L/B/P/A/T tags).
The renderer can do a v0 visualization with just wires + pin markers +
bounding boxes, but real transistor body art will need either:
  (a) extending xschem2spice to retain drawing primitives, or
  (b) a parallel lightweight scanner in spice3d that only reads L/B/P/A/T
      and discards everything else.
(a) is cleaner since the user owns xschem2spice. Tracked as future work.

### Smoke test
`test/test_schematic_loader.cpp` links schematic_loader.cpp against
xschem2spice's C sources (no Godot toolchain) and runs against the
example schematics in `../spice3d_notes/examples`. Today it asserts:
- `button_test.sch` → 3 components, 0 wires, cell=button_test.
- `3bit_counter.sch` → 14 components, 24 wires, all wires labelled.

Both pass locally. CI runs the same test on every push — `parser-test` job
in `.github/workflows/ci.yml` checks out `sifferman/spice3d_notes` as a
sibling for the example data, then `make -C test run`.

### Build glue
- `CMakeLists.txt`: added `LANGUAGES CXX C`, listed the 5 xschem2spice C
  files explicitly (excluding `xschem2spice.c` which has a CLI `main()`),
  added the include path.
- `SConstruct`: same — Glob with an explicit exclude of `xschem2spice.c`.

---

## 2026-05-22 — ngspice dual-backend scaffold

### `src/sim/` layout
```
sim/
├── spice_simulator.h        public interface (Sample, SimInitInfo, SpiceSimulator)
├── spice_simulator.cpp      factory: #ifdef WEB_ENABLED picks one
├── sample_queue.h           thread-safe FIFO (mutex+vector for v0)
├── native/                  libngspice impl (gated by SPICE3D_HAVE_LIBNGSPICE)
└── web/                     JavaScriptBridge → Worker impl (stub)
```

### Key API decisions
- **Samples carry timestamps** (`Sample::time`). Non-uniform tran steps mean
  the renderer must place each on the wall-clock timeline, not assume a fixed
  rate — captured directly in the type.
- **Drain-based ingress** (`drain_samples()`). v0 uses a `std::mutex`-guarded
  `std::vector` (sample_queue.h). Renderer polls each frame. A SAB ring buffer
  can swap in later without changing the public API.
- **External voltage sources keyed by lowercase name**. ngspice reports the
  callback name lowercased ("vbutton1"); host code can pass any case.
- **`save none` + `esave node`** issued before `bg_tran` to keep ngspice from
  accumulating an unbounded plot — design doc constraint.
- **`bg_tran` not `tran`**. Background transient lets ngspice run on its own
  thread and `ngSpice_Command("bg_halt")` from Godot's thread is how we stop.

### Native compile gate
`SPICE3D_HAVE_LIBNGSPICE` controls whether `sharedspice.h` is included and
ngspice C calls are made. Until libngspice is available locally / in CI, the
native backend compiles as a stub that returns false from `load_netlist` and
no-op everywhere else. Spice3DNode::simulator_backend() advertises this in
its return string so GDScript can distinguish "native (libngspice)" from
"native (stub)".

### Web Worker harness (placeholder)
`project/web/ngspice_bridge.js` and `project/web/ngspice_worker.js` are in
place but do nothing useful yet. Bridge sets up `globalThis.spice3d` with the
expected method names; worker just acks `ready` and errors on every other
message. pages.yml copies both files into the Pages output so they live at
predictable URLs the moment the real WASM is ready.

### Open questions / not verified
- Have not confirmed `godot_cpp/classes/java_script_bridge.hpp` is the
  correct header path in godot-cpp 4.3 — only validated empirically once a
  web build runs in CI.
- `JavaScriptBridge::get_singleton()->eval(...)` is the simplest path for
  the C++ → JS direction. JS → C++ direction is harder and likely needs to
  flow through a `JavaScriptObject` callback registered from GDScript;
  parking that for the real wiring pass.

---

## 2026-05-22 — GitHub Pages deploy workflow

Added `.github/workflows/pages.yml`. On every push to `main`:
1. Build the GDExtension for web (wasm32, single, `template_release`) via the
   existing `setup-godot-cpp` action from the godot-cpp 4.3 submodule.
2. Install Godot 4.3-stable + matching export templates.
3. Run `--headless --import` twice (first run dies before imports finish; the
   second pass is reliably clean), then `--headless --export-release "Web"`
   into `build-web/`.
4. Fetch `coi-serviceworker.js` and inject `<script src="coi-serviceworker.js">`
   into the first `<head>` tag of Godot's exported `index.html`. Idempotent.
5. Upload via `actions/upload-pages-artifact@v3` → `actions/deploy-pages@v4`.

### Why coi-serviceworker, even with Godot threads off
The GDExtension wasm is built `nothreads` (Godot 4.3 GDExtension web support
is the nothreads variant). Godot itself runs single-threaded in the main
context. But the ngspice WASM module will live in a **separately spawned**
Web Worker that we control, and that worker needs SharedArrayBuffer to talk
to Godot on the hot path. GitHub Pages can't serve COOP/COEP headers, so the
Service Worker shim is what gets us cross-origin-isolation at runtime.

### Export preset choices (`project/export_presets.cfg`)
- `variant/extensions_support=true` — required for GDExtension on web.
- `variant/thread_support=false` — matches `nothreads.wasm` paths in the
  `.gdextension`.
- `progressive_web_app/ensure_cross_origin_isolation_headers=true` — Godot
  4.3's own header-injection helper. Belt-and-suspenders with coi-serviceworker.

### Open questions / not verified
- The pages workflow has not been run end-to-end yet (no CI in this loop).
  Most likely failure points if it breaks on first run:
  - `~/.local/share/godot/export_templates/4.3.stable/` path (Godot's expected
    template root may differ between minor versions).
  - The `.tpz` unzips to a `templates/` directory we then move from — verify
    on first CI run.
  - The `actions/deploy-pages` step needs the repo's Pages source to be set
    to "GitHub Actions" in repo settings; we cannot do that from CI.

## 2026-05-22 — session start

### State of the repo
- Repo is an unmodified `godot-cpp-template` (placeholder `EXTENSION-NAME`, `example_library_init`, etc.).
- `godot-cpp/` submodule directory is empty — not initialized yet.
- Only commit on `main` and `claude` is the initial template import (`8f3bf92`).
- All referenced repos (ngspice, xschem, xschem2spice, ciel, ngspice_example, BananaSpice, concurrentqueue, godot-cpp-template, sky130_schematics) are populated as submodules under `/home/ethan/GitHub/spice3d_notes/references/`. Useful for source-reading; not part of this repo.

### Plan agreed with user
Order: **GitHub Pages deploy → ngspice integration → xschem parser**. Work autonomously and commit to `claude` branch (never `main`). Reuse `xschem2spice` parser logic rather than reimplementing from scratch.

### Notes from `spice3d_notes/README.md` that pin down concrete decisions
- **Threading model**: ngspice WASM lives in its own Web Worker; `SharedArrayBuffer` + `Atomics` for the hot path. coi-serviceworker provides COOP/COEP so SAB is available on GitHub Pages.
- **Sample carries timestamp**: ngspice transient timesteps are non-uniform — every `cb_SendData` value must keep its `time` so the renderer can place it on a wall-clock timeline.
- **Memory management**: must issue `esave node` + `save none` before `tran` to stop ngspice accumulating an unbounded internal plot. Voltage data flows through `cb_SendData` only.
- **Net mapping**: don't write a mapping file — call into xschem2spice's renaming functions directly so the renderer can bind drawn-wire labels to mangled hierarchical net names (`x1.x2.net`, bus expansion, global nets).
- **PDK assets**: only `libs.tech/combined/` (~3.2 MB SPICE models) and `libs.tech/xschem/` (~8.2 MB symbols) are needed. `libs.ref/` (~1.1 GB layouts) is **skipped in-stream** during tar extraction. Directory structure under `combined/` must be preserved so relative `.include` paths resolve inside ngspice's Emscripten FS.
- **`#ifdef WEB_ENABLED`** selects backend: web uses `JavaScriptBridge` to a Worker, native links `libngspice.so` directly. Same API above the line.

### Reference: minimal native ngspice loop
`spice3d_notes/references/ngspice_example/sim.cpp` is the working pattern — `ngSpice_Init` → `ngSpice_Init_Sync` (registers `cb_GetVSRCData`) → `ngSpice_Circ` (in-memory netlist) → `ngSpice_Command("tran ...")` → poll `ngSpice_running()`. `cb_GetVSRCData(value, time, nodeName, …)` is where switch state is injected; nodeName is lowercased.
