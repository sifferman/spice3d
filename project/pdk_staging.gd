extends Node


const XSCHEM_UPSTREAM_GIT_SHA := "d7f3980301eb9f12954a8542d55b188ffe851770"
const XSCHEM_JSDELIVR_FILE_LISTING_URL := \
		"https://data.jsdelivr.com/v1/packages/gh/StefanSchippers/xschem@" + XSCHEM_UPSTREAM_GIT_SHA + "?structure=flat"
const XSCHEM_JSDELIVR_FILE_URL_TEMPLATE := \
		"https://cdn.jsdelivr.net/gh/StefanSchippers/xschem@" + XSCHEM_UPSTREAM_GIT_SHA + "%s"
const XSCHEM_LOCAL_CACHE_ROOT := "user://xschem_stdlib/" + XSCHEM_UPSTREAM_GIT_SHA
const XSCHEM_LOCAL_DEVICES_DIRECTORY := XSCHEM_LOCAL_CACHE_ROOT + "/devices"
const XSCHEM_LOCAL_CACHE_COMPLETE_MARKER := XSCHEM_LOCAL_CACHE_ROOT + "/.fetch_complete"
const XSCHEM_DEVICES_PATH_FRAGMENT_INSIDE_REPO := "/xschem_library/devices/"

const PDK_CIEL_CORS_PROXY_URL_PREFIX := "https://ciel-cors-proxy.sifferman.workers.dev/?url="

const SKY130_FAMILY_SPEC := {
	"name": "sky130",
	"cache_key_revision": 2,
	"variants_to_expose_xschem_libraries_for": ["sky130A", "sky130B"],
	"ciel_manifest_url": "https://www-archive.fossi-foundation.org/ciel-releases/sky130/manifest.json",
	"ciel_fallback_version_if_manifest_unreachable": "74c0e6b118a67d94c24172143d3bd597473fa63d",
	"ciel_github_release_tag_prefix": "sky130-",
	"ciel_github_release_repo": "fossi-foundation/ciel-releases",
	"archive_filenames_to_fetch_at_startup": [
		"common.tar.zst",
		"sky130_fd_pr.tar.zst",
		"sky130_fd_sc_hd.tar.zst",
	],
	"archive_path_substrings_to_keep_during_extraction": [
		"/libs.tech/combined/",
		"/libs.tech/xschem/",
		"/libs.ref/sky130_fd_pr/spice/",
		"/libs.ref/sky130_fd_sc_hd/spice/sky130_fd_sc_hd.spice",
		"/libs.ref/sky130_fd_sc_hd/lib/sky130_fd_sc_hd__tt_025C_1v80.lib",
	],
	"pdk_source_subdirectories_relative_to_ciel_root_to_stage_into_worker": [
		"/sky130A/libs.tech/combined",
		"/sky130A/libs.ref/sky130_fd_pr/spice",
		"/sky130A/libs.ref/sky130_fd_sc_hd/spice",
	],
	"stdcell_subckt_spice_relative_path_inside_ciel_root_for_yosys_synth": "/sky130A/libs.ref/sky130_fd_sc_hd/spice/sky130_fd_sc_hd.spice",
	"stdcell_timing_liberty_relative_path_inside_ciel_root_for_yosys_synth": "/sky130A/libs.ref/sky130_fd_sc_hd/lib/sky130_fd_sc_hd__tt_025C_1v80.lib",
	"stdcell_power_rail_net_names_in_subckt_port_order": ["VGND", "VNB", "VPB", "VPWR"],
}

const GF180MCU_FAMILY_SPEC := {
	"name": "gf180mcu",
	"cache_key_revision": 3,
	"variants_to_expose_xschem_libraries_for": ["gf180mcuA", "gf180mcuB", "gf180mcuC", "gf180mcuD"],
	"ciel_manifest_url": "https://www-archive.fossi-foundation.org/ciel-releases/gf180mcu/manifest.json",
	"ciel_fallback_version_if_manifest_unreachable": "61a056e180dac7dcc6d4eb7529e2231f95105746",
	"ciel_github_release_tag_prefix": "gf180mcu-",
	"ciel_github_release_repo": "fossi-foundation/ciel-releases",
	"archive_filenames_to_fetch_at_startup": [
		"common.tar.zst",
	],
	"archive_path_substrings_to_keep_during_extraction": [
		"/libs.tech/ngspice/",
		"/libs.tech/xschem/",
	],
	"pdk_source_subdirectories_relative_to_ciel_root_to_stage_into_worker": [
		"/gf180mcuD/libs.tech/ngspice",
	],
	"stdcell_subckt_spice_relative_path_inside_ciel_root_for_yosys_synth": "",
	"stdcell_timing_liberty_relative_path_inside_ciel_root_for_yosys_synth": "",
	"stdcell_power_rail_net_names_in_subckt_port_order": ["VDD", "VNW", "VPW", "VSS"],
}

const PDK_FAMILY_SPECS_BY_NAME := {
	"sky130": SKY130_FAMILY_SPEC,
	"gf180mcu": GF180MCU_FAMILY_SPEC,
}


static func family_spec_for(pdk_family_name: String) -> Dictionary:
	if not PDK_FAMILY_SPECS_BY_NAME.has(pdk_family_name):
		push_error("unknown PDK family '%s' — known families: %s" % [
				pdk_family_name, str(PDK_FAMILY_SPECS_BY_NAME.keys())])
		return SKY130_FAMILY_SPEC
	return PDK_FAMILY_SPECS_BY_NAME[pdk_family_name]


static func absolute_path_for_xschem_devices_library_directory() -> String:
	return "%s/xschem_stdlib/%s/devices" % [OS.get_user_data_dir(), XSCHEM_UPSTREAM_GIT_SHA]


static func absolute_path_for_pdk_family_local_cache_root(pdk_family_name: String, ciel_version: String) -> String:
	return "%s/%s/%s" % [OS.get_user_data_dir(), pdk_family_name, ciel_version]


static func user_path_for_pdk_family_cache_root(pdk_family_name: String, ciel_version: String) -> String:
	return "user://%s/%s" % [pdk_family_name, ciel_version]


static func absolute_path_for_pdk_stdcell_subckt_spice_used_by_yosys_synth(
		pdk_family_name: String, ciel_version: String) -> String:
	var spec := family_spec_for(pdk_family_name)
	var relative_path: String = spec["stdcell_subckt_spice_relative_path_inside_ciel_root_for_yosys_synth"]
	if relative_path.is_empty():
		return ""
	return absolute_path_for_pdk_family_local_cache_root(pdk_family_name, ciel_version) + relative_path


static func absolute_path_for_pdk_stdcell_timing_liberty_used_by_yosys_synth(
		pdk_family_name: String, ciel_version: String) -> String:
	var spec := family_spec_for(pdk_family_name)
	var relative_path: String = spec["stdcell_timing_liberty_relative_path_inside_ciel_root_for_yosys_synth"]
	if relative_path.is_empty():
		return ""
	return absolute_path_for_pdk_family_local_cache_root(pdk_family_name, ciel_version) + relative_path


static func stdcell_power_rail_net_names_in_subckt_port_order_for(pdk_family_name: String) -> PackedStringArray:
	return PackedStringArray(family_spec_for(pdk_family_name)["stdcell_power_rail_net_names_in_subckt_port_order"])


static func absolute_path_for_pdk_xschem_library_directory(
		pdk_family_name: String, ciel_version: String, pdk_variant_name: String) -> String:
	return "%s/%s/libs.tech/xschem" % [
			absolute_path_for_pdk_family_local_cache_root(pdk_family_name, ciel_version),
			pdk_variant_name]


static func absolute_paths_for_all_pdk_xschem_library_directories(
		pdk_family_name: String, ciel_version: String) -> PackedStringArray:
	var directories := PackedStringArray()
	for one_variant in family_spec_for(pdk_family_name)["variants_to_expose_xschem_libraries_for"]:
		directories.append(absolute_path_for_pdk_xschem_library_directory(
				pdk_family_name, ciel_version, one_variant))
	return directories


func resolve_latest_pdk_ciel_version_from_manifest_with_fallback(pdk_family_name: String) -> String:
	var spec := family_spec_for(pdk_family_name)
	var manifest_url: String = spec["ciel_manifest_url"]
	var fallback_version: String = spec["ciel_fallback_version_if_manifest_unreachable"]
	var manifest_body := await download_url_as_byte_array(manifest_url)
	if manifest_body.is_empty():
		print("[spice3d] %s ciel version manifest unreachable; using fallback %s" % [
				pdk_family_name, fallback_version])
		return fallback_version
	var parsed_manifest = JSON.parse_string(manifest_body.get_string_from_utf8())
	if parsed_manifest == null or not parsed_manifest.has("versions"):
		push_error("%s ciel manifest did not parse as a 'versions' dictionary; using fallback" % pdk_family_name)
		return fallback_version
	for one_version_entry in parsed_manifest.versions:
		if not one_version_entry is Dictionary:
			continue
		var entry_is_a_pre_release: bool = one_version_entry.get("prerelease", false)
		if entry_is_a_pre_release:
			continue
		var version_sha: String = one_version_entry.get("version", "")
		if not version_sha.is_empty():
			return version_sha
	push_error("%s ciel manifest had no non-prerelease versions; using fallback" % pdk_family_name)
	return fallback_version


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


static func decrement_pending_request_count_and_emit_when_done(
		pending_request_count_remaining: Array,
		all_requests_finished_signal_emitter: RefCounted) -> void:
	pending_request_count_remaining[0] -= 1
	if pending_request_count_remaining[0] <= 0:
		all_requests_finished_signal_emitter.all_finished.emit()


func ensure_pdk_family_is_cached_using_extractor_node(
		spice3d_root_node: Node,
		pdk_family_name: String,
		ciel_version: String) -> void:
	var spec := family_spec_for(pdk_family_name)
	var cache_key_revision: int = spec["cache_key_revision"]
	var local_cache_root_user_path := user_path_for_pdk_family_cache_root(pdk_family_name, ciel_version)
	var local_cache_complete_marker_user_path := "%s/.fetch_complete_rev%d" % [
			local_cache_root_user_path, cache_key_revision]
	if FileAccess.file_exists(local_cache_complete_marker_user_path):
		print("[spice3d] %s PDK cache HIT (version=%s rev=%d)" % [
				pdk_family_name, ciel_version, cache_key_revision])
		return
	print("[spice3d] %s PDK cache MISS, fetching release metadata from GitHub API..." % pdk_family_name)
	DirAccess.make_dir_recursive_absolute(local_cache_root_user_path)
	var release_metadata := await fetch_pdk_release_metadata_from_github_api(pdk_family_name, ciel_version)
	if release_metadata.is_empty() or not release_metadata.has("assets"):
		push_error("%s release metadata fetch returned no assets" % pdk_family_name)
		return
	var expected_sha256_hex_by_archive_filename := build_expected_sha256_lookup_table(release_metadata)
	var upstream_download_url_by_archive_filename := build_upstream_download_url_lookup_table(release_metadata)
	for one_archive_filename in spec["archive_filenames_to_fetch_at_startup"]:
		var was_successfully_extracted := await fetch_verify_and_extract_one_pdk_archive(
				pdk_family_name,
				one_archive_filename,
				upstream_download_url_by_archive_filename.get(one_archive_filename, ""),
				expected_sha256_hex_by_archive_filename.get(one_archive_filename, ""),
				spice3d_root_node,
				ciel_version)
		if not was_successfully_extracted:
			push_error("%s archive %s failed; not writing cache-complete marker" % [
					pdk_family_name, one_archive_filename])
			return
	write_cache_complete_marker_at_path(local_cache_complete_marker_user_path)
	print("[spice3d] %s PDK cache populated (version=%s rev=%d)" % [
			pdk_family_name, ciel_version, cache_key_revision])


func fetch_pdk_release_metadata_from_github_api(
		pdk_family_name: String, ciel_version: String) -> Dictionary:
	var spec := family_spec_for(pdk_family_name)
	var github_release_api_url := "https://api.github.com/repos/%s/releases/tags/%s%s" % [
			spec["ciel_github_release_repo"],
			spec["ciel_github_release_tag_prefix"],
			ciel_version]
	var release_metadata_body := await download_url_as_byte_array(github_release_api_url)
	if release_metadata_body.is_empty():
		return {}
	var parsed_release_metadata = JSON.parse_string(release_metadata_body.get_string_from_utf8())
	if parsed_release_metadata == null or not parsed_release_metadata is Dictionary:
		push_error("%s release metadata did not parse as a JSON dictionary" % pdk_family_name)
		return {}
	return parsed_release_metadata


static func build_expected_sha256_lookup_table(release_metadata: Dictionary) -> Dictionary:
	var table_by_archive_filename := {}
	for one_release_asset in release_metadata.assets:
		var asset_filename: String = one_release_asset.get("name", "")
		var asset_digest_with_algorithm_prefix: String = one_release_asset.get("digest", "")
		if asset_filename.is_empty() or asset_digest_with_algorithm_prefix.is_empty():
			continue
		table_by_archive_filename[asset_filename] = asset_digest_with_algorithm_prefix.trim_prefix("sha256:")
	return table_by_archive_filename


static func build_upstream_download_url_lookup_table(release_metadata: Dictionary) -> Dictionary:
	var table_by_archive_filename := {}
	for one_release_asset in release_metadata.assets:
		var asset_filename: String = one_release_asset.get("name", "")
		var asset_browser_download_url: String = one_release_asset.get("browser_download_url", "")
		if asset_filename.is_empty() or asset_browser_download_url.is_empty():
			continue
		table_by_archive_filename[asset_filename] = asset_browser_download_url
	return table_by_archive_filename


func fetch_verify_and_extract_one_pdk_archive(
		pdk_family_name: String,
		archive_filename: String,
		upstream_github_download_url: String,
		expected_sha256_hex: String,
		spice3d_root_node: Node,
		ciel_version: String) -> bool:
	if upstream_github_download_url.is_empty() or expected_sha256_hex.is_empty():
		push_error("%s %s: missing download url or expected digest in release metadata" % [
				pdk_family_name, archive_filename])
		return false
	var spec := family_spec_for(pdk_family_name)
	var proxied_download_url := PDK_CIEL_CORS_PROXY_URL_PREFIX + upstream_github_download_url.uri_encode()
	var output_directory_absolute_path := absolute_path_for_pdk_family_local_cache_root(pdk_family_name, ciel_version)
	var path_substrings_to_keep := PackedStringArray(spec["archive_path_substrings_to_keep_during_extraction"])
	if OS.has_feature("web"):
		return await fetch_verify_and_extract_one_pdk_archive_via_streaming_on_web(
				pdk_family_name, archive_filename, proxied_download_url, expected_sha256_hex,
				spice3d_root_node, output_directory_absolute_path, path_substrings_to_keep)
	return await fetch_verify_and_extract_one_pdk_archive_via_buffered_download_on_native(
			pdk_family_name, archive_filename, proxied_download_url, expected_sha256_hex,
			spice3d_root_node, output_directory_absolute_path, path_substrings_to_keep)


func fetch_verify_and_extract_one_pdk_archive_via_buffered_download_on_native(
		pdk_family_name: String,
		archive_filename: String,
		proxied_download_url: String,
		expected_sha256_hex: String,
		spice3d_root_node: Node,
		output_directory_absolute_path: String,
		path_substrings_to_keep: PackedStringArray) -> bool:
	print("[spice3d] %s fetching %s (native buffered path)..." % [pdk_family_name, archive_filename])
	var fetch_start_milliseconds := Time.get_ticks_msec()
	var archive_bytes := await download_url_as_byte_array(proxied_download_url)
	if archive_bytes.is_empty():
		push_error("%s %s download failed" % [pdk_family_name, archive_filename])
		return false
	print("[spice3d] %s downloaded %s (%d bytes, %d ms)" % [
			pdk_family_name, archive_filename, archive_bytes.size(),
			Time.get_ticks_msec() - fetch_start_milliseconds])
	var actual_sha256_hex := compute_sha256_hex_of_byte_array(archive_bytes)
	if actual_sha256_hex != expected_sha256_hex:
		push_error("%s %s SHA-256 mismatch: expected %s, got %s" % [
				pdk_family_name, archive_filename, expected_sha256_hex, actual_sha256_hex])
		return false
	var extract_start_milliseconds := Time.get_ticks_msec()
	var extraction_result: Dictionary = spice3d_root_node.extract_zstd_tar_archive_filtered_by_path_substring(
			archive_bytes, output_directory_absolute_path, path_substrings_to_keep)
	if not extraction_result["was_successful"]:
		push_error("%s %s extraction failed: %s" % [
				pdk_family_name, archive_filename, str(extraction_result.get("error_message", ""))])
		return false
	print("[spice3d] %s %s extracted %d files (%d bytes) in %d ms" % [
			pdk_family_name, archive_filename,
			extraction_result["extracted_file_count"], extraction_result["total_bytes_written"],
			Time.get_ticks_msec() - extract_start_milliseconds])
	return true


const STREAMING_DOWNLOAD_POLL_INTERVAL_SECONDS_BETWEEN_EMPTY_RESPONSES := 0.05


func fetch_verify_and_extract_one_pdk_archive_via_streaming_on_web(
		pdk_family_name: String,
		archive_filename: String,
		proxied_download_url: String,
		expected_sha256_hex: String,
		spice3d_root_node: Node,
		output_directory_absolute_path: String,
		path_substrings_to_keep: PackedStringArray) -> bool:
	print("[spice3d] %s streaming %s via cors-proxy worker (chunked, low-memory)..."
			% [pdk_family_name, archive_filename])
	var streaming_pipeline_start_milliseconds := Time.get_ticks_msec()
	spice3d_root_node.begin_streaming_zstd_tar_extraction(
			output_directory_absolute_path, path_substrings_to_keep)
	var json_escaped_url := JSON.stringify(proxied_download_url)
	JavaScriptBridge.eval("globalThis.spice3d && globalThis.spice3d.beginStreamingDownload(%s)" % json_escaped_url, true)
	var incremental_sha256 := HashingContext.new()
	incremental_sha256.start(HashingContext.HASH_SHA256)
	var total_chunk_bytes_fed := 0
	while true:
		var bridge_returned_envelope_as_string: String = JavaScriptBridge.eval(
				"globalThis.spice3d && globalThis.spice3d.takeNextStreamingChunkAsJsonStatusEnvelope()", true)
		var parsed_envelope: Dictionary = JSON.parse_string(bridge_returned_envelope_as_string)
		var status_field: String = parsed_envelope.get("status", "")
		if status_field == "chunk":
			var chunk_bytes: PackedByteArray = Marshalls.base64_to_raw(parsed_envelope["base64ChunkBody"])
			incremental_sha256.update(chunk_bytes)
			var feed_result: Dictionary = spice3d_root_node.feed_streaming_zstd_tar_compressed_chunk(chunk_bytes)
			if not feed_result["was_successful"]:
				push_error("%s %s streaming extraction failed after %d bytes fed: %s" % [
						pdk_family_name, archive_filename, total_chunk_bytes_fed,
						str(feed_result["error_message"])])
				abort_streaming_extraction(spice3d_root_node)
				return false
			total_chunk_bytes_fed += chunk_bytes.size()
			continue
		if status_field == "pending":
			await get_tree().create_timer(STREAMING_DOWNLOAD_POLL_INTERVAL_SECONDS_BETWEEN_EMPTY_RESPONSES).timeout
			continue
		if status_field == "done":
			break
		if status_field == "error":
			push_error("%s %s streaming download failed: %s (status=%d)" % [
					pdk_family_name, archive_filename,
					str(parsed_envelope.get("errorMessage", "")),
					int(parsed_envelope.get("httpStatusCode", 0))])
			abort_streaming_extraction(spice3d_root_node)
			return false
		push_error("%s %s streaming download: unknown bridge status '%s'" % [
				pdk_family_name, archive_filename, status_field])
		abort_streaming_extraction(spice3d_root_node)
		return false
	JavaScriptBridge.eval("globalThis.spice3d && globalThis.spice3d.clearStreamingDownloadState()", true)
	var actual_sha256_hex := incremental_sha256.finish().hex_encode()
	if actual_sha256_hex != expected_sha256_hex:
		push_error("%s %s SHA-256 mismatch (streamed): expected %s, got %s" % [
				pdk_family_name, archive_filename, expected_sha256_hex, actual_sha256_hex])
		abort_streaming_extraction(spice3d_root_node)
		return false
	var finalize_result: Dictionary = spice3d_root_node.finalize_streaming_zstd_tar_extraction()
	if not finalize_result["was_successful"]:
		push_error("%s %s streaming finalize failed: %s" % [
				pdk_family_name, archive_filename, str(finalize_result.get("error_message", ""))])
		return false
	print("[spice3d] %s %s streamed+extracted %d bytes -> %d files (%d bytes on disk) in %d ms" % [
			pdk_family_name, archive_filename, total_chunk_bytes_fed,
			finalize_result["extracted_file_count"], finalize_result["total_bytes_written"],
			Time.get_ticks_msec() - streaming_pipeline_start_milliseconds])
	return true


func abort_streaming_extraction(spice3d_root_node: Node) -> void:
	JavaScriptBridge.eval("globalThis.spice3d && globalThis.spice3d.clearStreamingDownloadState()", true)
	spice3d_root_node.finalize_streaming_zstd_tar_extraction()


static func compute_sha256_hex_of_byte_array(input_bytes: PackedByteArray) -> String:
	var hashing_context := HashingContext.new()
	hashing_context.start(HashingContext.HASH_SHA256)
	hashing_context.update(input_bytes)
	return hashing_context.finish().hex_encode()


static func write_cache_complete_marker_at_path(marker_absolute_path: String) -> void:
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


static func stage_pdk_family_files_into_web_simulator_filesystem(
		spice3d_root_node: Node,
		pdk_family_name: String,
		ciel_version: String) -> void:
	var spec := family_spec_for(pdk_family_name)
	var pdk_filesystem_root_path := absolute_path_for_pdk_family_local_cache_root(pdk_family_name, ciel_version)
	var total_staged_file_count := 0
	for one_pdk_subdirectory in spec["pdk_source_subdirectories_relative_to_ciel_root_to_stage_into_worker"]:
		var source_directory_absolute_path: String = pdk_filesystem_root_path + one_pdk_subdirectory
		var virtual_directory_inside_worker: String = one_pdk_subdirectory
		var staged_file_count_for_this_subdirectory := stage_text_files_recursively_into_worker_filesystem(
				spice3d_root_node,
				source_directory_absolute_path,
				virtual_directory_inside_worker)
		total_staged_file_count += staged_file_count_for_this_subdirectory
	print("[spice3d] staged %d %s PDK file(s) into worker MEMFS" % [
			total_staged_file_count, pdk_family_name])


static func stage_text_files_recursively_into_worker_filesystem(
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


class AllParallelHttpRequestsFinishedSignalEmitter:
	extends RefCounted
	signal all_finished
