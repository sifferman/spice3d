#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include "../src/scene/schematic_loader.h"

namespace {

bool string_starts_with(const std::string &source_text, const char *prefix) {
	return source_text.compare(0, std::strlen(prefix), prefix) == 0;
}

bool any_component_symref_starts_with(
		const std::vector<spice3d::ComponentInstance> &components,
		const char *symref_prefix) {
	for (const auto &component : components) {
		if (string_starts_with(component.symbol_reference, symref_prefix)) {
			return true;
		}
	}
	return false;
}

std::size_t count_wires_with_non_empty_label(const std::vector<spice3d::WireSegment> &wires) {
	std::size_t labelled_wire_count = 0;
	for (const auto &wire : wires) {
		if (!wire.net_label.empty()) ++labelled_wire_count;
	}
	return labelled_wire_count;
}

int test_button_example_schematic(const std::string &examples_directory) {
	const std::string schematic_path = examples_directory + "/button/button_test.sch";
	const auto result = spice3d::load_schematic_from_file(schematic_path, "");
	if (!result.was_successful) {
		std::fprintf(stderr, "load failed: %s\n", result.error_message.c_str());
		return 1;
	}

	const spice3d::Schematic &schematic = result.loaded_schematic;
	if (schematic.cell_name != "button_test") {
		std::fprintf(stderr, "expected cell_name=button_test, got '%s'\n", schematic.cell_name.c_str());
		return 1;
	}
	if (schematic.wires.size() != 0) {
		std::fprintf(stderr, "expected 0 wires, got %zu\n", schematic.wires.size());
		return 1;
	}
	if (schematic.component_instances.size() != 3) {
		std::fprintf(stderr, "expected 3 components, got %zu\n", schematic.component_instances.size());
		return 1;
	}
	const bool has_button_symbol = any_component_symref_starts_with(schematic.component_instances, "button.sym");
	const bool has_opin_symbol = any_component_symref_starts_with(schematic.component_instances, "opin.sym");
	const bool has_ipin_symbol = any_component_symref_starts_with(schematic.component_instances, "ipin.sym");
	if (!(has_button_symbol && has_opin_symbol && has_ipin_symbol)) {
		std::fprintf(stderr, "missing expected symrefs (button/opin/ipin)\n");
		return 1;
	}

	std::printf("button_test: OK (cell=%s, %zu components, %zu wires)\n",
			schematic.cell_name.c_str(),
			schematic.component_instances.size(),
			schematic.wires.size());
	return 0;
}

int test_three_bit_counter_example_schematic(const std::string &examples_directory) {
	const std::string schematic_path = examples_directory + "/3bit_counter/3bit_counter.sch";
	const auto result = spice3d::load_schematic_from_file(schematic_path, "");
	if (!result.was_successful) {
		std::fprintf(stderr, "load failed: %s\n", result.error_message.c_str());
		return 1;
	}

	const spice3d::Schematic &schematic = result.loaded_schematic;
	if (schematic.cell_name != "3bit_counter") {
		std::fprintf(stderr, "expected cell_name=3bit_counter, got '%s'\n", schematic.cell_name.c_str());
		return 1;
	}
	constexpr std::size_t expected_minimum_wire_count = 20;
	if (schematic.wires.size() < expected_minimum_wire_count) {
		std::fprintf(stderr, "expected >=%zu wires, got %zu\n",
				expected_minimum_wire_count, schematic.wires.size());
		return 1;
	}
	constexpr std::size_t expected_minimum_component_count = 14;
	if (schematic.component_instances.size() < expected_minimum_component_count) {
		std::fprintf(stderr, "expected >=%zu components, got %zu\n",
				expected_minimum_component_count, schematic.component_instances.size());
		return 1;
	}

	const std::size_t labelled_wire_count = count_wires_with_non_empty_label(schematic.wires);
	if (labelled_wire_count == 0) {
		std::fprintf(stderr, "no wires got a `lab=` value\n");
		return 1;
	}

	std::printf("3bit_counter: OK (cell=%s, %zu components, %zu wires, %zu labelled)\n",
			schematic.cell_name.c_str(),
			schematic.component_instances.size(),
			schematic.wires.size(),
			labelled_wire_count);
	return 0;
}

} // namespace

int main(int argument_count, char **argument_values) {
	if (argument_count < 2) {
		std::fprintf(stderr, "usage: %s <examples_directory>\n", argument_values[0]);
		return 2;
	}
	const std::string examples_directory = argument_values[1];
	int aggregate_exit_code = 0;
	aggregate_exit_code |= test_button_example_schematic(examples_directory);
	aggregate_exit_code |= test_three_bit_counter_example_schematic(examples_directory);
	if (aggregate_exit_code == 0) {
		std::puts("all tests passed");
	}
	return aggregate_exit_code;
}
