#pragma once

#include "../sample_queue.h"
#include "../spice_simulator.h"

namespace spice3d {
namespace web {

class WebWorkerSpiceSimulator : public SpiceSimulator {
public:
	WebWorkerSpiceSimulator();
	~WebWorkerSpiceSimulator() override;

	bool load_netlist_lines(const std::vector<std::string> &netlist_lines) override;
	bool start_transient_analysis(double timestep_seconds, double stop_time_seconds) override;
	void stop_simulation() override;
	bool is_simulation_running() const override;
	void set_external_voltage_source(const std::string &source_name, double volts) override;
	std::vector<SimulationSample> take_buffered_samples() override;
	const SimulationNodeNames *get_node_names_when_ready() const override;

private:
	SimulationSampleQueue sample_queue;
	SimulationNodeNames simulation_node_names;
	bool node_names_are_ready = false;
	bool background_worker_is_running = false;
};

} // namespace web
} // namespace spice3d
