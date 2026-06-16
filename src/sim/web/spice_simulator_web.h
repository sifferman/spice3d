#pragma once

#ifdef WEB_ENABLED

#include "../sample_queue.h"
#include "../spice_simulator.h"

namespace spice3d {
namespace web {

class WebWorkerSpiceSimulator : public SpiceSimulator {
public:
	WebWorkerSpiceSimulator();
	~WebWorkerSpiceSimulator() override;

	void expose_persistent_directory_to_simulator(
			const std::string &user_relative_directory_path) override;
	std::string resolve_simulator_include_path_for_persistent_resource(
			const std::string &user_relative_path) const override;
	bool start_transient_analysis_with_netlist_and_seed_ic_nets(
			const std::vector<std::string> &netlist_lines,
			double transient_timestep_seconds,
			const std::vector<std::string> &internal_net_names_to_seed_at_half_vdd) override;
	bool update_transient_timestep_mid_simulation(double new_timestep_seconds) override;
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

#endif // WEB_ENABLED
