#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <random>
#include <string>
#include <vector>

#include "zstd.h"

#include "../src/pdk/zstd_tar_archive_extractor.h"

namespace {

constexpr std::size_t USTAR_BLOCK_SIZE_IN_BYTES = 512;
constexpr std::size_t USTAR_NAME_FIELD_OFFSET = 0;
constexpr std::size_t USTAR_NAME_FIELD_LENGTH = 100;
constexpr std::size_t USTAR_MODE_FIELD_OFFSET = 100;
constexpr std::size_t USTAR_UID_FIELD_OFFSET = 108;
constexpr std::size_t USTAR_GID_FIELD_OFFSET = 116;
constexpr std::size_t USTAR_SIZE_FIELD_OFFSET = 124;
constexpr std::size_t USTAR_MTIME_FIELD_OFFSET = 136;
constexpr std::size_t USTAR_CHECKSUM_FIELD_OFFSET = 148;
constexpr std::size_t USTAR_CHECKSUM_FIELD_LENGTH = 8;
constexpr std::size_t USTAR_TYPEFLAG_FIELD_OFFSET = 156;
constexpr std::size_t USTAR_MAGIC_FIELD_OFFSET = 257;
constexpr std::size_t USTAR_VERSION_FIELD_OFFSET = 263;
constexpr char USTAR_TYPEFLAG_REGULAR_FILE = '0';

int failed_assertion_count = 0;

#define REQUIRE_EQUAL(actual_value, expected_value, failure_description)                          \
	do {                                                                                          \
		const auto actual_value_for_compare = (actual_value);                                     \
		const auto expected_value_for_compare = (expected_value);                                 \
		if (!(actual_value_for_compare == expected_value_for_compare)) {                          \
			std::fprintf(stderr, "FAIL: %s\n  expected: %s\n  actual:   %s\n",                    \
					(failure_description),                                                        \
					std::to_string(expected_value_for_compare).c_str(),                           \
					std::to_string(actual_value_for_compare).c_str());                            \
			++failed_assertion_count;                                                             \
		}                                                                                         \
	} while (0)

#define REQUIRE_TRUE(boolean_expression, failure_description)                                     \
	do {                                                                                          \
		if (!(boolean_expression)) {                                                              \
			std::fprintf(stderr, "FAIL: %s (expected true)\n", (failure_description));            \
			++failed_assertion_count;                                                             \
		}                                                                                         \
	} while (0)

void write_octal_into_fixed_width_field(
		std::uint8_t *field_start,
		std::size_t field_width_in_bytes,
		std::uint64_t value_to_write) {
	std::vector<char> digit_characters;
	if (value_to_write == 0) digit_characters.push_back('0');
	while (value_to_write > 0) {
		digit_characters.push_back(static_cast<char>('0' + (value_to_write & 7)));
		value_to_write >>= 3;
	}
	std::reverse(digit_characters.begin(), digit_characters.end());
	const std::size_t leading_zero_count = (field_width_in_bytes > 0
			&& digit_characters.size() < field_width_in_bytes - 1)
			? field_width_in_bytes - 1 - digit_characters.size()
			: 0;
	for (std::size_t i = 0; i < leading_zero_count; ++i) field_start[i] = '0';
	for (std::size_t i = 0; i < digit_characters.size() && leading_zero_count + i < field_width_in_bytes - 1; ++i) {
		field_start[leading_zero_count + i] = static_cast<std::uint8_t>(digit_characters[i]);
	}
	if (field_width_in_bytes > 0) {
		field_start[field_width_in_bytes - 1] = 0;
	}
}

void append_ustar_header_block_for_regular_file(
		std::vector<std::uint8_t> &archive_bytes,
		const std::string &full_entry_path,
		std::size_t entry_body_size_in_bytes) {
	const std::size_t header_start_offset = archive_bytes.size();
	archive_bytes.resize(header_start_offset + USTAR_BLOCK_SIZE_IN_BYTES, 0);
	std::uint8_t *header_block_start = archive_bytes.data() + header_start_offset;
	std::memcpy(header_block_start + USTAR_NAME_FIELD_OFFSET,
			full_entry_path.c_str(),
			std::min(full_entry_path.size(), USTAR_NAME_FIELD_LENGTH));
	write_octal_into_fixed_width_field(header_block_start + USTAR_MODE_FIELD_OFFSET, 8, 0644);
	write_octal_into_fixed_width_field(header_block_start + USTAR_UID_FIELD_OFFSET, 8, 0);
	write_octal_into_fixed_width_field(header_block_start + USTAR_GID_FIELD_OFFSET, 8, 0);
	write_octal_into_fixed_width_field(header_block_start + USTAR_SIZE_FIELD_OFFSET, 12, entry_body_size_in_bytes);
	write_octal_into_fixed_width_field(header_block_start + USTAR_MTIME_FIELD_OFFSET, 12, 0);
	for (std::size_t i = 0; i < USTAR_CHECKSUM_FIELD_LENGTH; ++i) {
		header_block_start[USTAR_CHECKSUM_FIELD_OFFSET + i] = ' ';
	}
	header_block_start[USTAR_TYPEFLAG_FIELD_OFFSET] = USTAR_TYPEFLAG_REGULAR_FILE;
	std::memcpy(header_block_start + USTAR_MAGIC_FIELD_OFFSET, "ustar", 5);
	header_block_start[USTAR_MAGIC_FIELD_OFFSET + 5] = 0;
	header_block_start[USTAR_VERSION_FIELD_OFFSET] = '0';
	header_block_start[USTAR_VERSION_FIELD_OFFSET + 1] = '0';
	std::uint32_t checksum_running_sum = 0;
	for (std::size_t i = 0; i < USTAR_BLOCK_SIZE_IN_BYTES; ++i) {
		checksum_running_sum += header_block_start[i];
	}
	write_octal_into_fixed_width_field(header_block_start + USTAR_CHECKSUM_FIELD_OFFSET, 7, checksum_running_sum);
	header_block_start[USTAR_CHECKSUM_FIELD_OFFSET + 6] = 0;
	header_block_start[USTAR_CHECKSUM_FIELD_OFFSET + 7] = ' ';
}

void append_entry_body_and_padding_to_archive_bytes(
		std::vector<std::uint8_t> &archive_bytes,
		const std::vector<std::uint8_t> &entry_body_bytes) {
	archive_bytes.insert(archive_bytes.end(), entry_body_bytes.begin(), entry_body_bytes.end());
	const std::size_t bytes_into_last_block = entry_body_bytes.size() % USTAR_BLOCK_SIZE_IN_BYTES;
	if (bytes_into_last_block != 0) {
		const std::size_t padding_byte_count = USTAR_BLOCK_SIZE_IN_BYTES - bytes_into_last_block;
		archive_bytes.insert(archive_bytes.end(), padding_byte_count, 0);
	}
}

void append_trailing_two_zero_blocks_to_archive_bytes(std::vector<std::uint8_t> &archive_bytes) {
	archive_bytes.insert(archive_bytes.end(), 2 * USTAR_BLOCK_SIZE_IN_BYTES, 0);
}

std::vector<std::uint8_t> build_deterministic_body_of_exact_size(
		std::size_t entry_body_size_in_bytes,
		std::uint32_t seed) {
	std::vector<std::uint8_t> entry_body_bytes(entry_body_size_in_bytes);
	std::mt19937 random_engine(seed);
	for (std::size_t i = 0; i < entry_body_size_in_bytes; ++i) {
		entry_body_bytes[i] = static_cast<std::uint8_t>(random_engine() & 0xff);
	}
	return entry_body_bytes;
}

std::vector<std::uint8_t> zstd_compress_archive_bytes(const std::vector<std::uint8_t> &archive_bytes) {
	const std::size_t maximum_compressed_size_in_bytes = ZSTD_compressBound(archive_bytes.size());
	std::vector<std::uint8_t> compressed_bytes(maximum_compressed_size_in_bytes);
	const std::size_t actual_compressed_size_in_bytes = ZSTD_compress(
			compressed_bytes.data(), compressed_bytes.size(),
			archive_bytes.data(), archive_bytes.size(),
			3);
	if (ZSTD_isError(actual_compressed_size_in_bytes)) {
		std::fprintf(stderr, "ZSTD_compress error: %s\n",
				ZSTD_getErrorName(actual_compressed_size_in_bytes));
		std::abort();
	}
	compressed_bytes.resize(actual_compressed_size_in_bytes);
	return compressed_bytes;
}

std::vector<std::uint8_t> read_file_bytes_from_filesystem(const std::string &absolute_path) {
	std::ifstream input_stream(absolute_path, std::ios::binary);
	if (!input_stream) return {};
	input_stream.seekg(0, std::ios::end);
	const std::streamsize size_in_bytes = input_stream.tellg();
	input_stream.seekg(0, std::ios::beg);
	std::vector<std::uint8_t> file_bytes(static_cast<std::size_t>(size_in_bytes));
	input_stream.read(reinterpret_cast<char *>(file_bytes.data()), size_in_bytes);
	return file_bytes;
}

std::string make_unique_test_output_directory_under_tmp(const std::string &test_name_slug) {
	const std::string base_directory = "/tmp/spice3d_extractor_test_" + test_name_slug + "_"
			+ std::to_string(static_cast<long>(std::time(nullptr))) + "_"
			+ std::to_string(static_cast<long>(std::rand()));
	std::filesystem::remove_all(base_directory);
	std::filesystem::create_directories(base_directory);
	return base_directory;
}

void test_single_entry_whose_body_ends_exactly_on_a_block_boundary_with_zero_padding() {
	std::vector<std::uint8_t> archive_bytes;
	const std::vector<std::uint8_t> entry_body_bytes_aligned_to_block_boundary =
			build_deterministic_body_of_exact_size(USTAR_BLOCK_SIZE_IN_BYTES, 0xC0FFEE);
	append_ustar_header_block_for_regular_file(
			archive_bytes,
			"keep/exactly_one_block.bin",
			entry_body_bytes_aligned_to_block_boundary.size());
	append_entry_body_and_padding_to_archive_bytes(
			archive_bytes, entry_body_bytes_aligned_to_block_boundary);
	const std::vector<std::uint8_t> trailing_entry_body_bytes =
			build_deterministic_body_of_exact_size(123, 0xBADF00D);
	append_ustar_header_block_for_regular_file(
			archive_bytes,
			"keep/short_trailing_entry.bin",
			trailing_entry_body_bytes.size());
	append_entry_body_and_padding_to_archive_bytes(archive_bytes, trailing_entry_body_bytes);
	append_trailing_two_zero_blocks_to_archive_bytes(archive_bytes);

	const std::vector<std::uint8_t> compressed_bytes = zstd_compress_archive_bytes(archive_bytes);
	const std::string output_directory = make_unique_test_output_directory_under_tmp(
			"block_aligned");

	const auto extraction_result = spice3d::extract_zstd_tar_archive_filtered_by_path_substring(
			compressed_bytes.data(), compressed_bytes.size(),
			output_directory,
			std::vector<std::string>{"keep/"});

	REQUIRE_TRUE(extraction_result.was_successful,
			"extract_zstd_tar_archive_filtered_by_path_substring should succeed when "
			"an entry's body ends exactly on a 512-byte block boundary (no padding bytes follow). "
			"This used to fail with 'streaming consumer made no progress'.");
	REQUIRE_EQUAL(extraction_result.extracted_file_count, 2,
			"both entries should be extracted");
	REQUIRE_EQUAL(extraction_result.total_bytes_written,
			static_cast<std::int64_t>(entry_body_bytes_aligned_to_block_boundary.size()
					+ trailing_entry_body_bytes.size()),
			"total bytes written should equal sum of entry sizes");

	const std::vector<std::uint8_t> first_entry_bytes_on_disk = read_file_bytes_from_filesystem(
			output_directory + "/keep/exactly_one_block.bin");
	REQUIRE_TRUE(first_entry_bytes_on_disk == entry_body_bytes_aligned_to_block_boundary,
			"the block-aligned entry's bytes on disk should byte-for-byte equal what was packed");
	const std::vector<std::uint8_t> second_entry_bytes_on_disk = read_file_bytes_from_filesystem(
			output_directory + "/keep/short_trailing_entry.bin");
	REQUIRE_TRUE(second_entry_bytes_on_disk == trailing_entry_body_bytes,
			"a short entry immediately after a block-aligned one should still extract correctly "
			"(if the body→header transition is broken, this entry would be skipped or corrupted)");

	std::filesystem::remove_all(output_directory);
}

void test_archive_with_mixed_entry_sizes_and_substring_filter() {
	std::vector<std::uint8_t> archive_bytes;
	struct OneTarEntry {
		std::string full_path;
		std::vector<std::uint8_t> body_bytes;
	};
	const std::vector<OneTarEntry> entries_to_pack_in_order = {
		{"docs/readme.txt", build_deterministic_body_of_exact_size(0, 1)},
		{"keep/small_one_byte.bin", build_deterministic_body_of_exact_size(1, 2)},
		{"docs/changelog.txt", build_deterministic_body_of_exact_size(700, 3)},
		{"keep/exactly_two_blocks.bin",
				build_deterministic_body_of_exact_size(2 * USTAR_BLOCK_SIZE_IN_BYTES, 4)},
		{"keep/spans_many_blocks.bin",
				build_deterministic_body_of_exact_size(50000, 5)},
		{"docs/should_not_appear.txt", build_deterministic_body_of_exact_size(40, 6)},
		{"keep/odd_size.bin", build_deterministic_body_of_exact_size(513, 7)},
	};
	std::int64_t expected_bytes_written_for_kept_entries = 0;
	for (const auto &one_entry : entries_to_pack_in_order) {
		append_ustar_header_block_for_regular_file(
				archive_bytes, one_entry.full_path, one_entry.body_bytes.size());
		append_entry_body_and_padding_to_archive_bytes(archive_bytes, one_entry.body_bytes);
		if (one_entry.full_path.find("keep/") != std::string::npos) {
			expected_bytes_written_for_kept_entries += one_entry.body_bytes.size();
		}
	}
	append_trailing_two_zero_blocks_to_archive_bytes(archive_bytes);

	const std::vector<std::uint8_t> compressed_bytes = zstd_compress_archive_bytes(archive_bytes);
	const std::string output_directory = make_unique_test_output_directory_under_tmp("mixed_sizes");

	const auto extraction_result = spice3d::extract_zstd_tar_archive_filtered_by_path_substring(
			compressed_bytes.data(), compressed_bytes.size(),
			output_directory,
			std::vector<std::string>{"keep/"});

	REQUIRE_TRUE(extraction_result.was_successful,
			"mixed-size archive with substring filter should extract cleanly");
	REQUIRE_EQUAL(extraction_result.extracted_file_count, 4,
			"only the 4 entries whose path contains 'keep/' should be written");
	REQUIRE_EQUAL(extraction_result.total_bytes_written,
			expected_bytes_written_for_kept_entries,
			"total bytes written should equal sum of kept entries' sizes");
	REQUIRE_TRUE(!std::filesystem::exists(output_directory + "/docs/readme.txt"),
			"filtered-out entries must not appear on disk");
	REQUIRE_TRUE(!std::filesystem::exists(output_directory + "/docs/changelog.txt"),
			"filtered-out entries must not appear on disk");
	REQUIRE_TRUE(!std::filesystem::exists(output_directory + "/docs/should_not_appear.txt"),
			"filtered-out entries must not appear on disk");
	for (const auto &one_entry : entries_to_pack_in_order) {
		if (one_entry.full_path.find("keep/") == std::string::npos) continue;
		const std::vector<std::uint8_t> bytes_on_disk = read_file_bytes_from_filesystem(
				output_directory + "/" + one_entry.full_path);
		REQUIRE_TRUE(bytes_on_disk == one_entry.body_bytes,
				("kept entry '" + one_entry.full_path
						+ "' should byte-for-byte match what was packed").c_str());
	}

	std::filesystem::remove_all(output_directory);
}

void test_archive_large_enough_to_require_multiple_decompression_chunks() {
	const std::size_t entry_body_size_well_above_zstd_chunk_output_size =
			4 * ZSTD_DStreamOutSize() + 7;
	const std::vector<std::uint8_t> large_entry_body_bytes = build_deterministic_body_of_exact_size(
			entry_body_size_well_above_zstd_chunk_output_size, 0xDEADBEEF);
	std::vector<std::uint8_t> archive_bytes;
	append_ustar_header_block_for_regular_file(
			archive_bytes,
			"keep/large_entry_spanning_several_zstd_output_chunks.bin",
			large_entry_body_bytes.size());
	append_entry_body_and_padding_to_archive_bytes(archive_bytes, large_entry_body_bytes);
	append_trailing_two_zero_blocks_to_archive_bytes(archive_bytes);

	const std::vector<std::uint8_t> compressed_bytes = zstd_compress_archive_bytes(archive_bytes);
	const std::string output_directory = make_unique_test_output_directory_under_tmp(
			"multi_chunk");

	const auto extraction_result = spice3d::extract_zstd_tar_archive_filtered_by_path_substring(
			compressed_bytes.data(), compressed_bytes.size(),
			output_directory,
			std::vector<std::string>{"keep/"});

	REQUIRE_TRUE(extraction_result.was_successful,
			"a single entry larger than one ZSTD_DStreamOutSize() chunk must "
			"extract correctly across multiple feed_decompressed_bytes() calls. "
			"This is the structural OOM-prevention property: we never buffer the "
			"entire decompressed archive in memory.");
	REQUIRE_EQUAL(extraction_result.extracted_file_count, 1,
			"exactly one entry should be extracted");
	REQUIRE_EQUAL(extraction_result.total_bytes_written,
			static_cast<std::int64_t>(large_entry_body_bytes.size()),
			"bytes-written should equal the large entry's body size");
	const std::vector<std::uint8_t> bytes_on_disk = read_file_bytes_from_filesystem(
			output_directory + "/keep/large_entry_spanning_several_zstd_output_chunks.bin");
	REQUIRE_TRUE(bytes_on_disk == large_entry_body_bytes,
			"large entry's bytes on disk must byte-for-byte match what was packed");

	std::filesystem::remove_all(output_directory);
}

} // namespace

int main() {
	test_single_entry_whose_body_ends_exactly_on_a_block_boundary_with_zero_padding();
	test_archive_with_mixed_entry_sizes_and_substring_filter();
	test_archive_large_enough_to_require_multiple_decompression_chunks();

	if (failed_assertion_count > 0) {
		std::fprintf(stderr, "\n%d assertion(s) failed.\n", failed_assertion_count);
		return 1;
	}
	std::printf("PASS — all streaming zstd-tar extractor regression tests passed.\n");
	return 0;
}
