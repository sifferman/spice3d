#include "spice_simulator_native.h"

#ifndef WEB_ENABLED

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <thread>

#include <ngspice/sharedspice.h>

#include "godot_cpp/classes/project_settings.hpp"
#include "godot_cpp/variant/utility_functions.hpp"

namespace {

std::string godot_string_to_std_string_utf8(const godot::String &source) {
	const godot::CharString utf8 = source.utf8();
	return std::string(utf8.get_data(), static_cast<std::size_t>(utf8.length()));
}

} // namespace

namespace spice3d {
namespace native {

namespace {

// libngspice's background thread can fire callbacks (send_char, send_data, ...)
// concurrently with, and even briefly AFTER, bg_halt returns and our
// background_thread_running callback flips to false. Without a synchronization
// gate a lagging callback dereferences a freed LibngspiceSpiceSimulator via
// user_data and corrupts the heap — reproduced as "double free or corruption"
// in test_netlist_transformer, which runs after test_native_simulator_transient
// has autofree'd its Spice3DNode. The gate below (mutex + validity flag) makes
// callbacks either dispatch under the lock while the instance is guaranteed
// alive, or short-circuit as a no-op if the instance is being torn down.
std::mutex &get_ngspice_callback_dispatch_mutex() {
	static std::mutex ngspice_callback_dispatch_mutex;
	return ngspice_callback_dispatch_mutex;
}

std::atomic<LibngspiceSpiceSimulator *> currently_registered_simulator_or_null{nullptr};

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

LibngspiceSpiceSimulator *acquire_currently_registered_simulator_under_dispatch_lock(
		void *user_data_pointer, std::unique_lock<std::mutex> &dispatch_lock) {
	dispatch_lock = std::unique_lock<std::mutex>(get_ngspice_callback_dispatch_mutex());
	LibngspiceSpiceSimulator *const registered = currently_registered_simulator_or_null.load();
	if (registered == nullptr) return nullptr;
	if (user_data_pointer != nullptr && user_data_pointer != registered) return nullptr;
	return registered;
}

int ngspice_send_char_callback(char *message_text, int, void *user_data_pointer) {
	std::unique_lock<std::mutex> dispatch_lock;
	if (LibngspiceSpiceSimulator *sim = acquire_currently_registered_simulator_under_dispatch_lock(user_data_pointer, dispatch_lock)) {
		sim->receive_log_message(message_text);
	}
	return 0;
}

int ngspice_send_stat_callback(char *message_text, int, void *user_data_pointer) {
	std::unique_lock<std::mutex> dispatch_lock;
	if (LibngspiceSpiceSimulator *sim = acquire_currently_registered_simulator_under_dispatch_lock(user_data_pointer, dispatch_lock)) {
		sim->receive_status_message(message_text);
	}
	return 0;
}

int ngspice_controlled_exit_callback(int exit_status, NG_BOOL, NG_BOOL, int, void *user_data_pointer) {
	std::unique_lock<std::mutex> dispatch_lock;
	if (LibngspiceSpiceSimulator *sim = acquire_currently_registered_simulator_under_dispatch_lock(user_data_pointer, dispatch_lock)) {
		sim->receive_controlled_exit_status(exit_status);
	}
	return 0;
}

int ngspice_background_thread_running_callback(NG_BOOL background_thread_has_exited_flag, int, void *user_data_pointer) {
	// libngspice's BGThreadRunning callback (see third_party/ngspice
	// sharedspice.c _thread_run) is invoked with fl_exited — i.e. the flag
	// is TRUE when the thread has *finished*, not when it is running. Invert
	// here so downstream sees the intuitive "is currently running" state.
	const bool background_thread_is_now_running = !background_thread_has_exited_flag;
	std::unique_lock<std::mutex> dispatch_lock;
	if (LibngspiceSpiceSimulator *sim = acquire_currently_registered_simulator_under_dispatch_lock(user_data_pointer, dispatch_lock)) {
		sim->receive_background_thread_running_state(background_thread_is_now_running);
	}
	return 0;
}

int ngspice_send_data_callback(pvecvaluesall all_vector_values, int, int, void *user_data_pointer) {
	if (!all_vector_values) return 0;

	std::unique_lock<std::mutex> dispatch_lock;
	LibngspiceSpiceSimulator *const sim = acquire_currently_registered_simulator_under_dispatch_lock(user_data_pointer, dispatch_lock);
	if (sim == nullptr) return 0;

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

	sim->receive_simulation_sample(
			simulation_time_seconds,
			vector_names.data(),
			vector_values.data(),
			vector_count);
	return 0;
}

int ngspice_send_init_data_callback(pvecinfoall init_info, int, void *user_data_pointer) {
	if (!init_info) return 0;

	std::unique_lock<std::mutex> dispatch_lock;
	LibngspiceSpiceSimulator *const sim = acquire_currently_registered_simulator_under_dispatch_lock(user_data_pointer, dispatch_lock);
	if (sim == nullptr) return 0;

	const int vector_count = init_info->veccount;
	std::vector<const char *> vector_names(vector_count);
	for (int vector_index = 0; vector_index < vector_count; ++vector_index) {
		vector_names[vector_index] = init_info->vecs[vector_index] ? init_info->vecs[vector_index]->vecname : "";
	}
	sim->receive_node_names(vector_names.data(), vector_count);
	return 0;
}

int ngspice_get_voltage_source_data_callback(
		double *value_to_write,
		double simulation_time_seconds,
		char *source_node_name,
		int,
		void *user_data_pointer) {
	if (!value_to_write) return 0;

	std::unique_lock<std::mutex> dispatch_lock;
	if (LibngspiceSpiceSimulator *sim = acquire_currently_registered_simulator_under_dispatch_lock(user_data_pointer, dispatch_lock)) {
		sim->provide_external_voltage_value(
				value_to_write,
				simulation_time_seconds,
				source_node_name);
	}
	return 0;
}

} // namespace

LibngspiceSpiceSimulator::LibngspiceSpiceSimulator() {
	currently_registered_simulator_or_null.store(this);
}

LibngspiceSpiceSimulator::~LibngspiceSpiceSimulator() {
	stop_simulation();
	wait_for_background_thread_to_finish_before_freeing_instance_state();
	// Acquire the dispatch mutex before clearing the registration pointer so
	// any callback currently mid-dispatch finishes running against this
	// instance; subsequent lagging callbacks then see nullptr and short-circuit
	// before touching now-freed instance state.
	std::lock_guard<std::mutex> unregister_under_lock(get_ngspice_callback_dispatch_mutex());
	currently_registered_simulator_or_null.store(nullptr);
}

void LibngspiceSpiceSimulator::wait_for_background_thread_to_finish_before_freeing_instance_state() {
	constexpr int MAX_HUNDRED_MICROSECOND_POLLS_BEFORE_GIVING_UP_TO_AVOID_HANG = 50000;
	for (int poll_attempt = 0;
			poll_attempt < MAX_HUNDRED_MICROSECOND_POLLS_BEFORE_GIVING_UP_TO_AVOID_HANG;
			++poll_attempt) {
		// ngSpice_running() is authoritative for whether the bg thread is
		// still executing; the atomic mirror only reflects state we've been
		// notified about via the background_thread_running callback, which
		// can lag or be skipped when bg_halt races the thread's own exit path.
		if (!background_thread_is_running.load() && !ngSpice_running()) return;
		std::this_thread::sleep_for(std::chrono::microseconds(100));
	}
}

namespace {

constexpr double EFFECTIVELY_UNBOUNDED_TRANSIENT_STOP_TIME_SECONDS = 1.0e6;
constexpr double SEED_INITIAL_CONDITION_HIGH_VOLTS = 1.8;
constexpr double SEED_INITIAL_CONDITION_LOW_VOLTS = 0.0;

// Kept parallel to NGSPICE_OPTION_COMMANDS_FOR_LOOSE_RUN_PHASE in
// project/web/ngspice_worker.js. The web variant runs a 50-step
// full-precision bootstrap first (via .tran + step + bg_run) to break
// metastable equilibria before relaxing; native uses bg_tran which starts
// the analysis directly, so no equivalent bootstrap phase exists here.
const char *const NGSPICE_OPTION_COMMANDS_FOR_LOOSE_RUN_PHASE[] = {
	"option reltol=1e-2",
	"option abstol=1e-8",
	"option vntol=1e-3",
	"option chgtol=1e-12",
	"option trtol=50",
	"option bypass=1",
	"option gmin=1e-9",
	"option itl4=200",
	"option maxord=2",
};

bool load_netlist_lines_into_ngspice(
		const std::vector<std::string> &netlist_lines,
		bool &ngspice_has_been_initialized_flag,
		LibngspiceSpiceSimulator *caller_instance_for_callbacks);

bool start_or_restart_background_transient(
		double transient_timestep_seconds,
		double stop_time_seconds,
		bool use_initial_conditions);

std::vector<std::string> build_netlist_with_alternating_initial_condition_lines_for_internal_nets(
		const std::vector<std::string> &original_netlist_lines,
		const std::vector<std::string> &internal_net_names_to_seed_at_half_vdd) {
	if (internal_net_names_to_seed_at_half_vdd.empty()) {
		return original_netlist_lines;
	}
	std::vector<std::string> initial_condition_lines;
	initial_condition_lines.reserve(internal_net_names_to_seed_at_half_vdd.size());
	for (std::size_t one_net_index = 0; one_net_index < internal_net_names_to_seed_at_half_vdd.size(); ++one_net_index) {
		const double seed_voltage_for_this_net = (one_net_index % 2 == 0)
				? SEED_INITIAL_CONDITION_HIGH_VOLTS
				: SEED_INITIAL_CONDITION_LOW_VOLTS;
		char one_initial_condition_line_buffer[256];
		std::snprintf(
				one_initial_condition_line_buffer,
				sizeof(one_initial_condition_line_buffer),
				".ic v(%s)=%.6f",
				internal_net_names_to_seed_at_half_vdd[one_net_index].c_str(),
				seed_voltage_for_this_net);
		initial_condition_lines.emplace_back(one_initial_condition_line_buffer);
	}
	std::vector<std::string> augmented_netlist_lines;
	augmented_netlist_lines.reserve(original_netlist_lines.size() + initial_condition_lines.size());
	bool initial_condition_lines_have_been_inserted = false;
	for (const auto &one_original_line : original_netlist_lines) {
		std::string stripped_lowercase_line;
		stripped_lowercase_line.reserve(one_original_line.size());
		for (char one_character : one_original_line) {
			if (std::isspace(static_cast<unsigned char>(one_character))) continue;
			stripped_lowercase_line.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(one_character))));
		}
		if (!initial_condition_lines_have_been_inserted
				&& (stripped_lowercase_line == ".end" || stripped_lowercase_line.rfind(".end ", 0) == 0)) {
			for (const auto &one_initial_condition_line : initial_condition_lines) {
				augmented_netlist_lines.push_back(one_initial_condition_line);
			}
			initial_condition_lines_have_been_inserted = true;
		}
		augmented_netlist_lines.push_back(one_original_line);
	}
	if (!initial_condition_lines_have_been_inserted) {
		for (const auto &one_initial_condition_line : initial_condition_lines) {
			augmented_netlist_lines.push_back(one_initial_condition_line);
		}
	}
	return augmented_netlist_lines;
}

} // namespace

void LibngspiceSpiceSimulator::expose_persistent_directory_to_simulator(
		const std::string &user_relative_directory_path) {
	(void)user_relative_directory_path;
}

std::string LibngspiceSpiceSimulator::resolve_simulator_include_path_for_persistent_resource(
		const std::string &user_relative_path) const {
	const godot::String user_uri = godot::String("user://") + godot::String(user_relative_path.c_str());
	const godot::String globalized = godot::ProjectSettings::get_singleton()->globalize_path(user_uri);
	return godot_string_to_std_string_utf8(globalized);
}

bool LibngspiceSpiceSimulator::start_transient_analysis_with_netlist_and_seed_ic_nets(
		const std::vector<std::string> &netlist_lines,
		double transient_timestep_seconds,
		const std::vector<std::string> &internal_net_names_to_seed_at_half_vdd) {
	const std::vector<std::string> augmented_netlist_lines =
			build_netlist_with_alternating_initial_condition_lines_for_internal_nets(
					netlist_lines, internal_net_names_to_seed_at_half_vdd);
	if (!load_netlist_lines_into_ngspice(augmented_netlist_lines, ngspice_has_been_initialized, this)) {
		return false;
	}
	stop_has_been_requested = false;
	return start_or_restart_background_transient(
			transient_timestep_seconds,
			EFFECTIVELY_UNBOUNDED_TRANSIENT_STOP_TIME_SECONDS,
			!internal_net_names_to_seed_at_half_vdd.empty());
}

bool LibngspiceSpiceSimulator::update_transient_timestep_mid_simulation(double new_timestep_seconds) {
	if (background_thread_is_running.load()) {
		stop_has_been_requested = true;
		ngSpice_Command(const_cast<char *>("bg_halt"));
	}
	return start_or_restart_background_transient(
			new_timestep_seconds, EFFECTIVELY_UNBOUNDED_TRANSIENT_STOP_TIME_SECONDS, false);
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

void apply_loose_run_phase_options_via_runtime_commands() {
	for (const char *one_option_command : NGSPICE_OPTION_COMMANDS_FOR_LOOSE_RUN_PHASE) {
		ngSpice_Command(const_cast<char *>(one_option_command));
	}
}

bool start_or_restart_background_transient(
		double transient_timestep_seconds,
		double stop_time_seconds,
		bool use_initial_conditions) {
	apply_loose_run_phase_options_via_runtime_commands();

	char transient_command_buffer[160];
	std::snprintf(
			transient_command_buffer,
			sizeof(transient_command_buffer),
			"bg_tran %.15g %.15g 0 %.15g%s",
			transient_timestep_seconds,
			stop_time_seconds,
			transient_timestep_seconds,
			use_initial_conditions ? " uic" : "");
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

void LibngspiceSpiceSimulator::receive_log_message(const char *message_text) {
	if (!message_text) return;
	godot::UtilityFunctions::print(godot::String("[ngspice] ") + godot::String(message_text));
}

void LibngspiceSpiceSimulator::receive_status_message(const char *message_text) {
	if (!message_text) return;
	godot::UtilityFunctions::print(godot::String("[ngspice:status] ") + godot::String(message_text));
}

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
