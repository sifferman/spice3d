#pragma once

#include "godot_cpp/classes/node3d.hpp"
#include "godot_cpp/variant/dictionary.hpp"

namespace spice3d {

class Spice3DNode;
struct Schematic;

void add_rendered_meshes_for_schematic_to_parent_node(
		Spice3DNode *spice3d_node_for_button_signals,
		godot::Node3D *parent_node,
		const Schematic &loaded_schematic);

void update_wire_mesh_colors_from_node_voltages(
		godot::Node3D *schematic_root_node,
		const godot::Dictionary &spice_node_name_to_voltage,
		double vdd_volts);

} // namespace spice3d
