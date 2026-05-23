#pragma once

#include <memory>

#include "godot_cpp/classes/node.hpp"
#include "godot_cpp/classes/node3d.hpp"
#include "godot_cpp/classes/wrapped.hpp"
#include "godot_cpp/variant/dictionary.hpp"
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

	godot::String get_spice3d_version() const;
	bool is_running_on_web_platform() const;
	godot::String describe_simulator_backend();
	godot::Dictionary load_schematic_into_dictionary(
			const godot::String &schematic_file_path,
			const godot::String &xschemrc_file_path);
	godot::Dictionary load_schematic_and_render_into_node3d(
			godot::Node3D *parent_node_for_rendered_meshes,
			const godot::String &schematic_file_path,
			const godot::String &xschemrc_file_path);

private:
	std::unique_ptr<SpiceSimulator> simulator;
};

} // namespace spice3d
