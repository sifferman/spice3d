// Standalone smoke test for SchematicLoader.
//
// Build:
//   make -C test
//
// This test deliberately does NOT depend on godot-cpp — it links only
// schematic_loader.cpp + xschem2spice's C sources. Lets us verify the
// parser-side wiring without a full Godot toolchain.

#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include "../src/scene/schematic_loader.h"

namespace {

bool starts_with(const std::string &s, const char *prefix) {
	return s.compare(0, std::strlen(prefix), prefix) == 0;
}

int test_button(const std::string &examples_dir) {
	const std::string sch = examples_dir + "/button/button_test.sch";
	// extra_search_paths can be wired through here once the loader API
	// supports it from the test; for now provide xschemrc=""; the schematic
	// directory itself isn't on xschem2spice's library path by default, so
	// button.sym will not resolve — that's fine for this smoke test, we
	// only assert on the structure xschem2spice surfaces unconditionally.
	auto res = spice3d::load_schematic(sch, "");
	if (!res.ok) {
		std::fprintf(stderr, "load_schematic failed: %s\n", res.error.c_str());
		return 1;
	}
	if (res.schematic.cell_name != "button_test") {
		std::fprintf(stderr, "expected cell_name=button_test, got '%s'\n",
				res.schematic.cell_name.c_str());
		return 1;
	}
	// button_test.sch has 0 wires, 3 instances (button, opin, ipin).
	if (res.schematic.wires.size() != 0) {
		std::fprintf(stderr, "expected 0 wires, got %zu\n", res.schematic.wires.size());
		return 1;
	}
	if (res.schematic.components.size() != 3) {
		std::fprintf(stderr, "expected 3 components, got %zu\n", res.schematic.components.size());
		return 1;
	}

	bool saw_button = false, saw_opin = false, saw_ipin = false;
	for (const auto &c : res.schematic.components) {
		if (starts_with(c.symref, "button.sym")) saw_button = true;
		if (starts_with(c.symref, "opin.sym"))   saw_opin   = true;
		if (starts_with(c.symref, "ipin.sym"))   saw_ipin   = true;
	}
	if (!(saw_button && saw_opin && saw_ipin)) {
		std::fprintf(stderr, "missing expected symrefs (button/opin/ipin)\n");
		return 1;
	}

	std::printf("button_test: OK (cell=%s, %zu components, %zu wires)\n",
			res.schematic.cell_name.c_str(),
			res.schematic.components.size(),
			res.schematic.wires.size());
	return 0;
}

int test_counter(const std::string &examples_dir) {
	const std::string sch = examples_dir + "/3bit_counter/3bit_counter.sch";
	auto res = spice3d::load_schematic(sch, "");
	if (!res.ok) {
		std::fprintf(stderr, "load_schematic failed: %s\n", res.error.c_str());
		return 1;
	}
	if (res.schematic.cell_name != "3bit_counter") {
		std::fprintf(stderr, "expected cell_name=3bit_counter, got '%s'\n",
				res.schematic.cell_name.c_str());
		return 1;
	}
	// .sch has 24 N records (wires) and 17 C records (instances).
	// Counts may shift if xschem2spice normalizes; assert minimum.
	if (res.schematic.wires.size() < 20) {
		std::fprintf(stderr, "expected >=20 wires, got %zu\n", res.schematic.wires.size());
		return 1;
	}
	// 3bit_counter.sch has exactly 14 C records (6 stdcells + 4 ipins + 4 lab_pins).
	if (res.schematic.components.size() < 14) {
		std::fprintf(stderr, "expected >=14 components, got %zu\n", res.schematic.components.size());
		return 1;
	}

	// Every wire in this schematic has a `lab=`.
	std::size_t labelled = 0;
	for (const auto &w : res.schematic.wires) {
		if (!w.label.empty()) ++labelled;
	}
	if (labelled == 0) {
		std::fprintf(stderr, "no wires got a `lab=` value — wire_label() may be broken\n");
		return 1;
	}

	std::printf("3bit_counter: OK (cell=%s, %zu components, %zu wires, %zu labelled)\n",
			res.schematic.cell_name.c_str(),
			res.schematic.components.size(),
			res.schematic.wires.size(),
			labelled);
	return 0;
}

} // anonymous namespace

int main(int argc, char **argv) {
	if (argc < 2) {
		std::fprintf(stderr, "usage: %s <examples_dir>\n", argv[0]);
		return 2;
	}
	std::string dir = argv[1];
	int rc = 0;
	rc |= test_button(dir);
	rc |= test_counter(dir);
	if (rc == 0) {
		std::puts("all tests passed");
	}
	return rc;
}
