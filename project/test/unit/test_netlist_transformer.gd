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
			raw_xschem_emission, "sky130", "")
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


func test_is_subckt_open_close_directive_identifies_wrapper_lines() -> void:
	assert_true(XschemNetlistTransformer.is_subckt_open_directive(".subckt button_test btn_out_n"))
	assert_false(XschemNetlistTransformer.is_subckt_open_directive(".ends"))
	assert_true(XschemNetlistTransformer.is_subckt_close_directive(".ends"))
	assert_true(XschemNetlistTransformer.is_subckt_close_directive(".ends button_test"))
	assert_false(XschemNetlistTransformer.is_subckt_close_directive(".subckt foo"))
	assert_false(XschemNetlistTransformer.is_subckt_open_directive("VBUTTON1 net1 VGND"))
	assert_false(XschemNetlistTransformer.is_subckt_close_directive("VBUTTON1 net1 VGND"))
	assert_false(XschemNetlistTransformer.is_subckt_open_directive("*.PININFO btn_out_n:O"))


func test_only_outermost_subckt_wrapper_is_stripped_inner_subckts_survive() -> void:
	# 3bit_counter_busses-style: outer .subckt holds the testbench-bound
	# instances; an inner .subckt definition (3bit_incrementor) sits AFTER
	# the outer .ends and must survive intact so ngspice can resolve the
	# x4 reference back to the inner cell.
	var raw_xschem_emission := PackedStringArray([
		".subckt outer_cell out",
		"x_top a b sky130_fd_sc_hd__inv_1",
		".ends",
		".subckt inner_cell IN OUT",
		"xa IN net1 sky130_fd_sc_hd__inv_1",
		"xb net1 OUT sky130_fd_sc_hd__inv_1",
		".ends",
	])
	var converted_lines: PackedStringArray = XschemNetlistTransformer.convert_subckt_netlist_to_top_level_testbench(
			raw_xschem_emission, "sky130", "")
	var single_blob := "\n".join(converted_lines)
	assert_false(single_blob.contains(".subckt outer_cell"),
			"The outer .subckt wrapper must be stripped so the testbench is top-level.")
	assert_true(single_blob.contains(".subckt inner_cell"),
			"The inner .subckt definition must survive — ngspice needs it to resolve "
			+ "x-calls into the inner cell.")
	# the inner .ends should also remain
	var inner_ends_occurrences := 0
	for one_line in converted_lines:
		if one_line.strip_edges() == ".ends":
			inner_ends_occurrences += 1
	assert_eq(inner_ends_occurrences, 1,
			"Exactly one .ends should remain (the inner cell's closing directive); "
			+ "the outer wrapper's .ends was stripped along with its .subckt header.")


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
			raw_xschem_emission, "sky130", "")
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


func test_gf180mcu_spec_produces_5v_rails_and_correct_lib_path() -> void:
	var raw_xschem_emission := PackedStringArray([
		".subckt example_top out",
		"VBUTTON1 net1 VSS external",
		".ends",
		".end",
	])
	var converted_lines: PackedStringArray = XschemNetlistTransformer.convert_subckt_netlist_to_top_level_testbench(
			raw_xschem_emission, "gf180mcu", "")
	var single_blob_for_inspection := "\n".join(converted_lines)
	assert_true(single_blob_for_inspection.contains(".lib /gf180mcuD/libs.tech/ngspice/sm141064.spice typical"),
			"gf180mcu testbench must reference the gf180mcuD ngspice/sm141064.spice .lib at the typical corner.")
	assert_true(single_blob_for_inspection.contains("V_SPICE3D_TESTBENCH_VDD VDD 0 DC 5.0"),
			"gf180mcu mcu7t5v0 cells are 5V parts — the testbench must drive VDD to 5.0 V.")
	assert_false(single_blob_for_inspection.contains(".include /sky130A/"),
			"gf180mcu testbench must not include any sky130 paths.")


func test_gf180mcu_internal_net_extraction_treats_vdd_and_vss_as_rails_not_internal() -> void:
	var raw_xschem_emission := PackedStringArray([
		".subckt example_top out",
		"x1 net1 VDD VSS gf180mcu_fd_sc_mcu7t5v0__inv_1",
		".ends",
	])
	var internal_nets: PackedStringArray = XschemNetlistTransformer.extract_internal_net_names_from_subckt_netlist(
			raw_xschem_emission, "gf180mcu")
	assert_true(internal_nets.has("net1"),
			"net1 is a real internal net and should be returned.")
	assert_false(internal_nets.has("vdd"),
			"VDD is a power rail under the gf180mcu spec and must not be treated as internal.")
	assert_false(internal_nets.has("vss"),
			"VSS is a power rail under the gf180mcu spec and must not be treated as internal.")
	assert_false(internal_nets.has("gf180mcu_fd_sc_mcu7t5v0__inv_1"),
			"PDK cell references must not be treated as internal nets.")


func test_gf180mcu_internal_net_extraction_excludes_nfet_and_pfet_subckt_model_names() -> void:
	var raw_xschem_emission := PackedStringArray([
		".subckt example_top out",
		"X_i_1 net1 A2 VSS VPW nfet_05v0 L=6e-07 W=8.2e-07",
		"X_i_3 ZN A2 VDD VNW pfet_05v0 L=5e-07 W=1.13e-06",
		".ends",
	])
	var internal_nets: PackedStringArray = XschemNetlistTransformer.extract_internal_net_names_from_subckt_netlist(
			raw_xschem_emission, "gf180mcu")
	assert_true(internal_nets.has("net1"),
			"net1 is a real internal net and should be returned.")
	assert_true(internal_nets.has("a2"),
			"A2 is a real internal net (input wire) and should be returned.")
	assert_true(internal_nets.has("zn"),
			"ZN is a real internal net (output wire) and should be returned.")
	assert_false(internal_nets.has("nfet_05v0"),
			"nfet_05v0 is the subckt/model name (last positional token before params), "
			+ "not a net — the nfet_ prefix in the gf180mcu spec must exclude it. "
			+ "Otherwise it leaks into the seed-IC pass as a phantom .ic v(nfet_05v0)=...")
	assert_false(internal_nets.has("pfet_05v0"),
			"pfet_05v0 is the subckt name, not a net — pfet_ prefix in the gf180mcu spec must exclude it.")


func test_additional_subckt_definition_lines_get_injected_after_testbench_rails_and_before_xschem_output() -> void:
	var raw_xschem_emission := PackedStringArray([
		"** sch_path: /tmp/verilog_and_or_testbench.sch",
		".subckt verilog_and_or_testbench",
		"x1 a b c y VGND VNB VPB VPWR verilog_and_or",
		".ends",
	])
	var injected_subckt_definition_lines := PackedStringArray([
		"* SPICE subckt synthesized from verilog_and_or by yosys",
		".subckt verilog_and_or a b c y VGND VNB VPB VPWR",
		"X0 a b c VGND VNB VPB VPWR y sky130_fd_sc_hd__a21o_1",
		".ends verilog_and_or",
	])
	var converted_lines: PackedStringArray = XschemNetlistTransformer.convert_subckt_netlist_to_top_level_testbench(
			raw_xschem_emission, "sky130", "", injected_subckt_definition_lines)
	var single_blob_for_inspection := "\n".join(converted_lines)
	var injected_subckt_definition_position := single_blob_for_inspection.find(
			".subckt verilog_and_or a b c y VGND VNB VPB VPWR")
	var testbench_rail_voltage_definition_position := single_blob_for_inspection.find(
			"V_SPICE3D_TESTBENCH_VPWR")
	var xline_referencing_synthesized_subckt_position := single_blob_for_inspection.find(
			"x1 a b c y VGND VNB VPB VPWR verilog_and_or")
	assert_ne(injected_subckt_definition_position, -1,
			"Synthesized .subckt block must appear in the assembled deck.")
	assert_ne(testbench_rail_voltage_definition_position, -1,
			"Testbench rail V-sources must appear in the assembled deck.")
	assert_ne(xline_referencing_synthesized_subckt_position, -1,
			"X-line referencing the synthesized subckt must appear in the deck.")
	assert_gt(injected_subckt_definition_position, testbench_rail_voltage_definition_position,
			"Synthesized .subckt block must come AFTER testbench rails so VPWR/VGND nets are in scope.")
	assert_lt(injected_subckt_definition_position, xline_referencing_synthesized_subckt_position,
			"Synthesized .subckt block must come BEFORE the X-line that references it so ngspice resolves the name.")


func test_omitting_additional_subckt_definition_lines_preserves_previous_behavior() -> void:
	var raw_xschem_emission := PackedStringArray([
		"** sch_path: /tmp/button_test.sch",
		".subckt button_test btn_out_n",
		"VBUTTON1 net1 VGND external",
		".ends",
	])
	var without_explicit_empty_array: PackedStringArray = XschemNetlistTransformer.convert_subckt_netlist_to_top_level_testbench(
			raw_xschem_emission, "sky130", "")
	var with_explicit_empty_array: PackedStringArray = XschemNetlistTransformer.convert_subckt_netlist_to_top_level_testbench(
			raw_xschem_emission, "sky130", "", PackedStringArray())
	assert_eq(without_explicit_empty_array, with_explicit_empty_array,
			"Default-arg form must produce identical output to explicit-empty-PackedStringArray form.")
