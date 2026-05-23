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

	virtual bool load_netlist_lines(const std::vector<std::string> &netlist_lines) = 0;
	virtual bool start_transient_analysis(double timestep_seconds, double stop_time_seconds) = 0;
	virtual void stop_simulation() = 0;
	virtual bool is_simulation_running() const = 0;
	virtual void set_external_voltage_source(const std::string &source_name, double volts) = 0;
	virtual std::vector<SimulationSample> take_buffered_samples() = 0;
	virtual const SimulationNodeNames *get_node_names_when_ready() const = 0;

	static std::unique_ptr<SpiceSimulator> create_for_current_platform();
};

} // namespace spice3d
