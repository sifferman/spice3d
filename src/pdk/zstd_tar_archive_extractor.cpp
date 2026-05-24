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

bool ensure_parent_directory_exists(
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
	return true;
}

class StreamingTarFromDecompressedBytesConsumer {
public:
	StreamingTarFromDecompressedBytesConsumer(
			const std::string &filesystem_output_directory_absolute_path,
			const std::vector<std::string> &keep_only_paths_containing_any_of_these_substrings)
			: filesystem_output_directory_absolute_path_(filesystem_output_directory_absolute_path),
			  keep_only_paths_containing_any_of_these_substrings_(keep_only_paths_containing_any_of_these_substrings) {}

	bool feed_decompressed_bytes(const std::uint8_t *bytes_start, std::size_t bytes_length) {
		std::size_t bytes_consumed_from_input_chunk = 0;
		while (bytes_consumed_from_input_chunk < bytes_length) {
			if (finished_parsing_at_zero_block_) return true;
			const std::uint8_t *unconsumed_bytes_start = bytes_start + bytes_consumed_from_input_chunk;
			const std::size_t unconsumed_bytes_length = bytes_length - bytes_consumed_from_input_chunk;
			const std::size_t bytes_actually_taken = (currently_parsing_header_block_)
					? consume_bytes_into_pending_header_block(unconsumed_bytes_start, unconsumed_bytes_length)
					: consume_bytes_from_entry_body_or_padding(unconsumed_bytes_start, unconsumed_bytes_length);
			if (bytes_actually_taken == 0) {
				if (!encountered_fatal_parsing_error_) {
					fatal_parsing_error_message_ = std::string("streaming consumer made no progress (header=") +
							(currently_parsing_header_block_ ? "true" : "false") +
							" pending=" + std::to_string(pending_header_block_filled_byte_count_) +
							" body_remaining=" + std::to_string(currently_extracting_entry_remaining_body_byte_count_) +
							" padding_remaining=" + std::to_string(currently_skipping_entry_padding_byte_count_) +
							" input_left=" + std::to_string(unconsumed_bytes_length) + ")";
					encountered_fatal_parsing_error_ = true;
				}
				return false;
			}
			bytes_consumed_from_input_chunk += bytes_actually_taken;
		}
		return true;
	}

	bool finalize(std::string *error_message_out) {
		if (currently_extracting_destination_file_handle_ != nullptr) {
			std::fclose(currently_extracting_destination_file_handle_);
			currently_extracting_destination_file_handle_ = nullptr;
		}
		if (encountered_fatal_parsing_error_) {
			*error_message_out = fatal_parsing_error_message_;
			return false;
		}
		return true;
	}

	std::size_t extracted_file_count() const { return extracted_file_count_; }
	std::int64_t total_bytes_written() const { return total_bytes_written_; }

private:
	std::size_t consume_bytes_into_pending_header_block(
			const std::uint8_t *bytes_start, std::size_t bytes_length) {
		const std::size_t bytes_still_needed_for_header =
				TAR_BLOCK_SIZE_IN_BYTES - pending_header_block_filled_byte_count_;
		const std::size_t bytes_to_copy = std::min(bytes_still_needed_for_header, bytes_length);
		std::memcpy(pending_header_block_buffer_ + pending_header_block_filled_byte_count_,
				bytes_start, bytes_to_copy);
		pending_header_block_filled_byte_count_ += bytes_to_copy;
		if (pending_header_block_filled_byte_count_ < TAR_BLOCK_SIZE_IN_BYTES) {
			return bytes_to_copy;
		}
		pending_header_block_filled_byte_count_ = 0;
		if (!interpret_pending_header_block_and_transition_state()) return 0;
		return bytes_to_copy;
	}

	bool interpret_pending_header_block_and_transition_state() {
		if (block_is_all_zero_bytes(pending_header_block_buffer_)) {
			currently_parsing_header_block_ = true;
			finished_parsing_at_zero_block_ = true;
			return true;
		}
		if (!tar_header_is_ustar_magic(pending_header_block_buffer_)) {
			fatal_parsing_error_message_ = "tar header is not ustar at entry " + std::to_string(extracted_file_count_)
					+ " (first bytes: '"
					+ std::string(reinterpret_cast<const char *>(pending_header_block_buffer_), 32)
					+ "', magic field: '"
					+ std::string(reinterpret_cast<const char *>(pending_header_block_buffer_ + USTAR_MAGIC_FIELD_OFFSET), 8)
					+ "')";
			encountered_fatal_parsing_error_ = true;
			return false;
		}
		const std::int64_t entry_size_in_bytes = parse_octal_size_field(
				pending_header_block_buffer_ + USTAR_SIZE_FIELD_OFFSET, USTAR_SIZE_FIELD_LENGTH);
		const std::string full_entry_path = full_path_from_tar_header(pending_header_block_buffer_);

		const bool should_extract_this_entry = tar_entry_is_a_regular_file(pending_header_block_buffer_)
				&& any_substring_is_contained_in_path(
						full_entry_path,
						keep_only_paths_containing_any_of_these_substrings_);

		currently_extracting_entry_remaining_body_byte_count_ = static_cast<std::size_t>(entry_size_in_bytes);
		currently_skipping_entry_padding_byte_count_ =
				((entry_size_in_bytes + TAR_BLOCK_SIZE_IN_BYTES - 1) / TAR_BLOCK_SIZE_IN_BYTES)
						* TAR_BLOCK_SIZE_IN_BYTES
				- static_cast<std::size_t>(entry_size_in_bytes);

		if (currently_extracting_entry_remaining_body_byte_count_ == 0
				&& currently_skipping_entry_padding_byte_count_ == 0) {
			currently_parsing_header_block_ = true;
			return true;
		}

		if (should_extract_this_entry) {
			const std::string destination_absolute_path = filesystem_output_directory_absolute_path_
					+ std::string("/") + full_entry_path;
			std::string mkparent_error;
			if (!ensure_parent_directory_exists(destination_absolute_path, &mkparent_error)) {
				fatal_parsing_error_message_ = mkparent_error;
				encountered_fatal_parsing_error_ = true;
				return false;
			}
			currently_extracting_destination_file_handle_ = std::fopen(destination_absolute_path.c_str(), "wb");
			if (currently_extracting_destination_file_handle_ == nullptr) {
				fatal_parsing_error_message_ = "could not open " + destination_absolute_path + " for writing";
				encountered_fatal_parsing_error_ = true;
				return false;
			}
			extracted_file_count_ += 1;
		}
		currently_parsing_header_block_ = false;
		return true;
	}

	std::size_t consume_bytes_from_entry_body_or_padding(
			const std::uint8_t *bytes_start, std::size_t bytes_length) {
		if (finished_parsing_at_zero_block_) {
			return bytes_length;
		}
		if (currently_extracting_entry_remaining_body_byte_count_ > 0) {
			const std::size_t bytes_to_consume_for_body = std::min(
					currently_extracting_entry_remaining_body_byte_count_, bytes_length);
			if (currently_extracting_destination_file_handle_ != nullptr) {
				const std::size_t bytes_actually_written = std::fwrite(
						bytes_start, 1, bytes_to_consume_for_body,
						currently_extracting_destination_file_handle_);
				if (bytes_actually_written != bytes_to_consume_for_body) {
					fatal_parsing_error_message_ = "short write during streaming extraction";
					encountered_fatal_parsing_error_ = true;
					return 0;
				}
				total_bytes_written_ += static_cast<std::int64_t>(bytes_actually_written);
			}
			currently_extracting_entry_remaining_body_byte_count_ -= bytes_to_consume_for_body;
			if (currently_extracting_entry_remaining_body_byte_count_ == 0) {
				if (currently_extracting_destination_file_handle_ != nullptr) {
					std::fclose(currently_extracting_destination_file_handle_);
					currently_extracting_destination_file_handle_ = nullptr;
				}
				if (currently_skipping_entry_padding_byte_count_ == 0) {
					currently_parsing_header_block_ = true;
				}
			}
			return bytes_to_consume_for_body;
		}
		const std::size_t bytes_to_consume_for_padding = std::min(
				currently_skipping_entry_padding_byte_count_, bytes_length);
		currently_skipping_entry_padding_byte_count_ -= bytes_to_consume_for_padding;
		if (currently_skipping_entry_padding_byte_count_ == 0) {
			currently_parsing_header_block_ = true;
		}
		return bytes_to_consume_for_padding;
	}

	const std::string filesystem_output_directory_absolute_path_;
	const std::vector<std::string> keep_only_paths_containing_any_of_these_substrings_;

	std::uint8_t pending_header_block_buffer_[TAR_BLOCK_SIZE_IN_BYTES] = {};
	std::size_t pending_header_block_filled_byte_count_ = 0;
	bool currently_parsing_header_block_ = true;
	std::size_t currently_extracting_entry_remaining_body_byte_count_ = 0;
	std::size_t currently_skipping_entry_padding_byte_count_ = 0;
	std::FILE *currently_extracting_destination_file_handle_ = nullptr;

	bool finished_parsing_at_zero_block_ = false;
	bool encountered_fatal_parsing_error_ = false;
	std::string fatal_parsing_error_message_;

	std::size_t extracted_file_count_ = 0;
	std::int64_t total_bytes_written_ = 0;
};

} // namespace

ZstdTarExtractionResult extract_zstd_tar_archive_filtered_by_path_substring(
		const std::uint8_t *compressed_tar_zst_bytes,
		std::size_t compressed_tar_zst_bytes_length,
		const std::string &filesystem_output_directory_absolute_path,
		const std::vector<std::string> &keep_only_paths_containing_any_of_these_substrings) {
	ZstdTarExtractionResult extraction_result;

	std::unique_ptr<ZSTD_DCtx, decltype(&ZSTD_freeDCtx)> decompression_context(
			ZSTD_createDCtx(), ZSTD_freeDCtx);
	if (!decompression_context) {
		extraction_result.error_message = "ZSTD_createDCtx returned null";
		return extraction_result;
	}

	StreamingTarFromDecompressedBytesConsumer tar_consumer(
			filesystem_output_directory_absolute_path,
			keep_only_paths_containing_any_of_these_substrings);

	const std::size_t decompressed_chunk_capacity = ZSTD_DStreamOutSize();
	std::vector<std::uint8_t> decompressed_chunk_buffer(decompressed_chunk_capacity);

	ZSTD_inBuffer input_state{compressed_tar_zst_bytes, compressed_tar_zst_bytes_length, 0};
	while (input_state.pos < input_state.size) {
		ZSTD_outBuffer output_state{
				decompressed_chunk_buffer.data(),
				decompressed_chunk_buffer.size(),
				0};
		const std::size_t step_result = ZSTD_decompressStream(
				decompression_context.get(), &output_state, &input_state);
		if (ZSTD_isError(step_result)) {
			extraction_result.error_message = std::string("ZSTD_decompressStream error: ")
					+ ZSTD_getErrorName(step_result);
			return extraction_result;
		}
		if (output_state.pos > 0) {
			if (!tar_consumer.feed_decompressed_bytes(decompressed_chunk_buffer.data(), output_state.pos)) {
				std::string fatal_message;
				tar_consumer.finalize(&fatal_message);
				extraction_result.error_message = fatal_message;
				return extraction_result;
			}
		}
		if (step_result == 0 && input_state.pos == input_state.size) break;
	}

	std::string finalize_error_message;
	if (!tar_consumer.finalize(&finalize_error_message)) {
		extraction_result.error_message = finalize_error_message;
		return extraction_result;
	}

	extraction_result.extracted_file_count = static_cast<int>(tar_consumer.extracted_file_count());
	extraction_result.total_bytes_written = tar_consumer.total_bytes_written();
	extraction_result.was_successful = true;
	return extraction_result;
}

} // namespace spice3d
