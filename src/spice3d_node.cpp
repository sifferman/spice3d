#include "spice3d_node.h"

#include "godot_cpp/core/class_db.hpp"
#include "godot_cpp/variant/utility_functions.hpp"

#include "sim/spice_simulator.h"
#include "spice3d_version.h"

namespace spice3d {

void Spice3DNode::_bind_methods() {
	godot::ClassDB::bind_method(godot::D_METHOD("version"), &Spice3DNode::version);
	godot::ClassDB::bind_method(godot::D_METHOD("is_web_backend"), &Spice3DNode::is_web_backend);
	godot::ClassDB::bind_method(godot::D_METHOD("simulator_backend"), &Spice3DNode::simulator_backend);
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
