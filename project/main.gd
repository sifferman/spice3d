extends Node3D

@onready var schematic_view: Node3D = $SchematicView
@onready var status_label: Label = $StatusOverlay/StatusLabel

const ACTIVE_EXAMPLE_DIRECTORY_NAME := "button"
const SCHEMATIC_BUNDLED_DIR := "res://examples/" + ACTIVE_EXAMPLE_DIRECTORY_NAME
const SCHEMATIC_STAGED_DIR := "user://examples/" + ACTIVE_EXAMPLE_DIRECTORY_NAME
const SCHEMATIC_BUNDLED_FILE_NAMES := ["button_test.sch", "button.sym"]
const TOP_SCHEMATIC_FILE_NAME := "button_test.sch"

const XSCHEM_UPSTREAM_GIT_SHA := "d7f3980301eb9f12954a8542d55b188ffe851770"
const XSCHEM_JSDELIVR_FILE_LISTING_URL := \
		"https://data.jsdelivr.com/v1/packages/gh/StefanSchippers/xschem@" + XSCHEM_UPSTREAM_GIT_SHA + "?structure=flat"
const XSCHEM_JSDELIVR_FILE_URL_TEMPLATE := \
		"https://cdn.jsdelivr.net/gh/StefanSchippers/xschem@" + XSCHEM_UPSTREAM_GIT_SHA + "%s"
const XSCHEM_LOCAL_CACHE_ROOT := "user://xschem_stdlib/" + XSCHEM_UPSTREAM_GIT_SHA
const XSCHEM_LOCAL_DEVICES_DIRECTORY := XSCHEM_LOCAL_CACHE_ROOT + "/devices"
const XSCHEM_LOCAL_CACHE_COMPLETE_MARKER := XSCHEM_LOCAL_CACHE_ROOT + "/.fetch_complete"
const XSCHEM_DEVICES_PATH_FRAGMENT_INSIDE_REPO := "/xschem_library/devices/"

const SKY130_CIEL_VERSION_MANIFEST_URL := \
		"https://www-archive.fossi-foundation.org/ciel-releases/sky130/manifest.json"
const SKY130_CIEL_FALLBACK_VERSION_IF_MANIFEST_UNREACHABLE := "74c0e6b118a67d94c24172143d3bd597473fa63d"
const SKY130_CORS_PROXY_URL_PREFIX := "https://ciel-cors-proxy.sifferman.workers.dev/?url="
const SKY130_ARCHIVE_FILENAMES_TO_FETCH_AT_STARTUP := [
	"common.tar.zst",
	"sky130_fd_pr.tar.zst",
]
const SKY130_PATH_SUBSTRINGS_TO_KEEP_DURING_EXTRACTION := [
	"/libs.tech/combined/",
	"/libs.tech/xschem/",
	"/libs.ref/sky130_fd_pr/spice/",
]
const SKY130_PDK_RES_BUNDLED_FILES_TO_STAGE_INTO_WORKER_FILESYSTEM := [
	{
		"res_path": "res://sky130_pdk_bundled/sky130A/libs.ref/sky130_fd_sc_hd/spice/sky130_fd_sc_hd.spice",
		"worker_memfs_path": "/sky130A/libs.ref/sky130_fd_sc_hd/spice/sky130_fd_sc_hd.spice",
	},
]


func _ready() -> void:
	set_status_label_text_to_loading_phase("Setting up Godot scene")
	request_persistent_browser_storage_on_web()
	var spice3d_root_node := Spice3DNode.new()
	spice3d_root_node.button_pressed.connect(_on_schematic_button_pressed)
	add_child(spice3d_root_node)
	stage_bundled_schematic_files_to_writable_directory()
	set_status_label_text_to_loading_phase("Fetching xschem device symbols")
	await ensure_xschem_devices_library_is_cached()
	set_status_label_text_to_loading_phase("Resolving sky130 PDK release version")
	var sky130_ciel_version := await resolve_latest_sky130_ciel_version_from_manifest_with_fallback()
	print("[spice3d] sky130 ciel version selected: %s" % sky130_ciel_version)
	set_status_label_text_to_loading_phase("Downloading sky130 PDK (~20 MB)")
	await ensure_sky130_pdk_is_cached_using_extractor_node(spice3d_root_node, sky130_ciel_version)
	set_status_label_text_to_loading_phase("Loading schematic")
	var staged_top_schematic_absolute_path := absolute_path_for_staged_schematic_file(TOP_SCHEMATIC_FILE_NAME)
	var extra_symbol_search_directories := PackedStringArray([
		absolute_path_for_xschem_devices_library_directory(),
		absolute_path_for_sky130_xschem_library_directory_for_sky130a_variant(sky130_ciel_version),
		absolute_path_for_sky130_xschem_library_directory_for_sky130b_variant(sky130_ciel_version),
	])
	var loaded_schematic := spice3d_root_node.load_schematic_and_render_into_node3d(
			schematic_view,
			staged_top_schematic_absolute_path,
			"",
			extra_symbol_search_directories)
	set_status_label_text_to_loading_phase("Staging PDK into ngspice")
	stage_sky130_pdk_files_into_web_simulator_filesystem(spice3d_root_node, sky130_ciel_version)
	set_status_label_text_to_loading_phase("Generating netlist + starting ngspice")
	push_spice_netlist_and_start_transient_on_web_simulator(
			spice3d_root_node,
			staged_top_schematic_absolute_path,
			extra_symbol_search_directories)
	update_status_text(spice3d_root_node, loaded_schematic)


func set_status_label_text_to_loading_phase(human_readable_phase_description: String) -> void:
	status_label.text = ("Loading: " + human_readable_phase_description + "..."
			+ "\n(this may take a few seconds on first visit)")
	print("[spice3d] loading phase: " + human_readable_phase_description)


const VDD_VOLTS_FOR_BUTTON_HIGH_LEVEL := 1.8
const TRANSIENT_TIMESTEP_SECONDS := 5.0e-12
const TRANSIENT_STOP_TIME_PER_EVENT_DRIVEN_SIMULATION_SECONDS := 2.0e-10
const SIMULATION_SAMPLE_POLL_INTERVAL_SECONDS := 0.0
const SIMULATION_SAMPLE_FORWARD_RATE_HZ := 10000.0
const NUMBER_OF_INITIAL_SAMPLES_TO_LOG_KEY_VOLTAGES_FOR := 3
const MINIMUM_VOLTAGE_CHANGE_TO_LOG_A_NEW_SAMPLE_DIAGNOSTIC := 0.2
const WALL_CLOCK_SECONDS_BETWEEN_SAMPLE_PLAYBACK_STEPS := 0.03

const SKY130_PDK_TOP_LEVEL_LIB_SPICE_VIRTUAL_PATH_IN_WORKER := "/sky130A/libs.tech/combined/sky130.lib.spice"
const SKY130_PDK_LIB_CORNER_NAME := "tt"
const SKY130_PDK_SOURCE_SUBDIRECTORIES_RELATIVE_TO_CIEL_ROOT := [
	"/sky130A/libs.tech/combined",
	"/sky130A/libs.ref/sky130_fd_pr/spice",
]

const SKY130_FD_SC_HD_CONSOLIDATED_SPICE_VIRTUAL_PATH_IN_WORKER := "/sky130A/libs.ref/sky130_fd_sc_hd/spice/sky130_fd_sc_hd.spice"

var pressed_button_high_state_by_instance_name: Dictionary = {}
var spice3d_root_node_for_sample_polling: Node = null
var simulation_sample_poll_accumulator_seconds := 0.0
var has_logged_first_simulation_sample_node_names := false
var remaining_initial_samples_to_log_key_voltages_for := NUMBER_OF_INITIAL_SAMPLES_TO_LOG_KEY_VOLTAGES_FOR
var wire_color_apply_invocation_count := 0
var most_recently_logged_net1_voltage_volts := -100.0
var most_recently_logged_btn_out_n_voltage_volts := -100.0
var queued_samples_awaiting_playback_to_wires: Array = []
var wall_clock_seconds_accumulated_since_last_playback_step := 0.0


func _on_schematic_button_pressed(button_instance_name: String) -> void:
	var previously_high_state: bool = pressed_button_high_state_by_instance_name.get(button_instance_name, false)
	var new_high_state := not previously_high_state
	pressed_button_high_state_by_instance_name[button_instance_name] = new_high_state
	print("[spice3d] button '%s' toggled %s" % [button_instance_name, "HIGH" if new_high_state else "LOW"])
	if spice3d_root_node_for_sample_polling != null:
		var new_voltage_for_button := VDD_VOLTS_FOR_BUTTON_HIGH_LEVEL if new_high_state else 0.0
		spice3d_root_node_for_sample_polling.set_external_voltage_source_on_web_simulator(
				button_instance_name, new_voltage_for_button)


func stage_sky130_pdk_files_into_web_simulator_filesystem(
		spice3d_root_node: Node,
		sky130_ciel_version: String) -> void:
	var pdk_filesystem_root_path := absolute_path_for_sky130_local_cache_root(sky130_ciel_version)
	var total_staged_file_count := 0
	for one_pdk_subdirectory in SKY130_PDK_SOURCE_SUBDIRECTORIES_RELATIVE_TO_CIEL_ROOT:
		var source_directory_absolute_path: String = pdk_filesystem_root_path + one_pdk_subdirectory
		var virtual_directory_inside_worker: String = one_pdk_subdirectory
		var staged_file_count_for_this_subdirectory := stage_text_files_recursively_into_worker_filesystem(
				spice3d_root_node,
				source_directory_absolute_path,
				virtual_directory_inside_worker)
		total_staged_file_count += staged_file_count_for_this_subdirectory
	for one_bundled_file_entry in SKY130_PDK_RES_BUNDLED_FILES_TO_STAGE_INTO_WORKER_FILESYSTEM:
		if stage_one_res_bundled_file_into_worker_filesystem(
				spice3d_root_node,
				one_bundled_file_entry["res_path"],
				one_bundled_file_entry["worker_memfs_path"]):
			total_staged_file_count += 1
	print("[spice3d] staged %d sky130 PDK file(s) into worker MEMFS" % total_staged_file_count)


func stage_one_res_bundled_file_into_worker_filesystem(
		spice3d_root_node: Node,
		res_bundled_file_path: String,
		worker_memfs_destination_path: String) -> bool:
	var bundled_file_handle := FileAccess.open(res_bundled_file_path, FileAccess.READ)
	if bundled_file_handle == null:
		push_error("[spice3d] cannot open bundled PDK file '%s' for reading" % res_bundled_file_path)
		return false
	var bundled_file_text_content := bundled_file_handle.get_as_text()
	bundled_file_handle.close()
	spice3d_root_node.install_file_text_in_web_simulator_filesystem(
			worker_memfs_destination_path, bundled_file_text_content)
	return true


func stage_text_files_recursively_into_worker_filesystem(
		spice3d_root_node: Node,
		real_source_directory_absolute_path: String,
		virtual_destination_directory_path_inside_worker: String) -> int:
	var directory_handle := DirAccess.open(real_source_directory_absolute_path)
	if directory_handle == null:
		push_warning("[spice3d] cannot open '%s' for PDK staging" % real_source_directory_absolute_path)
		return 0
	directory_handle.list_dir_begin()
	var staged_file_count := 0
	while true:
		var one_entry_name := directory_handle.get_next()
		if one_entry_name.is_empty():
			break
		if one_entry_name.begins_with("."):
			continue
		var one_entry_real_path := real_source_directory_absolute_path + "/" + one_entry_name
		var one_entry_virtual_path := virtual_destination_directory_path_inside_worker + "/" + one_entry_name
		if directory_handle.current_is_dir():
			staged_file_count += stage_text_files_recursively_into_worker_filesystem(
					spice3d_root_node, one_entry_real_path, one_entry_virtual_path)
			continue
		var one_file_handle := FileAccess.open(one_entry_real_path, FileAccess.READ)
		if one_file_handle == null:
			continue
		var one_file_text_content := one_file_handle.get_as_text()
		one_file_handle.close()
		spice3d_root_node.install_file_text_in_web_simulator_filesystem(
				one_entry_virtual_path, one_file_text_content)
		staged_file_count += 1
	directory_handle.list_dir_end()
	return staged_file_count


const SKY130_PDK_RAIL_VOLTAGE_DEFINITIONS_FOR_TESTBENCH := [
	"V_SPICE3D_TESTBENCH_VPWR VPWR 0 DC 1.8",
	"V_SPICE3D_TESTBENCH_VGND VGND 0 DC 0",
	"V_SPICE3D_TESTBENCH_VPB  VPB  0 DC 1.8",
	"V_SPICE3D_TESTBENCH_VNB  VNB  0 DC 0",
]




func strip_xschem_escape_backslashes_from_subckt_names(spice_netlist_line: String) -> String:
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


func is_subckt_wrapper_directive(spice_netlist_line: String) -> bool:
	var stripped_line := spice_netlist_line.strip_edges()
	if stripped_line.is_empty(): return false
	if stripped_line.begins_with(".subckt"): return true
	if stripped_line == ".ends" or stripped_line.begins_with(".ends "): return true
	return false


func convert_xschem_subckt_netlist_into_top_level_testbench(
		raw_xschem_netlist_lines: PackedStringArray) -> PackedStringArray:
	var top_level_testbench_lines := PackedStringArray()
	top_level_testbench_lines.append(".lib %s %s" % [
			SKY130_PDK_TOP_LEVEL_LIB_SPICE_VIRTUAL_PATH_IN_WORKER,
			SKY130_PDK_LIB_CORNER_NAME])
	top_level_testbench_lines.append(".include %s"
			% SKY130_FD_SC_HD_CONSOLIDATED_SPICE_VIRTUAL_PATH_IN_WORKER)
	top_level_testbench_lines.append_array(
			PackedStringArray(SKY130_PDK_RAIL_VOLTAGE_DEFINITIONS_FOR_TESTBENCH))
	for one_existing_line in raw_xschem_netlist_lines:
		if is_subckt_wrapper_directive(one_existing_line):
			continue
		var without_escape_backslashes := strip_xschem_escape_backslashes_from_subckt_names(one_existing_line)
		top_level_testbench_lines.append(without_escape_backslashes)
	return top_level_testbench_lines


func push_spice_netlist_and_start_transient_on_web_simulator(
		spice3d_root_node: Node,
		staged_top_schematic_absolute_path: String,
		extra_symbol_search_directories: PackedStringArray) -> void:
	spice3d_root_node_for_sample_polling = spice3d_root_node
	var netlist_lines: PackedStringArray = spice3d_root_node.generate_spice_netlist_for_schematic_file(
			staged_top_schematic_absolute_path, "", extra_symbol_search_directories)
	if netlist_lines.is_empty():
		push_warning("[spice3d] netlist empty; skipping simulator push")
		return
	var netlist_lines_with_pdk_include := convert_xschem_subckt_netlist_into_top_level_testbench(netlist_lines)
	print("[spice3d] generated netlist with %d lines (after PDK include: %d)" % [
			netlist_lines.size(), netlist_lines_with_pdk_include.size()])
	spice3d_root_node.set_simulation_sample_throttle_on_web_simulator(SIMULATION_SAMPLE_FORWARD_RATE_HZ)
	spice3d_root_node.push_netlist_lines_to_web_simulator(netlist_lines_with_pdk_include)
	spice3d_root_node.start_transient_analysis_on_web_simulator(
			TRANSIENT_TIMESTEP_SECONDS, TRANSIENT_STOP_TIME_PER_EVENT_DRIVEN_SIMULATION_SECONDS)


func _process(delta_seconds_since_last_frame: float) -> void:
	if spice3d_root_node_for_sample_polling == null:
		return
	drain_new_simulator_samples_into_playback_queue()
	step_sample_playback_queue_forward_if_wall_clock_interval_elapsed(
			delta_seconds_since_last_frame)


func drain_new_simulator_samples_into_playback_queue() -> void:
	var drained_samples: Array = spice3d_root_node_for_sample_polling.drain_buffered_simulation_samples_from_web_simulator()
	if drained_samples.is_empty():
		return
	queued_samples_awaiting_playback_to_wires.append_array(drained_samples)


func step_sample_playback_queue_forward_if_wall_clock_interval_elapsed(
		delta_seconds_since_last_frame: float) -> void:
	wall_clock_seconds_accumulated_since_last_playback_step += delta_seconds_since_last_frame
	if wall_clock_seconds_accumulated_since_last_playback_step < WALL_CLOCK_SECONDS_BETWEEN_SAMPLE_PLAYBACK_STEPS:
		return
	wall_clock_seconds_accumulated_since_last_playback_step = 0.0
	if queued_samples_awaiting_playback_to_wires.is_empty():
		return
	var next_sample_to_play_back = queued_samples_awaiting_playback_to_wires.pop_front()
	if not (next_sample_to_play_back is Dictionary) or not next_sample_to_play_back.has("nodeVoltagesByName"):
		return
	var node_voltages_by_name: Dictionary = next_sample_to_play_back["nodeVoltagesByName"]
	if not has_logged_first_simulation_sample_node_names:
		print("[spice3d] first sample node names: %s" % str(node_voltages_by_name.keys()))
		has_logged_first_simulation_sample_node_names = true
	var current_net1_voltage_volts: float = node_voltages_by_name.get("net1", 0.0)
	var current_btn_out_n_voltage_volts: float = node_voltages_by_name.get("btn_out_n", 0.0)
	var net1_voltage_changed_enough_to_log: bool = absf(
			current_net1_voltage_volts - most_recently_logged_net1_voltage_volts
			) >= MINIMUM_VOLTAGE_CHANGE_TO_LOG_A_NEW_SAMPLE_DIAGNOSTIC
	var btn_out_n_voltage_changed_enough_to_log: bool = absf(
			current_btn_out_n_voltage_volts - most_recently_logged_btn_out_n_voltage_volts
			) >= MINIMUM_VOLTAGE_CHANGE_TO_LOG_A_NEW_SAMPLE_DIAGNOSTIC
	if (remaining_initial_samples_to_log_key_voltages_for > 0
			or net1_voltage_changed_enough_to_log
			or btn_out_n_voltage_changed_enough_to_log):
		if remaining_initial_samples_to_log_key_voltages_for > 0:
			remaining_initial_samples_to_log_key_voltages_for -= 1
		var sim_time_seconds: float = next_sample_to_play_back.get("simulationTimeSeconds", 0.0)
		print("[spice3d] played-back sample t=%ss net1=%f btn_out_n=%f remaining_in_queue=%d" % [
				str(sim_time_seconds),
				current_net1_voltage_volts,
				current_btn_out_n_voltage_volts,
				queued_samples_awaiting_playback_to_wires.size()])
		most_recently_logged_net1_voltage_volts = current_net1_voltage_volts
		most_recently_logged_btn_out_n_voltage_volts = current_btn_out_n_voltage_volts
	spice3d_root_node_for_sample_polling.apply_node_voltages_to_wire_colors(
			schematic_view,
			node_voltages_by_name,
			VDD_VOLTS_FOR_BUTTON_HIGH_LEVEL)
	wire_color_apply_invocation_count += 1
	if wire_color_apply_invocation_count == 1:
		var schematic_view_child_count: int = schematic_view.get_child_count()
		var wires_tagged_with_spice_node_name_by_label: Dictionary = {}
		for one_child in schematic_view.get_children():
			if one_child is MeshInstance3D and one_child.has_meta("spice_node_name"):
				var one_meta_value: String = one_child.get_meta("spice_node_name")
				wires_tagged_with_spice_node_name_by_label[one_meta_value] = (
						wires_tagged_with_spice_node_name_by_label.get(one_meta_value, 0) + 1)
		print("[spice3d] schematic_view has %d children; spice_node_name-tagged wire counts: %s" % [
				schematic_view_child_count,
				str(wires_tagged_with_spice_node_name_by_label)])


func resolve_latest_sky130_ciel_version_from_manifest_with_fallback() -> String:
	var manifest_body := await download_url_as_byte_array(SKY130_CIEL_VERSION_MANIFEST_URL)
	if manifest_body.is_empty():
		print("[spice3d] sky130 ciel version manifest unreachable; using fallback %s"
				% SKY130_CIEL_FALLBACK_VERSION_IF_MANIFEST_UNREACHABLE)
		return SKY130_CIEL_FALLBACK_VERSION_IF_MANIFEST_UNREACHABLE
	var parsed_manifest = JSON.parse_string(manifest_body.get_string_from_utf8())
	if parsed_manifest == null or not parsed_manifest.has("versions"):
		push_error("sky130 ciel manifest did not parse as a 'versions' dictionary; using fallback")
		return SKY130_CIEL_FALLBACK_VERSION_IF_MANIFEST_UNREACHABLE
	for one_version_entry in parsed_manifest.versions:
		if not one_version_entry is Dictionary:
			continue
		var entry_is_a_pre_release: bool = one_version_entry.get("prerelease", false)
		if entry_is_a_pre_release:
			continue
		var version_sha: String = one_version_entry.get("version", "")
		if not version_sha.is_empty():
			return version_sha
	push_error("sky130 ciel manifest had no non-prerelease versions; using fallback")
	return SKY130_CIEL_FALLBACK_VERSION_IF_MANIFEST_UNREACHABLE


func request_persistent_browser_storage_on_web() -> void:
	if not OS.has_feature("web"):
		return
	JavaScriptBridge.eval(
			"navigator.storage && navigator.storage.persist && navigator.storage.persist();",
			true)


func stage_bundled_schematic_files_to_writable_directory() -> void:
	DirAccess.make_dir_recursive_absolute(SCHEMATIC_STAGED_DIR)
	for one_bundled_file_name in SCHEMATIC_BUNDLED_FILE_NAMES:
		var bundled_source_path := "%s/%s" % [SCHEMATIC_BUNDLED_DIR, one_bundled_file_name]
		var staged_destination_path := "%s/%s" % [SCHEMATIC_STAGED_DIR, one_bundled_file_name]
		copy_file_via_godot_filesystem(bundled_source_path, staged_destination_path)


func ensure_xschem_devices_library_is_cached() -> void:
	if FileAccess.file_exists(XSCHEM_LOCAL_CACHE_COMPLETE_MARKER):
		print("[spice3d] xschem devices cache HIT (sha=%s)" % XSCHEM_UPSTREAM_GIT_SHA)
		return
	print("[spice3d] xschem devices cache MISS, listing repo via jsDelivr...")
	DirAccess.make_dir_recursive_absolute(XSCHEM_LOCAL_DEVICES_DIRECTORY)
	var device_symbol_repo_paths := await fetch_xschem_device_symbol_paths_via_jsdelivr_listing()
	if device_symbol_repo_paths.is_empty():
		push_error("xschem device-symbol listing returned no paths")
		return
	print("[spice3d] xschem listing returned %d device symbols, fetching in parallel..."
			% device_symbol_repo_paths.size())
	var parallel_fetch_start_milliseconds := Time.get_ticks_msec()
	var successfully_fetched_file_count := await fetch_all_xschem_device_symbol_files_in_parallel(device_symbol_repo_paths)
	var parallel_fetch_duration_milliseconds := Time.get_ticks_msec() - parallel_fetch_start_milliseconds
	print("[spice3d] xschem fetched %d/%d device symbols in %d ms" % [
			successfully_fetched_file_count,
			device_symbol_repo_paths.size(),
			parallel_fetch_duration_milliseconds])
	if successfully_fetched_file_count != device_symbol_repo_paths.size():
		push_error("xschem device-symbol fetch was incomplete; not writing cache-complete marker")
		return
	write_cache_complete_marker_at_path(XSCHEM_LOCAL_CACHE_COMPLETE_MARKER)


func fetch_xschem_device_symbol_paths_via_jsdelivr_listing() -> Array:
	var listing_body := await download_url_as_byte_array(XSCHEM_JSDELIVR_FILE_LISTING_URL)
	if listing_body.is_empty():
		return []
	var parsed_json = JSON.parse_string(listing_body.get_string_from_utf8())
	if parsed_json == null or not parsed_json.has("files"):
		push_error("jsDelivr listing JSON did not contain a 'files' array")
		return []
	var device_symbol_paths_inside_repo := []
	for one_file_entry in parsed_json.files:
		var file_path_inside_repo: String = one_file_entry.get("name", "")
		if not file_path_inside_repo.ends_with(".sym"):
			continue
		if not file_path_inside_repo.contains(XSCHEM_DEVICES_PATH_FRAGMENT_INSIDE_REPO):
			continue
		device_symbol_paths_inside_repo.append(file_path_inside_repo)
	return device_symbol_paths_inside_repo


func fetch_all_xschem_device_symbol_files_in_parallel(device_symbol_repo_paths: Array) -> int:
	var pending_request_count_remaining := [device_symbol_repo_paths.size()]
	var success_count_so_far := [0]
	var all_requests_finished_signal_emitter := AllParallelHttpRequestsFinishedSignalEmitter.new()
	for one_repo_path in device_symbol_repo_paths:
		issue_one_xschem_device_symbol_fetch(
				one_repo_path,
				pending_request_count_remaining,
				success_count_so_far,
				all_requests_finished_signal_emitter)
	if pending_request_count_remaining[0] > 0:
		await all_requests_finished_signal_emitter.all_finished
	return success_count_so_far[0]


func issue_one_xschem_device_symbol_fetch(
		one_repo_path: String,
		pending_request_count_remaining: Array,
		success_count_so_far: Array,
		all_requests_finished_signal_emitter: RefCounted) -> void:
	var http_request := HTTPRequest.new()
	add_child(http_request)
	var jsdelivr_file_url := XSCHEM_JSDELIVR_FILE_URL_TEMPLATE % one_repo_path
	http_request.request_completed.connect(func(result: int, status_code: int, _headers: PackedStringArray, body: PackedByteArray) -> void:
		handle_one_xschem_device_symbol_fetch_completion(
				one_repo_path,
				result,
				status_code,
				body,
				http_request,
				pending_request_count_remaining,
				success_count_so_far,
				all_requests_finished_signal_emitter), CONNECT_ONE_SHOT)
	var request_error := http_request.request(jsdelivr_file_url)
	if request_error != OK:
		push_error("HTTPRequest.request returned %d for %s" % [request_error, jsdelivr_file_url])
		http_request.queue_free()
		decrement_pending_request_count_and_emit_when_done(
				pending_request_count_remaining, all_requests_finished_signal_emitter)


func handle_one_xschem_device_symbol_fetch_completion(
		one_repo_path: String,
		result: int,
		status_code: int,
		body: PackedByteArray,
		http_request: HTTPRequest,
		pending_request_count_remaining: Array,
		success_count_so_far: Array,
		all_requests_finished_signal_emitter: RefCounted) -> void:
	http_request.queue_free()
	if result == HTTPRequest.RESULT_SUCCESS and status_code == 200:
		var symbol_file_name := one_repo_path.get_file()
		var destination_path := XSCHEM_LOCAL_DEVICES_DIRECTORY + "/" + symbol_file_name
		var destination_file := FileAccess.open(destination_path, FileAccess.WRITE)
		destination_file.store_buffer(body)
		destination_file.close()
		success_count_so_far[0] += 1
	else:
		push_error("xschem device-symbol fetch failed: %s (result=%d status=%d)" % [
				one_repo_path, result, status_code])
	decrement_pending_request_count_and_emit_when_done(
			pending_request_count_remaining, all_requests_finished_signal_emitter)


func decrement_pending_request_count_and_emit_when_done(
		pending_request_count_remaining: Array,
		all_requests_finished_signal_emitter: RefCounted) -> void:
	pending_request_count_remaining[0] -= 1
	if pending_request_count_remaining[0] <= 0:
		all_requests_finished_signal_emitter.all_finished.emit()


func ensure_sky130_pdk_is_cached_using_extractor_node(spice3d_root_node: Node, sky130_ciel_version: String) -> void:
	var local_cache_root_user_path := user_path_for_sky130_cache_root(sky130_ciel_version)
	var local_cache_complete_marker_user_path := local_cache_root_user_path + "/.fetch_complete"
	if FileAccess.file_exists(local_cache_complete_marker_user_path):
		print("[spice3d] sky130 PDK cache HIT (version=%s)" % sky130_ciel_version)
		return
	print("[spice3d] sky130 PDK cache MISS, fetching release metadata from GitHub API...")
	DirAccess.make_dir_recursive_absolute(local_cache_root_user_path)
	var release_metadata := await fetch_sky130_release_metadata_from_github_api(sky130_ciel_version)
	if release_metadata.is_empty() or not release_metadata.has("assets"):
		push_error("sky130 release metadata fetch returned no assets")
		return
	var expected_sha256_hex_by_archive_filename := build_expected_sha256_lookup_table(release_metadata)
	var upstream_download_url_by_archive_filename := build_upstream_download_url_lookup_table(release_metadata)
	for one_archive_filename in SKY130_ARCHIVE_FILENAMES_TO_FETCH_AT_STARTUP:
		var was_successfully_extracted := await fetch_verify_and_extract_one_sky130_archive(
				one_archive_filename,
				upstream_download_url_by_archive_filename.get(one_archive_filename, ""),
				expected_sha256_hex_by_archive_filename.get(one_archive_filename, ""),
				spice3d_root_node,
				sky130_ciel_version)
		if not was_successfully_extracted:
			push_error("sky130 archive %s failed; not writing cache-complete marker" % one_archive_filename)
			return
	write_cache_complete_marker_at_path(local_cache_complete_marker_user_path)
	print("[spice3d] sky130 PDK cache populated (version=%s)" % sky130_ciel_version)


func fetch_sky130_release_metadata_from_github_api(sky130_ciel_version: String) -> Dictionary:
	var github_release_api_url := \
			"https://api.github.com/repos/fossi-foundation/ciel-releases/releases/tags/sky130-" + sky130_ciel_version
	var release_metadata_body := await download_url_as_byte_array(github_release_api_url)
	if release_metadata_body.is_empty():
		return {}
	var parsed_release_metadata = JSON.parse_string(release_metadata_body.get_string_from_utf8())
	if parsed_release_metadata == null or not parsed_release_metadata is Dictionary:
		push_error("sky130 release metadata did not parse as a JSON dictionary")
		return {}
	return parsed_release_metadata


func build_expected_sha256_lookup_table(release_metadata: Dictionary) -> Dictionary:
	var table_by_archive_filename := {}
	for one_release_asset in release_metadata.assets:
		var asset_filename: String = one_release_asset.get("name", "")
		var asset_digest_with_algorithm_prefix: String = one_release_asset.get("digest", "")
		if asset_filename.is_empty() or asset_digest_with_algorithm_prefix.is_empty():
			continue
		table_by_archive_filename[asset_filename] = asset_digest_with_algorithm_prefix.trim_prefix("sha256:")
	return table_by_archive_filename


func build_upstream_download_url_lookup_table(release_metadata: Dictionary) -> Dictionary:
	var table_by_archive_filename := {}
	for one_release_asset in release_metadata.assets:
		var asset_filename: String = one_release_asset.get("name", "")
		var asset_browser_download_url: String = one_release_asset.get("browser_download_url", "")
		if asset_filename.is_empty() or asset_browser_download_url.is_empty():
			continue
		table_by_archive_filename[asset_filename] = asset_browser_download_url
	return table_by_archive_filename


func fetch_verify_and_extract_one_sky130_archive(
		archive_filename: String,
		upstream_github_download_url: String,
		expected_sha256_hex: String,
		spice3d_root_node: Node,
		sky130_ciel_version: String) -> bool:
	if upstream_github_download_url.is_empty() or expected_sha256_hex.is_empty():
		push_error("sky130 %s: missing download url or expected digest in release metadata" % archive_filename)
		return false
	print("[spice3d] sky130 fetching %s via cors-proxy worker..." % archive_filename)
	var fetch_start_milliseconds := Time.get_ticks_msec()
	var proxied_download_url := SKY130_CORS_PROXY_URL_PREFIX + upstream_github_download_url.uri_encode()
	var archive_bytes := await download_url_as_byte_array(proxied_download_url)
	if archive_bytes.is_empty():
		push_error("sky130 %s download failed via cors-proxy worker" % archive_filename)
		return false
	var fetch_duration_milliseconds := Time.get_ticks_msec() - fetch_start_milliseconds
	print("[spice3d] sky130 downloaded %s (%d bytes, %d ms)" % [
			archive_filename, archive_bytes.size(), fetch_duration_milliseconds])
	var actual_sha256_hex := compute_sha256_hex_of_byte_array(archive_bytes)
	if actual_sha256_hex != expected_sha256_hex:
		push_error("sky130 %s SHA-256 mismatch: expected %s, got %s" % [
				archive_filename, expected_sha256_hex, actual_sha256_hex])
		return false
	print("[spice3d] sky130 %s SHA-256 verified" % archive_filename)
	var extract_start_milliseconds := Time.get_ticks_msec()
	var extraction_result: Dictionary = spice3d_root_node.extract_zstd_tar_archive_filtered_by_path_substring(
			archive_bytes,
			absolute_path_for_sky130_local_cache_root(sky130_ciel_version),
			PackedStringArray(SKY130_PATH_SUBSTRINGS_TO_KEEP_DURING_EXTRACTION))
	if not extraction_result["was_successful"]:
		push_error("sky130 %s extraction failed: %s" % [
				archive_filename, str(extraction_result.get("error_message", ""))])
		return false
	var extract_duration_milliseconds := Time.get_ticks_msec() - extract_start_milliseconds
	print("[spice3d] sky130 %s extracted %d files (%d bytes) in %d ms" % [
			archive_filename,
			extraction_result["extracted_file_count"],
			extraction_result["total_bytes_written"],
			extract_duration_milliseconds])
	return true


func compute_sha256_hex_of_byte_array(input_bytes: PackedByteArray) -> String:
	var hashing_context := HashingContext.new()
	hashing_context.start(HashingContext.HASH_SHA256)
	hashing_context.update(input_bytes)
	return hashing_context.finish().hex_encode()


func write_cache_complete_marker_at_path(marker_absolute_path: String) -> void:
	var marker_file := FileAccess.open(marker_absolute_path, FileAccess.WRITE)
	marker_file.store_string("ok\n")
	marker_file.close()


func download_url_as_byte_array(url: String) -> PackedByteArray:
	var http_request := HTTPRequest.new()
	add_child(http_request)
	var request_error := http_request.request(url)
	if request_error != OK:
		push_error("HTTPRequest.request returned %d for %s" % [request_error, url])
		http_request.queue_free()
		return PackedByteArray()
	var completion = await http_request.request_completed
	var http_result: int = completion[0]
	var http_status_code: int = completion[1]
	var response_body: PackedByteArray = completion[3]
	http_request.queue_free()
	if http_result != HTTPRequest.RESULT_SUCCESS or http_status_code != 200:
		push_error("download failed: result=%d status=%d url=%s" % [http_result, http_status_code, url])
		return PackedByteArray()
	return response_body


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
	return "%s/examples/%s/%s" % [OS.get_user_data_dir(), ACTIVE_EXAMPLE_DIRECTORY_NAME, staged_file_name]


func absolute_path_for_xschem_devices_library_directory() -> String:
	return "%s/xschem_stdlib/%s/devices" % [OS.get_user_data_dir(), XSCHEM_UPSTREAM_GIT_SHA]


func absolute_path_for_sky130_local_cache_root(sky130_ciel_version: String) -> String:
	return "%s/sky130/%s" % [OS.get_user_data_dir(), sky130_ciel_version]


func user_path_for_sky130_cache_root(sky130_ciel_version: String) -> String:
	return "user://sky130/" + sky130_ciel_version


func absolute_path_for_sky130_xschem_library_directory_for_sky130a_variant(sky130_ciel_version: String) -> String:
	return absolute_path_for_sky130_local_cache_root(sky130_ciel_version) + "/sky130A/libs.tech/xschem"


func absolute_path_for_sky130_xschem_library_directory_for_sky130b_variant(sky130_ciel_version: String) -> String:
	return absolute_path_for_sky130_local_cache_root(sky130_ciel_version) + "/sky130B/libs.tech/xschem"


func update_status_text(spice3d_root_node: Node, loaded_schematic: Dictionary) -> void:
	var status_text := "spice3d %s\nbackend: %s\n%s — %d components, %d wires" % [
		spice3d_root_node.get_spice3d_version(),
		spice3d_root_node.describe_simulator_backend(),
		loaded_schematic["cell_name"],
		loaded_schematic["component_instances"].size(),
		loaded_schematic["wires"].size(),
	]
	if not loaded_schematic["was_successful"]:
		status_text += "\nload error: " + str(loaded_schematic["error_message"])
	status_label.text = status_text
	print(status_text)


class AllParallelHttpRequestsFinishedSignalEmitter:
	extends RefCounted
	signal all_finished
