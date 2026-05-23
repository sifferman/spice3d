#include "spice3d_node.h"

#include "godot_cpp/core/class_db.hpp"
#include "godot_cpp/variant/array.hpp"
#include "godot_cpp/variant/utility_functions.hpp"

#include "scene/schematic_loader.h"
#include "sim/spice_simulator.h"
#include "spice3d_version.h"

namespace spice3d {

namespace {

godot::String c_string_to_godot_string(const std::string &source_text) {
	return godot::String(source_text.c_str());
}

godot::Dictionary wire_segment_to_dictionary(const WireSegment &wire) {
	godot::Dictionary wire_dict;
	wire_dict["start_x"] = wire.start_x;
	wire_dict["start_y"] = wire.start_y;
	wire_dict["end_x"] = wire.end_x;
	wire_dict["end_y"] = wire.end_y;
	wire_dict["net_label"] = c_string_to_godot_string(wire.net_label);
	return wire_dict;
}

godot::Dictionary component_pin_to_dictionary(const ComponentPin &pin) {
	godot::Dictionary pin_dict;
	pin_dict["pin_name"] = c_string_to_godot_string(pin.pin_name);
	pin_dict["pin_direction"] = c_string_to_godot_string(pin.pin_direction);
	pin_dict["global_x"] = pin.global_x;
	pin_dict["global_y"] = pin.global_y;
	return pin_dict;
}

godot::Array pins_to_dictionary_array(const std::vector<ComponentPin> &pins) {
	godot::Array pin_array;
	for (const auto &one_pin : pins) {
		pin_array.push_back(component_pin_to_dictionary(one_pin));
	}
	return pin_array;
}

godot::Dictionary component_instance_to_dictionary(const ComponentInstance &component) {
	godot::Dictionary component_dict;
	component_dict["instance_name"] = c_string_to_godot_string(component.instance_name);
	component_dict["symbol_reference"] = c_string_to_godot_string(component.symbol_reference);
	component_dict["symbol_type"] = c_string_to_godot_string(component.symbol_type);
	component_dict["resolved_symbol_path"] = c_string_to_godot_string(component.resolved_symbol_path);
	component_dict["placement_x"] = component.placement_x;
	component_dict["placement_y"] = component.placement_y;
	component_dict["rotation_quarter_turns"] = component.rotation_quarter_turns;
	component_dict["flip_flag"] = component.flip_flag;
	component_dict["symbol_was_resolved"] = component.symbol_was_resolved;
	component_dict["pins"] = pins_to_dictionary_array(component.pins_in_global_coordinates);
	return component_dict;
}

godot::Array wires_to_dictionary_array(const std::vector<WireSegment> &wires) {
	godot::Array wire_array;
	for (const auto &one_wire : wires) {
		wire_array.push_back(wire_segment_to_dictionary(one_wire));
	}
	return wire_array;
}

godot::Array components_to_dictionary_array(const std::vector<ComponentInstance> &components) {
	godot::Array component_array;
	for (const auto &one_component : components) {
		component_array.push_back(component_instance_to_dictionary(one_component));
	}
	return component_array;
}

godot::Dictionary build_schematic_dictionary_from_result(const SchematicLoadResult &load_result) {
	godot::Dictionary result_dict;
	result_dict["was_successful"] = load_result.was_successful;
	result_dict["error_message"] = c_string_to_godot_string(load_result.error_message);
	result_dict["cell_name"] = c_string_to_godot_string(load_result.loaded_schematic.cell_name);
	result_dict["source_file_path"] = c_string_to_godot_string(load_result.loaded_schematic.source_file_path);
	result_dict["wires"] = wires_to_dictionary_array(load_result.loaded_schematic.wires);
	result_dict["component_instances"] = components_to_dictionary_array(
			load_result.loaded_schematic.component_instances);
	return result_dict;
}

std::string godot_string_to_std_string(const godot::String &godot_text) {
	return std::string(godot_text.utf8().get_data());
}

} // namespace

void Spice3DNode::_bind_methods() {
	godot::ClassDB::bind_method(
			godot::D_METHOD("get_spice3d_version"),
			&Spice3DNode::get_spice3d_version);
	godot::ClassDB::bind_method(
			godot::D_METHOD("is_running_on_web_platform"),
			&Spice3DNode::is_running_on_web_platform);
	godot::ClassDB::bind_method(
			godot::D_METHOD("describe_simulator_backend"),
			&Spice3DNode::describe_simulator_backend);
	godot::ClassDB::bind_method(
			godot::D_METHOD("load_schematic_into_dictionary", "schematic_file_path", "xschemrc_file_path"),
			&Spice3DNode::load_schematic_into_dictionary);
}

Spice3DNode::Spice3DNode() = default;
Spice3DNode::~Spice3DNode() = default;

godot::String Spice3DNode::get_spice3d_version() const {
	return godot::String(SPICE3D_VERSION_STRING);
}

bool Spice3DNode::is_running_on_web_platform() const {
#ifdef WEB_ENABLED
	return true;
#else
	return false;
#endif
}

godot::String Spice3DNode::describe_simulator_backend() {
	if (!simulator) {
		simulator = SpiceSimulator::create_for_current_platform();
	}
#ifdef WEB_ENABLED
	return godot::String("web (JavaScriptBridge to ngspice Worker)");
#elif defined(SPICE3D_HAVE_LIBNGSPICE)
	return godot::String("native (libngspice)");
#else
	return godot::String("native (stub, libngspice not linked)");
#endif
}

godot::Dictionary Spice3DNode::load_schematic_into_dictionary(
		const godot::String &schematic_file_path,
		const godot::String &xschemrc_file_path) {
	const std::string schematic_file_path_utf8 = godot_string_to_std_string(schematic_file_path);
	const std::string xschemrc_file_path_utf8 = godot_string_to_std_string(xschemrc_file_path);
	const SchematicLoadResult load_result = load_schematic_from_file(
			schematic_file_path_utf8,
			xschemrc_file_path_utf8);
	return build_schematic_dictionary_from_result(load_result);
}

} // namespace spice3d
