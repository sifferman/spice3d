#include "spice_simulator_web.h"

#ifdef WEB_ENABLED

#include "godot_cpp/classes/dir_access.hpp"
#include "godot_cpp/classes/file_access.hpp"
#include "godot_cpp/classes/java_script_bridge.hpp"
#include "godot_cpp/classes/json.hpp"
#include "godot_cpp/variant/packed_string_array.hpp"
#include "godot_cpp/variant/string.hpp"
#include "godot_cpp/variant/utility_functions.hpp"

namespace spice3d {
namespace web {

namespace {

godot::String std_string_to_godot_string(const std::string &source) {
	return godot::String(source.c_str());
}

void install_one_file_text_into_worker_memfs(
		const godot::String &worker_memfs_absolute_path,
		const godot::String &file_text_content) {
	const godot::String set_content_javascript = godot::String(
			"globalThis.__spice3dStagingFileContent = ")
			+ godot::JSON::stringify(file_text_content)
			+ godot::String(";");
	const godot::String install_javascript = godot::String(
			"globalThis.spice3d && globalThis.spice3d.installFileTextInWorkerFilesystem(")
			+ godot::JSON::stringify(worker_memfs_absolute_path)
			+ godot::String(", globalThis.__spice3dStagingFileContent || \"\");");
	godot::JavaScriptBridge::get_singleton()->eval(set_content_javascript);
	godot::JavaScriptBridge::get_singleton()->eval(install_javascript);
	godot::JavaScriptBridge::get_singleton()->eval("globalThis.__spice3dStagingFileContent = null;");
}

void recursively_stage_directory_contents_into_worker_memfs(
		const godot::String &user_directory_uri,
		const godot::String &worker_memfs_destination_prefix,
		std::size_t &accumulated_file_count) {
	godot::Ref<godot::DirAccess> directory_handle = godot::DirAccess::open(user_directory_uri);
	if (directory_handle.is_null()) {
		godot::UtilityFunctions::push_warning(
				godot::String("[spice3d] expose_persistent_directory: cannot open '")
				+ user_directory_uri + godot::String("'"));
		return;
	}
	directory_handle->list_dir_begin();
	while (true) {
		const godot::String one_entry_name = directory_handle->get_next();
		if (one_entry_name.is_empty()) break;
		if (one_entry_name.begins_with(".")) continue;
		const godot::String one_entry_user_uri = user_directory_uri + godot::String("/") + one_entry_name;
		const godot::String one_entry_worker_memfs_path =
				worker_memfs_destination_prefix + godot::String("/") + one_entry_name;
		if (directory_handle->current_is_dir()) {
			recursively_stage_directory_contents_into_worker_memfs(
					one_entry_user_uri, one_entry_worker_memfs_path, accumulated_file_count);
			continue;
		}
		godot::Ref<godot::FileAccess> file_handle =
				godot::FileAccess::open(one_entry_user_uri, godot::FileAccess::READ);
		if (file_handle.is_null()) continue;
		const godot::String file_text_content = file_handle->get_as_text();
		file_handle->close();
		install_one_file_text_into_worker_memfs(one_entry_worker_memfs_path, file_text_content);
		++accumulated_file_count;
	}
	directory_handle->list_dir_end();
}

godot::String json_encode_std_string_vector(const std::vector<std::string> &lines) {
	godot::String accumulator = godot::String("[");
	for (std::size_t line_index = 0; line_index < lines.size(); ++line_index) {
		if (line_index > 0) accumulator += godot::String(",");
		accumulator += godot::JSON::stringify(std_string_to_godot_string(lines[line_index]));
	}
	accumulator += godot::String("]");
	return accumulator;
}

void evaluate_browser_javascript(const godot::String &javascript_source) {
	godot::JavaScriptBridge::get_singleton()->eval(javascript_source);
}

} // namespace

WebWorkerSpiceSimulator::WebWorkerSpiceSimulator() = default;

WebWorkerSpiceSimulator::~WebWorkerSpiceSimulator() {
	stop_simulation();
}

void WebWorkerSpiceSimulator::expose_persistent_directory_to_simulator(
		const std::string &user_relative_directory_path) {
	const godot::String user_uri = godot::String("user://") + std_string_to_godot_string(user_relative_directory_path);
	const godot::String worker_memfs_destination_prefix =
			godot::String("/") + std_string_to_godot_string(user_relative_directory_path);
	std::size_t staged_file_count = 0;
	recursively_stage_directory_contents_into_worker_memfs(
			user_uri, worker_memfs_destination_prefix, staged_file_count);
	godot::UtilityFunctions::print(
			godot::String("[spice3d] staged ") + godot::String::num_int64(static_cast<int64_t>(staged_file_count))
			+ godot::String(" file(s) into worker MEMFS under ") + worker_memfs_destination_prefix);
}

std::string WebWorkerSpiceSimulator::resolve_simulator_include_path_for_persistent_resource(
		const std::string &user_relative_path) const {
	return std::string("/") + user_relative_path;
}

bool WebWorkerSpiceSimulator::start_transient_analysis_with_netlist_and_seed_ic_nets(
		const std::vector<std::string> &netlist_lines,
		double transient_timestep_seconds,
		const std::vector<std::string> &internal_net_names_to_seed_at_half_vdd) {
	const godot::String javascript_to_evaluate = godot::String(
			"globalThis.spice3d && globalThis.spice3d.loadNetlistLinesWithTimestepAndInternalNetsToSeed(")
			+ json_encode_std_string_vector(netlist_lines)
			+ godot::String(",")
			+ godot::String::num(transient_timestep_seconds)
			+ godot::String(",")
			+ json_encode_std_string_vector(internal_net_names_to_seed_at_half_vdd)
			+ godot::String(");");
	evaluate_browser_javascript(javascript_to_evaluate);
	background_worker_is_running = true;
	return true;
}

bool WebWorkerSpiceSimulator::update_transient_timestep_mid_simulation(double new_timestep_seconds) {
	const godot::String javascript_to_evaluate = godot::String(
			"globalThis.spice3d && globalThis.spice3d.updateTimeWarpTimestep(")
			+ godot::String::num(new_timestep_seconds)
			+ godot::String(");");
	evaluate_browser_javascript(javascript_to_evaluate);
	return true;
}

void WebWorkerSpiceSimulator::stop_simulation() {
	evaluate_browser_javascript("globalThis.spice3d && globalThis.spice3d.stopSimulation();");
	background_worker_is_running = false;
}

bool WebWorkerSpiceSimulator::is_simulation_running() const {
	return background_worker_is_running;
}

void WebWorkerSpiceSimulator::set_external_voltage_source(
		const std::string &source_name, double volts) {
	const godot::String javascript_to_evaluate = godot::String(
			"globalThis.spice3d && globalThis.spice3d.setExternalVoltageSource(")
			+ godot::JSON::stringify(std_string_to_godot_string(source_name))
			+ godot::String(",")
			+ godot::String::num(volts)
			+ godot::String(");");
	evaluate_browser_javascript(javascript_to_evaluate);
}

std::vector<SimulationSample> WebWorkerSpiceSimulator::take_buffered_samples() {
	return sample_queue.take_all_samples();
}

const SimulationNodeNames *WebWorkerSpiceSimulator::get_node_names_when_ready() const {
	return node_names_are_ready ? &simulation_node_names : nullptr;
}

} // namespace web
} // namespace spice3d

#endif // WEB_ENABLED
