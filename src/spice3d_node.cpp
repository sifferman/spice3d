#include "spice3d_node.h"

#include "godot_cpp/classes/input_event_mouse_button.hpp"
#include "godot_cpp/classes/java_script_bridge.hpp"
#include "godot_cpp/classes/json.hpp"
#include "godot_cpp/core/class_db.hpp"
#include "godot_cpp/variant/utility_functions.hpp"

#include "pdk/zstd_tar_archive_extractor.h"
#include "scene/schematic_loader.h"
#include "scene/schematic_renderer.h"
#include "sim/spice_simulator.h"
#include "spice3d_version.h"

namespace spice3d {

namespace {

godot::String c_string_to_godot_string(const std::string &source_text) {
	return godot::String(source_text.c_str());
}

std::string godot_string_to_std_string(const godot::String &godot_text) {
	return std::string(godot_text.utf8().get_data());
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

std::vector<std::string> packed_string_array_to_std_vector(
		const godot::PackedStringArray &godot_string_array) {
	std::vector<std::string> std_vector;
	std_vector.reserve(godot_string_array.size());
	for (int element_index = 0; element_index < godot_string_array.size(); ++element_index) {
		std_vector.push_back(godot_string_to_std_string(godot_string_array[element_index]));
	}
	return std_vector;
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
			godot::D_METHOD("load_schematic_into_dictionary",
					"schematic_file_path",
					"xschemrc_file_path",
					"extra_symbol_search_directories"),
			&Spice3DNode::load_schematic_into_dictionary);
	godot::ClassDB::bind_method(
			godot::D_METHOD("load_schematic_and_render_into_node3d",
					"parent_node_for_rendered_meshes",
					"schematic_file_path",
					"xschemrc_file_path",
					"extra_symbol_search_directories"),
			&Spice3DNode::load_schematic_and_render_into_node3d);
	godot::ClassDB::bind_method(
			godot::D_METHOD("extract_zstd_tar_archive_filtered_by_path_substring",
					"compressed_tar_zst_bytes",
					"filesystem_output_directory_absolute_path",
					"keep_only_paths_containing_any_of_these_substrings"),
			&Spice3DNode::extract_zstd_tar_archive_filtered_by_path_substring);
	godot::ClassDB::bind_method(
			godot::D_METHOD("begin_streaming_zstd_tar_extraction",
					"filesystem_output_directory_absolute_path",
					"keep_only_paths_containing_any_of_these_substrings"),
			&Spice3DNode::begin_streaming_zstd_tar_extraction);
	godot::ClassDB::bind_method(
			godot::D_METHOD("feed_streaming_zstd_tar_compressed_chunk", "compressed_chunk_bytes"),
			&Spice3DNode::feed_streaming_zstd_tar_compressed_chunk);
	godot::ClassDB::bind_method(
			godot::D_METHOD("finalize_streaming_zstd_tar_extraction"),
			&Spice3DNode::finalize_streaming_zstd_tar_extraction);
	godot::ClassDB::bind_method(
			godot::D_METHOD("generate_spice_netlist_for_schematic_file",
					"schematic_file_path",
					"xschemrc_file_path",
					"extra_symbol_search_directories"),
			&Spice3DNode::generate_spice_netlist_for_schematic_file);
	godot::ClassDB::bind_method(
			godot::D_METHOD("start_transient_analysis_with_netlist_and_seed_ic_nets",
					"netlist_lines", "transient_timestep_seconds", "internal_net_names_to_seed_at_half_vdd"),
			&Spice3DNode::start_transient_analysis_with_netlist_and_seed_ic_nets);
	godot::ClassDB::bind_method(
			godot::D_METHOD("update_transient_timestep_mid_simulation", "new_timestep_seconds"),
			&Spice3DNode::update_transient_timestep_mid_simulation);
	godot::ClassDB::bind_method(
			godot::D_METHOD("stop_simulation"),
			&Spice3DNode::stop_simulation);
	godot::ClassDB::bind_method(
			godot::D_METHOD("set_external_voltage_source", "source_name", "volts"),
			&Spice3DNode::set_external_voltage_source);
	godot::ClassDB::bind_method(
			godot::D_METHOD("drain_buffered_simulation_samples_as_godot_array"),
			&Spice3DNode::drain_buffered_simulation_samples_as_godot_array);
	godot::ClassDB::bind_method(
			godot::D_METHOD("install_file_text_in_simulator_filesystem",
					"virtual_path_in_simulator_filesystem",
					"file_content"),
			&Spice3DNode::install_file_text_in_simulator_filesystem);
	godot::ClassDB::bind_method(
			godot::D_METHOD("apply_node_voltages_to_wire_colors",
					"schematic_root_node",
					"spice_node_name_to_voltage",
					"vdd_volts"),
			&Spice3DNode::apply_node_voltages_to_wire_colors);
	godot::ClassDB::bind_method(
			godot::D_METHOD("on_button_area_input_event",
					"picking_camera",
					"input_event",
					"hit_position_in_world",
					"hit_normal",
					"collision_shape_index",
					"clicked_button_instance_name"),
			&Spice3DNode::on_button_area_input_event);
	ADD_SIGNAL(godot::MethodInfo("button_pressed",
			godot::PropertyInfo(godot::Variant::STRING, "button_instance_name")));
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
		const godot::String &xschemrc_file_path,
		const godot::PackedStringArray &extra_symbol_search_directories) {
	const std::string schematic_file_path_utf8 = godot_string_to_std_string(schematic_file_path);
	const std::string xschemrc_file_path_utf8 = godot_string_to_std_string(xschemrc_file_path);
	const std::vector<std::string> search_directories_utf8 =
			packed_string_array_to_std_vector(extra_symbol_search_directories);
	const SchematicLoadResult load_result = load_schematic_from_file(
			schematic_file_path_utf8,
			xschemrc_file_path_utf8,
			search_directories_utf8);
	return build_schematic_dictionary_from_result(load_result);
}

godot::Dictionary Spice3DNode::extract_zstd_tar_archive_filtered_by_path_substring(
		const godot::PackedByteArray &compressed_tar_zst_bytes,
		const godot::String &filesystem_output_directory_absolute_path,
		const godot::PackedStringArray &keep_only_paths_containing_any_of_these_substrings) {
	const std::vector<std::string> path_substrings_to_keep_utf8 =
			packed_string_array_to_std_vector(keep_only_paths_containing_any_of_these_substrings);
	const ZstdTarExtractionResult extraction_result = ::spice3d::extract_zstd_tar_archive_filtered_by_path_substring(
			compressed_tar_zst_bytes.ptr(),
			static_cast<std::size_t>(compressed_tar_zst_bytes.size()),
			godot_string_to_std_string(filesystem_output_directory_absolute_path),
			path_substrings_to_keep_utf8);
	godot::Dictionary result_dictionary;
	result_dictionary["was_successful"] = extraction_result.was_successful;
	result_dictionary["error_message"] = c_string_to_godot_string(extraction_result.error_message);
	result_dictionary["extracted_file_count"] = extraction_result.extracted_file_count;
	result_dictionary["total_bytes_written"] = extraction_result.total_bytes_written;
	return result_dictionary;
}

bool Spice3DNode::begin_streaming_zstd_tar_extraction(
		const godot::String &filesystem_output_directory_absolute_path,
		const godot::PackedStringArray &keep_only_paths_containing_any_of_these_substrings) {
	const std::vector<std::string> path_substrings_to_keep_utf8 =
			packed_string_array_to_std_vector(keep_only_paths_containing_any_of_these_substrings);
	active_streaming_zstd_tar_extractor = std::make_unique<ZstdTarStreamingExtractor>(
			godot_string_to_std_string(filesystem_output_directory_absolute_path),
			path_substrings_to_keep_utf8);
	return true;
}

godot::Dictionary Spice3DNode::feed_streaming_zstd_tar_compressed_chunk(
		const godot::PackedByteArray &compressed_chunk_bytes) {
	godot::Dictionary result_dictionary;
	if (!active_streaming_zstd_tar_extractor) {
		result_dictionary["was_successful"] = false;
		result_dictionary["error_message"] = godot::String(
				"feed_streaming_zstd_tar_compressed_chunk called without an active extractor "
				"(call begin_streaming_zstd_tar_extraction first)");
		return result_dictionary;
	}
	std::string feed_error_message;
	const bool feed_succeeded = active_streaming_zstd_tar_extractor->feed_compressed_chunk(
			compressed_chunk_bytes.ptr(),
			static_cast<std::size_t>(compressed_chunk_bytes.size()),
			&feed_error_message);
	result_dictionary["was_successful"] = feed_succeeded;
	result_dictionary["error_message"] = c_string_to_godot_string(feed_error_message);
	return result_dictionary;
}

godot::Dictionary Spice3DNode::finalize_streaming_zstd_tar_extraction() {
	godot::Dictionary result_dictionary;
	if (!active_streaming_zstd_tar_extractor) {
		result_dictionary["was_successful"] = false;
		result_dictionary["error_message"] = godot::String(
				"finalize_streaming_zstd_tar_extraction called without an active extractor");
		result_dictionary["extracted_file_count"] = 0;
		result_dictionary["total_bytes_written"] = 0;
		return result_dictionary;
	}
	const ZstdTarExtractionResult extraction_result = active_streaming_zstd_tar_extractor->finalize();
	active_streaming_zstd_tar_extractor.reset();
	result_dictionary["was_successful"] = extraction_result.was_successful;
	result_dictionary["error_message"] = c_string_to_godot_string(extraction_result.error_message);
	result_dictionary["extracted_file_count"] = extraction_result.extracted_file_count;
	result_dictionary["total_bytes_written"] = extraction_result.total_bytes_written;
	return result_dictionary;
}

godot::Dictionary Spice3DNode::load_schematic_and_render_into_node3d(
		godot::Node3D *parent_node_for_rendered_meshes,
		const godot::String &schematic_file_path,
		const godot::String &xschemrc_file_path,
		const godot::PackedStringArray &extra_symbol_search_directories) {
	const std::string schematic_file_path_utf8 = godot_string_to_std_string(schematic_file_path);
	const std::string xschemrc_file_path_utf8 = godot_string_to_std_string(xschemrc_file_path);
	const std::vector<std::string> search_directories_utf8 =
			packed_string_array_to_std_vector(extra_symbol_search_directories);
	const SchematicLoadResult load_result = load_schematic_from_file(
			schematic_file_path_utf8,
			xschemrc_file_path_utf8,
			search_directories_utf8);
	if (load_result.was_successful && parent_node_for_rendered_meshes != nullptr) {
		add_rendered_meshes_for_schematic_to_parent_node(
				this,
				parent_node_for_rendered_meshes,
				load_result.loaded_schematic);
	}
	return build_schematic_dictionary_from_result(load_result);
}

godot::PackedStringArray Spice3DNode::generate_spice_netlist_for_schematic_file(
		const godot::String &schematic_file_path,
		const godot::String &xschemrc_file_path,
		const godot::PackedStringArray &extra_symbol_search_directories) {
	const std::string schematic_file_path_utf8 = godot_string_to_std_string(schematic_file_path);
	const std::string xschemrc_file_path_utf8 = godot_string_to_std_string(xschemrc_file_path);
	const std::vector<std::string> search_directories_utf8 =
			packed_string_array_to_std_vector(extra_symbol_search_directories);
	const GeneratedSpiceNetlist generated_netlist = generate_spice_netlist_text_from_schematic_file(
			schematic_file_path_utf8,
			xschemrc_file_path_utf8,
			search_directories_utf8);
	godot::PackedStringArray netlist_lines_as_packed_string_array;
	if (!generated_netlist.was_successful) {
		godot::UtilityFunctions::printerr(
				godot::String("[spice3d] netlist generation failed: ") +
				c_string_to_godot_string(generated_netlist.error_message));
		return netlist_lines_as_packed_string_array;
	}
	const std::string &netlist_text = generated_netlist.spice_netlist_text;
	std::size_t line_start_index = 0;
	for (std::size_t scan_index = 0; scan_index < netlist_text.size(); ++scan_index) {
		if (netlist_text[scan_index] == '\n') {
			netlist_lines_as_packed_string_array.append(c_string_to_godot_string(
					netlist_text.substr(line_start_index, scan_index - line_start_index)));
			line_start_index = scan_index + 1;
		}
	}
	if (line_start_index < netlist_text.size()) {
		netlist_lines_as_packed_string_array.append(c_string_to_godot_string(
				netlist_text.substr(line_start_index)));
	}
	return netlist_lines_as_packed_string_array;
}

bool Spice3DNode::start_transient_analysis_with_netlist_and_seed_ic_nets(
		const godot::PackedStringArray &netlist_lines,
		double transient_timestep_seconds,
		const godot::PackedStringArray &internal_net_names_to_seed_at_half_vdd) {
	if (!simulator) {
		simulator = SpiceSimulator::create_for_current_platform();
	}
	return simulator->start_transient_analysis_with_netlist_and_seed_ic_nets(
			packed_string_array_to_std_vector(netlist_lines),
			transient_timestep_seconds,
			packed_string_array_to_std_vector(internal_net_names_to_seed_at_half_vdd));
}

bool Spice3DNode::update_transient_timestep_mid_simulation(double new_timestep_seconds) {
	if (!simulator) return false;
	return simulator->update_transient_timestep_mid_simulation(new_timestep_seconds);
}

void Spice3DNode::stop_simulation() {
	if (!simulator) return;
	simulator->stop_simulation();
}

void Spice3DNode::set_external_voltage_source(const godot::String &source_name, double volts) {
	if (!simulator) return;
	simulator->set_external_voltage_source(godot_string_to_std_string(source_name), volts);
}

bool Spice3DNode::install_file_text_in_simulator_filesystem(
		const godot::String &virtual_path_in_simulator_filesystem,
		const godot::String &file_content) {
	if (!simulator) {
		simulator = SpiceSimulator::create_for_current_platform();
	}
	simulator->install_file_text_in_simulator_filesystem(
			godot_string_to_std_string(virtual_path_in_simulator_filesystem),
			godot_string_to_std_string(file_content));
	return true;
}

godot::Array Spice3DNode::drain_buffered_simulation_samples_as_godot_array() {
	godot::Array drained_samples_as_godot_array;
#ifdef WEB_ENABLED
	const godot::Variant returned_value = godot::JavaScriptBridge::get_singleton()->eval(
			"JSON.stringify(globalThis.spice3d ? globalThis.spice3d.takeBufferedSimulationSamples() : []);",
			true);
	if (returned_value.get_type() == godot::Variant::STRING) {
		const godot::String json_text = static_cast<godot::String>(returned_value);
		const godot::Variant parsed = godot::JSON::parse_string(json_text);
		if (parsed.get_type() == godot::Variant::ARRAY) {
			drained_samples_as_godot_array = static_cast<godot::Array>(parsed);
		}
	}
#endif
	return drained_samples_as_godot_array;
}

void Spice3DNode::apply_node_voltages_to_wire_colors(
		godot::Node3D *schematic_root_node,
		const godot::Dictionary &spice_node_name_to_voltage,
		double vdd_volts) {
	update_wire_mesh_colors_from_node_voltages(
			schematic_root_node, spice_node_name_to_voltage, vdd_volts);
}

void Spice3DNode::on_button_area_input_event(
		godot::Camera3D *picking_camera,
		godot::Ref<godot::InputEvent> input_event,
		godot::Vector3 hit_position_in_world,
		godot::Vector3 hit_normal,
		int collision_shape_index,
		godot::String clicked_button_instance_name) {
	(void)picking_camera;
	(void)hit_position_in_world;
	(void)hit_normal;
	(void)collision_shape_index;
	const godot::Ref<godot::InputEventMouseButton> mouse_button_event = input_event;
	if (mouse_button_event.is_null()) return;
	if (!mouse_button_event->is_pressed()) return;
	if (mouse_button_event->get_button_index() != godot::MOUSE_BUTTON_LEFT) return;
	emit_signal("button_pressed", clicked_button_instance_name);
}

} // namespace spice3d
