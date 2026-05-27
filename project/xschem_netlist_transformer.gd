extends RefCounted


const SKY130_PDK_TOP_LEVEL_LIB_SPICE_VIRTUAL_PATH_IN_WORKER := "/sky130A/libs.tech/combined/sky130.lib.spice"
const SKY130_PDK_LIB_CORNER_NAME := "tt"
const SKY130_FD_SC_HD_CONSOLIDATED_SPICE_VIRTUAL_PATH_IN_WORKER := "/sky130A/libs.ref/sky130_fd_sc_hd/spice/sky130_fd_sc_hd.spice"
const TESTBENCH_RAIL_VOLTAGE_DEFINITION_LINES := [
	"V_SPICE3D_TESTBENCH_VPWR VPWR 0 DC 1.8",
	"V_SPICE3D_TESTBENCH_VGND VGND 0 DC 0",
	"V_SPICE3D_TESTBENCH_VPB  VPB  0 DC 1.8",
	"V_SPICE3D_TESTBENCH_VNB  VNB  0 DC 0",
]
const POWER_RAIL_NAMES_NEVER_TREATED_AS_INTERNAL_NETS := {
	"vpwr": true, "vgnd": true, "vpb": true, "vnb": true,
	"0": true, "gnd": true, "vss": true, "vdd": true,
}


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


static func token_looks_like_a_net_name_candidate(one_token: String) -> bool:
	if one_token.is_empty():
		return false
	if one_token.contains("="):
		return false
	if one_token.begins_with("sky130_"):
		return false
	if one_token == "external":
		return false
	if one_token.is_valid_float():
		return false
	if POWER_RAIL_NAMES_NEVER_TREATED_AS_INTERNAL_NETS.has(one_token):
		return false
	return true


static func extract_internal_net_names_from_subckt_netlist(
		raw_xschem_netlist_lines: PackedStringArray) -> PackedStringArray:
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
			if not token_looks_like_a_net_name_candidate(one_token):
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
		raw_xschem_netlist_lines: PackedStringArray) -> PackedStringArray:
	var top_level_testbench_lines := PackedStringArray()
	top_level_testbench_lines.append(".lib %s %s" % [
			SKY130_PDK_TOP_LEVEL_LIB_SPICE_VIRTUAL_PATH_IN_WORKER,
			SKY130_PDK_LIB_CORNER_NAME])
	top_level_testbench_lines.append(".include %s"
			% SKY130_FD_SC_HD_CONSOLIDATED_SPICE_VIRTUAL_PATH_IN_WORKER)
	top_level_testbench_lines.append_array(
			PackedStringArray(TESTBENCH_RAIL_VOLTAGE_DEFINITION_LINES))
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
