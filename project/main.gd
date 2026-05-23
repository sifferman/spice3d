extends Node3D

@onready var schematic_view: Node3D = $SchematicView
@onready var status_label: Label = $StatusOverlay/StatusLabel

const SCHEMATIC_BUNDLED_DIR := "res://examples/button"
const SCHEMATIC_STAGED_DIR := "user://examples/button"
const SCHEMATIC_BUNDLED_FILE_NAMES := ["button_test.sch", "button.sym"]
const TOP_SCHEMATIC_FILE_NAME := "button_test.sch"

const XSCHEM_UPSTREAM_GIT_SHA := "d7f3980301eb9f12954a8542d55b188ffe851770"
const XSCHEM_UPSTREAM_ZIP_URL := \
		"https://github.com/StefanSchippers/xschem/archive/" + XSCHEM_UPSTREAM_GIT_SHA + ".zip"
const XSCHEM_LOCAL_CACHE_ROOT := "user://xschem_stdlib/" + XSCHEM_UPSTREAM_GIT_SHA
const XSCHEM_LOCAL_DEVICES_DIRECTORY := XSCHEM_LOCAL_CACHE_ROOT + "/devices"
const XSCHEM_LOCAL_CACHE_COMPLETE_MARKER := XSCHEM_LOCAL_CACHE_ROOT + "/.fetch_complete"
const XSCHEM_LOCAL_TEMPORARY_ZIP_PATH := XSCHEM_LOCAL_CACHE_ROOT + "/source.zip"
const XSCHEM_DEVICES_PATH_FRAGMENT_INSIDE_ARCHIVE := "/xschem_library/devices/"


func _ready() -> void:
	request_persistent_browser_storage_on_web()
	stage_bundled_schematic_files_to_writable_directory()
	await ensure_xschem_devices_library_is_cached()
	var spice3d_root_node := Spice3DNode.new()
	add_child(spice3d_root_node)
	var staged_top_schematic_absolute_path := absolute_path_for_staged_schematic_file(TOP_SCHEMATIC_FILE_NAME)
	var extra_symbol_search_directories := PackedStringArray([
		absolute_path_for_xschem_devices_library_directory(),
	])
	var loaded_schematic := spice3d_root_node.load_schematic_and_render_into_node3d(
			schematic_view,
			staged_top_schematic_absolute_path,
			"",
			extra_symbol_search_directories)
	update_status_text(spice3d_root_node, loaded_schematic)


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
	print("[spice3d] xschem devices cache MISS, fetching %s" % XSCHEM_UPSTREAM_ZIP_URL)
	DirAccess.make_dir_recursive_absolute(XSCHEM_LOCAL_DEVICES_DIRECTORY)
	var fetch_start_milliseconds := Time.get_ticks_msec()
	var downloaded_zip_bytes := await download_url_as_byte_array(XSCHEM_UPSTREAM_ZIP_URL)
	if downloaded_zip_bytes.is_empty():
		push_error("xschem upstream zip download failed")
		return
	print("[spice3d] xschem zip downloaded: %d bytes, %d ms" % [
			downloaded_zip_bytes.size(), Time.get_ticks_msec() - fetch_start_milliseconds])
	var extract_start_milliseconds := Time.get_ticks_msec()
	var extracted_device_symbol_count := extract_xschem_devices_from_zip_bytes_to_local_cache(downloaded_zip_bytes)
	if extracted_device_symbol_count <= 0:
		push_error("no xschem device symbols extracted from downloaded zip")
		return
	print("[spice3d] xschem extracted %d device symbols in %d ms" % [
			extracted_device_symbol_count, Time.get_ticks_msec() - extract_start_milliseconds])
	write_cache_complete_marker_for_xschem_devices()


func extract_xschem_devices_from_zip_bytes_to_local_cache(zip_bytes: PackedByteArray) -> int:
	save_zip_bytes_to_temporary_path(zip_bytes)
	var zip_reader := ZIPReader.new()
	var zip_open_error := zip_reader.open(XSCHEM_LOCAL_TEMPORARY_ZIP_PATH)
	if zip_open_error != OK:
		push_error("ZIPReader.open failed: %d" % zip_open_error)
		return 0
	var device_symbol_entry_paths_inside_archive := filter_zip_entries_to_device_symbol_files(
			zip_reader.get_files())
	for one_entry_path_inside_archive in device_symbol_entry_paths_inside_archive:
		var entry_bytes := zip_reader.read_file(one_entry_path_inside_archive)
		var symbol_file_name := one_entry_path_inside_archive.get_file()
		var symbol_destination_path := XSCHEM_LOCAL_DEVICES_DIRECTORY + "/" + symbol_file_name
		var destination_file := FileAccess.open(symbol_destination_path, FileAccess.WRITE)
		destination_file.store_buffer(entry_bytes)
		destination_file.close()
	zip_reader.close()
	DirAccess.remove_absolute(XSCHEM_LOCAL_TEMPORARY_ZIP_PATH)
	return device_symbol_entry_paths_inside_archive.size()


func save_zip_bytes_to_temporary_path(zip_bytes: PackedByteArray) -> void:
	var temporary_zip_file := FileAccess.open(XSCHEM_LOCAL_TEMPORARY_ZIP_PATH, FileAccess.WRITE)
	temporary_zip_file.store_buffer(zip_bytes)
	temporary_zip_file.close()


func filter_zip_entries_to_device_symbol_files(all_entry_paths_inside_archive: PackedStringArray) -> PackedStringArray:
	var filtered_entry_paths := PackedStringArray()
	for one_entry_path in all_entry_paths_inside_archive:
		if not one_entry_path.ends_with(".sym"):
			continue
		if not one_entry_path.contains(XSCHEM_DEVICES_PATH_FRAGMENT_INSIDE_ARCHIVE):
			continue
		filtered_entry_paths.append(one_entry_path)
	return filtered_entry_paths


func write_cache_complete_marker_for_xschem_devices() -> void:
	var marker_file := FileAccess.open(XSCHEM_LOCAL_CACHE_COMPLETE_MARKER, FileAccess.WRITE)
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
	return "%s/examples/button/%s" % [OS.get_user_data_dir(), staged_file_name]


func absolute_path_for_xschem_devices_library_directory() -> String:
	return "%s/xschem_stdlib/%s/devices" % [OS.get_user_data_dir(), XSCHEM_UPSTREAM_GIT_SHA]


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
