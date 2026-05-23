#include "spice_simulator_native.h"

#include <algorithm>
#include <cctype>
#include <cstring>

#ifdef SPICE3D_HAVE_LIBNGSPICE
#include <sharedspice.h>
#endif

namespace spice3d {
namespace native {

namespace {

std::string lowercase(std::string s) {
	std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) {
		return static_cast<char>(std::tolower(c));
	});
	return s;
}

#ifdef SPICE3D_HAVE_LIBNGSPICE
// Trampolines — libngspice's C API takes raw function pointers plus a void*
// user-data slot; we set userData to the SpiceSimulatorNative instance and
// dispatch from there. ngspice will invoke these from its background thread.

int trampoline_send_char(char *msg, int /*id*/, void *ud) {
	if (ud) static_cast<SpiceSimulatorNative *>(ud)->on_send_char(msg);
	return 0;
}

int trampoline_send_stat(char *msg, int /*id*/, void *ud) {
	if (ud) static_cast<SpiceSimulatorNative *>(ud)->on_send_stat(msg);
	return 0;
}

int trampoline_controlled_exit(int status, NG_BOOL /*immed*/, NG_BOOL /*quit*/, int /*id*/, void *ud) {
	if (ud) static_cast<SpiceSimulatorNative *>(ud)->on_controlled_exit(status);
	return 0;
}

int trampoline_bg_running(NG_BOOL running, int /*id*/, void *ud) {
	if (ud) static_cast<SpiceSimulatorNative *>(ud)->on_bg_thread_running(running);
	return 0;
}

int trampoline_send_data(pvecvaluesall allvals, int /*count*/, int /*id*/, void *ud) {
	if (!ud || !allvals) return 0;
	auto *self = static_cast<SpiceSimulatorNative *>(ud);

	const int n = allvals->veccount;
	std::vector<const char *> names(n);
	std::vector<double> values(n);
	double time = 0.0;
	for (int i = 0; i < n; ++i) {
		const auto &v = *allvals->vecsa[i];
		names[i] = v.name;
		values[i] = v.creal;
		if (v.name && std::strcmp(v.name, "time") == 0) {
			time = v.creal;
		}
	}
	self->on_send_data_vec(time, names.data(), values.data(), n);
	return 0;
}

int trampoline_send_init_data(pvecinfoall info, int /*id*/, void *ud) {
	if (!ud || !info) return 0;
	auto *self = static_cast<SpiceSimulatorNative *>(ud);
	const int n = info->veccount;
	std::vector<const char *> names(n);
	for (int i = 0; i < n; ++i) {
		names[i] = info->vecs[i] ? info->vecs[i]->vecname : "";
	}
	self->on_send_init_info(names.data(), n);
	return 0;
}

int trampoline_get_vsrc(double *value, double time, char *node_name, int /*id*/, void *ud) {
	if (!ud || !value) return 0;
	static_cast<SpiceSimulatorNative *>(ud)->on_get_vsrc_data(value, time, node_name);
	return 0;
}
#endif // SPICE3D_HAVE_LIBNGSPICE

} // anonymous namespace

SpiceSimulatorNative::SpiceSimulatorNative() = default;

SpiceSimulatorNative::~SpiceSimulatorNative() {
	stop();
}

bool SpiceSimulatorNative::load_netlist(const std::vector<std::string> &lines) {
#ifdef SPICE3D_HAVE_LIBNGSPICE
	if (!ngspice_initialized_) {
		ngSpice_Init(
				trampoline_send_char,
				trampoline_send_stat,
				trampoline_controlled_exit,
				trampoline_send_data,
				trampoline_send_init_data,
				trampoline_bg_running,
				this);
		static int unique_id = 0;
		ngSpice_Init_Sync(
				trampoline_get_vsrc,
				nullptr,
				nullptr,
				&unique_id,
				this);
		ngspice_initialized_ = true;
	}

	// ngSpice_Circ wants a NULL-terminated char**. We own the strings; ngspice
	// just walks the array.
	std::vector<char *> argv;
	argv.reserve(lines.size() + 1);
	for (const auto &line : lines) {
		argv.push_back(const_cast<char *>(line.c_str()));
	}
	argv.push_back(nullptr);
	return ngSpice_Circ(argv.data()) == 0;
#else
	(void)lines;
	return false;
#endif
}

bool SpiceSimulatorNative::start_transient(double step_s, double stop_s) {
#ifdef SPICE3D_HAVE_LIBNGSPICE
	// Memory hygiene per design doc: prevent ngspice from accumulating an
	// unbounded internal plot — voltages flow exclusively through SendData.
	ngSpice_Command(const_cast<char *>("save none"));
	ngSpice_Command(const_cast<char *>("esave node"));

	char cmd[128];
	std::snprintf(cmd, sizeof(cmd), "bg_tran %.15g %.15g", step_s, stop_s);
	stop_requested_ = false;
	return ngSpice_Command(cmd) == 0;
#else
	(void)step_s;
	(void)stop_s;
	return false;
#endif
}

void SpiceSimulatorNative::stop() {
#ifdef SPICE3D_HAVE_LIBNGSPICE
	if (running_.load()) {
		stop_requested_ = true;
		ngSpice_Command(const_cast<char *>("bg_halt"));
	}
#endif
}

bool SpiceSimulatorNative::is_running() const {
	return running_.load();
}

void SpiceSimulatorNative::set_external_voltage(const std::string &source_name, double volts) {
	std::lock_guard<std::mutex> lock(sources_mutex_);
	external_sources_[lowercase(source_name)] = volts;
}

std::vector<Sample> SpiceSimulatorNative::drain_samples() {
	return queue_.drain();
}

const SimInitInfo *SpiceSimulatorNative::init_info() const {
	return init_info_ready_.load() ? &init_info_ : nullptr;
}

// ----- callbacks (called from ngspice's bg thread) -----

void SpiceSimulatorNative::on_send_char(const char *) {
	// Discard for now. Wire to Godot's print_line via a thread-safe buffer
	// once we have a log surface.
}

void SpiceSimulatorNative::on_send_stat(const char *) {}

void SpiceSimulatorNative::on_send_data_vec(double time, const char *const *names, const double *values, int count) {
	Sample s;
	s.time = time;
	s.voltages.reserve(count);
	for (int i = 0; i < count; ++i) {
		// We keep all vectors for now; the renderer indexes via init_info_.
		// "time" is included; downstream can skip it by name match.
		(void)names;
		s.voltages.push_back(values[i]);
	}
	queue_.push(std::move(s));
}

void SpiceSimulatorNative::on_send_init_info(const char *const *vector_names, int count) {
	init_info_.node_names.assign(vector_names, vector_names + count);
	init_info_ready_.store(true);
}

void SpiceSimulatorNative::on_bg_thread_running(bool running) {
	running_.store(running);
}

void SpiceSimulatorNative::on_controlled_exit(int) {
	running_.store(false);
}

void SpiceSimulatorNative::on_get_vsrc_data(double *out_value, double /*time*/, const char *node_name) {
	std::lock_guard<std::mutex> lock(sources_mutex_);
	auto it = external_sources_.find(node_name ? lowercase(node_name) : std::string());
	*out_value = (it == external_sources_.end()) ? 0.0 : it->second;
}

} // namespace native
} // namespace spice3d
