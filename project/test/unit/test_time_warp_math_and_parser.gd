extends GutTest


# Exercises the pure functions in main.gd that derive ngspice tran
# parameters and wall-clock playback pacing from the user-typed
# time-warp value. None of these access @onready vars or scene
# tree state, so we can call them directly on a freshly-instantiated
# main.gd Node.


var loaded_main_script_instance: Node = null


func before_each() -> void:
	var main_script: Script = load("res://main.gd")
	loaded_main_script_instance = main_script.new()


func after_each() -> void:
	if loaded_main_script_instance != null:
		loaded_main_script_instance.free()
		loaded_main_script_instance = null


# ---------- parser tests ----------

func test_parser_accepts_picoseconds_with_space() -> void:
	var parsed_value: float = loaded_main_script_instance.parse_time_warp_input_text_to_simulated_seconds_per_real_second("50 ps")
	assert_almost_eq(parsed_value, 50.0e-12, 1.0e-15,
			"'50 ps' should parse as 50 picoseconds.")


func test_parser_accepts_nanoseconds_without_space() -> void:
	var parsed_value: float = loaded_main_script_instance.parse_time_warp_input_text_to_simulated_seconds_per_real_second("1ns")
	assert_almost_eq(parsed_value, 1.0e-9, 1.0e-12,
			"'1ns' (no space) should parse as 1 nanosecond.")


func test_parser_accepts_microseconds_with_us_spelling() -> void:
	var parsed_value: float = loaded_main_script_instance.parse_time_warp_input_text_to_simulated_seconds_per_real_second("100 us")
	assert_almost_eq(parsed_value, 100.0e-6, 1.0e-9,
			"'100 us' should parse as 100 microseconds.")


func test_parser_accepts_microseconds_with_mu_symbol() -> void:
	var parsed_value: float = loaded_main_script_instance.parse_time_warp_input_text_to_simulated_seconds_per_real_second("100 µs")
	assert_almost_eq(parsed_value, 100.0e-6, 1.0e-9,
			"'100 µs' (real micro symbol) should parse the same as '100 us'.")


func test_parser_is_case_insensitive() -> void:
	var parsed_value: float = loaded_main_script_instance.parse_time_warp_input_text_to_simulated_seconds_per_real_second("500 NS")
	assert_almost_eq(parsed_value, 500.0e-9, 1.0e-12,
			"Unit suffix must be case-insensitive ('NS' should work).")


func test_parser_accepts_decimal_numeric_value() -> void:
	var parsed_value: float = loaded_main_script_instance.parse_time_warp_input_text_to_simulated_seconds_per_real_second("1.5 ns")
	assert_almost_eq(parsed_value, 1.5e-9, 1.0e-13,
			"Decimal numeric values should be accepted.")


func test_parser_rejects_value_above_one_thousand() -> void:
	var parsed_value: float = loaded_main_script_instance.parse_time_warp_input_text_to_simulated_seconds_per_real_second("1001 ns")
	assert_true(is_nan(parsed_value),
			"Numeric values above 1000 must be rejected to bound the time-warp range.")


func test_parser_rejects_zero() -> void:
	var parsed_value: float = loaded_main_script_instance.parse_time_warp_input_text_to_simulated_seconds_per_real_second("0 ns")
	assert_true(is_nan(parsed_value),
			"Zero must be rejected — a zero sim:wall ratio is undefined.")


func test_parser_rejects_negative() -> void:
	var parsed_value: float = loaded_main_script_instance.parse_time_warp_input_text_to_simulated_seconds_per_real_second("-1 ns")
	assert_true(is_nan(parsed_value),
			"Negative values must be rejected.")


func test_parser_rejects_unknown_unit() -> void:
	var parsed_value: float = loaded_main_script_instance.parse_time_warp_input_text_to_simulated_seconds_per_real_second("100 ms")
	assert_true(is_nan(parsed_value),
			"Milliseconds aren't in the supported ps/ns/us set.")


func test_parser_rejects_missing_unit() -> void:
	var parsed_value: float = loaded_main_script_instance.parse_time_warp_input_text_to_simulated_seconds_per_real_second("100")
	assert_true(is_nan(parsed_value),
			"Bare number with no unit must be rejected — semantics would be ambiguous.")


func test_parser_rejects_empty_string() -> void:
	var parsed_value: float = loaded_main_script_instance.parse_time_warp_input_text_to_simulated_seconds_per_real_second("")
	assert_true(is_nan(parsed_value),
			"Empty string must be rejected.")


# ---------- compute_transient_timestep_seconds_for_current_time_warp tests ----------

# The formula is now: timestep = T / N (always), wall_per_sample = 1/N (always).
# N is loaded_main_script_instance.TIME_WARP_NOMINAL_NUMBER_OF_SAMPLES_PER_WALL_SECOND_OF_PLAYBACK.
# Under the continuous-step-N worker architecture there's no fixed
# tran window anymore; ngspice runs one long tran and the playback
# rate is decoupled from the simulation rate.

func nominal_playback_samples_per_wall_second_constant_from_main_gd() -> int:
	return loaded_main_script_instance.TIME_WARP_NOMINAL_NUMBER_OF_SAMPLES_PER_WALL_SECOND_OF_PLAYBACK


func test_timestep_scales_linearly_with_time_warp_at_picosecond_range() -> void:
	loaded_main_script_instance.currently_selected_time_warp_simulated_seconds_per_real_second = 50.0e-12
	var computed_timestep: float = loaded_main_script_instance.compute_transient_timestep_seconds_for_current_time_warp()
	var expected_timestep := 50.0e-12 / nominal_playback_samples_per_wall_second_constant_from_main_gd()
	assert_almost_eq(computed_timestep, expected_timestep, 1.0e-15,
			"timestep should equal T / N for any T (continuous-step-N architecture).")


func test_timestep_scales_linearly_with_time_warp_at_nanosecond_range() -> void:
	loaded_main_script_instance.currently_selected_time_warp_simulated_seconds_per_real_second = 100.0e-9
	var computed_timestep: float = loaded_main_script_instance.compute_transient_timestep_seconds_for_current_time_warp()
	var expected_timestep := 100.0e-9 / nominal_playback_samples_per_wall_second_constant_from_main_gd()
	assert_almost_eq(computed_timestep, expected_timestep, 1.0e-12,
			"At T = 100 ns/s, timestep should be T/N = ~3.33 ns.")


func test_timestep_scales_linearly_with_time_warp_at_microsecond_range() -> void:
	loaded_main_script_instance.currently_selected_time_warp_simulated_seconds_per_real_second = 1.0e-6
	var computed_timestep: float = loaded_main_script_instance.compute_transient_timestep_seconds_for_current_time_warp()
	var expected_timestep := 1.0e-6 / nominal_playback_samples_per_wall_second_constant_from_main_gd()
	assert_almost_eq(computed_timestep, expected_timestep, 1.0e-9,
			"At T = 1 us/s, timestep should be T/N = ~33 ns.")


# ---------- compute_wall_clock_seconds_between_sample_playback_steps_for_current_time_warp tests ----------

# The new formula: wall_per_sample = 1/N for any T (continuous sim,
# playback paced at the nominal sample-per-wall-second rate).

func test_wall_per_sample_is_thirtieth_of_a_second_regardless_of_time_warp() -> void:
	var time_warp_values_to_check := [1.0e-12, 50.0e-12, 1.0e-9, 100.0e-9, 1.0e-6]
	for one_time_warp_value in time_warp_values_to_check:
		loaded_main_script_instance.currently_selected_time_warp_simulated_seconds_per_real_second = one_time_warp_value
		var computed_wall_per_sample: float = loaded_main_script_instance.compute_wall_clock_seconds_between_sample_playback_steps_for_current_time_warp()
		assert_almost_eq(computed_wall_per_sample, 1.0 / 30.0, 1.0e-9,
				"At T = %s the playback rate must stay locked at ~30 samples/wall-second." % str(one_time_warp_value))


# ---------- one round-trip sanity test that ties the parser to the math ----------

func test_user_typed_50_ps_resolves_to_thirty_hz_playback() -> void:
	var parsed_value: float = loaded_main_script_instance.parse_time_warp_input_text_to_simulated_seconds_per_real_second("50 ps")
	loaded_main_script_instance.currently_selected_time_warp_simulated_seconds_per_real_second = parsed_value
	var computed_wall_per_sample: float = loaded_main_script_instance.compute_wall_clock_seconds_between_sample_playback_steps_for_current_time_warp()
	assert_almost_eq(computed_wall_per_sample, 1.0 / 30.0, 1.0e-6,
			"Typing '50 ps' should yield ~30 sample-paints per wall second.")
