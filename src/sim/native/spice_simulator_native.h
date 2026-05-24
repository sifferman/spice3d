#pragma once

#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

#include "../sample_queue.h"
#include "../spice_simulator.h"

namespace spice3d {
namespace native {

class LibngspiceSpiceSimulator : public SpiceSimulator {
public:
	LibngspiceSpiceSimulator();
	~LibngspiceSpiceSimulator() override;

	bool load_netlist_lines(const std::vector<std::string> &netlist_lines) override;
	bool start_transient_analysis(double timestep_seconds, double stop_time_seconds) override;
	void stop_simulation() override;
	bool is_simulation_running() const override;
	void set_external_voltage_source(const std::string &source_name, double volts) override;
	std::vector<SimulationSample> take_buffered_samples() override;
	const SimulationNodeNames *get_node_names_when_ready() const override;

	void receive_log_message(const char *message_text);
	void receive_status_message(const char *message_text);
	void receive_simulation_sample(
			double simulation_time_seconds,
			const char *const *vector_names,
			const double *vector_values,
			int vector_count);
	void receive_node_names(const char *const *vector_names, int vector_count);
	void receive_background_thread_running_state(bool is_now_running);
	void receive_controlled_exit_status(int exit_status);
	void provide_external_voltage_value(
			double *value_to_write,
			double simulation_time_seconds,
			const char *source_node_name);

private:
	SimulationSampleQueue sample_queue;
	SimulationNodeNames simulation_node_names;
	std::atomic<bool> node_names_are_ready{false};
	std::atomic<bool> background_thread_is_running{false};
	std::atomic<bool> stop_has_been_requested{false};

	mutable std::mutex external_sources_mutex;
	std::unordered_map<std::string, double> external_voltage_sources_by_name;

	bool ngspice_has_been_initialized = false;
};

} // namespace native
} // namespace spice3d
