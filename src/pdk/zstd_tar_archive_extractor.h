#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace spice3d {

struct ZstdTarExtractionResult {
	bool was_successful = false;
	std::string error_message;
	int extracted_file_count = 0;
	std::int64_t total_bytes_written = 0;
};

class ZstdTarStreamingExtractor {
public:
	ZstdTarStreamingExtractor(
			const std::string &output_directory_absolute_path,
			const std::vector<std::string> &keep_only_paths_containing_substrings);
	~ZstdTarStreamingExtractor();

	ZstdTarStreamingExtractor(const ZstdTarStreamingExtractor &) = delete;
	ZstdTarStreamingExtractor &operator=(const ZstdTarStreamingExtractor &) = delete;

	bool feed_compressed_chunk(
			const std::uint8_t *compressed_bytes,
			std::size_t compressed_bytes_length,
			std::string *out_error_message);

	ZstdTarExtractionResult finalize();

private:
	struct Impl;
	std::unique_ptr<Impl> impl_;
};

ZstdTarExtractionResult extract_zstd_tar_archive_filtered_by_path_substring(
		const std::uint8_t *compressed_tar_zst_bytes,
		std::size_t compressed_tar_zst_bytes_length,
		const std::string &filesystem_output_directory_absolute_path,
		const std::vector<std::string> &keep_only_paths_containing_any_of_these_substrings);

} // namespace spice3d
