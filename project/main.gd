extends Node3D

@onready var schematic_view: Node3D = $SchematicView
@onready var status_label: Label = $StatusOverlay/StatusLabel

const SCHEMATIC_BUNDLED_DIR := "res://examples/button"
const SCHEMATIC_STAGED_DIR := "user://examples/button"
const SCHEMATIC_BUNDLED_FILE_NAMES := ["button_test.sch", "button.sym"]
const TOP_SCHEMATIC_FILE_NAME := "button_test.sch"

const XSCHEM_UPSTREAM_GIT_SHA := "d7f3980301eb9f12954a8542d55b188ffe851770"
const XSCHEM_UPSTREAM_RAW_URL_TEMPLATE := \
		"https://raw.githubusercontent.com/StefanSchippers/xschem/%s/xschem_library/devices/%s"
const XSCHEM_STDLIB_CACHE_DIR := "user://xschem_stdlib/" + XSCHEM_UPSTREAM_GIT_SHA
const REQUIRED_STDLIB_SYMBOL_FILE_NAMES := ["opin.sym", "ipin.sym"]


func _ready() -> void:
	stage_bundled_schematic_files_to_writable_directory()
	await ensure_required_stdlib_symbols_are_cached()
	stage_cached_stdlib_symbols_alongside_the_schematic()
	var spice3d_root_node := Spice3DNode.new()
	add_child(spice3d_root_node)
	var staged_top_schematic_path := absolute_path_for_staged_schematic_file(TOP_SCHEMATIC_FILE_NAME)
	var loaded_schematic := spice3d_root_node.load_schematic_and_render_into_node3d(
			schematic_view, staged_top_schematic_path, "")
	update_status_text(spice3d_root_node, loaded_schematic)


func stage_bundled_schematic_files_to_writable_directory() -> void:
	DirAccess.make_dir_recursive_absolute(SCHEMATIC_STAGED_DIR)
	for one_bundled_file_name in SCHEMATIC_BUNDLED_FILE_NAMES:
		var bundled_source_path := "%s/%s" % [SCHEMATIC_BUNDLED_DIR, one_bundled_file_name]
		var staged_destination_path := "%s/%s" % [SCHEMATIC_STAGED_DIR, one_bundled_file_name]
		copy_file_via_godot_filesystem(bundled_source_path, staged_destination_path)


func ensure_required_stdlib_symbols_are_cached() -> void:
	DirAccess.make_dir_recursive_absolute(XSCHEM_STDLIB_CACHE_DIR)
	for one_symbol_file_name in REQUIRED_STDLIB_SYMBOL_FILE_NAMES:
		var cache_path := "%s/%s" % [XSCHEM_STDLIB_CACHE_DIR, one_symbol_file_name]
		if FileAccess.file_exists(cache_path):
			continue
		await download_one_stdlib_symbol_into_cache(one_symbol_file_name, cache_path)


func download_one_stdlib_symbol_into_cache(symbol_file_name: String, cache_destination_path: String) -> void:
	var http_request := HTTPRequest.new()
	add_child(http_request)
	var full_url := XSCHEM_UPSTREAM_RAW_URL_TEMPLATE % [XSCHEM_UPSTREAM_GIT_SHA, symbol_file_name]
	var request_error := http_request.request(full_url)
	if request_error != OK:
		push_error("HTTPRequest.request returned %d for %s" % [request_error, full_url])
		http_request.queue_free()
		return
	var completion = await http_request.request_completed
	var http_result: int = completion[0]
	var http_status_code: int = completion[1]
	var response_body: PackedByteArray = completion[3]
	http_request.queue_free()
	if http_result != HTTPRequest.RESULT_SUCCESS or http_status_code != 200:
		push_error("failed to fetch %s: result=%d status=%d" % [symbol_file_name, http_result, http_status_code])
		return
	var cache_file := FileAccess.open(cache_destination_path, FileAccess.WRITE)
	cache_file.store_buffer(response_body)
	cache_file.close()


func stage_cached_stdlib_symbols_alongside_the_schematic() -> void:
	for one_symbol_file_name in REQUIRED_STDLIB_SYMBOL_FILE_NAMES:
		var cache_source_path := "%s/%s" % [XSCHEM_STDLIB_CACHE_DIR, one_symbol_file_name]
		var staged_destination_path := "%s/%s" % [SCHEMATIC_STAGED_DIR, one_symbol_file_name]
		copy_file_via_godot_filesystem(cache_source_path, staged_destination_path)


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
