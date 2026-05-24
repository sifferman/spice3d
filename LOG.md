# spice3d work log

A running log of what's been learned, decided, and completed while building spice3d.
Newest entries at the top. The previous LOG (covering the first PR) lives in the
description of [#1](https://github.com/sifferman/spice3d/pull/1).

---

## 2026-05-23 — Buttons drive ngspice via alter; wire colors animate from samples

End-to-end interactive loop. Clicking the button on the loaded
schematic toggles V_VBUTTON1 between 0 V and VDD; ngspice in the
worker re-stabilises the transient; samples stream back via the
SendData callback and update wire colors in real time.

### C++ side

`Spice3DNode` gained five web-simulator helpers (all no-ops on
native):

- `generate_spice_netlist_for_schematic_file()` — wraps the new
  `schematic_loader::generate_spice_netlist_text_from_schematic_file()`
  which calls `xs_netlister_emit_spice()` into a `std::tmpfile()`
  buffer (was `open_memstream`, but that's POSIX-only and broke
  the Windows CI matrix). Returns `PackedStringArray` of lines.
- `push_netlist_lines_to_web_simulator(lines)` —
  `JavaScriptBridge::eval` `globalThis.spice3d.loadNetlistLines(json)`.
- `start_transient_analysis_on_web_simulator(step, stop)` —
  `globalThis.spice3d.startTransientAnalysis(...)`.
- `halt_simulation_on_web_simulator()` — `stopSimulation()`.
- `set_external_voltage_source_on_web_simulator(name, volts)` —
  `setExternalVoltageSource(name, volts)`.
- `drain_buffered_simulation_samples_from_web_simulator()` —
  `JavaScriptBridge::eval("JSON.stringify(...takeBufferedSimulationSamples())")`
  then `JSON.parse_string()` to a Godot `Array`.

Wire rendering switched from a single shared material to a
per-instance `StandardMaterial3D` so each wire's albedo can be
animated independently. Each wire MeshInstance3D carries the
SPICE node name in its meta dictionary (xschem net label
normalised: leading `#` stripped, lowercased).

New `apply_node_voltages_to_wire_colors(root, voltagesByName, vdd)`
walks the schematic root, looks up each wire's tagged node name
in the dictionary, and lerps its albedo between a low colour
(blue) and a high colour (warm yellow) by voltage / VDD.

### Bridge + worker

Bridge's `handleWorkerMessage` decorates every incoming
`SendData` sample with a `nodeVoltagesByName` dict (built from
`this.nodeNames` captured on `SendInitData`) before queuing it
in `bufferedSimulationSamples`. GDScript drains the buffer with
ready-to-use voltage maps — no parallel-array re-indexing.

### main.gd

After the schematic loads:
1. Generate the netlist, push it to the worker, start a 5 ns / 5 µs
   transient.
2. `_process()` every 100 ms drains buffered samples and feeds the
   most recent `nodeVoltagesByName` into
   `apply_node_voltages_to_wire_colors`.
3. On `button_pressed(instance_name)`, toggle the per-button
   high/low state and send
   `set_external_voltage_source_on_web_simulator(name, 0 or VDD)`.

### Tests

GUT button-signal tests (5) still cover left/right/release/key
event filtering. The Node-level `scripts/test-ngspice-wasm.js`
covers the sharedspice path end-to-end. 9/9 GUT tests pass
headless under Godot 4.4.1.

### godot-cpp gotcha: no namespace-scope `godot::String` constants

A `const godot::String WIRE_META_KEY = godot::String("…")` at file
scope crashed Godot during "Verifying GDExtensions" with a stack
that showed only `libc.so.6 +0x42520`. Cause: godot-cpp wrapper
types call into the GDExtension interface table during
construction, but namespace-scope globals run BEFORE the
`entry_symbol` is called, so the interface table isn't installed
yet. Fixed by switching the key to `const char *`; equivalent
constraint applies to `godot::Variant` / `godot::Dictionary` /
`godot::Color` constants anywhere outside function bodies.

---

## 2026-05-23 — libngspice sharedspice (ngshared) now builds for wasm

The libtool spike succeeded. ngspice's `--with-ngshared` flag (which
exposes the interactive `ngSpice_Init` / `ngSpice_Command` API surface
needed for streaming samples and live `alter` commands) now compiles
end-to-end under emscripten.

### The libtool obstacle

`emconfigure ./configure --with-ngshared --enable-shared` produces a
`libtool` whose top-level config has `build_libtool_libs=no` —
libtool's host detection treats `wasm32-unknown-emscripten` as
unable to build shared libraries. The moment ngspice's per-TU
compile passes `-shared` (which `--with-ngshared` always does),
libtool hits this guard at line ~3998:

```bash
case $arg in
-shared)
  test yes = "$build_libtool_libs" \
    || func_fatal_configuration "cannot build a shared library"
```

and aborts. Compounding it, the libtool template's
`func_fatal_configuration` calls `func__fatal_error` which isn't
defined in the dependent funclib slice that gets emitted, so the
user-visible failure is just `func__fatal_error: command not
found` — easy to chase the wrong rabbit hole.

### The build script's compromise

`scripts/build-ngspice-for-emscripten.sh` now:

1. `emconfigure ../configure --with-ngshared --enable-shared
    --disable-static …`
2. `sed -i 's/^build_libtool_libs=no$/build_libtool_libs=yes/' libtool`
3. `emmake make` — every `.c` compiles to a `.o` under `.libs/`;
   the final libtool link step still fails (libtool can't shape the
   emcc command for a wasm "shared library" output), and that's
   fine because…
4. We collect every `.libs/*.o` (excluding `.libs/libngspice.lax/`
   which contains libtool's duplicate extractions of static
   dependencies — leaving those in produces "duplicate symbol"
   wasm-ld errors) and link them ourselves with `emcc -O2
   -sMODULARIZE=1 -sEXPORT_NAME=createNgspiceModule
   -sEXPORTED_FUNCTIONS=[…ngSpice_Init,ngSpice_Command,…]
   -sEXPORTED_RUNTIME_METHODS=[FS,ccall,cwrap,addFunction,…]`.

Output is a 4.7 MB `ngspice.wasm` + 106 KB `ngspice.js` factory.
The factory pattern works under both Node and a Worker; previous
non-MODULARIZE'd output had a Node CommonJS scoping bug that
hid `globalThis.Module` from the script.

### Worker rewrite

`project/web/ngspice_worker.js` now loads ngspice via
`createNgspiceModule({...}).then(...)`, calls `ngSpice_Init` with
six sharedspice callbacks (SendChar / SendStat / ControlledExit /
SendData / SendInitData / BGThreadRunning) wrapped via
`addFunction`, and translates incoming bridge messages to ngspice
commands:

| Bridge message     | ngspice command(s)               |
|-------------------|------------------------------------|
| `loadNetlist`      | one `circbyline …` per line       |
| `startTransient`   | `tran <step> <stop>` then `bg_run`|
| `halt`             | `bg_halt`                          |
| `externalVoltage`  | `alter v.<name> dc <volts>`       |

Each `SendData` firing posts a `{simulationTimeSeconds,
nodeVoltages[]}` sample back through the bridge.

### Verification path without a browser

`scripts/test-ngspice-wasm.js` loads the freshly-built `ngspice.js`
under Node, runs an RC transient (V1 PULSE -> R1 -> C1) through the
sharedspice callbacks, and asserts:

- The `SendInitData` callback fires and reports vectors named `in`
  and `out` (i.e. ngspice parsed the netlist).
- ≥ 20 `SendData` samples stream back.
- `v(in)` reaches ≥ 0.99 V at its peak.
- `v(out)` reaches ≥ 0.3 V by the end of the run (the RC charge).

Local run prints `PASS — 62 samples, peak v(in)=1.0000,
final v(out)=0.6131`. The pages CI workflow runs this immediately
after the wasm build so I have a functional regression check
without needing browser access.

---

## 2026-05-23 — Godot tests: GUT v9.4.0 vendored, run headless in CI

A research subagent compared GUT (bitwes/Gut) and gdUnit4
(godot-gdunit-labs/gdUnit4) for spice3d's needs (Godot 4.4 compat,
submodule-vendorable, single-file CLI runner). Picked GUT v9.4.0
because it's the explicit 4.3-4.4 release line (9.5+ moved to 4.5+)
and its `addons/gut/gut_cmdln.gd` is one GDScript invoked exactly via
`godot --headless -s …` with `gexit` propagating the test exit code.

Vendored at `third_party/gut` (submodule). Linked into the project
via a symlink `project/addons/gut -> ../../third_party/gut/addons/gut`
so Godot picks it up without duplicating files. First unit test
(`project/test/unit/test_spice3d_node_bindings.gd`) covers the
GDExtension's bound query methods (version, backend description,
web-platform flag) so the binding layer is exercised on every push.

CI runs the suite right after `godot --headless --import` and before
the web export in pages.yml.

---

## 2026-05-23 — Session 2 kickoff: button + animation + interactive ngspice

Goal: get a real interactive loop working — click the button in the schematic,
ngspice runs, wire colors animate based on the resulting voltages. The
schematic in `project/examples/button/` already wires a `button.sym`
(externally-controlled vsource) into a `sky130_fd_sc_hd__inv_1`
(inverter), so the visual loop is "click button, watch the inverter's
output node light up".

### Plan

1. Bring back `claude` as a deploy trigger on `pages.yml` and switch
   `main.gd` to the `button` example.
2. Pick + install a Godot test framework — most of this round will be
   non-visual and needs CI-runnable regression tests. Candidates: GUT
   (bitwes/Gut) and the asset-library entry the user linked.
3. Spike on patching libtool for `--with-ngshared` (interactive
   sharedspice callbacks) under emscripten. Time-box ~30 minutes; if
   it doesn't converge, stay on CLI batch-replay mode.
4. Make the button symbol clickable in Godot. Each click toggles an
   internal high/low state and notifies the simulator.
5. Wire the click → simulator path: assemble the netlist, run ngspice,
   stream samples back, animate wires by mapping voltage to color
   (and optionally extruded height per the design doc's "Color + glow"
   spec).
