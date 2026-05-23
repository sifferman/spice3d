#include "spice3d_node.h"

#include "godot_cpp/core/class_db.hpp"
#include "godot_cpp/variant/utility_functions.hpp"

#include "spice3d_version.h"

namespace spice3d {

void Spice3DNode::_bind_methods() {
	godot::ClassDB::bind_method(godot::D_METHOD("version"), &Spice3DNode::version);
	godot::ClassDB::bind_method(godot::D_METHOD("is_web_backend"), &Spice3DNode::is_web_backend);
}

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

} // namespace spice3d
