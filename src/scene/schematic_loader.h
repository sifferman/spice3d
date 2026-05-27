#pragma once

#include <string>
#include <variant>
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

struct DrawingLineSegment {
	double x1 = 0.0;
	double y1 = 0.0;
	double x2 = 0.0;
	double y2 = 0.0;
};

struct DrawingBox {
	double x1 = 0.0;
	double y1 = 0.0;
	double x2 = 0.0;
	double y2 = 0.0;
	bool filled = false;
};

struct DrawingPolygon {
	std::vector<double> vertex_xs;
	std::vector<double> vertex_ys;
	bool filled = false;
};

struct DrawingArc {
	double center_x = 0.0;
	double center_y = 0.0;
	double radius = 0.0;
	double start_angle_degrees = 0.0;
	double sweep_angle_degrees = 0.0;
};

struct DrawingText {
	std::string text;
	double anchor_x = 0.0;
	double anchor_y = 0.0;
	int rotation_quarter_turns = 0;
	int flip = 0;
	double horizontal_size_factor = 1.0;
	double vertical_size_factor = 1.0;
};

using DrawingRecord = std::variant<
		DrawingLineSegment,
		DrawingBox,
		DrawingPolygon,
		DrawingArc,
		DrawingText>;

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
	std::vector<DrawingRecord> symbol_drawing_records_in_local_coordinates;
	bool symbol_was_resolved = false;
};

struct Schematic {
	std::string source_file_path;
	std::string cell_name;
	std::vector<WireSegment> wires;
	std::vector<ComponentInstance> component_instances;
	std::vector<DrawingRecord> top_level_drawing_records_in_global_coordinates;
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

struct GeneratedSpiceNetlist {
	bool was_successful = false;
	std::string error_message;
	std::string spice_netlist_text;
};

GeneratedSpiceNetlist generate_spice_netlist_text_from_schematic_file(
		const std::string &schematic_file_path,
		const std::string &xschemrc_file_path = std::string(),
		const std::vector<std::string> &extra_symbol_search_paths = {});

} // namespace spice3d
