#pragma once

// SampleQueue — a small, thread-safe FIFO of Samples used to buffer between
// the ngspice background thread (or Web Worker) and Godot's main thread.
//
// This is the v0 implementation: a std::mutex around a std::vector. Good
// enough to get correctness end-to-end before measuring. A
// SharedArrayBuffer-backed SPSC ring buffer can replace it later behind the
// same interface; the rest of the codebase only sees push() / drain().

#include <mutex>
#include <utility>
#include <vector>

#include "spice_simulator.h"

namespace spice3d {

class SampleQueue {
public:
	void push(Sample sample) {
		std::lock_guard<std::mutex> lock(mutex_);
		samples_.push_back(std::move(sample));
	}

	std::vector<Sample> drain() {
		std::lock_guard<std::mutex> lock(mutex_);
		std::vector<Sample> out;
		out.swap(samples_);
		return out;
	}

	void clear() {
		std::lock_guard<std::mutex> lock(mutex_);
		samples_.clear();
	}

	std::size_t size_approx() const {
		std::lock_guard<std::mutex> lock(mutex_);
		return samples_.size();
	}

private:
	mutable std::mutex mutex_;
	std::vector<Sample> samples_;
};

} // namespace spice3d
