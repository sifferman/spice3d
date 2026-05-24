#include "spice_simulator_web.h"

#ifdef WEB_ENABLED
#include "godot_cpp/classes/java_script_bridge.hpp"
#include "godot_cpp/variant/string.hpp"
#endif

namespace spice3d {
namespace web {

#ifdef WEB_ENABLED
namespace {
void evaluate_browser_javascript(const char *javascript_source_text) {
	godot::JavaScriptBridge::get_singleton()->eval(javascript_source_text);
}
} // namespace
#endif

WebWorkerSpiceSimulator::WebWorkerSpiceSimulator() = default;

WebWorkerSpiceSimulator::~WebWorkerSpiceSimulator() {
	stop_simulation();
}

bool WebWorkerSpiceSimulator::load_netlist_lines(const std::vector<std::string> &netlist_lines) {
	(void)netlist_lines;
	return false;
}

bool WebWorkerSpiceSimulator::start_transient_analysis(double timestep_seconds, double stop_time_seconds) {
	(void)timestep_seconds;
	(void)stop_time_seconds;
	return false;
}

void WebWorkerSpiceSimulator::stop_simulation() {
#ifdef WEB_ENABLED
	evaluate_browser_javascript("if (globalThis.spice3d) globalThis.spice3d.stopSimulation();");
#endif
	background_worker_is_running = false;
}

bool WebWorkerSpiceSimulator::is_simulation_running() const {
	return background_worker_is_running;
}

void WebWorkerSpiceSimulator::set_external_voltage_source(const std::string &source_name, double volts) {
	(void)source_name;
	(void)volts;
}

std::vector<SimulationSample> WebWorkerSpiceSimulator::take_buffered_samples() {
	return sample_queue.take_all_samples();
}

const SimulationNodeNames *WebWorkerSpiceSimulator::get_node_names_when_ready() const {
	return node_names_are_ready ? &simulation_node_names : nullptr;
}

} // namespace web
} // namespace spice3d
