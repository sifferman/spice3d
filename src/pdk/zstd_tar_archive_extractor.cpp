#include "zstd_tar_archive_extractor.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <memory>

#include "zstd.h"

namespace spice3d {

namespace {

constexpr std::size_t TAR_BLOCK_SIZE_IN_BYTES = 512;
constexpr std::size_t USTAR_NAME_FIELD_OFFSET = 0;
constexpr std::size_t USTAR_NAME_FIELD_LENGTH = 100;
constexpr std::size_t USTAR_SIZE_FIELD_OFFSET = 124;
constexpr std::size_t USTAR_SIZE_FIELD_LENGTH = 12;
constexpr std::size_t USTAR_TYPEFLAG_FIELD_OFFSET = 156;
constexpr std::size_t USTAR_MAGIC_FIELD_OFFSET = 257;
constexpr std::size_t USTAR_PREFIX_FIELD_OFFSET = 345;
constexpr std::size_t USTAR_PREFIX_FIELD_LENGTH = 155;
constexpr char USTAR_TYPEFLAG_REGULAR_FILE_PRIMARY = '0';
constexpr char USTAR_TYPEFLAG_REGULAR_FILE_LEGACY_NUL = '\0';

bool block_is_all_zero_bytes(const std::uint8_t *block_start) {
	for (std::size_t byte_index = 0; byte_index < TAR_BLOCK_SIZE_IN_BYTES; ++byte_index) {
		if (block_start[byte_index] != 0) return false;
	}
	return true;
}

std::string null_terminated_string_from_field(const std::uint8_t *field_start, std::size_t field_max_length) {
	std::size_t actual_length = 0;
	while (actual_length < field_max_length && field_start[actual_length] != 0) {
		++actual_length;
	}
	return std::string(reinterpret_cast<const char *>(field_start), actual_length);
}

std::int64_t parse_octal_size_field(const std::uint8_t *field_start, std::size_t field_max_length) {
	std::int64_t parsed_value = 0;
	for (std::size_t byte_index = 0; byte_index < field_max_length; ++byte_index) {
		const char one_character = static_cast<char>(field_start[byte_index]);
		if (one_character < '0' || one_character > '7') break;
		parsed_value = (parsed_value * 8) + (one_character - '0');
	}
	return parsed_value;
}

std::string full_path_from_tar_header(const std::uint8_t *tar_header_block_start) {
	const std::string name_part = null_terminated_string_from_field(
			tar_header_block_start + USTAR_NAME_FIELD_OFFSET, USTAR_NAME_FIELD_LENGTH);
	const std::string prefix_part = null_terminated_string_from_field(
			tar_header_block_start + USTAR_PREFIX_FIELD_OFFSET, USTAR_PREFIX_FIELD_LENGTH);
	if (prefix_part.empty()) return name_part;
	return prefix_part + std::string("/") + name_part;
}

bool tar_header_is_ustar_magic(const std::uint8_t *tar_header_block_start) {
	const char *magic_field = reinterpret_cast<const char *>(tar_header_block_start + USTAR_MAGIC_FIELD_OFFSET);
	return std::memcmp(magic_field, "ustar", 5) == 0;
}

bool tar_entry_is_a_regular_file(const std::uint8_t *tar_header_block_start) {
	const char typeflag_character = static_cast<char>(tar_header_block_start[USTAR_TYPEFLAG_FIELD_OFFSET]);
	return typeflag_character == USTAR_TYPEFLAG_REGULAR_FILE_PRIMARY
			|| typeflag_character == USTAR_TYPEFLAG_REGULAR_FILE_LEGACY_NUL;
}

bool any_substring_is_contained_in_path(
		const std::string &path_to_check,
		const std::vector<std::string> &candidate_substrings) {
	for (const auto &one_candidate_substring : candidate_substrings) {
		if (path_to_check.find(one_candidate_substring) != std::string::npos) return true;
	}
	return false;
}

std::vector<std::uint8_t> decompress_zstd_byte_stream_into_one_buffer(
		const std::uint8_t *compressed_bytes,
		std::size_t compressed_bytes_length,
		std::string *error_message_out) {
	std::vector<std::uint8_t> decompressed_buffer;
	std::unique_ptr<ZSTD_DCtx, decltype(&ZSTD_freeDCtx)> decompression_context(ZSTD_createDCtx(), ZSTD_freeDCtx);
	if (!decompression_context) {
		*error_message_out = "ZSTD_createDCtx returned null";
		return decompressed_buffer;
	}
	const std::size_t output_chunk_capacity = ZSTD_DStreamOutSize();
	std::vector<std::uint8_t> output_chunk(output_chunk_capacity);
	ZSTD_inBuffer input_state{compressed_bytes, compressed_bytes_length, 0};
	while (input_state.pos < input_state.size) {
		ZSTD_outBuffer output_state{output_chunk.data(), output_chunk.size(), 0};
		const std::size_t step_result = ZSTD_decompressStream(
				decompression_context.get(), &output_state, &input_state);
		if (ZSTD_isError(step_result)) {
			*error_message_out = std::string("ZSTD_decompressStream error: ") + ZSTD_getErrorName(step_result);
			return std::vector<std::uint8_t>();
		}
		decompressed_buffer.insert(
				decompressed_buffer.end(),
				output_chunk.data(),
				output_chunk.data() + output_state.pos);
		if (step_result == 0 && input_state.pos == input_state.size) break;
	}
	return decompressed_buffer;
}

bool write_byte_range_to_filesystem_path(
		const std::uint8_t *byte_range_start,
		std::size_t byte_range_length,
		const std::string &destination_absolute_path,
		std::string *error_message_out) {
	const std::filesystem::path destination_filesystem_path(destination_absolute_path);
	const std::filesystem::path parent_directory_filesystem_path = destination_filesystem_path.parent_path();
	std::error_code directory_creation_error_code;
	std::filesystem::create_directories(parent_directory_filesystem_path, directory_creation_error_code);
	if (directory_creation_error_code) {
		*error_message_out = "could not create parent directory " + parent_directory_filesystem_path.string()
				+ ": " + directory_creation_error_code.message();
		return false;
	}
	std::FILE *destination_file_handle = std::fopen(destination_absolute_path.c_str(), "wb");
	if (!destination_file_handle) {
		*error_message_out = "could not open " + destination_absolute_path + " for writing";
		return false;
	}
	const std::size_t bytes_actually_written = std::fwrite(
			byte_range_start, 1, byte_range_length, destination_file_handle);
	std::fclose(destination_file_handle);
	if (bytes_actually_written != byte_range_length) {
		*error_message_out = "short write to " + destination_absolute_path;
		return false;
	}
	return true;
}

} // namespace

ZstdTarExtractionResult extract_zstd_tar_archive_filtered_by_path_substring(
		const std::uint8_t *compressed_tar_zst_bytes,
		std::size_t compressed_tar_zst_bytes_length,
		const std::string &filesystem_output_directory_absolute_path,
		const std::vector<std::string> &keep_only_paths_containing_any_of_these_substrings) {
	ZstdTarExtractionResult extraction_result;

	std::string decompression_error_message;
	const std::vector<std::uint8_t> uncompressed_tar_bytes = decompress_zstd_byte_stream_into_one_buffer(
			compressed_tar_zst_bytes, compressed_tar_zst_bytes_length, &decompression_error_message);
	if (!decompression_error_message.empty()) {
		extraction_result.error_message = decompression_error_message;
		return extraction_result;
	}

	std::size_t cursor_byte_offset = 0;
	while (cursor_byte_offset + TAR_BLOCK_SIZE_IN_BYTES <= uncompressed_tar_bytes.size()) {
		const std::uint8_t *current_tar_header_block_start = uncompressed_tar_bytes.data() + cursor_byte_offset;
		if (block_is_all_zero_bytes(current_tar_header_block_start)) {
			break;
		}
		if (!tar_header_is_ustar_magic(current_tar_header_block_start)) {
			extraction_result.error_message = "tar header at offset "
					+ std::to_string(cursor_byte_offset) + " is not ustar";
			return extraction_result;
		}
		const std::int64_t entry_size_in_bytes = parse_octal_size_field(
				current_tar_header_block_start + USTAR_SIZE_FIELD_OFFSET, USTAR_SIZE_FIELD_LENGTH);
		const std::string full_entry_path = full_path_from_tar_header(current_tar_header_block_start);
		const std::size_t entry_body_starts_at_offset = cursor_byte_offset + TAR_BLOCK_SIZE_IN_BYTES;
		const std::size_t entry_body_padded_length =
				((entry_size_in_bytes + TAR_BLOCK_SIZE_IN_BYTES - 1) / TAR_BLOCK_SIZE_IN_BYTES) * TAR_BLOCK_SIZE_IN_BYTES;

		if (entry_body_starts_at_offset + entry_body_padded_length > uncompressed_tar_bytes.size()) {
			extraction_result.error_message = "tar entry body extends past end of archive";
			return extraction_result;
		}

		const bool should_extract_this_entry = tar_entry_is_a_regular_file(current_tar_header_block_start)
				&& any_substring_is_contained_in_path(
						full_entry_path,
						keep_only_paths_containing_any_of_these_substrings);
		if (should_extract_this_entry) {
			const std::string destination_absolute_path = filesystem_output_directory_absolute_path
					+ std::string("/") + full_entry_path;
			std::string write_error_message;
			const bool write_was_successful = write_byte_range_to_filesystem_path(
					uncompressed_tar_bytes.data() + entry_body_starts_at_offset,
					static_cast<std::size_t>(entry_size_in_bytes),
					destination_absolute_path,
					&write_error_message);
			if (!write_was_successful) {
				extraction_result.error_message = write_error_message;
				return extraction_result;
			}
			extraction_result.extracted_file_count += 1;
			extraction_result.total_bytes_written += entry_size_in_bytes;
		}

		cursor_byte_offset = entry_body_starts_at_offset + entry_body_padded_length;
	}

	extraction_result.was_successful = true;
	return extraction_result;
}

} // namespace spice3d
