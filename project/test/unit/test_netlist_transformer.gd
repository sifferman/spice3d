extends GutTest

const XschemNetlistTransformer = preload("res://xschem_netlist_transformer.gd")


var loaded_main_script_instance: Node = null


func before_each() -> void:
	var main_script: Script = load("res://main.gd")
	loaded_main_script_instance = main_script.new()


func after_each() -> void:
	if loaded_main_script_instance != null:
		loaded_main_script_instance.free()
		loaded_main_script_instance = null


func test_external_voltage_source_keyword_passes_through_to_ngspice_unchanged() -> void:
	# xschem emits "Vname n1 n2 external" for externally-controlled sources.
	# ngspice's shared-library mode (--with-ngshared, SHARED_MODULE) implements
	# `external` natively: at every solver step the GetVSRCData callback
	# registered via ngSpice_Init_Sync gets queried for the current value.
	# So the testbench must keep `external` verbatim — no substitution.
	var raw_xschem_emission := PackedStringArray([
		"** sch_path: /tmp/button_test.sch",
		".subckt button_test btn_out_n",
		"VBUTTON1 net1 VGND external",
		".ends",
	])
	var converted_lines: PackedStringArray = XschemNetlistTransformer.convert_subckt_netlist_to_top_level_testbench(
			raw_xschem_emission)
	var single_blob_for_inspection := "\n".join(converted_lines)
	assert_true(single_blob_for_inspection.contains("VBUTTON1 net1 VGND external"),
			"`external` is a real ngspice source type under --with-ngshared; "
			+ "the xschem line must survive into the testbench verbatim.")


func test_strip_xschem_escape_backslashes_removes_backslash_before_underscored_number() -> void:
	var cleaned: String = XschemNetlistTransformer.strip_xschem_escape_backslashes_from_subckt_names(
			"x1 net1 VGND VNB VPB VPWR btn_out_n sky130_fd_sc_hd__\\inv_1")
	assert_eq(cleaned,
			"x1 net1 VGND VNB VPB VPWR btn_out_n sky130_fd_sc_hd__inv_1",
			"xschem emits a literal '\\' before underscored cell suffixes; ngspice can't parse it.")


func test_strip_xschem_escape_backslashes_is_idempotent_on_clean_input() -> void:
	var already_clean := "Xinv a b c d e f sky130_fd_sc_hd__inv_1"
	var passed_through: String = XschemNetlistTransformer.strip_xschem_escape_backslashes_from_subckt_names(
			already_clean)
	assert_eq(passed_through, already_clean,
			"Lines without backslashes should pass through unchanged.")


func test_is_subckt_wrapper_directive_identifies_wrapper_lines() -> void:
	assert_true(XschemNetlistTransformer.is_subckt_wrapper_directive(".subckt button_test btn_out_n"))
	assert_true(XschemNetlistTransformer.is_subckt_wrapper_directive(".ends"))
	assert_true(XschemNetlistTransformer.is_subckt_wrapper_directive(".ends button_test"))
	assert_false(XschemNetlistTransformer.is_subckt_wrapper_directive("VBUTTON1 net1 VGND"))
	assert_false(XschemNetlistTransformer.is_subckt_wrapper_directive("*.PININFO btn_out_n:O"))


func test_subckt_to_testbench_conversion_preserves_external_strips_subckt_wrapper_and_unescapes_subckt_names() -> void:
	var raw_xschem_emission := PackedStringArray([
		"** sch_path: /tmp/button_test.sch",
		".subckt button_test btn_out_n",
		"*.PININFO btn_out_n:O",
		"VBUTTON1 net1 VGND external",
		"x1 net1 VGND VNB VPB VPWR btn_out_n sky130_fd_sc_hd__\\inv_1",
		".ends",
		".end",
	])
	var converted_lines: PackedStringArray = XschemNetlistTransformer.convert_subckt_netlist_to_top_level_testbench(
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
	assert_true(single_blob_for_inspection.contains(" external"),
			"xschem's 'external' keyword must pass through to ngspice — "
			+ "ngspice's shared-library mode handles it via the GetVSRCData callback.")
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
	assert_false(single_blob_for_inspection.contains("C_SPICE3D_FO4_LOAD_"),
			"FO4 load capacitors must NOT be injected on output nets — they distort timing "
			+ "for ring-oscillator-style circuits where adjacent stage gate-caps already "
			+ "provide the natural load.")
	# `.end` must survive in the testbench (ngspice needs it to finalize the
	# netlist as a runnable circuit). Catching `.end` stripping caught a real
	# bug this session: dropping it produces "no circuit loaded".
	var dot_end_position_in_testbench := -1
	for one_line_index in converted_lines.size():
		if converted_lines[one_line_index].strip_edges() == ".end":
			dot_end_position_in_testbench = one_line_index
	assert_true(dot_end_position_in_testbench >= 0,
			"`.end` directive must survive into the converted testbench — ngspice needs "
			+ "it to finalize the netlist before `run`; stripping it produces 'no circuit loaded'.")
