extends GutTest


var loaded_main_script_instance: Node = null


func before_each() -> void:
	var main_script: Script = load("res://main.gd")
	loaded_main_script_instance = main_script.new()


func after_each() -> void:
	if loaded_main_script_instance != null:
		loaded_main_script_instance.free()
		loaded_main_script_instance = null


func test_strip_xschem_external_voltage_source_keyword_removes_trailing_external() -> void:
	var stripped: String = loaded_main_script_instance.strip_xschem_external_voltage_source_keyword(
			"VBUTTON1 net1 VGND external")
	assert_eq(stripped, "VBUTTON1 net1 VGND",
			"Trailing ' external' should be stripped from xschem voltage source emission.")


func test_strip_xschem_external_voltage_source_keyword_leaves_other_lines_alone() -> void:
	var unchanged: String = loaded_main_script_instance.strip_xschem_external_voltage_source_keyword(
			"V1 in 0 DC 1.8")
	assert_eq(unchanged, "V1 in 0 DC 1.8",
			"Lines without trailing 'external' should pass through unchanged.")


func test_strip_xschem_escape_backslashes_removes_backslash_before_underscored_number() -> void:
	var cleaned: String = loaded_main_script_instance.strip_xschem_escape_backslashes_from_subckt_names(
			"x1 net1 VGND VNB VPB VPWR btn_out_n sky130_fd_sc_hd__\\inv_1")
	assert_eq(cleaned,
			"x1 net1 VGND VNB VPB VPWR btn_out_n sky130_fd_sc_hd__inv_1",
			"xschem emits a literal '\\' before underscored cell suffixes; ngspice can't parse it.")


func test_strip_xschem_escape_backslashes_is_idempotent_on_clean_input() -> void:
	var already_clean := "Xinv a b c d e f sky130_fd_sc_hd__inv_1"
	var passed_through: String = loaded_main_script_instance.strip_xschem_escape_backslashes_from_subckt_names(
			already_clean)
	assert_eq(passed_through, already_clean,
			"Lines without backslashes should pass through unchanged.")


func test_is_subckt_wrapper_directive_identifies_wrapper_lines() -> void:
	assert_true(loaded_main_script_instance.is_subckt_wrapper_directive(".subckt button_test btn_out_n"))
	assert_true(loaded_main_script_instance.is_subckt_wrapper_directive(".ends"))
	assert_true(loaded_main_script_instance.is_subckt_wrapper_directive(".ends button_test"))
	assert_false(loaded_main_script_instance.is_subckt_wrapper_directive("VBUTTON1 net1 VGND"))
	assert_false(loaded_main_script_instance.is_subckt_wrapper_directive("*.PININFO btn_out_n:O"))


func test_subckt_to_testbench_conversion_strips_all_three_xschem_artifacts() -> void:
	var raw_xschem_emission := PackedStringArray([
		"** sch_path: /tmp/button_test.sch",
		".subckt button_test btn_out_n",
		"*.PININFO btn_out_n:O",
		"VBUTTON1 net1 VGND external",
		"x1 net1 VGND VNB VPB VPWR btn_out_n sky130_fd_sc_hd__\\inv_1",
		".ends",
		".end",
	])
	var converted_lines: PackedStringArray = loaded_main_script_instance.convert_xschem_subckt_netlist_into_top_level_testbench(
			raw_xschem_emission)
	var single_blob_for_inspection := "\n".join(converted_lines)
	assert_false(single_blob_for_inspection.contains(".subckt button_test"),
			"`.subckt button_test` wrapper header must be removed — ngspice needs a top-level testbench.")
	var ends_directive_occurrence_count := 0
	for one_line in converted_lines:
		if one_line.strip_edges() == ".ends" or one_line.strip_edges().begins_with(".ends "):
			ends_directive_occurrence_count += 1
	assert_eq(ends_directive_occurrence_count, 0,
			"No `.ends` should survive — the xschem button_test wrapper's `.ends` must be stripped, "
			+ "and stdcell subckts come from the '.include'd PDK file at simulation time.")
	assert_false(single_blob_for_inspection.contains(" external"),
			"xschem's 'external' keyword must be stripped (ngspice rejects it).")
	assert_false(single_blob_for_inspection.contains("\\"),
			"xschem's '\\inv_1' escape must be stripped (subckt name otherwise won't match).")
	assert_true(single_blob_for_inspection.contains(".lib"),
			"PDK '.lib' directive must be prepended to the testbench.")
	assert_true(single_blob_for_inspection.contains(
					".include /sky130A/libs.ref/sky130_fd_sc_hd/spice/sky130_fd_sc_hd.spice"),
			"Consolidated sky130_fd_sc_hd.spice must be '.include'd "
			+ "(streaming extractor now pulls it from sky130_fd_sc_hd.tar.zst).")
	assert_true(single_blob_for_inspection.contains("VPWR"),
			"Rail definition for VPWR must be present in the testbench.")
