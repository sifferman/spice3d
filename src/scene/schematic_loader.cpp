#include "schematic_loader.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>

extern "C" {
#include "netlist.h"
#include "parser.h"
#include "xschemrc.h"
}

namespace spice3d {

namespace {

std::string copy_c_string_or_empty(const char *possibly_null_c_string) {
	return possibly_null_c_string ? std::string(possibly_null_c_string) : std::string();
}

std::string read_property_value_or_empty(const char *property_block, const char *property_key) {
	if (!property_block) return {};
	char *allocated_value = xs_prop_get(property_block, property_key);
	if (!allocated_value) return {};
	std::string value_copy(allocated_value);
	std::free(allocated_value);
	return value_copy;
}

ComponentPin make_pin_in_global_coordinates(
		const xs_instance &instance,
		const xs_symbol_pin &symbol_local_pin) {
	double rotated_local_x = 0.0;
	double rotated_local_y = 0.0;
	xs_transform_pin_to_global(
			instance.rotation,
			instance.flip,
			symbol_local_pin.x,
			symbol_local_pin.y,
			&rotated_local_x,
			&rotated_local_y);

	ComponentPin pin;
	pin.pin_name = copy_c_string_or_empty(symbol_local_pin.name);
	pin.pin_direction = copy_c_string_or_empty(symbol_local_pin.dir);
	pin.global_x = instance.x + rotated_local_x;
	pin.global_y = instance.y + rotated_local_y;
	return pin;
}

DrawingRecord drawing_record_from_xschem_record(const xs_drawing_record &xschem_record) {
	switch (xschem_record.tag) {
		case 'L': {
			DrawingLineSegment line;
			line.x1 = xschem_record.data.line.x1;
			line.y1 = xschem_record.data.line.y1;
			line.x2 = xschem_record.data.line.x2;
			line.y2 = xschem_record.data.line.y2;
			return line;
		}
		case 'B': {
			DrawingBox box;
			box.x1 = xschem_record.data.box.x1;
			box.y1 = xschem_record.data.box.y1;
			box.x2 = xschem_record.data.box.x2;
			box.y2 = xschem_record.data.box.y2;
			box.filled = xschem_record.data.box.filled != 0;
			return box;
		}
		case 'P': {
			DrawingPolygon polygon;
			const int vertex_count = xschem_record.data.polygon.vertex_count;
			polygon.vertex_xs.assign(
					xschem_record.data.polygon.vertex_xs,
					xschem_record.data.polygon.vertex_xs + vertex_count);
			polygon.vertex_ys.assign(
					xschem_record.data.polygon.vertex_ys,
					xschem_record.data.polygon.vertex_ys + vertex_count);
			polygon.filled = xschem_record.data.polygon.filled != 0;
			return polygon;
		}
		case 'A': {
			DrawingArc arc;
			arc.center_x = xschem_record.data.arc.center_x;
			arc.center_y = xschem_record.data.arc.center_y;
			arc.radius = xschem_record.data.arc.radius;
			arc.start_angle_degrees = xschem_record.data.arc.start_angle_degrees;
			arc.sweep_angle_degrees = xschem_record.data.arc.sweep_angle_degrees;
			return arc;
		}
		default: {
			DrawingText text;
			text.text = copy_c_string_or_empty(xschem_record.data.text.text);
			text.anchor_x = xschem_record.data.text.anchor_x;
			text.anchor_y = xschem_record.data.text.anchor_y;
			text.rotation_quarter_turns = xschem_record.data.text.rotation_quarter_turns;
			text.flip = xschem_record.data.text.flip;
			text.horizontal_size_factor = xschem_record.data.text.horizontal_size_factor;
			text.vertical_size_factor = xschem_record.data.text.vertical_size_factor;
			return text;
		}
	}
}

std::vector<DrawingRecord> drawing_records_vector_from_xschem(
		const xs_drawing_record *xschem_records,
		int xschem_record_count);

void populate_symbol_dependent_fields(const xs_instance &instance, ComponentInstance &component) {
	if (!instance.resolved_symbol) {
		component.symbol_was_resolved = false;
		return;
	}
	const xs_symbol &resolved_symbol = *instance.resolved_symbol;
	component.symbol_was_resolved = true;
	component.symbol_type = copy_c_string_or_empty(resolved_symbol.type);
	component.resolved_symbol_path = copy_c_string_or_empty(resolved_symbol.path);
	component.pins_in_global_coordinates.reserve(resolved_symbol.pin_count);
	for (int pin_index = 0; pin_index < resolved_symbol.pin_count; ++pin_index) {
		component.pins_in_global_coordinates.push_back(
				make_pin_in_global_coordinates(instance, resolved_symbol.pins[pin_index]));
	}
	component.symbol_drawing_records_in_local_coordinates = drawing_records_vector_from_xschem(
			resolved_symbol.drawing_records, resolved_symbol.drawing_record_count);
}

std::vector<DrawingRecord> drawing_records_vector_from_xschem(
		const xs_drawing_record *xschem_records,
		int xschem_record_count) {
	std::vector<DrawingRecord> records;
	records.reserve(xschem_record_count);
	for (int record_index = 0; record_index < xschem_record_count; ++record_index) {
		records.push_back(drawing_record_from_xschem_record(xschem_records[record_index]));
	}
	return records;
}

WireSegment make_wire_segment(const xs_wire &xschem_wire) {
	WireSegment wire;
	wire.start_x = xschem_wire.x1;
	wire.start_y = xschem_wire.y1;
	wire.end_x = xschem_wire.x2;
	wire.end_y = xschem_wire.y2;
	wire.net_label = read_property_value_or_empty(xschem_wire.prop_block, "lab");
	return wire;
}

ComponentInstance make_component_instance(const xs_instance &xschem_instance) {
	ComponentInstance component;
	component.instance_name = read_property_value_or_empty(xschem_instance.prop_block, "name");
	component.symbol_reference = copy_c_string_or_empty(xschem_instance.symref);
	component.placement_x = xschem_instance.x;
	component.placement_y = xschem_instance.y;
	component.rotation_quarter_turns = xschem_instance.rotation;
	component.flip_flag = xschem_instance.flip;
	populate_symbol_dependent_fields(xschem_instance, component);
	return component;
}

void load_xschemrc_into_library_path_if_provided(
		const std::string &xschemrc_file_path,
		xs_library_path *library_path) {
	if (xschemrc_file_path.empty()) return;
	xs_library_path_load_xschemrc(library_path, xschemrc_file_path.c_str());
}

void append_search_paths_to_library_path(
		const std::vector<std::string> &extra_symbol_search_paths,
		xs_library_path *library_path) {
	for (const auto &one_search_path : extra_symbol_search_paths) {
		xs_library_path_add(library_path, one_search_path.c_str());
	}
}

std::string directory_portion_of_file_path(const std::string &file_path) {
	const auto last_path_separator_position = file_path.find_last_of("/\\");
	if (last_path_separator_position == std::string::npos) return std::string(".");
	if (last_path_separator_position == 0) return std::string("/");
	return file_path.substr(0, last_path_separator_position);
}

void add_schematic_own_directory_to_library_path(
		const std::string &schematic_file_path,
		xs_library_path *library_path) {
	const std::string schematic_directory = directory_portion_of_file_path(schematic_file_path);
	xs_library_path_add(library_path, schematic_directory.c_str());
}

std::vector<WireSegment> wires_from_parsed_xschem(const xs_schematic &parsed_schematic) {
	std::vector<WireSegment> wires;
	wires.reserve(parsed_schematic.wire_count);
	for (int wire_index = 0; wire_index < parsed_schematic.wire_count; ++wire_index) {
		wires.push_back(make_wire_segment(parsed_schematic.wires[wire_index]));
	}
	return wires;
}

std::vector<ComponentInstance> components_from_parsed_xschem(const xs_schematic &parsed_schematic) {
	std::vector<ComponentInstance> components;
	components.reserve(parsed_schematic.instance_count);
	for (int instance_index = 0; instance_index < parsed_schematic.instance_count; ++instance_index) {
		components.push_back(make_component_instance(parsed_schematic.instances[instance_index]));
	}
	return components;
}

Schematic schematic_from_parsed_xschem(const xs_schematic &parsed_schematic) {
	Schematic schematic;
	schematic.source_file_path = copy_c_string_or_empty(parsed_schematic.path);
	schematic.cell_name = copy_c_string_or_empty(parsed_schematic.cell_name);
	schematic.wires = wires_from_parsed_xschem(parsed_schematic);
	schematic.component_instances = components_from_parsed_xschem(parsed_schematic);
	schematic.top_level_drawing_records_in_global_coordinates = drawing_records_vector_from_xschem(
			parsed_schematic.drawing_records, parsed_schematic.drawing_record_count);
	return schematic;
}

} // namespace

GeneratedSpiceNetlist generate_spice_netlist_text_from_schematic_file(
		const std::string &schematic_file_path,
		const std::string &xschemrc_file_path,
		const std::vector<std::string> &extra_symbol_search_paths) {
	GeneratedSpiceNetlist netlist_result;

	xs_library_path symbol_library_path;
	xs_library_path_init(&symbol_library_path);
	load_xschemrc_into_library_path_if_provided(xschemrc_file_path, &symbol_library_path);
	append_search_paths_to_library_path(extra_symbol_search_paths, &symbol_library_path);
	add_schematic_own_directory_to_library_path(schematic_file_path, &symbol_library_path);

	xs_schematic parsed_schematic;
	std::memset(&parsed_schematic, 0, sizeof(parsed_schematic));
	if (xs_parse_schematic(schematic_file_path.c_str(), &parsed_schematic) != 0) {
		xs_library_path_free(&symbol_library_path);
		netlist_result.error_message = "failed to parse schematic: " + schematic_file_path;
		return netlist_result;
	}

	constexpr int lvs_mode_disabled = 0;
	xs_netlister netlister;
	xs_netlister_init(&netlister, &symbol_library_path, lvs_mode_disabled);
	xs_netlister_resolve_symbols(&netlister, &parsed_schematic);

	FILE *netlist_scratch_temporary_file = std::tmpfile();
	if (netlist_scratch_temporary_file == nullptr) {
		xs_netlister_free(&netlister);
		xs_free_schematic(&parsed_schematic);
		xs_library_path_free(&symbol_library_path);
		netlist_result.error_message = "tmpfile() failed while preparing netlist buffer";
		return netlist_result;
	}

	const int emit_return_code = xs_netlister_emit_spice(
			&netlister, &parsed_schematic, netlist_scratch_temporary_file);
	std::fflush(netlist_scratch_temporary_file);

	if (emit_return_code == 0) {
		std::fseek(netlist_scratch_temporary_file, 0, SEEK_END);
		const long netlist_text_byte_length = std::ftell(netlist_scratch_temporary_file);
		std::rewind(netlist_scratch_temporary_file);
		if (netlist_text_byte_length > 0) {
			std::string netlist_text_buffer(static_cast<size_t>(netlist_text_byte_length), '\0');
			const size_t bytes_read = std::fread(
					netlist_text_buffer.data(),
					1,
					static_cast<size_t>(netlist_text_byte_length),
					netlist_scratch_temporary_file);
			netlist_text_buffer.resize(bytes_read);
			netlist_result.spice_netlist_text = std::move(netlist_text_buffer);
		}
		netlist_result.was_successful = true;
	} else {
		netlist_result.error_message = "xs_netlister_emit_spice returned " + std::to_string(emit_return_code);
	}
	std::fclose(netlist_scratch_temporary_file);

	xs_netlister_free(&netlister);
	xs_free_schematic(&parsed_schematic);
	xs_library_path_free(&symbol_library_path);
	return netlist_result;
}

SchematicLoadResult load_schematic_from_file(
		const std::string &schematic_file_path,
		const std::string &xschemrc_file_path,
		const std::vector<std::string> &extra_symbol_search_paths) {
	SchematicLoadResult load_result;

	xs_library_path symbol_library_path;
	xs_library_path_init(&symbol_library_path);
	load_xschemrc_into_library_path_if_provided(xschemrc_file_path, &symbol_library_path);
	append_search_paths_to_library_path(extra_symbol_search_paths, &symbol_library_path);
	add_schematic_own_directory_to_library_path(schematic_file_path, &symbol_library_path);

	xs_schematic parsed_schematic;
	std::memset(&parsed_schematic, 0, sizeof(parsed_schematic));
	if (xs_parse_schematic(schematic_file_path.c_str(), &parsed_schematic) != 0) {
		xs_library_path_free(&symbol_library_path);
		load_result.error_message = "failed to parse schematic: " + schematic_file_path;
		return load_result;
	}

	constexpr int lvs_mode_disabled = 0;
	xs_netlister netlister;
	xs_netlister_init(&netlister, &symbol_library_path, lvs_mode_disabled);
	xs_netlister_resolve_symbols(&netlister, &parsed_schematic);

	load_result.loaded_schematic = schematic_from_parsed_xschem(parsed_schematic);
	load_result.was_successful = true;

	xs_netlister_free(&netlister);
	xs_free_schematic(&parsed_schematic);
	xs_library_path_free(&symbol_library_path);
	return load_result;
}

} // namespace spice3d
