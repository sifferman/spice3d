#pragma once

// SchematicLoader — thin C++ wrapper around the xschem2spice C library.
//
// Spice3d does NOT re-parse xschem files itself. The `third_party/xschem2spice/`
// submodule already contains a vetted (LVS-tested) parser distilled from
// xschem 3.4.7. We link its .c files into the GDExtension and surface a
// C++ struct view through this header.
//
// Coverage today
// --------------
// xschem2spice exposes the netlisting view (wires, instances, symbol
// resolution, pin geometry). It does NOT keep the .sym drawing primitives
// (L/B/P/A/T tags), so the renderer cannot yet draw transistor bodies, only
// wires + pin markers + bounding boxes. Extending xschem2spice to retain
// drawing primitives is a planned follow-up.

#include <memory>
#include <string>
#include <vector>

namespace spice3d {

struct WireSegment {
	double x1 = 0.0, y1 = 0.0, x2 = 0.0, y2 = 0.0;
	std::string label; // from `lab=` in the N-record property block; "" if unset
};

struct Pin {
	std::string name; // symbol-local pin name (e.g. "OUT", "VPWR")
	std::string dir;  // "in", "out", "inout", or "" if unset
	double x = 0.0, y = 0.0; // *global* coordinates after applying instance transform
};

struct ComponentInstance {
	std::string name;           // instance's `name=` from C-record property block (e.g. "x1")
	std::string symref;         // exact symref from the .sch (e.g. "sky130_stdcells/dfxtp_1.sym")
	std::string symbol_type;    // K-block type= on the resolved symbol (e.g. "subcircuit", "ipin")
	std::string symbol_path;    // absolute path xschem2spice loaded the .sym from
	double x = 0.0, y = 0.0;    // placement origin in schematic coords
	int rotation = 0;           // 0..3 (×90° CCW)
	int flip = 0;               // 0 or 1
	std::vector<Pin> pins;      // in global coords (instance transform already applied)
	bool symbol_resolved = false;
};

struct Schematic {
	std::string path;
	std::string cell_name;
	std::vector<WireSegment> wires;
	std::vector<ComponentInstance> components;
};

struct SchematicLoadResult {
	bool ok = false;
	std::string error; // human-readable; empty when ok
	Schematic schematic;
};

// Load and resolve a `.sch` file. `xschemrc_path` may be empty to use
// built-in defaults (xschem2spice still searches the .sch's own directory).
// `extra_search_paths` are appended to the library path before resolution —
// use this to point at PDK xschem directories that aren't in an xschemrc.
SchematicLoadResult load_schematic(
		const std::string &sch_path,
		const std::string &xschemrc_path = std::string(),
		const std::vector<std::string> &extra_search_paths = {});

} // namespace spice3d
