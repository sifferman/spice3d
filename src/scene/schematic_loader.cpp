#include "schematic_loader.h"

#include <cstdlib>
#include <cstring>

extern "C" {
#include "netlist.h"
#include "parser.h"
#include "xschemrc.h"
}

namespace spice3d {

namespace {

std::string maybe_dup(const char *s) {
	return s ? std::string(s) : std::string();
}

// Read `lab=` from an N-record property block via xschem2spice's parser.
std::string wire_label(const char *prop_block) {
	if (!prop_block) return {};
	char *val = xs_prop_get(prop_block, "lab");
	if (!val) return {};
	std::string out(val);
	std::free(val);
	return out;
}

std::string instance_name(const char *prop_block) {
	if (!prop_block) return {};
	char *val = xs_prop_get(prop_block, "name");
	if (!val) return {};
	std::string out(val);
	std::free(val);
	return out;
}

void copy_pins_to_global(const xs_instance &inst, ComponentInstance &out) {
	if (!inst.resolved_symbol) {
		out.symbol_resolved = false;
		return;
	}
	out.symbol_resolved = true;
	out.symbol_type = maybe_dup(inst.resolved_symbol->type);
	out.symbol_path = maybe_dup(inst.resolved_symbol->path);

	const xs_symbol &sym = *inst.resolved_symbol;
	out.pins.reserve(sym.pin_count);
	for (int i = 0; i < sym.pin_count; ++i) {
		const xs_symbol_pin &p = sym.pins[i];
		double gx = 0.0, gy = 0.0;
		xs_transform_pin_to_global(inst.rotation, inst.flip, p.x, p.y, &gx, &gy);
		Pin pin;
		pin.name = maybe_dup(p.name);
		pin.dir = maybe_dup(p.dir);
		pin.x = inst.x + gx;
		pin.y = inst.y + gy;
		out.pins.push_back(std::move(pin));
	}
}

} // anonymous namespace

SchematicLoadResult load_schematic(
		const std::string &sch_path,
		const std::string &xschemrc_path,
		const std::vector<std::string> &extra_search_paths) {
	SchematicLoadResult result;

	xs_library_path lib;
	xs_library_path_init(&lib);
	if (!xschemrc_path.empty()) {
		xs_library_path_load_xschemrc(&lib, xschemrc_path.c_str());
	}
	for (const auto &p : extra_search_paths) {
		xs_library_path_add(&lib, p.c_str());
	}

	xs_schematic sch;
	std::memset(&sch, 0, sizeof(sch));
	if (xs_parse_schematic(sch_path.c_str(), &sch) != 0) {
		xs_library_path_free(&lib);
		result.error = "failed to parse schematic: " + sch_path;
		return result;
	}

	xs_netlister nl;
	xs_netlister_init(&nl, &lib, /*lvs_mode=*/0);
	if (xs_netlister_resolve_symbols(&nl, &sch) != 0) {
		// Continue anyway — unresolved symbols become components with
		// symbol_resolved=false. This matches xschem's own "* IS MISSING"
		// pattern; the renderer can draw a placeholder.
	}

	result.schematic.path = maybe_dup(sch.path);
	result.schematic.cell_name = maybe_dup(sch.cell_name);

	result.schematic.wires.reserve(sch.wire_count);
	for (int i = 0; i < sch.wire_count; ++i) {
		const xs_wire &w = sch.wires[i];
		WireSegment seg;
		seg.x1 = w.x1; seg.y1 = w.y1; seg.x2 = w.x2; seg.y2 = w.y2;
		seg.label = wire_label(w.prop_block);
		result.schematic.wires.push_back(std::move(seg));
	}

	result.schematic.components.reserve(sch.instance_count);
	for (int i = 0; i < sch.instance_count; ++i) {
		const xs_instance &inst = sch.instances[i];
		ComponentInstance c;
		c.name = instance_name(inst.prop_block);
		c.symref = maybe_dup(inst.symref);
		c.x = inst.x;
		c.y = inst.y;
		c.rotation = inst.rotation;
		c.flip = inst.flip;
		copy_pins_to_global(inst, c);
		result.schematic.components.push_back(std::move(c));
	}

	result.ok = true;
	xs_netlister_free(&nl);
	xs_free_schematic(&sch);
	xs_library_path_free(&lib);
	return result;
}

} // namespace spice3d
