#include "spice_simulator_web.h"

#ifdef WEB_ENABLED
#include "godot_cpp/classes/java_script_bridge.hpp"
#include "godot_cpp/variant/string.hpp"
#endif

namespace spice3d {
namespace web {

namespace {

#ifdef WEB_ENABLED
// Minimal bootstrap script. Real implementation will move into
// project/web/ngspice_bridge.js (loaded via the export preset's head_include)
// — this inline stub just proves the bridge is reachable for now.
const char *kBootstrap = R"JS(
if (!globalThis.spice3d) {
	globalThis.spice3d = {
		ready: false,
		pending_external: {},
		samples: [],
		init_info: null,
		running: false,
		load_netlist: function(lines) { /* TODO: spawn worker */ return false; },
		start_transient: function(step, stop) { /* TODO */ return false; },
		stop: function() { /* TODO */ },
		set_external: function(name, v) { this.pending_external[name.toLowerCase()] = v; },
		drain_samples: function() { const s = this.samples; this.samples = []; return s; },
	};
}
)JS";
#endif

} // namespace

SpiceSimulatorWeb::SpiceSimulatorWeb() {
#ifdef WEB_ENABLED
	godot::JavaScriptBridge::get_singleton()->eval(kBootstrap);
#endif
}

SpiceSimulatorWeb::~SpiceSimulatorWeb() {
	stop();
}

bool SpiceSimulatorWeb::load_netlist(const std::vector<std::string> & /*lines*/) {
	// TODO: marshal `lines` into a JS array via JavaScriptBridge and call
	// globalThis.spice3d.load_netlist(...). Will require the worker to be
	// spawned (handled JS-side) and the ngspice WASM to be fetched.
	return false;
}

bool SpiceSimulatorWeb::start_transient(double /*step_s*/, double /*stop_s*/) {
	return false;
}

void SpiceSimulatorWeb::stop() {
#ifdef WEB_ENABLED
	godot::JavaScriptBridge::get_singleton()->eval("if (globalThis.spice3d) globalThis.spice3d.stop();");
#endif
	running_ = false;
}

bool SpiceSimulatorWeb::is_running() const { return running_; }

void SpiceSimulatorWeb::set_external_voltage(const std::string & /*source_name*/, double /*volts*/) {
	// TODO: forward to globalThis.spice3d.set_external(name, volts) once the
	// JS bridge can accept a (string, number) call from C++.
}

std::vector<Sample> SpiceSimulatorWeb::drain_samples() {
	// Bridge wiring will pull samples from the JS-side ring buffer and push
	// into queue_ from a Godot-thread callback (likely _process). For now the
	// queue stays empty.
	return queue_.drain();
}

const SimInitInfo *SpiceSimulatorWeb::init_info() const {
	return init_info_ready_ ? &init_info_ : nullptr;
}

} // namespace web
} // namespace spice3d
