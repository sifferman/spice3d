# spice3d work log

A running log of what's been learned, decided, and completed while building spice3d.
Newest entries at the top.

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
