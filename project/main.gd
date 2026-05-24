extends Node3D

@onready var schematic_view: Node3D = $SchematicView
@onready var status_label: Label = $StatusOverlay/StatusLabel

const ACTIVE_EXAMPLE_DIRECTORY_NAME := "inverter"
const SCHEMATIC_BUNDLED_DIR := "res://examples/" + ACTIVE_EXAMPLE_DIRECTORY_NAME
const SCHEMATIC_STAGED_DIR := "user://examples/" + ACTIVE_EXAMPLE_DIRECTORY_NAME
const SCHEMATIC_BUNDLED_FILE_NAMES := ["sky130_fd_sc_hd__inv_1.sch"]
const TOP_SCHEMATIC_FILE_NAME := "sky130_fd_sc_hd__inv_1.sch"

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
const SKY130_ARCHIVE_FILENAMES_TO_FETCH_AT_STARTUP := ["common.tar.zst"]
const SKY130_PATH_SUBSTRINGS_TO_KEEP_DURING_EXTRACTION := [
	"/libs.tech/combined/",
	"/libs.tech/xschem/",
]


func _ready() -> void:
	request_persistent_browser_storage_on_web()
	var spice3d_root_node := Spice3DNode.new()
	add_child(spice3d_root_node)
	stage_bundled_schematic_files_to_writable_directory()
	await ensure_xschem_devices_library_is_cached()
	var sky130_ciel_version := await resolve_latest_sky130_ciel_version_from_manifest_with_fallback()
	print("[spice3d] sky130 ciel version selected: %s" % sky130_ciel_version)
	await ensure_sky130_pdk_is_cached_using_extractor_node(spice3d_root_node, sky130_ciel_version)
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
	update_status_text(spice3d_root_node, loaded_schematic)


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
