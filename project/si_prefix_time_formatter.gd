extends RefCounted


static func format_seconds_with_si_prefix(seconds_value: float, significant_digits: int = 3) -> String:
	if is_nan(seconds_value) or is_inf(seconds_value):
		return str(seconds_value)
	var sign_prefix := "-" if seconds_value < 0.0 else ""
	var absolute_seconds := absf(seconds_value)
	if absolute_seconds == 0.0:
		return "0 s"
	var unit_suffix := ""
	var scaled_value := 0.0
	if absolute_seconds >= 1.0:
		unit_suffix = "s"
		scaled_value = absolute_seconds
	elif absolute_seconds >= 1.0e-3:
		unit_suffix = "ms"
		scaled_value = absolute_seconds * 1.0e3
	elif absolute_seconds >= 1.0e-6:
		unit_suffix = "us"
		scaled_value = absolute_seconds * 1.0e6
	elif absolute_seconds >= 1.0e-9:
		unit_suffix = "ns"
		scaled_value = absolute_seconds * 1.0e9
	elif absolute_seconds >= 1.0e-12:
		unit_suffix = "ps"
		scaled_value = absolute_seconds * 1.0e12
	else:
		unit_suffix = "fs"
		scaled_value = absolute_seconds * 1.0e15
	var integer_digit_count := 1 if scaled_value < 10.0 else (2 if scaled_value < 100.0 else 3)
	var fractional_digit_count: int = maxi(0, significant_digits - integer_digit_count)
	return "%s%.*f %s" % [sign_prefix, fractional_digit_count, scaled_value, unit_suffix]
