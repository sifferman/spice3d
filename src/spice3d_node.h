#pragma once

// Spice3DNode is the entry-point GDExtension node for the spice3d simulator.
// For now it is intentionally minimal: it exists so the Godot project can
// instantiate *something* from the GDExtension while the rest of the
// architecture (xschem parsing, ngspice bridge, scene generation) is wired up.

#include <memory>

#include "godot_cpp/classes/node.hpp"
#include "godot_cpp/classes/wrapped.hpp"
#include "godot_cpp/variant/string.hpp"

namespace spice3d {

class SpiceSimulator;

class Spice3DNode : public godot::Node {
	GDCLASS(Spice3DNode, godot::Node)

protected:
	static void _bind_methods();

public:
	Spice3DNode();
	~Spice3DNode() override;

	godot::String version() const;
	bool is_web_backend() const;

	// Construct (lazily) and return the simulator's backend tag — useful in
	// GDScript for sanity-checking that the factory picked the expected
	// implementation per platform.
	godot::String simulator_backend();

private:
	std::unique_ptr<SpiceSimulator> simulator_;
};

} // namespace spice3d
