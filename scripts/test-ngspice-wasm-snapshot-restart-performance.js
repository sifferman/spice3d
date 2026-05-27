// Measures snapshot+restart wall-clock latency across two circuit sizes
// (single inverter, 9-stage RO). Reports per-phase timing breakdown and
// asserts the worst-case cycle stays within PER_CYCLE_BUDGET_MILLISECONDS.
// Skips with exit code 0 if PDK_ROOT or the bundled FD_SC_HD spice file
// is missing.

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

const SIM_TRANSIENT_TIMESTEP_SECONDS = 1.0e-12;
const SIM_TRANSIENT_UPPER_BOUND_TSTOP_SECONDS = 1.0e-3;
const WARMUP_CHUNK_SAMPLE_COUNT = 30;
const REPEAT_CYCLE_COUNT = 5;
const PER_CYCLE_BUDGET_MILLISECONDS = 50.0;
const EXCLUDE_NODES_FROM_RESTART_SNAPSHOT = new Set(['time', '0']);

const TESTBENCH_PDK_ROOT_ENVIRONMENT_VARIABLE_NAME = 'PDK_ROOT';
const SKIP_EXIT_CODE_BECAUSE_PDK_NOT_AVAILABLE_LOCALLY = 0;
const FAIL_EXIT_CODE_BECAUSE_ASSERTIONS_BROKE = 1;

function emitSkipMessageAndExitCleanly(human_readable_skip_reason) {
	process.stdout.write('SKIP: ' + human_readable_skip_reason + '\n');
	process.exit(SKIP_EXIT_CODE_BECAUSE_PDK_NOT_AVAILABLE_LOCALLY);
}

function emitFailMessageAndExitWithFailureCode(human_readable_failure_message) {
	process.stderr.write('FAIL: ' + human_readable_failure_message + '\n');
	process.exit(FAIL_EXIT_CODE_BECAUSE_ASSERTIONS_BROKE);
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

function buildSingleInverterDeck(optional_initial_condition_lines, use_initial_conditions_flag) {
	const tran_keyword_suffix = use_initial_conditions_flag ? ' uic' : '';
	return [
		'spice3d snapshot-restart perf — single inverter',
		'.lib /sky130A/libs.tech/combined/sky130.lib.spice tt',
		'.include /sky130A/libs.ref/sky130_fd_sc_hd/spice/sky130_fd_sc_hd.spice',
		'V_VPWR VPWR 0 DC 1.8',
		'V_VGND VGND 0 DC 0',
		'V_VPB  VPB  0 DC 1.8',
		'V_VNB  VNB  0 DC 0',
		'VBUTTON1 net1 VGND external',
		'x1 net1 VGND VNB VPB VPWR btn_out_n sky130_fd_sc_hd__inv_1',
		'C_FO4_btn_out_n btn_out_n VGND 7.4f',
	].concat(optional_initial_condition_lines).concat([
		'.tran ' + SIM_TRANSIENT_TIMESTEP_SECONDS
				+ ' ' + SIM_TRANSIENT_UPPER_BOUND_TSTOP_SECONDS
				+ ' 0 ' + SIM_TRANSIENT_TIMESTEP_SECONDS
				+ tran_keyword_suffix,
		'.end',
	]);
}

function buildNineStageRingOscillatorDeck(optional_initial_condition_lines, use_initial_conditions_flag) {
	const tran_keyword_suffix = use_initial_conditions_flag ? ' uic' : '';
	const ring_net_count = 9;
	const inverter_instance_lines = [];
	for (let one_stage_index = 0; one_stage_index < ring_net_count; ++one_stage_index) {
		const input_net_name = 'ro_net' + one_stage_index;
		const output_net_name = 'ro_net' + ((one_stage_index + 1) % ring_net_count);
		inverter_instance_lines.push(
				'x_ro_inv' + one_stage_index + ' '
				+ input_net_name + ' VGND VNB VPB VPWR ' + output_net_name
				+ ' sky130_fd_sc_hd__inv_1');
	}
	return [
		'spice3d snapshot-restart perf — 9-stage ring oscillator',
		'.lib /sky130A/libs.tech/combined/sky130.lib.spice tt',
		'.include /sky130A/libs.ref/sky130_fd_sc_hd/spice/sky130_fd_sc_hd.spice',
		'V_VPWR VPWR 0 DC 1.8',
		'V_VGND VGND 0 DC 0',
		'V_VPB  VPB  0 DC 1.8',
		'V_VNB  VNB  0 DC 0',
	].concat(inverter_instance_lines).concat(optional_initial_condition_lines).concat([
		'.tran ' + SIM_TRANSIENT_TIMESTEP_SECONDS
				+ ' ' + SIM_TRANSIENT_UPPER_BOUND_TSTOP_SECONDS
				+ ' 0 ' + SIM_TRANSIENT_TIMESTEP_SECONDS
				+ tran_keyword_suffix,
		'.end',
	]);
}

function readNamedVoltagesFromSendDataCallbackPayload(ngspice_module, allValuesPointer, vectorCount) {
	const vectorEntryArrayPointer = ngspice_module.HEAPU32[(allValuesPointer + 8) >> 2];
	const namedVoltages = Object.create(null);
	let simulationTimeAtThisSample = 0.0;
	for (let vectorIndex = 0; vectorIndex < vectorCount; ++vectorIndex) {
		const vectorEntryPointer = ngspice_module.HEAPU32[(vectorEntryArrayPointer >> 2) + vectorIndex];
		const namePointer = ngspice_module.HEAPU32[vectorEntryPointer >> 2];
		const realPart = ngspice_module.HEAPF64[(vectorEntryPointer + 8) >> 3];
		const name = ngspice_module.UTF8ToString(namePointer);
		if (name === 'time') simulationTimeAtThisSample = realPart;
		namedVoltages[name] = realPart;
	}
	return { simulationTimeAtThisSample, namedVoltages };
}

function buildInitialConditionLinesFromCapturedNodeVoltages(captured_node_voltages_dict) {
	const initial_condition_lines = [];
	for (const one_node_name of Object.keys(captured_node_voltages_dict)) {
		if (EXCLUDE_NODES_FROM_RESTART_SNAPSHOT.has(one_node_name)) continue;
		const node_voltage_in_volts = captured_node_voltages_dict[one_node_name];
		initial_condition_lines.push('.ic v(' + one_node_name + ')=' + node_voltage_in_volts);
	}
	return initial_condition_lines;
}

function loadDeckIntoNgspiceViaCircArray(ngspice_module, deck_lines) {
	const total_byte_length_with_terminators = deck_lines.reduce(
			(acc_byte_total, one_line) => acc_byte_total + one_line.length + 1, 0);
	const heap_text_buffer_pointer = ngspice_module._malloc(total_byte_length_with_terminators);
	const heap_pointer_array_size_in_pointers = deck_lines.length + 1;
	const heap_pointer_array_pointer = ngspice_module._malloc(
			heap_pointer_array_size_in_pointers * 4);
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

function measureOneSnapshotRestartCycleAndReturnPhaseMillisecondsBreakdown(
		ngspice_module, sendNgspiceCommand, samplesCollectedSinceLastReset,
		deck_factory_function) {
	const snapshot_phase_start_ms = performance.now();
	const last_observed_sample = samplesCollectedSinceLastReset[
			samplesCollectedSinceLastReset.length - 1];
	const captured_voltages = Object.assign(Object.create(null), last_observed_sample.namedVoltages);
	const snapshot_phase_end_ms = performance.now();

	const initial_condition_lines = buildInitialConditionLinesFromCapturedNodeVoltages(captured_voltages);
	const restarted_deck = deck_factory_function(initial_condition_lines, true);
	const deck_assembly_phase_end_ms = performance.now();

	const reload_return_code = loadDeckIntoNgspiceViaCircArray(ngspice_module, restarted_deck);
	if (reload_return_code !== 0) {
		emitFailMessageAndExitWithFailureCode(
				'ngSpice_Circ during perf cycle returned ' + reload_return_code);
	}
	sendNgspiceCommand('save none');
	const circ_reload_phase_end_ms = performance.now();

	samplesCollectedSinceLastReset.length = 0;
	sendNgspiceCommand('step 1');
	const first_post_restart_step_phase_end_ms = performance.now();

	return {
		snapshot_capture_ms: snapshot_phase_end_ms - snapshot_phase_start_ms,
		deck_assembly_ms: deck_assembly_phase_end_ms - snapshot_phase_end_ms,
		circ_reload_ms: circ_reload_phase_end_ms - deck_assembly_phase_end_ms,
		first_post_restart_step_ms: first_post_restart_step_phase_end_ms - circ_reload_phase_end_ms,
		total_cycle_ms: first_post_restart_step_phase_end_ms - snapshot_phase_start_ms,
	};
}

async function bootNgspiceAndMeasureSnapshotRestartLatencyAcrossCircuitSizes() {
	const pdk_root_environment_value = process.env[TESTBENCH_PDK_ROOT_ENVIRONMENT_VARIABLE_NAME];
	if (!pdk_root_environment_value || !fs.existsSync(
			path.join(pdk_root_environment_value, 'sky130A', 'libs.tech', 'combined', 'sky130.lib.spice'))) {
		emitSkipMessageAndExitCleanly(
				TESTBENCH_PDK_ROOT_ENVIRONMENT_VARIABLE_NAME
				+ ' is unset or sky130A/libs.tech/combined is missing.');
	}
	if (!fs.existsSync(repo_bundled_sc_hd_consolidated_spice_file_path)) {
		emitSkipMessageAndExitCleanly(
				'bundled sky130_fd_sc_hd.spice missing.');
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

	const samplesCollectedSinceLastReset = [];
	const sendDataCallbackFunctionPointer = ngspice_module.addFunction(
			function captureOneSampleIntoArray(allValuesPointer, vectorCount) {
				samplesCollectedSinceLastReset.push(
						readNamedVoltagesFromSendDataCallbackPayload(
								ngspice_module, allValuesPointer, vectorCount));
				return 0;
			},
			'iiiii');
	ngspice_module._ngSpice_Init(
			ngspice_module.addFunction(() => 0, 'iiii'),
			ngspice_module.addFunction(() => 0, 'iiii'),
			ngspice_module.addFunction(() => 0, 'iiiiii'),
			sendDataCallbackFunctionPointer,
			ngspice_module.addFunction(() => 0, 'iiii'),
			ngspice_module.addFunction(() => 0, 'iiii'),
			0);
	const externalVoltageSourceStateByLowercaseName = Object.create(null);
	externalVoltageSourceStateByLowercaseName['vbutton1'] = { valueAfterStep: 1.8 };
	const getVsrcDataCallbackFunctionPointer = ngspice_module.addFunction(
			function returnExternalVoltageSourceValueAtSimulatedTime(
					resultDoublePointer, simulatedTime, sourceNameCharPointer) {
				const sourceName = ngspice_module.UTF8ToString(sourceNameCharPointer);
				const sourceState = externalVoltageSourceStateByLowercaseName[sourceName.toLowerCase()];
				ngspice_module.HEAPF64[resultDoublePointer >> 3] = sourceState ? sourceState.valueAfterStep : 0.0;
				return 0;
			},
			'iidiii');
	ngspice_module._ngSpice_Init_Sync(
			getVsrcDataCallbackFunctionPointer, 0, 0, 0, 0);

	const sendNgspiceCommand = ngspice_module.cwrap('ngSpice_Command', 'number', ['string']);

	const circuit_size_test_cases = [
		{ human_label: 'single inverter', deck_factory: buildSingleInverterDeck },
		{ human_label: '9-stage ring oscillator', deck_factory: buildNineStageRingOscillatorDeck },
	];

	let largest_observed_total_cycle_ms_across_all_cases = 0;
	for (const one_test_case of circuit_size_test_cases) {
		process.stdout.write('---- circuit: ' + one_test_case.human_label + ' ----\n');
		const initial_deck = one_test_case.deck_factory([], false);
		loadDeckIntoNgspiceViaCircArray(ngspice_module, initial_deck);
		sendNgspiceCommand('save none');

		samplesCollectedSinceLastReset.length = 0;
		sendNgspiceCommand('step ' + WARMUP_CHUNK_SAMPLE_COUNT);
		if (samplesCollectedSinceLastReset.length === 0) {
			emitFailMessageAndExitWithFailureCode(
					one_test_case.human_label + ' warmup emitted zero samples');
		}

		const per_cycle_phase_breakdowns = [];
		for (let one_cycle_index = 0; one_cycle_index < REPEAT_CYCLE_COUNT; ++one_cycle_index) {
			const phase_breakdown_for_this_cycle = measureOneSnapshotRestartCycleAndReturnPhaseMillisecondsBreakdown(
					ngspice_module, sendNgspiceCommand, samplesCollectedSinceLastReset,
					one_test_case.deck_factory);
			per_cycle_phase_breakdowns.push(phase_breakdown_for_this_cycle);
			process.stdout.write(
					'  cycle ' + one_cycle_index + ': '
					+ 'snapshot=' + phase_breakdown_for_this_cycle.snapshot_capture_ms.toFixed(2) + 'ms, '
					+ 'assemble=' + phase_breakdown_for_this_cycle.deck_assembly_ms.toFixed(2) + 'ms, '
					+ 'reload=' + phase_breakdown_for_this_cycle.circ_reload_ms.toFixed(2) + 'ms, '
					+ 'first_step=' + phase_breakdown_for_this_cycle.first_post_restart_step_ms.toFixed(2) + 'ms, '
					+ 'total=' + phase_breakdown_for_this_cycle.total_cycle_ms.toFixed(2) + 'ms\n');
			samplesCollectedSinceLastReset.length = 0;
			sendNgspiceCommand('step ' + WARMUP_CHUNK_SAMPLE_COUNT);
		}
		const median_total_cycle_ms = [...per_cycle_phase_breakdowns]
				.map((b) => b.total_cycle_ms)
				.sort((a, b) => a - b)[Math.floor(per_cycle_phase_breakdowns.length / 2)];
		const worst_total_cycle_ms = per_cycle_phase_breakdowns
				.reduce((acc, b) => Math.max(acc, b.total_cycle_ms), 0);
		process.stdout.write(
				'  ' + one_test_case.human_label + ' median total = '
				+ median_total_cycle_ms.toFixed(2) + 'ms, worst = '
				+ worst_total_cycle_ms.toFixed(2) + 'ms (budget = '
				+ PER_CYCLE_BUDGET_MILLISECONDS + 'ms)\n');
		if (worst_total_cycle_ms > largest_observed_total_cycle_ms_across_all_cases) {
			largest_observed_total_cycle_ms_across_all_cases = worst_total_cycle_ms;
		}
	}

	if (largest_observed_total_cycle_ms_across_all_cases > PER_CYCLE_BUDGET_MILLISECONDS) {
		emitFailMessageAndExitWithFailureCode(
				'worst-case snapshot+restart cycle = '
				+ largest_observed_total_cycle_ms_across_all_cases.toFixed(2)
				+ 'ms, exceeds budget ' + PER_CYCLE_BUDGET_MILLISECONDS + 'ms');
	}
	process.stdout.write('PASS — snapshot+restart latency within budget\n');
}

bootNgspiceAndMeasureSnapshotRestartLatencyAcrossCircuitSizes().catch((unhandled_error) => {
	emitFailMessageAndExitWithFailureCode('uncaught: ' + (unhandled_error && unhandled_error.stack || unhandled_error));
});
