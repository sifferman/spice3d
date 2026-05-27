extends GutTest


# Integration test for main.gd's sample-playback pacing. The unit tests
# in test_time_warp_math_and_parser.gd validate the timestep + interval
# *formulas* in isolation. This file validates that
# step_sample_playback_queue_forward_if_wall_clock_interval_elapsed_and_return_count
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
	var expected_interval: float = loaded_main_script_instance.WALL_CLOCK_SECONDS_BETWEEN_PLAYBACK_STEPS
	push_fake_sample_into_queue(0.0)
	push_fake_sample_into_queue(1.0e-12)
	loaded_main_script_instance.step_sample_playback_queue_forward_if_wall_clock_interval_elapsed_and_return_count(expected_interval * 0.5)
	assert_eq(loaded_main_script_instance.queued_samples_awaiting_playback_to_wires.size(), 2,
			"step() must not drain a sample when accumulated delta is below the per-sample interval.")


func test_playback_step_drains_one_sample_when_accumulated_delta_crosses_interval() -> void:
	loaded_main_script_instance.currently_selected_time_warp_simulated_seconds_per_real_second = 100.0e-12
	var expected_interval: float = loaded_main_script_instance.WALL_CLOCK_SECONDS_BETWEEN_PLAYBACK_STEPS
	push_fake_sample_into_queue(0.0)
	push_fake_sample_into_queue(1.0e-12)
	loaded_main_script_instance.step_sample_playback_queue_forward_if_wall_clock_interval_elapsed_and_return_count(expected_interval * 1.01)
	assert_eq(loaded_main_script_instance.queued_samples_awaiting_playback_to_wires.size(), 1,
			"step() must drain exactly one sample when accumulated delta crosses the per-sample interval.")


# ---------- multi-step pacing tests ----------

func test_playback_drains_all_samples_after_n_interval_long_steps() -> void:
	loaded_main_script_instance.currently_selected_time_warp_simulated_seconds_per_real_second = 100.0e-12
	var expected_interval: float = loaded_main_script_instance.WALL_CLOCK_SECONDS_BETWEEN_PLAYBACK_STEPS
	var sample_count := 10
	for one_sample_index in sample_count:
		push_fake_sample_into_queue(one_sample_index * 1.0e-12)
	for _one_step_index in sample_count:
		loaded_main_script_instance.step_sample_playback_queue_forward_if_wall_clock_interval_elapsed_and_return_count(expected_interval * 1.01)
	assert_eq(loaded_main_script_instance.queued_samples_awaiting_playback_to_wires.size(), 0,
			"%d step() calls with delta = 1.01 * interval should drain all %d queued samples." % [
				sample_count, sample_count])


# ---------- scaling-correctness tests ----------

func test_per_sample_wall_interval_is_thirtieth_of_a_second_for_every_supported_time_warp() -> void:
	var time_warp_values_to_check := [1.0e-12, 5.0e-11, 1.0e-10, 1.0e-9, 1.0e-7, 1.0e-6]
	for one_time_warp_value in time_warp_values_to_check:
		loaded_main_script_instance.currently_selected_time_warp_simulated_seconds_per_real_second = one_time_warp_value
		var interval: float = loaded_main_script_instance.WALL_CLOCK_SECONDS_BETWEEN_PLAYBACK_STEPS
		assert_almost_eq(interval, 1.0 / 30.0, 1.0e-9,
				"Per-sample wall interval must stay at 1/30s regardless of T. Got %ss at T=%s." % [
					str(interval), str(one_time_warp_value)])
