extends RefCounted


const SKY130_NETLIST_SPEC := {
	"top_level_lib_spice_virtual_path_in_worker": "/sky130A/libs.tech/combined/sky130.lib.spice",
	"lib_corner_name": "tt",
	"extra_include_paths_to_prepend_before_dot_lib_directive": [],
	"extra_include_paths_to_append_after_dot_lib_directive": [
		"/sky130A/libs.ref/sky130_fd_sc_hd/spice/sky130_fd_sc_hd.spice",
	],
	"testbench_rail_voltage_definition_lines": [
		"V_SPICE3D_TESTBENCH_VPWR VPWR 0 DC 1.8",
		"V_SPICE3D_TESTBENCH_VGND VGND 0 DC 0",
		"V_SPICE3D_TESTBENCH_VPB  VPB  0 DC 1.8",
		"V_SPICE3D_TESTBENCH_VNB  VNB  0 DC 0",
	],
	"power_rail_names_never_treated_as_internal_nets": {
		"vpwr": true, "vgnd": true, "vpb": true, "vnb": true,
		"0": true, "gnd": true, "vss": true, "vdd": true,
	},
	"token_prefixes_that_denote_a_model_or_subckt_name_not_an_internal_net": [
		"sky130_",
	],
	"vdd_volts_for_external_voltage_source_high_level": 1.8,
}

const GF180MCU_NETLIST_SPEC := {
	"top_level_lib_spice_virtual_path_in_worker": "/gf180mcuD/libs.tech/ngspice/sm141064.spice",
	"lib_corner_name": "typical",
	"extra_include_paths_to_prepend_before_dot_lib_directive": [
		"/gf180mcuD/libs.tech/ngspice/design.spice",
	],
	"extra_include_paths_to_append_after_dot_lib_directive": [],
	"testbench_rail_voltage_definition_lines": [
		"V_SPICE3D_TESTBENCH_VDD VDD 0 DC 5.0",
		"V_SPICE3D_TESTBENCH_VSS VSS 0 DC 0",
		"V_SPICE3D_TESTBENCH_VNW VNW 0 DC 5.0",
		"V_SPICE3D_TESTBENCH_VPW VPW 0 DC 0",
	],
	"power_rail_names_never_treated_as_internal_nets": {
		"vdd": true, "vss": true, "vnw": true, "vpw": true,
		"0": true, "gnd": true,
	},
	"token_prefixes_that_denote_a_model_or_subckt_name_not_an_internal_net": [
		"gf180mcu_",
		"nfet_",
		"pfet_",
	],
	"vdd_volts_for_external_voltage_source_high_level": 5.0,
}

const PDK_NETLIST_SPECS_BY_FAMILY_NAME := {
	"sky130": SKY130_NETLIST_SPEC,
	"gf180mcu": GF180MCU_NETLIST_SPEC,
}


static func netlist_spec_for(pdk_family_name: String) -> Dictionary:
	if not PDK_NETLIST_SPECS_BY_FAMILY_NAME.has(pdk_family_name):
		push_error("unknown PDK family '%s' for netlist spec — known families: %s" % [
				pdk_family_name, str(PDK_NETLIST_SPECS_BY_FAMILY_NAME.keys())])
		return SKY130_NETLIST_SPEC
	return PDK_NETLIST_SPECS_BY_FAMILY_NAME[pdk_family_name]


static func strip_xschem_escape_backslashes_from_subckt_names(spice_netlist_line: String) -> String:
	if spice_netlist_line.find("\\") == -1: return spice_netlist_line
	var output_characters := PackedStringArray()
	var i := 0
	while i < spice_netlist_line.length():
		var one_character := spice_netlist_line[i]
		if one_character == "\\" and i + 1 < spice_netlist_line.length():
			output_characters.append(spice_netlist_line[i + 1])
			i += 2
		else:
			output_characters.append(one_character)
			i += 1
	return "".join(output_characters)


static func is_subckt_wrapper_directive(spice_netlist_line: String) -> bool:
	var stripped_line := spice_netlist_line.strip_edges()
	if stripped_line.is_empty(): return false
	if stripped_line.begins_with(".subckt"): return true
	if stripped_line == ".ends" or stripped_line.begins_with(".ends "): return true
	return false


static func looks_like_xschem_component_instance_line(stripped_lowercase_line: String) -> bool:
	if stripped_lowercase_line.is_empty():
		return false
	var first_character := stripped_lowercase_line.unicode_at(0)
	return first_character in [
		"v".unicode_at(0), "x".unicode_at(0), "m".unicode_at(0),
		"r".unicode_at(0), "c".unicode_at(0), "l".unicode_at(0),
		"i".unicode_at(0), "d".unicode_at(0), "q".unicode_at(0),
	]


static func token_looks_like_a_net_name_candidate(
		one_token: String,
		power_rail_names_never_treated_as_internal_nets: Dictionary,
		model_or_subckt_name_prefixes: Array) -> bool:
	if one_token.is_empty():
		return false
	if one_token.contains("="):
		return false
	for one_model_or_subckt_name_prefix in model_or_subckt_name_prefixes:
		if one_token.begins_with(one_model_or_subckt_name_prefix):
			return false
	if one_token == "external":
		return false
	if one_token.is_valid_float():
		return false
	if power_rail_names_never_treated_as_internal_nets.has(one_token):
		return false
	return true


static func extract_internal_net_names_from_subckt_netlist(
		raw_xschem_netlist_lines: PackedStringArray,
		pdk_family_name: String) -> PackedStringArray:
	var spec := netlist_spec_for(pdk_family_name)
	var power_rail_names: Dictionary = spec["power_rail_names_never_treated_as_internal_nets"]
	var model_or_subckt_name_prefixes: Array = spec["token_prefixes_that_denote_a_model_or_subckt_name_not_an_internal_net"]
	var distinct_net_names_seen_so_far := {}
	var ordered_internal_net_names := PackedStringArray()
	for one_xschem_line in raw_xschem_netlist_lines:
		var stripped_lowercase_line := one_xschem_line.strip_edges().to_lower()
		if not looks_like_xschem_component_instance_line(stripped_lowercase_line):
			continue
		var tokens_on_this_line := stripped_lowercase_line.split(" ", false)
		if tokens_on_this_line.size() <= 1:
			continue
		for one_token_index in range(1, tokens_on_this_line.size()):
			var one_token: String = tokens_on_this_line[one_token_index]
			if not token_looks_like_a_net_name_candidate(
					one_token, power_rail_names, model_or_subckt_name_prefixes):
				continue
			if distinct_net_names_seen_so_far.has(one_token):
				continue
			distinct_net_names_seen_so_far[one_token] = true
			ordered_internal_net_names.append(one_token)
	return ordered_internal_net_names


static func strip_empty_parameter_assignments_from_one_spice_line(spice_line: String) -> String:
	var output_tokens := PackedStringArray()
	for one_token in spice_line.split(" ", false):
		if one_token.ends_with("="):
			continue
		output_tokens.append(one_token)
	if output_tokens.size() == 1 and output_tokens[0] == "+":
		return ""
	return " ".join(output_tokens)


static func convert_subckt_netlist_to_top_level_testbench(
		raw_xschem_netlist_lines: PackedStringArray,
		pdk_family_name: String) -> PackedStringArray:
	var spec := netlist_spec_for(pdk_family_name)
	var top_level_testbench_lines := PackedStringArray()
	for one_include_path_before_lib in spec["extra_include_paths_to_prepend_before_dot_lib_directive"]:
		top_level_testbench_lines.append(".include %s" % one_include_path_before_lib)
	top_level_testbench_lines.append(".lib %s %s" % [
			spec["top_level_lib_spice_virtual_path_in_worker"],
			spec["lib_corner_name"]])
	for one_include_path_after_lib in spec["extra_include_paths_to_append_after_dot_lib_directive"]:
		top_level_testbench_lines.append(".include %s" % one_include_path_after_lib)
	top_level_testbench_lines.append_array(
			PackedStringArray(spec["testbench_rail_voltage_definition_lines"]))
	var raw_xschem_netlist_contained_a_dot_end_directive := false
	for one_existing_line in raw_xschem_netlist_lines:
		if is_subckt_wrapper_directive(one_existing_line):
			continue
		if one_existing_line.strip_edges() == ".end":
			raw_xschem_netlist_contained_a_dot_end_directive = true
			continue
		var without_empty_param_assignments := strip_empty_parameter_assignments_from_one_spice_line(one_existing_line)
		if without_empty_param_assignments.is_empty():
			continue
		var without_escape_backslashes := strip_xschem_escape_backslashes_from_subckt_names(without_empty_param_assignments)
		top_level_testbench_lines.append(without_escape_backslashes)
	if raw_xschem_netlist_contained_a_dot_end_directive:
		top_level_testbench_lines.append(".end")
	return top_level_testbench_lines
