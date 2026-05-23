#pragma once

// SpiceSimulator — backend-agnostic interface to ngspice.
//
// Native builds link libngspice directly (see native/spice_simulator_native.*).
// Web builds talk to a Web Worker that hosts the ngspice WASM module
// (see web/spice_simulator_web.*). The factory in spice_simulator.cpp picks
// one via `#ifdef WEB_ENABLED`.
//
// Threading contract
// ------------------
// All public methods are intended to be called from Godot's main thread.
// Sample delivery (`Sample`s pushed via the SendData callback) happens on
// some other thread (the libngspice background thread on native, the Worker
// on web). The default implementation buffers samples in a thread-safe queue
// that the renderer drains each frame via `drain_samples()`. This is a
// deliberately coarse model for v0 — a SAB ring buffer can drop in later
// without changing the public API.

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace spice3d {

// One sample from the simulator — every accepted transient timestep produces
// one Sample. The timestamps are non-uniform (ngspice's adaptive `tran`), so
// the renderer must use `time` to place the sample on its wall-clock timeline.
struct Sample {
	double time = 0.0;                // ngspice simulation time, seconds
	std::vector<double> voltages;     // parallel to `node_names` from SimInitInfo
};

// Static info delivered once, after the netlist parses, before `start()`.
// Tells the renderer which vector index in Sample::voltages corresponds to
// which ngspice node name.
struct SimInitInfo {
	std::vector<std::string> node_names; // e.g. ["time", "v(out)", "v(clk)"]
};

// Reasons a simulator may exit early.
enum class StopReason {
	Finished,      // simulation reached the requested stop time
	UserStopped,   // host called stop()
	NgspiceError,  // ngspice signalled ControlledExit
};

class SpiceSimulator {
public:
	virtual ~SpiceSimulator() = default;

	// Send a netlist to ngspice (lines, in order; trailing ".end" required).
	// May be called once per SpiceSimulator instance. Returns false if ngspice
	// rejected the netlist.
	virtual bool load_netlist(const std::vector<std::string> &lines) = 0;

	// Start a transient analysis: `tran <step> <stop>`. `stop` may be a very
	// large number for "continuous" interactive sessions — the simulator runs
	// in the background and pushes Samples until stop() is called.
	virtual bool start_transient(double step_s, double stop_s) = 0;

	// Stop the background simulation. Idempotent.
	virtual void stop() = 0;

	// True while ngspice's bg thread (native) / Worker (web) is still running.
	virtual bool is_running() const = 0;

	// Update an EXTERNAL voltage source's value. Source name matches the
	// netlist (lowercased on the ngspice side; we lowercase here too so the
	// caller can pass either case). Thread-safe; called from Godot's main
	// thread when the user clicks a switch.
	virtual void set_external_voltage(const std::string &source_name, double volts) = 0;

	// Drain buffered samples produced since the last call. Returns ownership;
	// safe to call every frame. Order is preserved.
	virtual std::vector<Sample> drain_samples() = 0;

	// One-shot init-info handoff. May return nullptr if init hasn't fired yet.
	virtual const SimInitInfo *init_info() const = 0;

	// Factory — implemented in spice_simulator.cpp; picks native vs web.
	static std::unique_ptr<SpiceSimulator> create();
};

} // namespace spice3d
