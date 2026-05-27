extends RefCounted


const PAUSE_SENTINEL_SIMULATED_SECONDS_PER_REAL_SECOND := 0.0
const MAXIMUM_NUMERIC_VALUE := 1000.0


static func parse_input_text_to_simulated_seconds_per_real_second(input_text: String) -> float:
	var trimmed_lowercase_text := input_text.strip_edges().to_lower().replace("µ", "u")
	if trimmed_lowercase_text.is_valid_float() and trimmed_lowercase_text.to_float() == 0.0:
		return PAUSE_SENTINEL_SIMULATED_SECONDS_PER_REAL_SECOND
	var unit_multiplier_in_seconds := 0.0
	if trimmed_lowercase_text.ends_with("ps"):
		unit_multiplier_in_seconds = 1.0e-12
	elif trimmed_lowercase_text.ends_with("ns"):
		unit_multiplier_in_seconds = 1.0e-9
	elif trimmed_lowercase_text.ends_with("us"):
		unit_multiplier_in_seconds = 1.0e-6
	else:
		return NAN
	var numeric_text_without_unit_suffix := trimmed_lowercase_text.substr(
			0, trimmed_lowercase_text.length() - 2).strip_edges()
	if not numeric_text_without_unit_suffix.is_valid_float():
		return NAN
	var numeric_value: float = numeric_text_without_unit_suffix.to_float()
	if numeric_value < 0.0 or numeric_value > MAXIMUM_NUMERIC_VALUE:
		return NAN
	return numeric_value * unit_multiplier_in_seconds


static func format_simulated_seconds_per_real_second_as_input_text(seconds_value: float) -> String:
	if seconds_value >= 1.0e-6:
		return "%s us" % str(seconds_value * 1.0e6)
	if seconds_value >= 1.0e-9:
		return "%s ns" % str(seconds_value * 1.0e9)
	return "%s ps" % str(seconds_value * 1.0e12)
