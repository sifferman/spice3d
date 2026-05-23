#pragma once

// Spice3DNode is the entry-point GDExtension node for the spice3d simulator.
// For now it is intentionally minimal: it exists so the Godot project can
// instantiate *something* from the GDExtension while the rest of the
// architecture (xschem parsing, ngspice bridge, scene generation) is wired up.

#include "godot_cpp/classes/node.hpp"
#include "godot_cpp/classes/wrapped.hpp"
#include "godot_cpp/variant/string.hpp"

namespace spice3d {

class Spice3DNode : public godot::Node {
	GDCLASS(Spice3DNode, godot::Node)

protected:
	static void _bind_methods();

public:
	Spice3DNode() = default;
	~Spice3DNode() override = default;

	godot::String version() const;
	bool is_web_backend() const;
};

} // namespace spice3d
