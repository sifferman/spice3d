#include "spice_simulator_web.h"

#ifdef WEB_ENABLED

#include "godot_cpp/classes/java_script_bridge.hpp"
#include "godot_cpp/classes/json.hpp"
#include "godot_cpp/variant/string.hpp"

namespace spice3d {
namespace web {

namespace {

godot::String std_string_to_godot_string(const std::string &source) {
	return godot::String(source.c_str());
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

void WebWorkerSpiceSimulator::install_file_text_in_simulator_filesystem(
		const std::string &virtual_path_in_simulator_filesystem,
		const std::string &file_content) {
	const godot::String set_content_javascript = godot::String(
			"globalThis.__spice3dStagingFileContent = ")
			+ godot::JSON::stringify(std_string_to_godot_string(file_content))
			+ godot::String(";");
	const godot::String install_javascript = godot::String(
			"globalThis.spice3d && globalThis.spice3d.installFileTextInWorkerFilesystem(")
			+ godot::JSON::stringify(std_string_to_godot_string(virtual_path_in_simulator_filesystem))
			+ godot::String(", globalThis.__spice3dStagingFileContent || \"\");");
	evaluate_browser_javascript(set_content_javascript);
	evaluate_browser_javascript(install_javascript);
	evaluate_browser_javascript("globalThis.__spice3dStagingFileContent = null;");
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
