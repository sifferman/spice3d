#pragma once

#include <memory>

#include "godot_cpp/classes/camera3d.hpp"
#include "godot_cpp/classes/input_event.hpp"
#include "godot_cpp/classes/node.hpp"
#include "godot_cpp/classes/node3d.hpp"
#include "godot_cpp/classes/wrapped.hpp"
#include "godot_cpp/variant/dictionary.hpp"
#include "godot_cpp/variant/packed_byte_array.hpp"
#include "godot_cpp/variant/packed_string_array.hpp"
#include "godot_cpp/variant/string.hpp"
#include "godot_cpp/variant/vector3.hpp"

namespace spice3d {

class SpiceSimulator;
class ZstdTarStreamingExtractor;

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
			const godot::String &xschemrc_file_path,
			const godot::PackedStringArray &extra_symbol_search_directories);
	godot::Dictionary load_schematic_and_render_into_node3d(
			godot::Node3D *parent_node_for_rendered_meshes,
			const godot::String &schematic_file_path,
			const godot::String &xschemrc_file_path,
			const godot::PackedStringArray &extra_symbol_search_directories);
	godot::PackedStringArray generate_spice_netlist_for_schematic_file(
			const godot::String &schematic_file_path,
			const godot::String &xschemrc_file_path,
			const godot::PackedStringArray &extra_symbol_search_directories);
	bool start_transient_analysis_with_netlist_and_seed_ic_nets(
			const godot::PackedStringArray &netlist_lines,
			double transient_timestep_seconds,
			const godot::PackedStringArray &internal_net_names_to_seed_at_half_vdd);
	bool update_transient_timestep_mid_simulation(double new_timestep_seconds);
	void stop_simulation();
	void set_external_voltage_source(const godot::String &source_name, double volts);
	godot::Array drain_buffered_simulation_samples_as_godot_array();
	void expose_persistent_directory_to_simulator(
			const godot::String &user_relative_directory_path);
	godot::String resolve_simulator_include_path_for_persistent_resource(
			const godot::String &user_relative_path);
	void apply_node_voltages_to_wire_colors(
			godot::Node3D *schematic_root_node,
			const godot::Dictionary &spice_node_name_to_voltage,
			double vdd_volts);
	godot::Dictionary extract_zstd_tar_archive_filtered_by_path_substring(
			const godot::PackedByteArray &compressed_tar_zst_bytes,
			const godot::String &filesystem_output_directory_absolute_path,
			const godot::PackedStringArray &keep_only_paths_containing_any_of_these_substrings);

	bool begin_streaming_zstd_tar_extraction(
			const godot::String &filesystem_output_directory_absolute_path,
			const godot::PackedStringArray &keep_only_paths_containing_any_of_these_substrings);
	godot::Dictionary feed_streaming_zstd_tar_compressed_chunk(
			const godot::PackedByteArray &compressed_chunk_bytes);
	godot::Dictionary finalize_streaming_zstd_tar_extraction();

	void on_button_area_input_event(
			godot::Camera3D *picking_camera,
			godot::Ref<godot::InputEvent> input_event,
			godot::Vector3 hit_position_in_world,
			godot::Vector3 hit_normal,
			int collision_shape_index,
			godot::String clicked_button_instance_name);

private:
	std::unique_ptr<SpiceSimulator> simulator;
	std::unique_ptr<ZstdTarStreamingExtractor> active_streaming_zstd_tar_extractor;
};

} // namespace spice3d
