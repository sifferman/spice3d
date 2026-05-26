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

# The formula is: timestep = min(TRAN_STOP, T) / N.
# The expected values below are derived from the constants on main.gd
# rather than hardcoded so this file does not need editing when the
# tran-window default changes.

func tran_stop_constant_from_main_gd() -> float:
	return loaded_main_script_instance.TIME_WARP_TRANSIENT_STOP_PER_EVENT_DRIVEN_SECONDS


func nominal_playback_samples_per_wall_second_constant_from_main_gd() -> int:
	return loaded_main_script_instance.TIME_WARP_NOMINAL_NUMBER_OF_SAMPLES_PER_WALL_SECOND_OF_PLAYBACK


func test_timestep_at_t_below_tran_stop_scales_with_t() -> void:
	# At T = 50 ps/s (slower than the 200 ps tran window), timestep is
	# bounded by T not by STOP, so we get more samples per tran for a
	# smoother slow-motion animation.
	loaded_main_script_instance.currently_selected_time_warp_simulated_seconds_per_real_second = 50.0e-12
	var computed_timestep: float = loaded_main_script_instance.compute_transient_timestep_seconds_for_current_time_warp()
	var expected_timestep := 50.0e-12 / nominal_playback_samples_per_wall_second_constant_from_main_gd()
	assert_almost_eq(computed_timestep, expected_timestep, 1.0e-15,
			"At T < TRAN_STOP the timestep should be T / N to keep sample count high "
			+ "(slow-motion needs more frames).")


func test_timestep_at_t_equal_to_tran_stop_uses_stop_over_n() -> void:
	loaded_main_script_instance.currently_selected_time_warp_simulated_seconds_per_real_second = tran_stop_constant_from_main_gd()
	var computed_timestep: float = loaded_main_script_instance.compute_transient_timestep_seconds_for_current_time_warp()
	var expected_timestep := tran_stop_constant_from_main_gd() / nominal_playback_samples_per_wall_second_constant_from_main_gd()
	assert_almost_eq(computed_timestep, expected_timestep, 1.0e-15,
			"At T == TRAN_STOP the timestep should equal TRAN_STOP / N.")


func test_timestep_at_t_far_above_tran_stop_is_clamped_to_stop_over_n() -> void:
	# At T = 1 us/s (way above the 200 ps tran window), timestep is
	# bounded by STOP not by T — we don't oversample a tran just because
	# the user asked for fast playback.
	loaded_main_script_instance.currently_selected_time_warp_simulated_seconds_per_real_second = 1.0e-6
	var computed_timestep: float = loaded_main_script_instance.compute_transient_timestep_seconds_for_current_time_warp()
	var expected_timestep := tran_stop_constant_from_main_gd() / nominal_playback_samples_per_wall_second_constant_from_main_gd()
	assert_almost_eq(computed_timestep, expected_timestep, 1.0e-15,
			"At T >> TRAN_STOP the timestep should saturate at TRAN_STOP / N.")


# ---------- compute_wall_clock_seconds_between_sample_playback_steps_for_current_time_warp tests ----------

# The formula is: wall_per_sample = timestep / T
# Because each ngspice sample represents `timestep` seconds of sim time, and
# at T sim-seconds-per-real-second the equivalent real time per sample is
# timestep / T.

func test_wall_per_sample_at_slow_time_warp_is_thirtieth_of_a_second() -> void:
	# At T = 50 ps/s, timestep = 50ps/30, so wall_per_sample = (50ps/30) / 50ps = 1/30 s
	# i.e. exactly 30 sample-paints per real second — smooth animation.
	loaded_main_script_instance.currently_selected_time_warp_simulated_seconds_per_real_second = 50.0e-12
	var computed_wall_per_sample: float = loaded_main_script_instance.compute_wall_clock_seconds_between_sample_playback_steps_for_current_time_warp()
	assert_almost_eq(computed_wall_per_sample, 1.0 / 30.0, 1.0e-6,
			"At T below TRAN_STOP the playback rate is locked to ~30 samples/wall-second.")


func test_wall_per_sample_at_t_equal_to_tran_stop_is_thirtieth_of_a_second() -> void:
	loaded_main_script_instance.currently_selected_time_warp_simulated_seconds_per_real_second = tran_stop_constant_from_main_gd()
	var computed_wall_per_sample: float = loaded_main_script_instance.compute_wall_clock_seconds_between_sample_playback_steps_for_current_time_warp()
	assert_almost_eq(computed_wall_per_sample, 1.0 / 30.0, 1.0e-6,
			"At T == TRAN_STOP the playback rate is also ~30 samples/wall-second.")


func test_wall_per_sample_at_fast_time_warp_collapses_toward_one_frame() -> void:
	# At T = 1 us/s, the 200 ps tran replays over (200ps / 1us_per_s) = 0.2 ms wall.
	# Spread across 30 samples that's ~6.67 us per sample — effectively one render
	# frame, animation reads as instant.
	loaded_main_script_instance.currently_selected_time_warp_simulated_seconds_per_real_second = 1.0e-6
	var computed_wall_per_sample: float = loaded_main_script_instance.compute_wall_clock_seconds_between_sample_playback_steps_for_current_time_warp()
	# timestep at this T = TRAN_STOP/30 = 200ps/30. wall_per_sample = (200ps/30) / 1us = 200ps/(30*1us) = 6.67us
	var expected_wall_per_sample := tran_stop_constant_from_main_gd() / (nominal_playback_samples_per_wall_second_constant_from_main_gd() * 1.0e-6)
	assert_almost_eq(computed_wall_per_sample, expected_wall_per_sample, 1.0e-9,
			"At T well above TRAN_STOP the wall-per-sample collapses below one render frame "
			+ "— the animation correctly reads as instant.")


# ---------- one round-trip sanity test that ties the parser to the math ----------

func test_user_typed_50_ps_resolves_to_thirty_hz_playback() -> void:
	var parsed_value: float = loaded_main_script_instance.parse_time_warp_input_text_to_simulated_seconds_per_real_second("50 ps")
	loaded_main_script_instance.currently_selected_time_warp_simulated_seconds_per_real_second = parsed_value
	var computed_wall_per_sample: float = loaded_main_script_instance.compute_wall_clock_seconds_between_sample_playback_steps_for_current_time_warp()
	# Round-trip: the user types "50 ps" and the simulator plays back at ~30 Hz.
	assert_almost_eq(computed_wall_per_sample, 1.0 / 30.0, 1.0e-6,
			"Typing '50 ps' should yield ~30 sample-paints per wall second.")
