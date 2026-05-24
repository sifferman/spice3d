#pragma once

#include <mutex>
#include <utility>
#include <vector>

#include "spice_simulator.h"

namespace spice3d {

class SimulationSampleQueue {
public:
	void push_sample(SimulationSample new_sample) {
		const std::lock_guard<std::mutex> lock(samples_mutex);
		buffered_samples.push_back(std::move(new_sample));
	}

	std::vector<SimulationSample> take_all_samples() {
		const std::lock_guard<std::mutex> lock(samples_mutex);
		std::vector<SimulationSample> drained_samples;
		drained_samples.swap(buffered_samples);
		return drained_samples;
	}

	void clear_all_samples() {
		const std::lock_guard<std::mutex> lock(samples_mutex);
		buffered_samples.clear();
	}

	std::size_t approximate_buffered_count() const {
		const std::lock_guard<std::mutex> lock(samples_mutex);
		return buffered_samples.size();
	}

private:
	mutable std::mutex samples_mutex;
	std::vector<SimulationSample> buffered_samples;
};

} // namespace spice3d
