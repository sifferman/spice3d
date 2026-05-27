// Verifies ngspice's `.tran ... ; step N ; step M ; ...` chunking
// mechanism: each chunk emits its N samples, ci_inprogress stays TRUE
// between chunks, CKTtime advances continuously, and a voltage-source
// change between two `step` calls takes effect on the next solver step.
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

const VDD_VOLTS = 1.8;
const SIM_TRANSIENT_TIMESTEP_SECONDS = 1.0e-12;
const SIM_TRANSIENT_UPPER_BOUND_TSTOP_NEVER_REACHED_BY_CHUNKED_STEPS_SECONDS = 1.0e-3;
const EXTERNAL_VOLTAGE_SOURCE_RAMP_DURATION_SECONDS = 5.0e-12;
const FIRST_CHUNK_SAMPLE_COUNT = 30;
const SECOND_CHUNK_SAMPLE_COUNT = 60;
const POST_TOGGLE_CHUNK_SAMPLE_COUNT = 200;
const STEADY_STATE_VOLTAGE_TOLERANCE_VOLTS = 0.1;

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

function buildInverterTestbenchNetlistLinesWithDeckLevelTranSoStepNDrivesExecution() {
	return [
		'spice3d step-N continuous-tran verification',
		'.lib /sky130A/libs.tech/combined/sky130.lib.spice tt',
		'.include /sky130A/libs.ref/sky130_fd_sc_hd/spice/sky130_fd_sc_hd.spice',
		'V_SPICE3D_TESTBENCH_VPWR VPWR 0 DC 1.8',
		'V_SPICE3D_TESTBENCH_VGND VGND 0 DC 0',
		'V_SPICE3D_TESTBENCH_VPB  VPB  0 DC 1.8',
		'V_SPICE3D_TESTBENCH_VNB  VNB  0 DC 0',
		'VBUTTON1 net1 VGND external',
		'x1 net1 VGND VNB VPB VPWR btn_out_n sky130_fd_sc_hd__inv_1',
		'C_SPICE3D_FO4_LOAD_btn_out_n btn_out_n VGND 7.4f',
		'.tran ' + SIM_TRANSIENT_TIMESTEP_SECONDS
				+ ' ' + SIM_TRANSIENT_UPPER_BOUND_TSTOP_NEVER_REACHED_BY_CHUNKED_STEPS_SECONDS
				+ ' 0 ' + SIM_TRANSIENT_TIMESTEP_SECONDS,
		'.end',
	];
}

function readNamedVoltagesAtCurrentTimestepFromVecValuesAllStruct(
		ngspice_module, allValuesPointer, vectorCount) {
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

async function bootNgspiceAndVerifyStepNContinuousTran() {
	const pdk_root_environment_value = process.env[TESTBENCH_PDK_ROOT_ENVIRONMENT_VARIABLE_NAME];
	if (!pdk_root_environment_value || !fs.existsSync(
			path.join(pdk_root_environment_value, 'sky130A', 'libs.tech', 'combined', 'sky130.lib.spice'))) {
		emitSkipMessageAndExitCleanly(
				TESTBENCH_PDK_ROOT_ENVIRONMENT_VARIABLE_NAME
				+ ' is unset or sky130A/libs.tech/combined is missing.');
	}
	if (!fs.existsSync(repo_bundled_sc_hd_consolidated_spice_file_path)) {
		emitSkipMessageAndExitCleanly(
				'bundled sky130_fd_sc_hd.spice missing at ' + repo_bundled_sc_hd_consolidated_spice_file_path);
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
			function captureOneSampleIntoArray(allValuesPointer, vectorCount /* , libId, userData */) {
				samplesCollectedSinceLastReset.push(
						readNamedVoltagesAtCurrentTimestepFromVecValuesAllStruct(
								ngspice_module, allValuesPointer, vectorCount));
				return 0;
			},
			'iiiii');
	const ngSpiceInitReturnCode = ngspice_module._ngSpice_Init(
			ngspice_module.addFunction(() => 0, 'iiii'),
			ngspice_module.addFunction(() => 0, 'iiii'),
			ngspice_module.addFunction(() => 0, 'iiiiii'),
			sendDataCallbackFunctionPointer,
			ngspice_module.addFunction(() => 0, 'iiii'),
			ngspice_module.addFunction(() => 0, 'iiii'),
			0);
	if (ngSpiceInitReturnCode !== 0) {
		emitFailMessageAndExitWithFailureCode('ngSpice_Init returned ' + ngSpiceInitReturnCode);
	}

	const externalVoltageSourceStateByLowercaseName = Object.create(null);
	externalVoltageSourceStateByLowercaseName['vbutton1'] =
			{ valueBeforeStep: 0.0, valueAfterStep: 0.0, changeAnchorSimTime: 0.0 };
	const getVsrcDataCallbackFunctionPointer = ngspice_module.addFunction(
			function returnExternalVoltageSourceValueAtSimulatedTime(
					resultDoublePointer, simulatedTime, sourceNameCharPointer /* , libId, userData */) {
				const sourceName = ngspice_module.UTF8ToString(sourceNameCharPointer);
				const sourceState = externalVoltageSourceStateByLowercaseName[sourceName.toLowerCase()];
				let valueToReturn = 0.0;
				if (sourceState !== undefined) {
					const timeSinceChangeAnchor = simulatedTime - sourceState.changeAnchorSimTime;
					if (timeSinceChangeAnchor <= 0) {
						valueToReturn = sourceState.valueBeforeStep;
					} else if (timeSinceChangeAnchor >= EXTERNAL_VOLTAGE_SOURCE_RAMP_DURATION_SECONDS) {
						valueToReturn = sourceState.valueAfterStep;
					} else {
						const lerpFraction = timeSinceChangeAnchor / EXTERNAL_VOLTAGE_SOURCE_RAMP_DURATION_SECONDS;
						valueToReturn = sourceState.valueBeforeStep
								+ (sourceState.valueAfterStep - sourceState.valueBeforeStep) * lerpFraction;
					}
				}
				ngspice_module.HEAPF64[resultDoublePointer >> 3] = valueToReturn;
				return 0;
			},
			'iidiii');
	const ngSpiceInitSyncReturnCode = ngspice_module._ngSpice_Init_Sync(
			getVsrcDataCallbackFunctionPointer, 0, 0, 0, 0);
	if (ngSpiceInitSyncReturnCode !== 0) {
		emitFailMessageAndExitWithFailureCode(
				'ngSpice_Init_Sync returned ' + ngSpiceInitSyncReturnCode);
	}

	const sendNgspiceCommand = ngspice_module.cwrap('ngSpice_Command', 'number', ['string']);
	for (const one_testbench_line of buildInverterTestbenchNetlistLinesWithDeckLevelTranSoStepNDrivesExecution()) {
		sendNgspiceCommand('circbyline ' + one_testbench_line);
	}
	sendNgspiceCommand('save none');

	samplesCollectedSinceLastReset.length = 0;
	sendNgspiceCommand('step ' + FIRST_CHUNK_SAMPLE_COUNT);
	const chunk_one_samples = samplesCollectedSinceLastReset.slice();
	if (chunk_one_samples.length !== FIRST_CHUNK_SAMPLE_COUNT) {
		emitFailMessageAndExitWithFailureCode(
				'expected ' + FIRST_CHUNK_SAMPLE_COUNT + ' samples after first `step '
				+ FIRST_CHUNK_SAMPLE_COUNT + '`, got ' + chunk_one_samples.length
				+ ' (ngspice may have ignored the step counter)');
	}
	const chunk_one_first_sim_time = chunk_one_samples[0].simulationTimeAtThisSample;
	const chunk_one_last_sim_time = chunk_one_samples[chunk_one_samples.length - 1].simulationTimeAtThisSample;
	if (chunk_one_first_sim_time !== 0.0) {
		emitFailMessageAndExitWithFailureCode(
				'first sample of chunk 1 should be at sim_t=0 (initial conditions), got ' + chunk_one_first_sim_time);
	}
	if (chunk_one_last_sim_time <= chunk_one_first_sim_time) {
		emitFailMessageAndExitWithFailureCode(
				'chunk 1 sim time did not advance: first=' + chunk_one_first_sim_time
				+ ' last=' + chunk_one_last_sim_time);
	}
	process.stdout.write(
			'  chunk 1: ' + chunk_one_samples.length + ' samples, sim_t '
			+ chunk_one_first_sim_time.toExponential(3) + ' -> '
			+ chunk_one_last_sim_time.toExponential(3) + ' s\n');

	// ------- Chunk 2: step 60 (no new tran command) -------
	samplesCollectedSinceLastReset.length = 0;
	sendNgspiceCommand('step ' + SECOND_CHUNK_SAMPLE_COUNT);
	const chunk_two_samples = samplesCollectedSinceLastReset.slice();
	if (chunk_two_samples.length !== SECOND_CHUNK_SAMPLE_COUNT) {
		emitFailMessageAndExitWithFailureCode(
				'expected ' + SECOND_CHUNK_SAMPLE_COUNT + ' samples after second `step '
				+ SECOND_CHUNK_SAMPLE_COUNT + '`, got ' + chunk_two_samples.length
				+ ' (likely ngspice restarted the tran instead of continuing)');
	}
	const chunk_two_first_sim_time = chunk_two_samples[0].simulationTimeAtThisSample;
	const chunk_two_last_sim_time = chunk_two_samples[chunk_two_samples.length - 1].simulationTimeAtThisSample;
	if (chunk_two_first_sim_time <= chunk_one_last_sim_time) {
		emitFailMessageAndExitWithFailureCode(
				'chunk 2 first sim_t (' + chunk_two_first_sim_time
				+ ') is not strictly greater than chunk 1 last sim_t ('
				+ chunk_one_last_sim_time + ') — ngspice restarted the tran from t=0');
	}
	const expected_gap_seconds = SIM_TRANSIENT_TIMESTEP_SECONDS;
	const observed_gap_seconds = chunk_two_first_sim_time - chunk_one_last_sim_time;
	const gap_relative_error = Math.abs(observed_gap_seconds - expected_gap_seconds) / expected_gap_seconds;
	if (gap_relative_error > 5.0) {
		emitFailMessageAndExitWithFailureCode(
				'gap between chunks 1 and 2 is ' + observed_gap_seconds
				+ ' s; expected ~' + expected_gap_seconds + ' s (one timestep)');
	}
	process.stdout.write(
			'  chunk 2: ' + chunk_two_samples.length + ' samples, sim_t '
			+ chunk_two_first_sim_time.toExponential(3) + ' -> '
			+ chunk_two_last_sim_time.toExponential(3) + ' s '
			+ '(gap from chunk 1 = ' + observed_gap_seconds.toExponential(3) + ' s)\n');

	// ------- Chunk 3: toggle vbutton1 mid-stream, then step 60, verify response -------
	externalVoltageSourceStateByLowercaseName['vbutton1'].valueBeforeStep =
			externalVoltageSourceStateByLowercaseName['vbutton1'].valueAfterStep;
	externalVoltageSourceStateByLowercaseName['vbutton1'].valueAfterStep = VDD_VOLTS;
	externalVoltageSourceStateByLowercaseName['vbutton1'].changeAnchorSimTime = chunk_two_last_sim_time;

	samplesCollectedSinceLastReset.length = 0;
	sendNgspiceCommand('step ' + POST_TOGGLE_CHUNK_SAMPLE_COUNT);
	const chunk_three_samples = samplesCollectedSinceLastReset.slice();
	if (chunk_three_samples.length !== POST_TOGGLE_CHUNK_SAMPLE_COUNT) {
		emitFailMessageAndExitWithFailureCode(
				'expected ' + POST_TOGGLE_CHUNK_SAMPLE_COUNT + ' samples after post-toggle `step '
				+ POST_TOGGLE_CHUNK_SAMPLE_COUNT + '`, got ' + chunk_three_samples.length);
	}
	const chunk_three_first_sim_time = chunk_three_samples[0].simulationTimeAtThisSample;
	if (chunk_three_first_sim_time <= chunk_two_last_sim_time) {
		emitFailMessageAndExitWithFailureCode(
				'chunk 3 did not continue from where chunk 2 left off (no tran restart expected)');
	}
	const final_sample_of_chunk_three = chunk_three_samples[chunk_three_samples.length - 1];
	const final_net1_voltage = final_sample_of_chunk_three.namedVoltages['net1'];
	const final_btn_out_n_voltage = final_sample_of_chunk_three.namedVoltages['btn_out_n'];
	if (Math.abs(final_net1_voltage - VDD_VOLTS) > STEADY_STATE_VOLTAGE_TOLERANCE_VOLTS) {
		emitFailMessageAndExitWithFailureCode(
				'mid-stream vbutton1 toggle to ' + VDD_VOLTS + ' V did not propagate to net1; '
				+ 'final net1=' + final_net1_voltage + ' V (expected ~' + VDD_VOLTS + ' V)');
	}
	if (Math.abs(final_btn_out_n_voltage - 0.0) > STEADY_STATE_VOLTAGE_TOLERANCE_VOLTS) {
		emitFailMessageAndExitWithFailureCode(
				'inverter output did not respond to mid-stream input toggle; '
				+ 'final btn_out_n=' + final_btn_out_n_voltage + ' V (expected ~0 V)');
	}
	process.stdout.write(
			'  chunk 3 (post-toggle): ' + chunk_three_samples.length + ' samples, '
			+ 'final net1=' + final_net1_voltage.toFixed(3) + ' V, '
			+ 'final btn_out_n=' + final_btn_out_n_voltage.toFixed(3) + ' V\n');

	process.stdout.write('PASS — step-N continuous tran behaves as documented\n');
}

bootNgspiceAndVerifyStepNContinuousTran().catch((unhandled_error) => {
	emitFailMessageAndExitWithFailureCode('uncaught: ' + (unhandled_error && unhandled_error.stack || unhandled_error));
});
