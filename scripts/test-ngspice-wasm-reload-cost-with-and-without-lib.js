// A/B comparison of ngSpice_Circ reload latency: minimal deck (no .lib /
// no .include / no transistors) versus the full sky130 PDK inverter
// testbench. Skips with exit code 0 if PDK_ROOT or the bundled FD_SC_HD
// spice file is missing.

const fs = require('fs');
const path = require('path');

const repository_root_directory = path.resolve(__dirname, '..');
const ngspice_emscripten_build_directory = path.resolve(
		repository_root_directory, 'third_party', 'ngspice', 'build-emscripten');
const ngspice_module_javascript_path = path.resolve(
		ngspice_emscripten_build_directory, 'ngspice.js');
const repo_bundled_sc_hd_consolidated_spice_file_path = path.resolve(
		repository_root_directory,
		'project', 'sky130_pdk_bundled',
		'sky130A', 'libs.ref', 'sky130_fd_sc_hd', 'spice', 'sky130_fd_sc_hd.spice');
const memfs_destination_path_for_sc_hd_consolidated_spice_file =
		'/sky130A/libs.ref/sky130_fd_sc_hd/spice/sky130_fd_sc_hd.spice';

const FAKE_PROC_MEMINFO_TEXT_FOR_NGSPICE_BUFFER_SIZING = [
	'MemTotal:        1048576 kB',
	'MemFree:         1048576 kB',
	'MemAvailable:    1048576 kB',
	'',
].join('\n');

const REPEAT_CYCLE_COUNT = 4;

function emitSkipMessageAndExitCleanly(human_readable_skip_reason) {
	process.stdout.write('SKIP: ' + human_readable_skip_reason + '\n');
	process.exit(0);
}

function recursivelyCollectAllFilesUnder(absolute_directory_path, accumulator) {
	for (const dirent of fs.readdirSync(absolute_directory_path, { withFileTypes: true })) {
		if (dirent.name.startsWith('.')) continue;
		const child_absolute_path = path.join(absolute_directory_path, dirent.name);
		if (dirent.isDirectory()) {
			recursivelyCollectAllFilesUnder(child_absolute_path, accumulator);
		} else if (dirent.isFile()) {
			accumulator.push(child_absolute_path);
		}
	}
}

function stageHostDirectoryIntoNgspiceMemfsAtSameRelativePath(
		ngspice_module, host_subdirectory_absolute_path, memfs_subdirectory_path) {
	const all_files_under_subdirectory = [];
	recursivelyCollectAllFilesUnder(host_subdirectory_absolute_path, all_files_under_subdirectory);
	for (const one_host_file_absolute_path of all_files_under_subdirectory) {
		const path_relative_to_subdirectory = one_host_file_absolute_path.slice(
				host_subdirectory_absolute_path.length);
		const memfs_full_path = memfs_subdirectory_path + path_relative_to_subdirectory;
		ngspice_module.FS.mkdirTree(path.posix.dirname(memfs_full_path));
		ngspice_module.FS.writeFile(
				memfs_full_path,
				fs.readFileSync(one_host_file_absolute_path, 'utf8'));
	}
}

function stageRepoBundledScHdSpiceIntoNgspiceMemfs(ngspice_module) {
	ngspice_module.FS.mkdirTree(
			path.posix.dirname(memfs_destination_path_for_sc_hd_consolidated_spice_file));
	ngspice_module.FS.writeFile(
			memfs_destination_path_for_sc_hd_consolidated_spice_file,
			fs.readFileSync(repo_bundled_sc_hd_consolidated_spice_file_path, 'utf8'));
}

function buildMinimalDeckThatHasNoLibrariesNoTransistorsNoIncludes() {
	return [
		'spice3d reload-cost test — minimal deck no lib no transistors',
		'V_VPWR vdd 0 DC 1.8',
		'R1 vdd vmid 1k',
		'R2 vmid 0 1k',
		'.tran 1p 1m 0 1p',
		'.end',
	];
}

function buildFullPdkInverterDeckSameShapeAsProductionTestbench() {
	return [
		'spice3d reload-cost test — full PDK single inverter',
		'.lib /sky130A/libs.tech/combined/sky130.lib.spice tt',
		'.include /sky130A/libs.ref/sky130_fd_sc_hd/spice/sky130_fd_sc_hd.spice',
		'V_VPWR VPWR 0 DC 1.8',
		'V_VGND VGND 0 DC 0',
		'V_VPB  VPB  0 DC 1.8',
		'V_VNB  VNB  0 DC 0',
		'VBUTTON1 net1 VGND DC 0',
		'x1 net1 VGND VNB VPB VPWR btn_out_n sky130_fd_sc_hd__inv_1',
		'C_FO4_btn_out_n btn_out_n VGND 7.4f',
		'.tran 1p 1m 0 1p',
		'.end',
	];
}

function loadDeckIntoNgspiceViaCircArray(ngspice_module, deck_lines) {
	const total_byte_length_with_terminators = deck_lines.reduce(
			(acc_byte_total, one_line) => acc_byte_total + one_line.length + 1, 0);
	const heap_text_buffer_pointer = ngspice_module._malloc(total_byte_length_with_terminators);
	const heap_pointer_array_pointer = ngspice_module._malloc((deck_lines.length + 1) * 4);
	let running_offset_in_text_buffer = 0;
	for (let one_line_index = 0; one_line_index < deck_lines.length; ++one_line_index) {
		const one_line = deck_lines[one_line_index];
		ngspice_module.stringToUTF8(
				one_line, heap_text_buffer_pointer + running_offset_in_text_buffer, one_line.length + 1);
		ngspice_module.HEAPU32[(heap_pointer_array_pointer >> 2) + one_line_index] =
				heap_text_buffer_pointer + running_offset_in_text_buffer;
		running_offset_in_text_buffer += one_line.length + 1;
	}
	ngspice_module.HEAPU32[(heap_pointer_array_pointer >> 2) + deck_lines.length] = 0;
	const returnCode = ngspice_module._ngSpice_Circ(heap_pointer_array_pointer);
	ngspice_module._free(heap_pointer_array_pointer);
	ngspice_module._free(heap_text_buffer_pointer);
	return returnCode;
}

async function bootNgspiceAndCompareReloadCostsAcrossConditions() {
	const pdk_root_environment_value = process.env.PDK_ROOT;
	if (!pdk_root_environment_value || !fs.existsSync(
			path.join(pdk_root_environment_value, 'sky130A', 'libs.tech', 'combined', 'sky130.lib.spice'))) {
		emitSkipMessageAndExitCleanly('PDK_ROOT is unset or sky130A/libs.tech/combined is missing.');
	}
	if (!fs.existsSync(repo_bundled_sc_hd_consolidated_spice_file_path)) {
		emitSkipMessageAndExitCleanly('bundled sky130_fd_sc_hd.spice missing.');
	}

	const createNgspiceModule = require(ngspice_module_javascript_path);
	const ngspice_module = await createNgspiceModule({
		locateFile: (rel) => path.resolve(ngspice_emscripten_build_directory, rel),
		print: () => {},
		printErr: () => {},
		preRun: [
			function stubFakeProcMeminfoIntoModuleMemfs(module) {
				module.FS.mkdirTree('/proc');
				module.FS.writeFile('/proc/meminfo', FAKE_PROC_MEMINFO_TEXT_FOR_NGSPICE_BUFFER_SIZING);
			},
		],
	});

	stageHostDirectoryIntoNgspiceMemfsAtSameRelativePath(
			ngspice_module,
			path.join(pdk_root_environment_value, 'sky130A', 'libs.tech', 'combined'),
			'/sky130A/libs.tech/combined');
	stageHostDirectoryIntoNgspiceMemfsAtSameRelativePath(
			ngspice_module,
			path.join(pdk_root_environment_value, 'sky130A', 'libs.ref', 'sky130_fd_pr', 'spice'),
			'/sky130A/libs.ref/sky130_fd_pr/spice');
	stageRepoBundledScHdSpiceIntoNgspiceMemfs(ngspice_module);

	ngspice_module._ngSpice_Init(
			ngspice_module.addFunction(() => 0, 'iiii'),
			ngspice_module.addFunction(() => 0, 'iiii'),
			ngspice_module.addFunction(() => 0, 'iiiiii'),
			ngspice_module.addFunction(() => 0, 'iiiii'),
			ngspice_module.addFunction(() => 0, 'iiii'),
			ngspice_module.addFunction(() => 0, 'iiii'),
			0);

	const conditions_to_compare = [
		{ human_label: 'minimal-no-lib-no-transistors', deck_factory: buildMinimalDeckThatHasNoLibrariesNoTransistorsNoIncludes },
		{ human_label: 'full-pdk-inverter', deck_factory: buildFullPdkInverterDeckSameShapeAsProductionTestbench },
	];

	for (const one_condition of conditions_to_compare) {
		process.stdout.write('---- ' + one_condition.human_label + ' ----\n');
		for (let one_cycle_index = 0; one_cycle_index < REPEAT_CYCLE_COUNT; ++one_cycle_index) {
			const cycle_start_ms = performance.now();
			loadDeckIntoNgspiceViaCircArray(ngspice_module, one_condition.deck_factory());
			const cycle_end_ms = performance.now();
			process.stdout.write(
					'  cycle ' + one_cycle_index + ': reload=' + (cycle_end_ms - cycle_start_ms).toFixed(1) + 'ms\n');
		}
	}
	process.stdout.write('DONE\n');
}

bootNgspiceAndCompareReloadCostsAcrossConditions().catch((unhandled_error) => {
	process.stderr.write('FAIL: ' + (unhandled_error && unhandled_error.stack || unhandled_error) + '\n');
	process.exit(1);
});
