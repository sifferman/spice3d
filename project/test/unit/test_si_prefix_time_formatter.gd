extends GutTest


const SiPrefixTime = preload("res://si_prefix_time_formatter.gd")


func test_seconds_in_seconds_range_uses_s_suffix() -> void:
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(1.0), "1.00s")
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(2.5), "2.50s")
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(123.0), "123s")


func test_milliseconds_range_uses_ms_suffix() -> void:
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(1.0e-3), "1.00ms")
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(33.3e-3), "33.3ms")
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(999.0e-3), "999ms")


func test_microseconds_range_uses_us_suffix() -> void:
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(1.0e-6), "1.00us")
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(250.0e-6), "250us")


func test_nanoseconds_range_uses_ns_suffix() -> void:
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(1.0e-9), "1.00ns")
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(2.0e-9), "2.00ns")
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(500.0e-9), "500ns")


func test_picoseconds_range_uses_ps_suffix() -> void:
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(1.0e-12), "1.00ps")
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(31.0e-12), "31.0ps")
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(200.0e-12), "200ps")


func test_sub_picosecond_range_uses_fs_suffix() -> void:
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(1.0e-15), "1.00fs")
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(33.0e-15), "33.0fs")


func test_zero_seconds_renders_as_zero_s() -> void:
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(0.0), "0s")


func test_negative_seconds_preserves_sign() -> void:
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(-1.0e-9), "-1.00ns")
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(-31.0e-12), "-31.0ps")


func test_round_trip_contains_no_space_between_number_and_unit() -> void:
	var typical_input_values := [
			1.0e-15, 1.0e-12, 1.0e-9, 1.0e-6, 1.0e-3, 1.0,
			31.0e-12, 200.0e-12, 33.3e-3, 250.0e-9, 1.5,
	]
	for one_value in typical_input_values:
		var rendered := SiPrefixTime.format_seconds_with_si_prefix(one_value)
		assert_false(rendered.contains(" "),
				"format_seconds_with_si_prefix(%s) returned %s which contains a space — numbers and units must be joined." % [
					str(one_value), rendered])
		assert_false(rendered.to_lower().contains("e"),
				"format_seconds_with_si_prefix(%s) returned %s which contains scientific notation 'e'." % [
					str(one_value), rendered])
