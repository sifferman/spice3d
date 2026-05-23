#pragma once

#include <string>
#include <vector>

namespace spice3d {

struct WireSegment {
	double start_x = 0.0;
	double start_y = 0.0;
	double end_x = 0.0;
	double end_y = 0.0;
	std::string net_label;
};

struct ComponentPin {
	std::string pin_name;
	std::string pin_direction;
	double global_x = 0.0;
	double global_y = 0.0;
};

struct ComponentInstance {
	std::string instance_name;
	std::string symbol_reference;
	std::string symbol_type;
	std::string resolved_symbol_path;
	double placement_x = 0.0;
	double placement_y = 0.0;
	int rotation_quarter_turns = 0;
	int flip_flag = 0;
	std::vector<ComponentPin> pins_in_global_coordinates;
	bool symbol_was_resolved = false;
};

struct Schematic {
	std::string source_file_path;
	std::string cell_name;
	std::vector<WireSegment> wires;
	std::vector<ComponentInstance> component_instances;
};

struct SchematicLoadResult {
	bool was_successful = false;
	std::string error_message;
	Schematic loaded_schematic;
};

SchematicLoadResult load_schematic_from_file(
		const std::string &schematic_file_path,
		const std::string &xschemrc_file_path = std::string(),
		const std::vector<std::string> &extra_symbol_search_paths = {});

} // namespace spice3d
