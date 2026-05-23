#pragma once

// Web (Emscripten) implementation of SpiceSimulator.
//
// Forwards all calls through Godot's JavaScriptBridge to a JS module that
// hosts the ngspice WASM module inside a dedicated Web Worker. The bridge
// glue (sim/web/ngspice_bridge.js) is responsible for:
//   - spawning the Worker on first load_netlist()
//   - posting netlist / tran / external-source updates into the Worker
//   - receiving voltage Samples back over a SharedArrayBuffer ring buffer
// This file is the C++ side only; bridge glue and Worker live under
// `project/web/` so Godot picks them up at export time.
//
// v0 status: scaffolding only. Methods return false / no-op until the
// JavaScriptBridge glue lands.

#include "../sample_queue.h"
#include "../spice_simulator.h"

namespace spice3d {
namespace web {

class SpiceSimulatorWeb : public SpiceSimulator {
public:
	SpiceSimulatorWeb();
	~SpiceSimulatorWeb() override;

	bool load_netlist(const std::vector<std::string> &lines) override;
	bool start_transient(double step_s, double stop_s) override;
	void stop() override;
	bool is_running() const override;
	void set_external_voltage(const std::string &source_name, double volts) override;
	std::vector<Sample> drain_samples() override;
	const SimInitInfo *init_info() const override;

private:
	SampleQueue queue_;
	SimInitInfo init_info_;
	bool init_info_ready_ = false;
	bool running_ = false;
};

} // namespace web
} // namespace spice3d
