# spice3d work log

A running log of what's been learned, decided, and completed while building spice3d.
Newest entries at the top.

---

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
