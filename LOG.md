# spice3d work log

A running log of what's been learned, decided, and completed while building spice3d.
Newest entries at the top. The previous LOG (covering the first PR) lives in the
description of [#1](https://github.com/sifferman/spice3d/pull/1).

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
