extends GutTest


# Integration test for main.gd's sample-playback pacing. The unit tests
# in test_time_warp_math_and_parser.gd validate the timestep + interval
# *formulas* in isolation. This file validates that
# step_sample_playback_queue_forward_if_wall_clock_interval_elapsed
# actually drains the queue at the rate those formulas promise — and
# that the per-click total wall time scales correctly with T.
#
# Mocks:
#   - schematic_view: a fresh empty Node3D, so apply_node_voltages_to_wire_colors
#     iterates zero children (no-op, no GDExtension wire-color side effects).
#   - spice3d_root_node_for_sample_polling: a real Spice3DNode instance
#     (same as test_spice3d_node_bindings.gd does). Needed for the
#     apply_node_voltages_to_wire_colors method to dispatch.


var loaded_main_script_instance: Node = null
var stub_schematic_view: Node3D = null
var stub_spice3d_root_node: Spice3DNode = null


func before_each() -> void:
	var main_script: Script = load("res://main.gd")
	loaded_main_script_instance = main_script.new()
	stub_schematic_view = Node3D.new()
	stub_spice3d_root_node = Spice3DNode.new()
	loaded_main_script_instance.schematic_view = stub_schematic_view
	loaded_main_script_instance.spice3d_root_node_for_sample_polling = stub_spice3d_root_node


func after_each() -> void:
	if loaded_main_script_instance != null:
		loaded_main_script_instance.free()
		loaded_main_script_instance = null
	if stub_schematic_view != null:
		stub_schematic_view.free()
		stub_schematic_view = null
	if stub_spice3d_root_node != null:
		stub_spice3d_root_node.free()
		stub_spice3d_root_node = null


func push_fake_sample_into_queue(simulated_time_seconds: float) -> void:
	loaded_main_script_instance.queued_samples_awaiting_playback_to_wires.append({
		"simulationTimeSeconds": simulated_time_seconds,
		"nodeVoltagesByName": {
			"net1": 0.0,
			"btn_out_n": 1.8,
		},
	})


# ---------- single-step pacing tests ----------

func test_playback_step_does_not_drain_when_accumulated_delta_is_below_interval() -> void:
	loaded_main_script_instance.currently_selected_time_warp_simulated_seconds_per_real_second = 100.0e-12
	var expected_interval: float = loaded_main_script_instance.compute_wall_clock_seconds_between_sample_playback_steps_for_current_time_warp()
	push_fake_sample_into_queue(0.0)
	push_fake_sample_into_queue(1.0e-12)
	loaded_main_script_instance.step_sample_playback_queue_forward_if_wall_clock_interval_elapsed(expected_interval * 0.5)
	assert_eq(loaded_main_script_instance.queued_samples_awaiting_playback_to_wires.size(), 2,
			"step() must not drain a sample when accumulated delta is below the per-sample interval.")


func test_playback_step_drains_one_sample_when_accumulated_delta_crosses_interval() -> void:
	loaded_main_script_instance.currently_selected_time_warp_simulated_seconds_per_real_second = 100.0e-12
	var expected_interval: float = loaded_main_script_instance.compute_wall_clock_seconds_between_sample_playback_steps_for_current_time_warp()
	push_fake_sample_into_queue(0.0)
	push_fake_sample_into_queue(1.0e-12)
	loaded_main_script_instance.step_sample_playback_queue_forward_if_wall_clock_interval_elapsed(expected_interval * 1.01)
	assert_eq(loaded_main_script_instance.queued_samples_awaiting_playback_to_wires.size(), 1,
			"step() must drain exactly one sample when accumulated delta crosses the per-sample interval.")


# ---------- multi-step pacing tests ----------

func test_playback_drains_all_samples_after_n_interval_long_steps() -> void:
	loaded_main_script_instance.currently_selected_time_warp_simulated_seconds_per_real_second = 100.0e-12
	var expected_interval: float = loaded_main_script_instance.compute_wall_clock_seconds_between_sample_playback_steps_for_current_time_warp()
	var sample_count := 10
	for one_sample_index in sample_count:
		push_fake_sample_into_queue(one_sample_index * 1.0e-12)
	for _one_step_index in sample_count:
		loaded_main_script_instance.step_sample_playback_queue_forward_if_wall_clock_interval_elapsed(expected_interval * 1.01)
	assert_eq(loaded_main_script_instance.queued_samples_awaiting_playback_to_wires.size(), 0,
			"%d step() calls with delta = 1.01 * interval should drain all %d queued samples." % [
				sample_count, sample_count])


# ---------- scaling-correctness tests ----------

func test_per_click_total_wall_time_scales_inversely_with_time_warp() -> void:
	# Per-click total wall time = (tran_stop / T). At a 10x slower T,
	# the SAME sim-time window plays back over 10x more wall seconds.
	# This is the most user-visible scaling relationship — the rest of
	# the math (timestep, interval, sample count) is downstream of it.
	var stop_seconds: float = loaded_main_script_instance.TIME_WARP_TRANSIENT_STOP_PER_EVENT_DRIVEN_SECONDS

	loaded_main_script_instance.currently_selected_time_warp_simulated_seconds_per_real_second = 100.0e-12
	var interval_at_100ps: float = loaded_main_script_instance.compute_wall_clock_seconds_between_sample_playback_steps_for_current_time_warp()
	var timestep_at_100ps: float = loaded_main_script_instance.compute_transient_timestep_seconds_for_current_time_warp()
	var samples_per_tran_at_100ps: float = stop_seconds / timestep_at_100ps
	var total_wall_seconds_at_100ps: float = samples_per_tran_at_100ps * interval_at_100ps

	loaded_main_script_instance.currently_selected_time_warp_simulated_seconds_per_real_second = 10.0e-12
	var interval_at_10ps: float = loaded_main_script_instance.compute_wall_clock_seconds_between_sample_playback_steps_for_current_time_warp()
	var timestep_at_10ps: float = loaded_main_script_instance.compute_transient_timestep_seconds_for_current_time_warp()
	var samples_per_tran_at_10ps: float = stop_seconds / timestep_at_10ps
	var total_wall_seconds_at_10ps: float = samples_per_tran_at_10ps * interval_at_10ps

	var ratio: float = total_wall_seconds_at_10ps / total_wall_seconds_at_100ps
	assert_almost_eq(ratio, 10.0, 0.01,
			("At 10x slower T, the per-click total wall time should be 10x larger. "
			+ "Got %s / %s = %s (expected ~10).") % [
				str(total_wall_seconds_at_10ps), str(total_wall_seconds_at_100ps), str(ratio)])


func test_per_click_total_wall_time_matches_the_math_total_wall_formula() -> void:
	# total wall = STOP / T. Verify directly across three orders of magnitude.
	var stop_seconds: float = loaded_main_script_instance.TIME_WARP_TRANSIENT_STOP_PER_EVENT_DRIVEN_SECONDS
	var time_warp_values_to_check := [1.0e-12, 1.0e-10, 1.0e-8]
	for one_time_warp_value in time_warp_values_to_check:
		loaded_main_script_instance.currently_selected_time_warp_simulated_seconds_per_real_second = one_time_warp_value
		var interval: float = loaded_main_script_instance.compute_wall_clock_seconds_between_sample_playback_steps_for_current_time_warp()
		var timestep: float = loaded_main_script_instance.compute_transient_timestep_seconds_for_current_time_warp()
		var samples_per_tran: float = stop_seconds / timestep
		var measured_total_wall: float = samples_per_tran * interval
		var expected_total_wall: float = stop_seconds / one_time_warp_value
		var relative_error: float = absf(measured_total_wall - expected_total_wall) / expected_total_wall
		assert_lt(relative_error, 0.001,
				("At T=%s sim-s/real-s the per-click wall time should be STOP/T=%s s, "
				+ "got %s s (relative error %s).") % [
					String.num_scientific(one_time_warp_value),
					String.num_scientific(expected_total_wall),
					String.num_scientific(measured_total_wall),
					str(relative_error),
				])


func test_per_sample_interval_is_capped_at_thirty_hz_when_T_is_below_tran_stop() -> void:
	# When T < STOP the formula `timestep = T/N` keeps `wall_per_sample = timestep/T`
	# at exactly 1/N regardless of T — that's how we keep the visual frame rate steady
	# at ~30 fps across the entire slow-mo range.
	var time_warp_values_below_stop := [1.0e-12, 5.0e-11, 1.0e-10, 2.0e-10]
	for one_time_warp_value in time_warp_values_below_stop:
		loaded_main_script_instance.currently_selected_time_warp_simulated_seconds_per_real_second = one_time_warp_value
		var interval: float = loaded_main_script_instance.compute_wall_clock_seconds_between_sample_playback_steps_for_current_time_warp()
		assert_almost_eq(interval, 1.0 / 30.0, 1.0e-6,
				"At T=%s sim-s/real-s (≤ STOP), the per-sample interval should be ~33 ms (30 Hz). Got %s s." % [
					String.num_scientific(one_time_warp_value),
					String.num_scientific(interval),
				])
