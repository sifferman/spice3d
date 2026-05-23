#pragma once

// Native libngspice implementation of SpiceSimulator.
//
// Build: only compiled when SPICE3D_HAVE_LIBNGSPICE is defined (set by the
// build system when `sharedspice.h` and `libngspice` are available). Without
// libngspice we fall back to a stub that always reports "no backend".

#include "../spice_simulator.h"

#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

#include "../sample_queue.h"

namespace spice3d {
namespace native {

class SpiceSimulatorNative : public SpiceSimulator {
public:
	SpiceSimulatorNative();
	~SpiceSimulatorNative() override;

	bool load_netlist(const std::vector<std::string> &lines) override;
	bool start_transient(double step_s, double stop_s) override;
	void stop() override;
	bool is_running() const override;
	void set_external_voltage(const std::string &source_name, double volts) override;
	std::vector<Sample> drain_samples() override;
	const SimInitInfo *init_info() const override;

	// libngspice C callbacks — public so the trampolines in the .cpp can
	// dispatch into the instance via the userData pointer ngSpice_Init takes.
	void on_send_char(const char *msg);
	void on_send_stat(const char *msg);
	void on_send_data_vec(double time, const char *const *names, const double *values, int count);
	void on_send_init_info(const char *const *vector_names, int count);
	void on_bg_thread_running(bool running);
	void on_controlled_exit(int status);
	void on_get_vsrc_data(double *out_value, double time, const char *node_name);

private:
	SampleQueue queue_;
	SimInitInfo init_info_;
	std::atomic<bool> init_info_ready_{false};
	std::atomic<bool> running_{false};
	std::atomic<bool> stop_requested_{false};

	mutable std::mutex sources_mutex_;
	std::unordered_map<std::string, double> external_sources_;

	bool ngspice_initialized_ = false;
};

} // namespace native
} // namespace spice3d
