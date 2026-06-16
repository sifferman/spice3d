#pragma once

#ifndef WEB_ENABLED

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

#endif // !WEB_ENABLED
