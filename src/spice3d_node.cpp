#include "spice3d_node.h"

#include "godot_cpp/core/class_db.hpp"
#include "godot_cpp/variant/array.hpp"
#include "godot_cpp/variant/utility_functions.hpp"

#include "scene/schematic_loader.h"
#include "sim/spice_simulator.h"
#include "spice3d_version.h"

namespace spice3d {

namespace {

godot::Dictionary wire_to_dict(const WireSegment &w) {
	godot::Dictionary d;
	d["x1"] = w.x1;
	d["y1"] = w.y1;
	d["x2"] = w.x2;
	d["y2"] = w.y2;
	d["label"] = godot::String(w.label.c_str());
	return d;
}

godot::Dictionary pin_to_dict(const Pin &p) {
	godot::Dictionary d;
	d["name"] = godot::String(p.name.c_str());
	d["dir"] = godot::String(p.dir.c_str());
	d["x"] = p.x;
	d["y"] = p.y;
	return d;
}

godot::Dictionary component_to_dict(const ComponentInstance &c) {
	godot::Dictionary d;
	d["name"] = godot::String(c.name.c_str());
	d["symref"] = godot::String(c.symref.c_str());
	d["type"] = godot::String(c.symbol_type.c_str());
	d["symbol_path"] = godot::String(c.symbol_path.c_str());
	d["x"] = c.x;
	d["y"] = c.y;
	d["rotation"] = c.rotation;
	d["flip"] = c.flip;
	d["resolved"] = c.symbol_resolved;

	godot::Array pins;
	for (const auto &p : c.pins) {
		pins.push_back(pin_to_dict(p));
	}
	d["pins"] = pins;
	return d;
}

} // namespace

void Spice3DNode::_bind_methods() {
	godot::ClassDB::bind_method(godot::D_METHOD("version"), &Spice3DNode::version);
	godot::ClassDB::bind_method(godot::D_METHOD("is_web_backend"), &Spice3DNode::is_web_backend);
	godot::ClassDB::bind_method(godot::D_METHOD("simulator_backend"), &Spice3DNode::simulator_backend);
	godot::ClassDB::bind_method(
			godot::D_METHOD("load_schematic", "sch_path", "xschemrc_path"),
			&Spice3DNode::load_schematic);
}

Spice3DNode::Spice3DNode() = default;
Spice3DNode::~Spice3DNode() = default;

godot::String Spice3DNode::version() const {
	return godot::String(SPICE3D_VERSION);
}

bool Spice3DNode::is_web_backend() const {
#ifdef WEB_ENABLED
	return true;
#else
	return false;
#endif
}

godot::Dictionary Spice3DNode::load_schematic(const godot::String &sch_path, const godot::String &xschemrc_path) {
	const std::string sch = std::string(sch_path.utf8().get_data());
	const std::string rc = std::string(xschemrc_path.utf8().get_data());
	SchematicLoadResult res = spice3d::load_schematic(sch, rc);

	godot::Dictionary out;
	out["ok"] = res.ok;
	out["error"] = godot::String(res.error.c_str());
	out["cell_name"] = godot::String(res.schematic.cell_name.c_str());
	out["path"] = godot::String(res.schematic.path.c_str());

	godot::Array wires;
	for (const auto &w : res.schematic.wires) {
		wires.push_back(wire_to_dict(w));
	}
	out["wires"] = wires;

	godot::Array components;
	for (const auto &c : res.schematic.components) {
		components.push_back(component_to_dict(c));
	}
	out["components"] = components;

	return out;
}

godot::String Spice3DNode::simulator_backend() {
	if (!simulator_) {
		simulator_ = SpiceSimulator::create();
	}
#ifdef WEB_ENABLED
	return godot::String("web (JavaScriptBridge → ngspice Worker)");
#elif defined(SPICE3D_HAVE_LIBNGSPICE)
	return godot::String("native (libngspice)");
#else
	return godot::String("native (stub — libngspice not linked)");
#endif
}

} // namespace spice3d
