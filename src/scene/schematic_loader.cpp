#include "schematic_loader.h"

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
	return schematic;
}

} // namespace

SchematicLoadResult load_schematic_from_file(
		const std::string &schematic_file_path,
		const std::string &xschemrc_file_path,
		const std::vector<std::string> &extra_symbol_search_paths) {
	SchematicLoadResult load_result;

	xs_library_path symbol_library_path;
	xs_library_path_init(&symbol_library_path);
	load_xschemrc_into_library_path_if_provided(xschemrc_file_path, &symbol_library_path);
	append_search_paths_to_library_path(extra_symbol_search_paths, &symbol_library_path);

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
