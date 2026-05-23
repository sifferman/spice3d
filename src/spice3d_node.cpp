#include "spice3d_node.h"

#include "godot_cpp/classes/box_mesh.hpp"
#include "godot_cpp/classes/mesh_instance3d.hpp"
#include "godot_cpp/classes/standard_material3d.hpp"
#include "godot_cpp/core/class_db.hpp"
#include "godot_cpp/variant/array.hpp"
#include "godot_cpp/variant/color.hpp"
#include "godot_cpp/variant/utility_functions.hpp"
#include "godot_cpp/variant/vector2.hpp"
#include "godot_cpp/variant/vector3.hpp"

#include "pdk/zstd_tar_archive_extractor.h"
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

constexpr double WIRE_THICKNESS_IN_WORLD_UNITS = 4.0;
constexpr double COMPONENT_PLACEHOLDER_SIZE_IN_WORLD_UNITS = 60.0;

godot::Vector3 schematic_xy_to_lying_flat_world_position(double schematic_x, double schematic_y) {
	constexpr double table_surface_world_y = 0.0;
	return godot::Vector3(schematic_x, table_surface_world_y, schematic_y);
}

godot::Ref<godot::StandardMaterial3D> build_wire_render_material() {
	godot::Ref<godot::StandardMaterial3D> wire_material;
	wire_material.instantiate();
	wire_material->set_albedo(godot::Color(0.75f, 0.8f, 0.95f));
	wire_material->set_feature(godot::BaseMaterial3D::FEATURE_EMISSION, true);
	wire_material->set_emission(godot::Color(0.2f, 0.25f, 0.5f));
	return wire_material;
}

godot::Ref<godot::StandardMaterial3D> build_component_render_material() {
	godot::Ref<godot::StandardMaterial3D> component_material;
	component_material.instantiate();
	component_material->set_albedo(godot::Color(0.85f, 0.55f, 0.25f));
	component_material->set_metallic(0.2f);
	component_material->set_roughness(0.55f);
	return component_material;
}

void add_wire_segment_mesh_to_parent_node(
		godot::Node3D *parent_node,
		const WireSegment &wire,
		const godot::Ref<godot::Material> &wire_material) {
	const godot::Vector2 start_in_schematic_space(wire.start_x, wire.start_y);
	const godot::Vector2 end_in_schematic_space(wire.end_x, wire.end_y);
	const godot::Vector2 midpoint_in_schematic_space = (start_in_schematic_space + end_in_schematic_space) * 0.5;
	const double segment_length = start_in_schematic_space.distance_to(end_in_schematic_space);
	const double segment_angle_radians = (end_in_schematic_space - start_in_schematic_space).angle();

	godot::Ref<godot::BoxMesh> wire_box_mesh;
	wire_box_mesh.instantiate();
	wire_box_mesh->set_size(godot::Vector3(
			segment_length, WIRE_THICKNESS_IN_WORLD_UNITS, WIRE_THICKNESS_IN_WORLD_UNITS));

	godot::MeshInstance3D *wire_mesh_instance = memnew(godot::MeshInstance3D);
	wire_mesh_instance->set_mesh(wire_box_mesh);
	wire_mesh_instance->set_material_override(wire_material);
	wire_mesh_instance->set_position(
			schematic_xy_to_lying_flat_world_position(midpoint_in_schematic_space.x, midpoint_in_schematic_space.y));
	wire_mesh_instance->set_rotation(godot::Vector3(0.0, -segment_angle_radians, 0.0));
	parent_node->add_child(wire_mesh_instance);
}

void add_component_placeholder_mesh_to_parent_node(
		godot::Node3D *parent_node,
		const ComponentInstance &component,
		const godot::Ref<godot::Material> &component_material) {
	godot::Ref<godot::BoxMesh> placeholder_box_mesh;
	placeholder_box_mesh.instantiate();
	placeholder_box_mesh->set_size(
			godot::Vector3(COMPONENT_PLACEHOLDER_SIZE_IN_WORLD_UNITS,
					COMPONENT_PLACEHOLDER_SIZE_IN_WORLD_UNITS,
					COMPONENT_PLACEHOLDER_SIZE_IN_WORLD_UNITS));

	godot::MeshInstance3D *component_mesh_instance = memnew(godot::MeshInstance3D);
	component_mesh_instance->set_mesh(placeholder_box_mesh);
	component_mesh_instance->set_material_override(component_material);
	component_mesh_instance->set_position(
			schematic_xy_to_lying_flat_world_position(component.placement_x, component.placement_y));
	parent_node->add_child(component_mesh_instance);
}

void add_rendered_meshes_for_schematic_to_parent_node(
		godot::Node3D *parent_node,
		const Schematic &loaded_schematic) {
	godot::Ref<godot::Material> wire_material = build_wire_render_material();
	for (const auto &one_wire : loaded_schematic.wires) {
		add_wire_segment_mesh_to_parent_node(parent_node, one_wire, wire_material);
	}
	godot::Ref<godot::Material> component_material = build_component_render_material();
	for (const auto &one_component : loaded_schematic.component_instances) {
		add_component_placeholder_mesh_to_parent_node(parent_node, one_component, component_material);
	}
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

namespace {

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
				parent_node_for_rendered_meshes,
				load_result.loaded_schematic);
	}
	return build_schematic_dictionary_from_result(load_result);
}

} // namespace spice3d
