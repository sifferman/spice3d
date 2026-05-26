extends GutTest


const SiPrefixTime = preload("res://si_prefix_time_formatter.gd")


func test_seconds_in_seconds_range_uses_s_suffix() -> void:
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(1.0), "1.00 s")
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(2.5), "2.50 s")
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(123.0), "123 s")


func test_milliseconds_range_uses_ms_suffix() -> void:
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(1.0e-3), "1.00 ms")
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(33.3e-3), "33.3 ms")
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(999.0e-3), "999 ms")


func test_microseconds_range_uses_us_suffix() -> void:
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(1.0e-6), "1.00 us")
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(250.0e-6), "250 us")


func test_nanoseconds_range_uses_ns_suffix() -> void:
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(1.0e-9), "1.00 ns")
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(2.0e-9), "2.00 ns")
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(500.0e-9), "500 ns")


func test_picoseconds_range_uses_ps_suffix() -> void:
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(1.0e-12), "1.00 ps")
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(31.0e-12), "31.0 ps")
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(200.0e-12), "200 ps")


func test_sub_picosecond_range_uses_fs_suffix() -> void:
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(1.0e-15), "1.00 fs")
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(33.0e-15), "33.0 fs")


func test_zero_seconds_renders_as_zero_s() -> void:
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(0.0), "0 s")


func test_negative_seconds_preserves_sign() -> void:
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(-1.0e-9), "-1.00 ns")
	assert_eq(SiPrefixTime.format_seconds_with_si_prefix(-31.0e-12), "-31.0 ps")


func test_round_trip_does_not_render_scientific_notation_for_any_typical_input() -> void:
	var typical_input_values := [
			1.0e-15, 1.0e-12, 1.0e-9, 1.0e-6, 1.0e-3, 1.0,
			31.0e-12, 200.0e-12, 33.3e-3, 250.0e-9, 1.5,
	]
	for one_value in typical_input_values:
		var rendered := SiPrefixTime.format_seconds_with_si_prefix(one_value)
		assert_false(rendered.contains("e"),
				"format_seconds_with_si_prefix(%s) returned %s which contains scientific notation 'e'." % [
					str(one_value), rendered])
		assert_false(rendered.contains("E"),
				"format_seconds_with_si_prefix(%s) returned %s which contains scientific notation 'E'." % [
					str(one_value), rendered])
