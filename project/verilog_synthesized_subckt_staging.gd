extends RefCounted


const VERILOG_MODULE_SOURCE_FILE_NAMES_TO_SYNTHESIZE_INTO_SUBCKT_METADATA_KEY := \
		"verilog_module_source_file_names_to_synthesize_into_subckt"
const SECONDS_BETWEEN_BROWSER_YOSYS_SYNTH_RESULT_POLLS := 0.1
const SECONDS_BEFORE_GIVING_UP_ON_BROWSER_YOSYS_SYNTH_RESULT := 90.0


static func verilog_modules_to_synthesize_for_example(
		active_example_metadata: Dictionary) -> Array:
	if not active_example_metadata.has(VERILOG_MODULE_SOURCE_FILE_NAMES_TO_SYNTHESIZE_INTO_SUBCKT_METADATA_KEY):
		return []
	var declared_modules: Variant = active_example_metadata[
			VERILOG_MODULE_SOURCE_FILE_NAMES_TO_SYNTHESIZE_INTO_SUBCKT_METADATA_KEY]
	if not (declared_modules is Array):
		return []
	return declared_modules


static func synthesize_all_verilog_modules_for_active_example_via_browser_yosys(
		host_node_used_for_polling_timer: Node,
		active_example_staged_directory_absolute_path: String,
		verilog_modules_to_synthesize: Array,
		stdcell_subckt_spice_absolute_path: String,
		stdcell_timing_liberty_absolute_path: String,
		stdcell_power_rail_net_names_in_subckt_port_order: PackedStringArray
		) -> PackedStringArray:
	var concatenated_synthesized_subckt_definition_lines := PackedStringArray()
	if verilog_modules_to_synthesize.is_empty():
		return concatenated_synthesized_subckt_definition_lines
	if not OS.has_feature("web"):
		push_error("[spice3d] browser-side yosys synth is only available on the web export"
				+ " — skipping " + str(verilog_modules_to_synthesize.size()) + " verilog module(s)")
		return concatenated_synthesized_subckt_definition_lines
	var stdcell_subckt_spice_text := read_entire_text_file_or_empty_with_error_log(
			stdcell_subckt_spice_absolute_path,
			"PDK stdcell .subckt .spice file (needed by browser yosys to build spice-port-order blackbox)")
	var stdcell_timing_liberty_text := read_entire_text_file_or_empty_with_error_log(
			stdcell_timing_liberty_absolute_path,
			"PDK stdcell Liberty timing file (needed by browser yosys for dfflibmap + abc -liberty)")
	if stdcell_subckt_spice_text.is_empty() or stdcell_timing_liberty_text.is_empty():
		return concatenated_synthesized_subckt_definition_lines
	var pdk_rail_names_in_subckt_order_as_json := JSON.stringify(
			Array(stdcell_power_rail_net_names_in_subckt_port_order))
	for one_module_to_synthesize in verilog_modules_to_synthesize:
		if not (one_module_to_synthesize is Dictionary):
			push_error("[spice3d] verilog module entry must be a Dictionary, got " + str(typeof(one_module_to_synthesize)))
			continue
		var verilog_source_file_name: String = one_module_to_synthesize.get("verilog_source_file_name", "")
		var top_module_name: String = one_module_to_synthesize.get("top_module_name", "")
		if verilog_source_file_name.is_empty() or top_module_name.is_empty():
			push_error("[spice3d] verilog module entry missing verilog_source_file_name or top_module_name: "
					+ str(one_module_to_synthesize))
			continue
		var verilog_source_absolute_path := "%s/%s" % [
				active_example_staged_directory_absolute_path, verilog_source_file_name]
		var verilog_source_text := read_entire_text_file_or_empty_with_error_log(
				verilog_source_absolute_path,
				"verilog module source for synth")
		if verilog_source_text.is_empty():
			continue
		print("[spice3d] synthesizing verilog module '%s' from %s via browser YoWASP yosys..." % [
				top_module_name, verilog_source_file_name])
		var synthesized_subckt_text := await synthesize_one_verilog_module_via_browser_yosys_and_wait_for_result(
				host_node_used_for_polling_timer,
				verilog_source_text,
				top_module_name,
				stdcell_subckt_spice_text,
				stdcell_timing_liberty_text,
				pdk_rail_names_in_subckt_order_as_json)
		if synthesized_subckt_text.is_empty():
			continue
		for one_synthesized_line in synthesized_subckt_text.split("\n", false):
			concatenated_synthesized_subckt_definition_lines.append(String(one_synthesized_line))
	return concatenated_synthesized_subckt_definition_lines


static func read_entire_text_file_or_empty_with_error_log(
		absolute_path: String, what_the_file_is_for_human_description: String) -> String:
	if absolute_path.is_empty():
		push_error("[spice3d] %s: no path configured" % what_the_file_is_for_human_description)
		return ""
	var file_handle := FileAccess.open(absolute_path, FileAccess.READ)
	if file_handle == null:
		push_error("[spice3d] %s: cannot open '%s'" % [what_the_file_is_for_human_description, absolute_path])
		return ""
	var file_text := file_handle.get_as_text()
	file_handle.close()
	return file_text


static func synthesize_one_verilog_module_via_browser_yosys_and_wait_for_result(
		host_node_used_for_polling_timer: Node,
		verilog_source_text: String,
		top_module_name: String,
		stdcell_subckt_spice_text: String,
		stdcell_timing_liberty_text: String,
		pdk_rail_names_in_subckt_order_as_json: String) -> String:
	var request_id := generate_unique_browser_yosys_synth_request_id(top_module_name)
	stage_one_input_file_for_next_verilog_synth_via_bridge("input.v", verilog_source_text)
	stage_one_input_file_for_next_verilog_synth_via_bridge("timing.lib", stdcell_timing_liberty_text)
	stage_one_input_file_for_next_verilog_synth_via_bridge("stdcell_subckt.spice", stdcell_subckt_spice_text)
	JavaScriptBridge.eval(
			"globalThis.spice3d.beginVerilogSynthRequestUsingPreviouslyStagedInputs(%s, %s, %s);" % [
				JSON.stringify(request_id),
				JSON.stringify(top_module_name),
				JSON.stringify(pdk_rail_names_in_subckt_order_as_json)],
			true)
	var synth_wall_clock_start_milliseconds := Time.get_ticks_msec()
	while true:
		await host_node_used_for_polling_timer.get_tree().create_timer(
				SECONDS_BETWEEN_BROWSER_YOSYS_SYNTH_RESULT_POLLS).timeout
		var raw_status_envelope_json: Variant = JavaScriptBridge.eval(
				"globalThis.spice3d.takeVerilogSynthResultAsJsonStatusEnvelope(%s);" % JSON.stringify(request_id),
				true)
		if not (raw_status_envelope_json is String):
			push_error("[spice3d] browser yosys synth status envelope was not a String for %s" % top_module_name)
			return ""
		var parsed_status_envelope: Variant = JSON.parse_string(raw_status_envelope_json)
		if not (parsed_status_envelope is Dictionary):
			push_error("[spice3d] browser yosys synth status envelope did not parse as Dictionary for %s" % top_module_name)
			return ""
		var status_envelope: Dictionary = parsed_status_envelope
		var status_string: String = status_envelope.get("status", "unknown")
		if status_string == "pending":
			if Time.get_ticks_msec() - synth_wall_clock_start_milliseconds > int(
					SECONDS_BEFORE_GIVING_UP_ON_BROWSER_YOSYS_SYNTH_RESULT * 1000.0):
				push_error("[spice3d] browser yosys synth for %s timed out after %s seconds" % [
						top_module_name, SECONDS_BEFORE_GIVING_UP_ON_BROWSER_YOSYS_SYNTH_RESULT])
				return ""
			continue
		if status_string == "done":
			var synthesized_spice_text: String = status_envelope.get("synthesizedSpiceText", "")
			print("[spice3d] browser yosys synth complete for %s (%d ms, %d lines emitted)" % [
					top_module_name,
					Time.get_ticks_msec() - synth_wall_clock_start_milliseconds,
					synthesized_spice_text.count("\n") + 1])
			return synthesized_spice_text
		push_error("[spice3d] browser yosys synth failed for %s: %s" % [
				top_module_name, status_envelope.get("errorMessage", "(no error message)")])
		return ""
	return ""


static func stage_one_input_file_for_next_verilog_synth_via_bridge(
		virtual_input_file_name: String, file_text: String) -> void:
	JavaScriptBridge.eval(
			"globalThis.__spice3dPendingVerilogSynthInputFileText = "
			+ JSON.stringify(file_text) + ";",
			true)
	JavaScriptBridge.eval(
			"globalThis.spice3d.stageOneInputFileForNextVerilogSynth("
			+ JSON.stringify(virtual_input_file_name)
			+ ", globalThis.__spice3dPendingVerilogSynthInputFileText);",
			true)
	JavaScriptBridge.eval(
			"globalThis.__spice3dPendingVerilogSynthInputFileText = null;",
			true)


static func generate_unique_browser_yosys_synth_request_id(top_module_name: String) -> String:
	return "verilog_synth_%s_%d_%d" % [top_module_name, Time.get_ticks_msec(), randi()]
