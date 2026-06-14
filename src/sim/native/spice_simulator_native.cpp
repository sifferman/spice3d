#include "spice_simulator_native.h"

#ifndef WEB_ENABLED

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstring>

#include <ngspice/sharedspice.h>

namespace spice3d {
namespace native {

namespace {

std::string to_lowercase_copy(std::string original_text) {
	std::transform(
			original_text.begin(),
			original_text.end(),
			original_text.begin(),
			[](unsigned char character) {
				return static_cast<char>(std::tolower(character));
			});
	return original_text;
}

LibngspiceSpiceSimulator *get_simulator_from_user_data(void *user_data_pointer) {
	return static_cast<LibngspiceSpiceSimulator *>(user_data_pointer);
}

int ngspice_send_char_callback(char *message_text, int, void *user_data_pointer) {
	if (user_data_pointer) get_simulator_from_user_data(user_data_pointer)->receive_log_message(message_text);
	return 0;
}

int ngspice_send_stat_callback(char *message_text, int, void *user_data_pointer) {
	if (user_data_pointer) get_simulator_from_user_data(user_data_pointer)->receive_status_message(message_text);
	return 0;
}

int ngspice_controlled_exit_callback(int exit_status, NG_BOOL, NG_BOOL, int, void *user_data_pointer) {
	if (user_data_pointer) get_simulator_from_user_data(user_data_pointer)->receive_controlled_exit_status(exit_status);
	return 0;
}

int ngspice_background_thread_running_callback(NG_BOOL is_now_running, int, void *user_data_pointer) {
	if (user_data_pointer) get_simulator_from_user_data(user_data_pointer)->receive_background_thread_running_state(is_now_running);
	return 0;
}

int ngspice_send_data_callback(pvecvaluesall all_vector_values, int, int, void *user_data_pointer) {
	if (!user_data_pointer || !all_vector_values) return 0;

	const int vector_count = all_vector_values->veccount;
	std::vector<const char *> vector_names(vector_count);
	std::vector<double> vector_values(vector_count);
	double simulation_time_seconds = 0.0;
	for (int vector_index = 0; vector_index < vector_count; ++vector_index) {
		const vecvalues &one_vector = *all_vector_values->vecsa[vector_index];
		vector_names[vector_index] = one_vector.name;
		vector_values[vector_index] = one_vector.creal;
		if (one_vector.name && std::strcmp(one_vector.name, "time") == 0) {
			simulation_time_seconds = one_vector.creal;
		}
	}

	get_simulator_from_user_data(user_data_pointer)
			->receive_simulation_sample(
					simulation_time_seconds,
					vector_names.data(),
					vector_values.data(),
					vector_count);
	return 0;
}

int ngspice_send_init_data_callback(pvecinfoall init_info, int, void *user_data_pointer) {
	if (!user_data_pointer || !init_info) return 0;

	const int vector_count = init_info->veccount;
	std::vector<const char *> vector_names(vector_count);
	for (int vector_index = 0; vector_index < vector_count; ++vector_index) {
		vector_names[vector_index] = init_info->vecs[vector_index] ? init_info->vecs[vector_index]->vecname : "";
	}
	get_simulator_from_user_data(user_data_pointer)
			->receive_node_names(vector_names.data(), vector_count);
	return 0;
}

int ngspice_get_voltage_source_data_callback(
		double *value_to_write,
		double simulation_time_seconds,
		char *source_node_name,
		int,
		void *user_data_pointer) {
	if (!user_data_pointer || !value_to_write) return 0;
	get_simulator_from_user_data(user_data_pointer)
			->provide_external_voltage_value(
					value_to_write,
					simulation_time_seconds,
					source_node_name);
	return 0;
}

} // namespace

LibngspiceSpiceSimulator::LibngspiceSpiceSimulator() = default;

LibngspiceSpiceSimulator::~LibngspiceSpiceSimulator() {
	stop_simulation();
}

namespace {

constexpr double EFFECTIVELY_UNBOUNDED_TRANSIENT_STOP_TIME_SECONDS = 1.0e6;

bool load_netlist_lines_into_ngspice(
		const std::vector<std::string> &netlist_lines,
		bool &ngspice_has_been_initialized_flag,
		LibngspiceSpiceSimulator *caller_instance_for_callbacks);

bool start_or_restart_background_transient(
		double transient_timestep_seconds,
		double stop_time_seconds);

} // namespace

void LibngspiceSpiceSimulator::install_file_text_in_simulator_filesystem(
		const std::string &virtual_path_in_simulator_filesystem,
		const std::string &file_content) {
	(void)virtual_path_in_simulator_filesystem;
	(void)file_content;
}

bool LibngspiceSpiceSimulator::start_transient_analysis_with_netlist_and_seed_ic_nets(
		const std::vector<std::string> &netlist_lines,
		double transient_timestep_seconds,
		const std::vector<std::string> &internal_net_names_to_seed_at_half_vdd) {
	(void)internal_net_names_to_seed_at_half_vdd;
	if (!load_netlist_lines_into_ngspice(netlist_lines, ngspice_has_been_initialized, this)) {
		return false;
	}
	stop_has_been_requested = false;
	return start_or_restart_background_transient(
			transient_timestep_seconds, EFFECTIVELY_UNBOUNDED_TRANSIENT_STOP_TIME_SECONDS);
}

bool LibngspiceSpiceSimulator::update_transient_timestep_mid_simulation(double new_timestep_seconds) {
	if (background_thread_is_running.load()) {
		stop_has_been_requested = true;
		ngSpice_Command(const_cast<char *>("bg_halt"));
	}
	return start_or_restart_background_transient(
			new_timestep_seconds, EFFECTIVELY_UNBOUNDED_TRANSIENT_STOP_TIME_SECONDS);
}

namespace {

bool load_netlist_lines_into_ngspice(
		const std::vector<std::string> &netlist_lines,
		bool &ngspice_has_been_initialized_flag,
		LibngspiceSpiceSimulator *caller_instance_for_callbacks) {
	if (!ngspice_has_been_initialized_flag) {
		ngSpice_Init(
				ngspice_send_char_callback,
				ngspice_send_stat_callback,
				ngspice_controlled_exit_callback,
				ngspice_send_data_callback,
				ngspice_send_init_data_callback,
				ngspice_background_thread_running_callback,
				caller_instance_for_callbacks);
		static int caller_instance_identifier = 0;
		ngSpice_Init_Sync(
				ngspice_get_voltage_source_data_callback,
				nullptr,
				nullptr,
				&caller_instance_identifier,
				caller_instance_for_callbacks);
		ngspice_has_been_initialized_flag = true;
	}

	std::vector<char *> netlist_argv;
	netlist_argv.reserve(netlist_lines.size() + 1);
	for (const auto &one_netlist_line : netlist_lines) {
		netlist_argv.push_back(const_cast<char *>(one_netlist_line.c_str()));
	}
	netlist_argv.push_back(nullptr);
	return ngSpice_Circ(netlist_argv.data()) == 0;
}

bool start_or_restart_background_transient(
		double transient_timestep_seconds,
		double stop_time_seconds) {
	ngSpice_Command(const_cast<char *>("save none"));
	ngSpice_Command(const_cast<char *>("esave node"));

	char transient_command_buffer[128];
	std::snprintf(
			transient_command_buffer,
			sizeof(transient_command_buffer),
			"bg_tran %.15g %.15g",
			transient_timestep_seconds,
			stop_time_seconds);
	return ngSpice_Command(transient_command_buffer) == 0;
}

} // namespace

void LibngspiceSpiceSimulator::stop_simulation() {
	if (background_thread_is_running.load()) {
		stop_has_been_requested = true;
		ngSpice_Command(const_cast<char *>("bg_halt"));
	}
}

bool LibngspiceSpiceSimulator::is_simulation_running() const {
	return background_thread_is_running.load();
}

void LibngspiceSpiceSimulator::set_external_voltage_source(const std::string &source_name, double volts) {
	const std::lock_guard<std::mutex> lock(external_sources_mutex);
	external_voltage_sources_by_name[to_lowercase_copy(source_name)] = volts;
}

std::vector<SimulationSample> LibngspiceSpiceSimulator::take_buffered_samples() {
	return sample_queue.take_all_samples();
}

const SimulationNodeNames *LibngspiceSpiceSimulator::get_node_names_when_ready() const {
	return node_names_are_ready.load() ? &simulation_node_names : nullptr;
}

void LibngspiceSpiceSimulator::receive_log_message(const char *) {}
void LibngspiceSpiceSimulator::receive_status_message(const char *) {}

void LibngspiceSpiceSimulator::receive_simulation_sample(
		double simulation_time_seconds,
		const char *const *,
		const double *vector_values,
		int vector_count) {
	SimulationSample new_sample;
	new_sample.simulation_time_seconds = simulation_time_seconds;
	new_sample.node_voltages.reserve(vector_count);
	for (int vector_index = 0; vector_index < vector_count; ++vector_index) {
		new_sample.node_voltages.push_back(vector_values[vector_index]);
	}
	sample_queue.push_sample(std::move(new_sample));
}

void LibngspiceSpiceSimulator::receive_node_names(const char *const *vector_names, int vector_count) {
	simulation_node_names.ordered_node_names.assign(vector_names, vector_names + vector_count);
	node_names_are_ready.store(true);
}

void LibngspiceSpiceSimulator::receive_background_thread_running_state(bool is_now_running) {
	background_thread_is_running.store(is_now_running);
}

void LibngspiceSpiceSimulator::receive_controlled_exit_status(int) {
	background_thread_is_running.store(false);
}

void LibngspiceSpiceSimulator::provide_external_voltage_value(
		double *value_to_write,
		double,
		const char *source_node_name) {
	const std::lock_guard<std::mutex> lock(external_sources_mutex);
	const std::string lookup_key = source_node_name ? to_lowercase_copy(source_node_name) : std::string();
	const auto found_source = external_voltage_sources_by_name.find(lookup_key);
	*value_to_write = (found_source == external_voltage_sources_by_name.end()) ? 0.0 : found_source->second;
}

} // namespace native
} // namespace spice3d

#endif // !WEB_ENABLED
