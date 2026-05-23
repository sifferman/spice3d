#include "symbol_drawing_loader.h"

#include <algorithm>
#include <fstream>
#include <sstream>

namespace spice3d {

namespace {

bool try_parse_record_header_for_line_or_box(
		const std::string &one_line_of_text,
		char *out_record_type_character,
		double *out_x1,
		double *out_y1,
		double *out_x2,
		double *out_y2) {
	if (one_line_of_text.empty()) return false;
	const char record_type_character = one_line_of_text[0];
	if (record_type_character != 'L' && record_type_character != 'B') return false;
	std::istringstream record_stream(one_line_of_text);
	char parsed_record_type = 0;
	int unused_color_integer = 0;
	double x1 = 0.0;
	double y1 = 0.0;
	double x2 = 0.0;
	double y2 = 0.0;
	record_stream >> parsed_record_type >> unused_color_integer >> x1 >> y1 >> x2 >> y2;
	if (!record_stream) return false;
	*out_record_type_character = parsed_record_type;
	*out_x1 = x1;
	*out_y1 = y1;
	*out_x2 = x2;
	*out_y2 = y2;
	return true;
}

} // namespace

SymbolDrawingPrimitivesInLocalCoordinates load_symbol_drawing_primitives_from_file(
		const std::string &symbol_file_path) {
	SymbolDrawingPrimitivesInLocalCoordinates primitives;
	std::ifstream symbol_file_stream(symbol_file_path);
	if (!symbol_file_stream.is_open()) return primitives;
	std::string one_line_of_text;
	while (std::getline(symbol_file_stream, one_line_of_text)) {
		char record_type_character = 0;
		double x1 = 0.0;
		double y1 = 0.0;
		double x2 = 0.0;
		double y2 = 0.0;
		if (!try_parse_record_header_for_line_or_box(
				one_line_of_text, &record_type_character, &x1, &y1, &x2, &y2)) {
			continue;
		}
		if (record_type_character == 'L') {
			SymbolLineSegmentInLocalCoordinates line_segment;
			line_segment.start_x = x1;
			line_segment.start_y = y1;
			line_segment.end_x = x2;
			line_segment.end_y = y2;
			primitives.line_segments.push_back(line_segment);
		} else {
			SymbolBoxInLocalCoordinates box;
			box.minimum_x = std::min(x1, x2);
			box.minimum_y = std::min(y1, y2);
			box.maximum_x = std::max(x1, x2);
			box.maximum_y = std::max(y1, y2);
			primitives.boxes.push_back(box);
		}
	}
	return primitives;
}

} // namespace spice3d
