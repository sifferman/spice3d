#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace spice3d {

struct SimulationSample {
	double simulation_time_seconds = 0.0;
	std::vector<double> node_voltages;
};

struct SimulationNodeNames {
	std::vector<std::string> ordered_node_names;
};

class SpiceSimulator {
public:
	virtual ~SpiceSimulator() = default;

	virtual void expose_persistent_directory_to_simulator(
			const std::string &user_relative_directory_path) = 0;
	virtual std::string resolve_simulator_include_path_for_persistent_resource(
			const std::string &user_relative_path) const = 0;

	virtual bool start_transient_analysis_with_netlist_and_seed_ic_nets(
			const std::vector<std::string> &netlist_lines,
			double transient_timestep_seconds,
			const std::vector<std::string> &internal_net_names_to_seed_at_half_vdd) = 0;

	virtual bool update_transient_timestep_mid_simulation(double new_timestep_seconds) = 0;
	virtual void stop_simulation() = 0;
	virtual bool is_simulation_running() const = 0;
	virtual void set_external_voltage_source(const std::string &source_name, double volts) = 0;
	virtual std::vector<SimulationSample> take_buffered_samples() = 0;
	virtual const SimulationNodeNames *get_node_names_when_ready() const = 0;

	static std::unique_ptr<SpiceSimulator> create_for_current_platform();
};

} // namespace spice3d
