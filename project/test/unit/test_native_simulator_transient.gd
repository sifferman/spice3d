extends GutTest


var spice3d_node_under_test: Node = null


func before_each() -> void:
	spice3d_node_under_test = ClassDB.instantiate("Spice3DNode")
	add_child_autofree(spice3d_node_under_test)


func test_resolve_simulator_include_path_returns_globalized_user_path_on_native() -> void:
	if spice3d_node_under_test.is_running_on_web_platform():
		gut.p("skipped on web — this test is for the native filesystem mapping")
		assert_true(true)
		return
	var resolved_path: String = spice3d_node_under_test \
			.resolve_simulator_include_path_for_persistent_resource("sky130/example_version")
	var globalize_baseline: String = ProjectSettings.globalize_path("user://sky130/example_version")
	assert_eq(resolved_path, globalize_baseline,
			"On native, the simulator should consume ngspice .include paths via "
			+ "ProjectSettings.globalize_path of the user:// resource so libngspice can "
			+ "read the staged PDK from disk directly.")


func test_simple_rc_transient_produces_at_least_one_sample_within_three_seconds_on_native() -> void:
	if spice3d_node_under_test.is_running_on_web_platform():
		gut.p("skipped on web — RC transient regression test runs against libngspice")
		assert_true(true)
		return
	var rc_charging_netlist := PackedStringArray([
		"* simple RC charging — regression that native libngspice produces samples",
		"V1 in 0 DC 1.0",
		"R1 in out 1k",
		"C1 out 0 1u",
		".end",
	])
	var transient_started: bool = spice3d_node_under_test \
			.start_transient_analysis_with_netlist_and_seed_ic_nets(
					rc_charging_netlist, 1e-5, PackedStringArray())
	assert_true(transient_started,
			"start_transient_analysis_with_netlist_and_seed_ic_nets must succeed for a "
			+ "well-formed RC deck; failure here means libngspice rejected the netlist.")
	var deadline_ticks_msec: int = Time.get_ticks_msec() + 3000
	var collected_samples: Array = []
	while Time.get_ticks_msec() < deadline_ticks_msec:
		var newly_drained_samples: Array = spice3d_node_under_test \
				.drain_buffered_simulation_samples_as_godot_array()
		collected_samples.append_array(newly_drained_samples)
		if collected_samples.size() > 0:
			break
		await get_tree().create_timer(0.05).timeout
	spice3d_node_under_test.stop_simulation()
	assert_gt(collected_samples.size(), 0,
			"libngspice background transient must deliver at least one sample within "
			+ "three seconds for a trivial RC charging deck. Zero samples means either "
			+ "bg_tran silently failed, send_data callback wasn't wired, or the simulator "
			+ "thread never started.")
