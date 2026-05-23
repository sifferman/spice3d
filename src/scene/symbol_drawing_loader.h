#pragma once

#include <string>
#include <vector>

namespace spice3d {

struct SymbolLineSegmentInLocalCoordinates {
	double start_x = 0.0;
	double start_y = 0.0;
	double end_x = 0.0;
	double end_y = 0.0;
};

struct SymbolBoxInLocalCoordinates {
	double minimum_x = 0.0;
	double minimum_y = 0.0;
	double maximum_x = 0.0;
	double maximum_y = 0.0;
};

struct SymbolDrawingPrimitivesInLocalCoordinates {
	std::vector<SymbolLineSegmentInLocalCoordinates> line_segments;
	std::vector<SymbolBoxInLocalCoordinates> boxes;
};

SymbolDrawingPrimitivesInLocalCoordinates load_symbol_drawing_primitives_from_file(
		const std::string &symbol_file_path);

} // namespace spice3d
