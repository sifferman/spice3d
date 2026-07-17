extends Node3D

const SiPrefixTime = preload("res://si_prefix_time_formatter.gd")
const TimeWarpParser = preload("res://time_warp_parser.gd")
const XschemNetlistTransformer = preload("res://xschem_netlist_transformer.gd")
const PdkStaging = preload("res://pdk_staging.gd")
const VerilogSynthesizedSubcktStaging = preload("res://verilog_synthesized_subckt_staging.gd")

@onready var schematic_view: Node3D = $SchematicView
@onready var status_label: Label = $StatusOverlay/StatusLabel
@onready var status_background_color_rect: ColorRect = $StatusOverlay/StatusBackground
@onready var time_warp_input_line_edit: LineEdit = $StatusOverlay/TimeWarpControl/TimeWarpInnerHBox/TimeWarpInput

const DEFAULT_EXAMPLE_DIRECTORY_NAME := "button"
const KNOWN_EXAMPLES_BY_DIRECTORY_NAME := {
	"button": {
		"top_schematic_file_name": "button_test.sch",
		"bundled_file_names": ["button_test.sch", "button.sym"],
		"pdk_family": "sky130",
	},
	"ro": {
		"top_schematic_file_name": "ro.sch",
		"bundled_file_names": ["ro.sch"],
		"pdk_family": "sky130",
	},
	"gf180mcu_nand2": {
		"top_schematic_file_name": "gf180mcu_nand2.sch",
		"bundled_file_names": ["gf180mcu_nand2.sch", "gf180mcu_button.sym"],
		"pdk_family": "gf180mcu",
	},
	"3bit_counter_busses": {
		"top_schematic_file_name": "3bit_counter_busses.sch",
		"bundled_file_names": [
			"3bit_counter_busses.sch",
			"3bit_incrementor.sch",
			"3bit_incrementor.sym",
			"button.sym",
		],
		"pdk_family": "sky130",
	},
	"3bit_counter": {
		"top_schematic_file_name": "3bit_counter.sch",
		"bundled_file_names": ["3bit_counter.sch", "button.sym"],
		"pdk_family": "sky130",
	},
	"verilog_and_or": {
		"top_schematic_file_name": "verilog_and_or_testbench.sch",
		"bundled_file_names": [
			"verilog_and_or_testbench.sch",
			"verilog_and_or.sym",
			"verilog_and_or.v",
			"button.sym",
		],
		"verilog_module_source_file_names_to_synthesize_into_subckt": [
			{"verilog_source_file_name": "verilog_and_or.v", "top_module_name": "verilog_and_or"},
		],
		"pdk_family": "sky130",
	},
}
var active_example_directory_name: String = DEFAULT_EXAMPLE_DIRECTORY_NAME


func active_example_metadata() -> Dictionary:
	return KNOWN_EXAMPLES_BY_DIRECTORY_NAME[active_example_directory_name]


func active_example_top_schematic_file_name() -> String:
	return active_example_metadata()["top_schematic_file_name"]


func active_example_bundled_file_names() -> Array:
	return active_example_metadata()["bundled_file_names"]


func active_example_pdk_family_name() -> String:
	return active_example_metadata()["pdk_family"]


func active_example_bundled_directory_path() -> String:
	return "res://examples/" + active_example_directory_name


func active_example_staged_directory_path() -> String:
	return "user://examples/" + active_example_directory_name


func resolve_active_example_directory_name_from_browser_url_hash_or_default() -> String:
	if not OS.has_feature("web"):
		return DEFAULT_EXAMPLE_DIRECTORY_NAME
	var location_hash_raw_text: Variant = JavaScriptBridge.eval(
			"globalThis.location ? globalThis.location.hash : ''", true)
	if not (location_hash_raw_text is String):
		return DEFAULT_EXAMPLE_DIRECTORY_NAME
	var location_hash_text: String = location_hash_raw_text
	if location_hash_text.begins_with("#"):
		location_hash_text = location_hash_text.substr(1)
	for one_hash_segment in location_hash_text.split("&"):
		var one_segment_pieces := one_hash_segment.split("=", true, 1)
		if one_segment_pieces.size() == 2 and one_segment_pieces[0] == "example":
			var requested_example_directory_name: String = one_segment_pieces[1]
			if KNOWN_EXAMPLES_BY_DIRECTORY_NAME.has(requested_example_directory_name):
				return requested_example_directory_name
			print("[spice3d] ignoring unknown ?example= value: %s" % requested_example_directory_name)
			return DEFAULT_EXAMPLE_DIRECTORY_NAME
	return DEFAULT_EXAMPLE_DIRECTORY_NAME


const TIME_WARP_NOMINAL_NUMBER_OF_SAMPLES_PER_WALL_SECOND_OF_PLAYBACK := 30
const WALL_CLOCK_SECONDS_BETWEEN_PLAYBACK_STEPS := 1.0 / float(TIME_WARP_NOMINAL_NUMBER_OF_SAMPLES_PER_WALL_SECOND_OF_PLAYBACK)
const MAXIMUM_PLAYBACK_QUEUE_SIZE_BEFORE_DROPPING_OLDEST_SAMPLES: int = 60
const TIME_WARP_DEFAULT_INPUT_TEXT := "100 ps"
const TIME_WARP_DEFAULT_SIMULATED_SECONDS_PER_REAL_SECOND := 100.0e-12
const STATUS_BACKGROUND_COLOR_WHILE_SIMULATOR_LOADING := Color(0.65, 0.3, 0.0, 0.75)
const STATUS_BACKGROUND_COLOR_AFTER_SIMULATOR_READY := Color(0.0, 0.0, 0.0, 0.55)
const NUMBER_OF_INITIAL_SAMPLES_TO_LOG_KEY_VOLTAGES_FOR := 3
const FRAME_TIMING_DIAGNOSTIC_REPORT_INTERVAL_FRAMES: int = 60

var pressed_button_high_state_by_instance_name: Dictionary = {}
var spice3d_root_node_for_sample_polling: Node = null
var has_logged_first_simulation_sample_node_names := false
var remaining_initial_samples_to_log_key_voltages_for := NUMBER_OF_INITIAL_SAMPLES_TO_LOG_KEY_VOLTAGES_FOR
var is_first_played_back_sample_still_pending: bool = true
var queued_samples_awaiting_playback_to_wires: Array = []
var wall_clock_seconds_accumulated_since_last_playback_step := 0.0
var currently_selected_time_warp_simulated_seconds_per_real_second: float = TIME_WARP_DEFAULT_SIMULATED_SECONDS_PER_REAL_SECOND
var loaded_schematic_pending_ready_transition_on_first_sample: Dictionary = {}
var spice3d_root_node_pending_ready_transition_on_first_sample: Node = null
var is_simulator_ready_to_accept_button_clicks: bool = false

var frame_timing_frames_since_last_report: int = 0
var frame_timing_drain_total_microseconds: int = 0
var frame_timing_playback_total_microseconds: int = 0
var frame_timing_largest_single_drain_microseconds: int = 0
var frame_timing_largest_single_playback_microseconds: int = 0
var frame_timing_samples_drained_total: int = 0
var frame_timing_samples_played_back_total: int = 0
var frame_timing_largest_queue_size_observed: int = 0
var frame_timing_wall_clock_microseconds_at_window_start: int = 0


func _ready() -> void:
	active_example_directory_name = resolve_active_example_directory_name_from_browser_url_hash_or_default()
	print("[spice3d] active example: %s" % active_example_directory_name)
	wire_up_time_warp_input_line_edit()
	set_status_label_text_to_loading_phase("Setting up Godot scene")
	request_persistent_browser_storage_on_web()
	var spice3d_root_node := Spice3DNode.new()
	spice3d_root_node.button_pressed.connect(_on_schematic_button_pressed)
	add_child(spice3d_root_node)
	var pdk_staging := PdkStaging.new()
	add_child(pdk_staging)
	stage_bundled_schematic_files_into_user_directory()
	var pdk_family_name := active_example_pdk_family_name()
	set_status_label_text_to_loading_phase("Fetching xschem device symbols")
	await pdk_staging.ensure_xschem_devices_library_is_cached()
	set_status_label_text_to_loading_phase("Resolving %s PDK release version" % pdk_family_name)
	var pdk_ciel_version := await pdk_staging.resolve_latest_pdk_ciel_version_from_manifest_with_fallback(pdk_family_name)
	print("[spice3d] %s ciel version selected: %s" % [pdk_family_name, pdk_ciel_version])
	set_status_label_text_to_loading_phase("Downloading %s PDK (~20 MB)" % pdk_family_name)
	await pdk_staging.ensure_pdk_family_is_cached_using_extractor_node(spice3d_root_node, pdk_family_name, pdk_ciel_version)
	set_status_label_text_to_loading_phase("Loading schematic")
	var staged_top_schematic_absolute_path := absolute_path_for_staged_schematic_file(active_example_top_schematic_file_name())
	var extra_symbol_search_directories := PackedStringArray()
	extra_symbol_search_directories.append(PdkStaging.absolute_path_for_xschem_devices_library_directory())
	extra_symbol_search_directories.append_array(
			PdkStaging.absolute_paths_for_all_pdk_xschem_library_directories(pdk_family_name, pdk_ciel_version))
	var loaded_schematic := spice3d_root_node.load_schematic_and_render_into_node3d(
			schematic_view,
			staged_top_schematic_absolute_path,
			"",
			extra_symbol_search_directories)
	set_status_label_text_to_loading_phase("Exposing PDK to ngspice")
	PdkStaging.expose_pdk_family_to_simulator(
			spice3d_root_node, pdk_family_name, pdk_ciel_version)
	var simulator_pdk_include_path_prefix: String = PdkStaging.simulator_include_path_prefix_for_pdk_family(
			spice3d_root_node, pdk_family_name, pdk_ciel_version)
	var verilog_modules_to_synthesize_for_active_example := VerilogSynthesizedSubcktStaging.verilog_modules_to_synthesize_for_example(
			active_example_metadata())
	if not verilog_modules_to_synthesize_for_active_example.is_empty():
		set_status_label_text_to_loading_phase("Synthesizing Verilog modules via browser yosys (first run downloads ~50 MB)")
	var synthesized_verilog_subckt_definition_lines := await VerilogSynthesizedSubcktStaging.synthesize_all_verilog_modules_for_active_example_via_browser_yosys(
			self,
			active_example_staged_directory_path(),
			verilog_modules_to_synthesize_for_active_example,
			PdkStaging.absolute_path_for_pdk_stdcell_subckt_spice_used_by_yosys_synth(pdk_family_name, pdk_ciel_version),
			PdkStaging.absolute_path_for_pdk_stdcell_timing_liberty_used_by_yosys_synth(pdk_family_name, pdk_ciel_version),
			PdkStaging.stdcell_power_rail_net_names_in_subckt_port_order_for(pdk_family_name))
	set_status_label_text_to_loading_phase("Generating netlist + starting ngspice")
	push_spice_netlist_and_start_transient_analysis(
			spice3d_root_node,
			staged_top_schematic_absolute_path,
			extra_symbol_search_directories,
			synthesized_verilog_subckt_definition_lines,
			simulator_pdk_include_path_prefix)
	loaded_schematic_pending_ready_transition_on_first_sample = loaded_schematic
	spice3d_root_node_pending_ready_transition_on_first_sample = spice3d_root_node
	set_status_label_text_to_loading_phase("Waiting for first ngspice sample to come back")


func set_status_label_text_to_loading_phase(human_readable_phase_description: String) -> void:
	status_label.text = ("[LOADING — simulator not yet ready] " + human_readable_phase_description + "..."
			+ "\n(may take a few seconds on first visit; button clicks won't register until ready)")
	status_background_color_rect.color = STATUS_BACKGROUND_COLOR_WHILE_SIMULATOR_LOADING
	print("[spice3d] loading phase: " + human_readable_phase_description)


func wire_up_time_warp_input_line_edit() -> void:
	time_warp_input_line_edit.text = TIME_WARP_DEFAULT_INPUT_TEXT
	time_warp_input_line_edit.text_submitted.connect(_on_time_warp_input_text_submitted_by_user)


func _on_time_warp_input_text_submitted_by_user(submitted_input_text: String) -> void:
	var parsed_simulated_seconds_per_real_second: float = TimeWarpParser.parse_input_text_to_simulated_seconds_per_real_second(
			submitted_input_text)
	if is_nan(parsed_simulated_seconds_per_real_second):
		print("[spice3d] ignored invalid time-warp input %s — expected '<0-1000> <ps|ns|us>'" % [
				JSON.stringify(submitted_input_text)])
		time_warp_input_line_edit.text = TimeWarpParser.format_simulated_seconds_per_real_second_as_input_text(
				currently_selected_time_warp_simulated_seconds_per_real_second)
		return
	currently_selected_time_warp_simulated_seconds_per_real_second = parsed_simulated_seconds_per_real_second
	var discarded_old_pace_sample_count := queued_samples_awaiting_playback_to_wires.size()
	queued_samples_awaiting_playback_to_wires.clear()
	if discarded_old_pace_sample_count > 0:
		print("[spice3d] discarded %d queued sample(s) from previous time-warp setting" % discarded_old_pace_sample_count)
	if currently_selected_time_warp_simulated_seconds_per_real_second == TimeWarpParser.PAUSE_SENTINEL_SIMULATED_SECONDS_PER_REAL_SECOND:
		print("[spice3d] time-warp set to 0 — simulation paused; wires hold last displayed state")
		if spice3d_root_node_for_sample_polling != null:
			spice3d_root_node_for_sample_polling.stop_simulation()
		return
	var new_transient_timestep_seconds := compute_transient_timestep_seconds_for_current_time_warp()
	print("[spice3d] time-warp set to %s sim-time per real-second (timestep=%s)" % [
			SiPrefixTime.format_seconds_with_si_prefix(currently_selected_time_warp_simulated_seconds_per_real_second),
			SiPrefixTime.format_seconds_with_si_prefix(new_transient_timestep_seconds)])
	if spice3d_root_node_for_sample_polling != null:
		spice3d_root_node_for_sample_polling.update_transient_timestep_mid_simulation(
				new_transient_timestep_seconds)


func compute_transient_timestep_seconds_for_current_time_warp() -> float:
	return (currently_selected_time_warp_simulated_seconds_per_real_second
			/ TIME_WARP_NOMINAL_NUMBER_OF_SAMPLES_PER_WALL_SECOND_OF_PLAYBACK)


func active_example_supply_voltage_volts() -> float:
	return XschemNetlistTransformer.netlist_spec_for(
			active_example_pdk_family_name())["vdd_volts_for_external_voltage_source_high_level"]


func _on_schematic_button_pressed(button_instance_name: String) -> void:
	if not is_simulator_ready_to_accept_button_clicks:
		print("[spice3d] button '%s' click ignored — simulator is still loading" % button_instance_name)
		return
	var previously_high_state: bool = pressed_button_high_state_by_instance_name.get(button_instance_name, false)
	var new_high_state := not previously_high_state
	pressed_button_high_state_by_instance_name[button_instance_name] = new_high_state
	print("[spice3d] button '%s' toggled %s" % [button_instance_name, "HIGH" if new_high_state else "LOW"])
	if spice3d_root_node_for_sample_polling != null:
		var new_voltage_for_button := active_example_supply_voltage_volts() if new_high_state else 0.0
		spice3d_root_node_for_sample_polling.set_external_voltage_source(
				button_instance_name, new_voltage_for_button)
		var stale_pre_click_sample_count := queued_samples_awaiting_playback_to_wires.size()
		queued_samples_awaiting_playback_to_wires.clear()
		if stale_pre_click_sample_count > 0:
			print("[spice3d] flushed %d pre-click playback sample(s) so the new voltage shows up immediately" % stale_pre_click_sample_count)


func push_spice_netlist_and_start_transient_analysis(
		spice3d_root_node: Node,
		staged_top_schematic_absolute_path: String,
		extra_symbol_search_directories: PackedStringArray,
		synthesized_verilog_subckt_definition_lines: PackedStringArray,
		simulator_pdk_include_path_prefix: String) -> void:
	spice3d_root_node_for_sample_polling = spice3d_root_node
	var netlist_lines: PackedStringArray = spice3d_root_node.generate_spice_netlist_for_schematic_file(
			staged_top_schematic_absolute_path, "", extra_symbol_search_directories)
	if netlist_lines.is_empty():
		push_warning("[spice3d] netlist empty; skipping simulator push")
		return
	var pdk_family_name := active_example_pdk_family_name()
	var netlist_lines_with_pdk_include := XschemNetlistTransformer.convert_subckt_netlist_to_top_level_testbench(
			netlist_lines, pdk_family_name, simulator_pdk_include_path_prefix, synthesized_verilog_subckt_definition_lines)
	var internal_net_names_to_seed_at_half_vdd := XschemNetlistTransformer.extract_internal_net_names_from_subckt_netlist(
			netlist_lines, pdk_family_name)
	print("[spice3d] generated netlist with %d lines (after PDK include: %d, seed-IC nets: %d)" % [
			netlist_lines.size(), netlist_lines_with_pdk_include.size(),
			internal_net_names_to_seed_at_half_vdd.size()])
	spice3d_root_node.start_transient_analysis_with_netlist_and_seed_ic_nets(
			netlist_lines_with_pdk_include,
			compute_transient_timestep_seconds_for_current_time_warp(),
			internal_net_names_to_seed_at_half_vdd)


func _process(delta_seconds_since_last_frame: float) -> void:
	if spice3d_root_node_for_sample_polling == null:
		return
	var drain_phase_start_microseconds := Time.get_ticks_usec()
	var samples_drained_count := drain_new_simulator_samples_into_playback_queue_and_return_count()
	var drain_phase_end_microseconds := Time.get_ticks_usec()
	var samples_played_back_count := step_sample_playback_queue_forward_if_wall_clock_interval_elapsed_and_return_count(
			delta_seconds_since_last_frame)
	var playback_phase_end_microseconds := Time.get_ticks_usec()
	accumulate_per_frame_timing_diagnostic(
			drain_phase_end_microseconds - drain_phase_start_microseconds,
			playback_phase_end_microseconds - drain_phase_end_microseconds,
			samples_drained_count,
			samples_played_back_count,
			queued_samples_awaiting_playback_to_wires.size())


func accumulate_per_frame_timing_diagnostic(
		drain_microseconds: int,
		playback_microseconds: int,
		samples_drained_count: int,
		samples_played_back_count: int,
		queue_size_after_this_frame: int) -> void:
	if frame_timing_frames_since_last_report == 0:
		frame_timing_wall_clock_microseconds_at_window_start = Time.get_ticks_usec()
	frame_timing_frames_since_last_report += 1
	frame_timing_drain_total_microseconds += drain_microseconds
	frame_timing_playback_total_microseconds += playback_microseconds
	frame_timing_samples_drained_total += samples_drained_count
	frame_timing_samples_played_back_total += samples_played_back_count
	if drain_microseconds > frame_timing_largest_single_drain_microseconds:
		frame_timing_largest_single_drain_microseconds = drain_microseconds
	if playback_microseconds > frame_timing_largest_single_playback_microseconds:
		frame_timing_largest_single_playback_microseconds = playback_microseconds
	if queue_size_after_this_frame > frame_timing_largest_queue_size_observed:
		frame_timing_largest_queue_size_observed = queue_size_after_this_frame
	if frame_timing_frames_since_last_report < FRAME_TIMING_DIAGNOSTIC_REPORT_INTERVAL_FRAMES:
		return
	var wall_clock_seconds_for_this_window: float = (
			float(Time.get_ticks_usec() - frame_timing_wall_clock_microseconds_at_window_start)
			/ 1.0e6)
	var measured_frames_per_second: float = (
			float(frame_timing_frames_since_last_report) / wall_clock_seconds_for_this_window
			if wall_clock_seconds_for_this_window > 0.0 else 0.0)
	var measured_samples_drained_per_second: float = (
			float(frame_timing_samples_drained_total) / wall_clock_seconds_for_this_window
			if wall_clock_seconds_for_this_window > 0.0 else 0.0)
	var measured_samples_played_per_second: float = (
			float(frame_timing_samples_played_back_total) / wall_clock_seconds_for_this_window
			if wall_clock_seconds_for_this_window > 0.0 else 0.0)
	var average_drain_microseconds: float = float(frame_timing_drain_total_microseconds) / float(frame_timing_frames_since_last_report)
	var average_playback_microseconds: float = float(frame_timing_playback_total_microseconds) / float(frame_timing_frames_since_last_report)
	print(("[spice3d] frame-timing (%d frames in %.2fs = %.1f fps): "
			+ "drain avg=%.2fms max=%.2fms, "
			+ "playback avg=%.2fms max=%.2fms, "
			+ "drained=%d (%.1f/s) played=%d (%.1f/s), peak queue=%d") % [
		frame_timing_frames_since_last_report,
		wall_clock_seconds_for_this_window,
		measured_frames_per_second,
		average_drain_microseconds / 1000.0,
		float(frame_timing_largest_single_drain_microseconds) / 1000.0,
		average_playback_microseconds / 1000.0,
		float(frame_timing_largest_single_playback_microseconds) / 1000.0,
		frame_timing_samples_drained_total,
		measured_samples_drained_per_second,
		frame_timing_samples_played_back_total,
		measured_samples_played_per_second,
		frame_timing_largest_queue_size_observed])
	frame_timing_frames_since_last_report = 0
	frame_timing_drain_total_microseconds = 0
	frame_timing_playback_total_microseconds = 0
	frame_timing_largest_single_drain_microseconds = 0
	frame_timing_largest_single_playback_microseconds = 0
	frame_timing_samples_drained_total = 0
	frame_timing_samples_played_back_total = 0
	frame_timing_largest_queue_size_observed = 0


func drain_new_simulator_samples_into_playback_queue_and_return_count() -> int:
	var drained_samples: Array = spice3d_root_node_for_sample_polling.drain_buffered_simulation_samples_as_godot_array()
	if drained_samples.is_empty():
		return 0
	queued_samples_awaiting_playback_to_wires.append_array(drained_samples)
	if queued_samples_awaiting_playback_to_wires.size() > MAXIMUM_PLAYBACK_QUEUE_SIZE_BEFORE_DROPPING_OLDEST_SAMPLES:
		var overflow_count: int = queued_samples_awaiting_playback_to_wires.size() - MAXIMUM_PLAYBACK_QUEUE_SIZE_BEFORE_DROPPING_OLDEST_SAMPLES
		queued_samples_awaiting_playback_to_wires = queued_samples_awaiting_playback_to_wires.slice(overflow_count)
	return drained_samples.size()


func step_sample_playback_queue_forward_if_wall_clock_interval_elapsed_and_return_count(
		delta_seconds_since_last_frame: float) -> int:
	wall_clock_seconds_accumulated_since_last_playback_step += delta_seconds_since_last_frame
	if wall_clock_seconds_accumulated_since_last_playback_step < WALL_CLOCK_SECONDS_BETWEEN_PLAYBACK_STEPS:
		return 0
	wall_clock_seconds_accumulated_since_last_playback_step -= WALL_CLOCK_SECONDS_BETWEEN_PLAYBACK_STEPS
	if queued_samples_awaiting_playback_to_wires.is_empty():
		return 0
	var next_sample_to_play_back = queued_samples_awaiting_playback_to_wires.pop_front()
	if not (next_sample_to_play_back is Dictionary) or not next_sample_to_play_back.has("nodeVoltagesByName"):
		return 0
	var node_voltages_by_name: Dictionary = next_sample_to_play_back["nodeVoltagesByName"]
	if not has_logged_first_simulation_sample_node_names:
		print("[spice3d] first sample node names: %s" % str(node_voltages_by_name.keys()))
		has_logged_first_simulation_sample_node_names = true
	if remaining_initial_samples_to_log_key_voltages_for > 0:
		remaining_initial_samples_to_log_key_voltages_for -= 1
		var sim_time_seconds: float = next_sample_to_play_back.get("simulationTimeSeconds", 0.0)
		print("[spice3d] played-back sample t=%s node_voltages=%s remaining_in_queue=%d" % [
				SiPrefixTime.format_seconds_with_si_prefix(sim_time_seconds),
				str(node_voltages_by_name),
				queued_samples_awaiting_playback_to_wires.size()])
	spice3d_root_node_for_sample_polling.apply_node_voltages_to_wire_colors(
			schematic_view,
			node_voltages_by_name,
			active_example_supply_voltage_volts())
	if is_first_played_back_sample_still_pending:
		is_first_played_back_sample_still_pending = false
		if spice3d_root_node_pending_ready_transition_on_first_sample != null:
			update_status_text(
					spice3d_root_node_pending_ready_transition_on_first_sample,
					loaded_schematic_pending_ready_transition_on_first_sample)
			spice3d_root_node_pending_ready_transition_on_first_sample = null
			loaded_schematic_pending_ready_transition_on_first_sample = {}
			is_simulator_ready_to_accept_button_clicks = true
	return 1


func request_persistent_browser_storage_on_web() -> void:
	if not OS.has_feature("web"):
		return
	JavaScriptBridge.eval(
			"navigator.storage && navigator.storage.persist && navigator.storage.persist();",
			true)


func stage_bundled_schematic_files_into_user_directory() -> void:
	DirAccess.make_dir_recursive_absolute(active_example_staged_directory_path())
	for one_bundled_file_name in active_example_bundled_file_names():
		var bundled_source_path := "%s/%s" % [active_example_bundled_directory_path(), one_bundled_file_name]
		var staged_destination_path := "%s/%s" % [active_example_staged_directory_path(), one_bundled_file_name]
		copy_file_via_godot_filesystem(bundled_source_path, staged_destination_path)


func copy_file_via_godot_filesystem(source_path: String, destination_path: String) -> void:
	var source_file := FileAccess.open(source_path, FileAccess.READ)
	if source_file == null:
		push_error("could not open source for copy: " + source_path)
		return
	var source_bytes := source_file.get_buffer(source_file.get_length())
	source_file.close()
	var destination_file := FileAccess.open(destination_path, FileAccess.WRITE)
	destination_file.store_buffer(source_bytes)
	destination_file.close()


func absolute_path_for_staged_schematic_file(staged_file_name: String) -> String:
	return "%s/examples/%s/%s" % [OS.get_user_data_dir(), active_example_directory_name, staged_file_name]


func update_status_text(spice3d_root_node: Node, loaded_schematic: Dictionary) -> void:
	var status_text := "[READY] spice3d %s | backend: %s | %s — %d components, %d wires" % [
		spice3d_root_node.get_spice3d_version(),
		spice3d_root_node.describe_simulator_backend(),
		loaded_schematic["cell_name"],
		loaded_schematic["component_instances"].size(),
		loaded_schematic["wires"].size(),
	]
	if not loaded_schematic["was_successful"]:
		status_text += "\nload error: " + str(loaded_schematic["error_message"])
	status_label.text = status_text
	status_background_color_rect.color = STATUS_BACKGROUND_COLOR_AFTER_SIMULATOR_READY
	print(status_text)
