// Verifies that snapshotting all node voltages from the SendData
// callback, rebuilding the deck with .ic v(node)=value lines, and
// reloading via ngSpice_Circ with `.tran ... uic` preserves the
// circuit trajectory across the restart — both at steady state and
// mid-transient (sim-time-aligned). Skips with exit code 0 if
// PDK_ROOT or the bundled FD_SC_HD spice file is missing.

const fs = require('fs');
const path = require('path');

const repository_root_directory = path.resolve(__dirname, '..');
const ngspice_emscripten_build_directory = path.resolve(
		repository_root_directory, 'third_party', 'ngspice', 'build-emscripten');
const ngspice_module_javascript_path = path.resolve(
		ngspice_emscripten_build_directory, 'ngspice.js');

const FAKE_PROC_MEMINFO_TEXT_FOR_NGSPICE_BUFFER_SIZING = [
	'MemTotal:        1048576 kB',
	'MemFree:         1048576 kB',
	'MemAvailable:    1048576 kB',
	'',
].join('\n');

const VDD_VOLTS = 1.8;
const SIM_TRANSIENT_TIMESTEP_SECONDS = 1.0e-12;
const SIM_TRANSIENT_UPPER_BOUND_TSTOP_SECONDS = 1.0e-3;
const PRE_SNAPSHOT_CHUNK_SAMPLE_COUNT = 50;
const POST_RESTART_VERIFICATION_CHUNK_SAMPLE_COUNT = 100;
const RESTART_NODE_VOLTAGE_TOLERANCE_VOLTS = 0.05;
const EVOLUTION_DIVERGENCE_TOLERANCE_VOLTS = 0.15;
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


function buildInverterTestbenchDeckLines(optional_initial_condition_lines, transient_timestep_seconds, transient_upper_bound_tstop_seconds, use_initial_conditions_flag) {
	const lines = [
		'spice3d snapshot+restart correctness test',
		'.lib /sky130A/libs.tech/combined/sky130.lib.spice tt',
		'.include /sky130A/libs.ref/sky130_fd_sc_hd/spice/sky130_fd_sc_hd.spice',
		'V_SPICE3D_TESTBENCH_VPWR VPWR 0 DC 1.8',
		'V_SPICE3D_TESTBENCH_VGND VGND 0 DC 0',
		'V_SPICE3D_TESTBENCH_VPB  VPB  0 DC 1.8',
		'V_SPICE3D_TESTBENCH_VNB  VNB  0 DC 0',
		'VBUTTON1 net1 VGND external',
		'x1 net1 VGND VNB VPB VPWR btn_out_n sky130_fd_sc_hd__inv_1',
		'C_SPICE3D_FO4_LOAD_btn_out_n btn_out_n VGND 7.4f',
	];
	for (const one_ic_line of optional_initial_condition_lines) {
		lines.push(one_ic_line);
	}
	const tran_command_keyword_suffix = use_initial_conditions_flag ? ' uic' : '';
	lines.push(
			'.tran ' + transient_timestep_seconds
			+ ' ' + transient_upper_bound_tstop_seconds
			+ ' 0 ' + transient_timestep_seconds
			+ tran_command_keyword_suffix);
	lines.push('.end');
	return lines;
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
	const ngSpiceCircReturnCode = ngspice_module._ngSpice_Circ(heap_pointer_array_pointer);
	ngspice_module._free(heap_pointer_array_pointer);
	ngspice_module._free(heap_text_buffer_pointer);
	return ngSpiceCircReturnCode;
}

async function bootNgspiceAndVerifySnapshotRestartRoundTrip() {
	const pdk_root_environment_value = process.env[TESTBENCH_PDK_ROOT_ENVIRONMENT_VARIABLE_NAME];
	if (!pdk_root_environment_value || !fs.existsSync(
			path.join(pdk_root_environment_value, 'sky130A', 'libs.tech', 'combined', 'sky130.lib.spice'))) {
		emitSkipMessageAndExitCleanly(
				TESTBENCH_PDK_ROOT_ENVIRONMENT_VARIABLE_NAME
				+ ' is unset or sky130A/libs.tech/combined is missing.');
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
	stageHostDirectoryIntoNgspiceMemfsAtSameRelativePath(
			ngspice_module,
			path.join(pdk_root_environment_value, 'sky130A', 'libs.ref', 'sky130_fd_sc_hd', 'spice'),
			'/sky130A/libs.ref/sky130_fd_sc_hd/spice');

	const samplesCollectedSinceLastReset = [];
	const sendDataCallbackFunctionPointer = ngspice_module.addFunction(
			function captureOneSampleIntoArray(allValuesPointer, vectorCount /* , libId, userData */) {
				samplesCollectedSinceLastReset.push(
						readNamedVoltagesFromSendDataCallbackPayload(
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
			{ valueBeforeStep: VDD_VOLTS, valueAfterStep: VDD_VOLTS, changeAnchorSimTime: 0.0 };
	const getVsrcDataCallbackFunctionPointer = ngspice_module.addFunction(
			function returnExternalVoltageSourceValueAtSimulatedTime(
					resultDoublePointer, simulatedTime, sourceNameCharPointer /* , libId, userData */) {
				const sourceName = ngspice_module.UTF8ToString(sourceNameCharPointer);
				const sourceState = externalVoltageSourceStateByLowercaseName[sourceName.toLowerCase()];
				let valueToReturn = 0.0;
				if (sourceState !== undefined) {
					valueToReturn = sourceState.valueAfterStep;
				}
				ngspice_module.HEAPF64[resultDoublePointer >> 3] = valueToReturn;
				return 0;
			},
			'iidiii');
	ngspice_module._ngSpice_Init_Sync(
			getVsrcDataCallbackFunctionPointer, 0, 0, 0, 0);

	const sendNgspiceCommand = ngspice_module.cwrap('ngSpice_Command', 'number', ['string']);

	const original_deck_no_initial_conditions = buildInverterTestbenchDeckLines(
			[],
			SIM_TRANSIENT_TIMESTEP_SECONDS,
			SIM_TRANSIENT_UPPER_BOUND_TSTOP_SECONDS,
			false);
	for (const one_line of original_deck_no_initial_conditions) {
		sendNgspiceCommand('circbyline ' + one_line);
	}
	sendNgspiceCommand('save none');

	samplesCollectedSinceLastReset.length = 0;
	sendNgspiceCommand('step ' + PRE_SNAPSHOT_CHUNK_SAMPLE_COUNT);
	const pre_snapshot_chunk_samples = samplesCollectedSinceLastReset.slice();
	if (pre_snapshot_chunk_samples.length === 0) {
		emitFailMessageAndExitWithFailureCode('pre-snapshot chunk emitted zero samples');
	}
	const snapshot_sample = pre_snapshot_chunk_samples[pre_snapshot_chunk_samples.length - 1];
	const snapshot_sim_time = snapshot_sample.simulationTimeAtThisSample;
	const snapshot_node_voltages = snapshot_sample.namedVoltages;
	process.stdout.write(
			'  snapshot taken at sim_t=' + snapshot_sim_time.toExponential(3) + 's:');
	for (const one_node_name of Object.keys(snapshot_node_voltages)) {
		if (EXCLUDE_NODES_FROM_RESTART_SNAPSHOT.has(one_node_name)) continue;
		process.stdout.write(
				' ' + one_node_name + '=' + snapshot_node_voltages[one_node_name].toFixed(4) + 'V');
	}
	process.stdout.write('\n');

	samplesCollectedSinceLastReset.length = 0;
	sendNgspiceCommand('step ' + POST_RESTART_VERIFICATION_CHUNK_SAMPLE_COUNT);
	const control_branch_post_snapshot_samples = samplesCollectedSinceLastReset.slice();

	const initial_condition_lines_from_snapshot = buildInitialConditionLinesFromCapturedNodeVoltages(
			snapshot_node_voltages);
	const restarted_deck_with_initial_conditions = buildInverterTestbenchDeckLines(
			initial_condition_lines_from_snapshot,
			SIM_TRANSIENT_TIMESTEP_SECONDS,
			SIM_TRANSIENT_UPPER_BOUND_TSTOP_SECONDS,
			true);
	const ngSpiceCircReturnCode = loadDeckIntoNgspiceViaCircArray(
			ngspice_module, restarted_deck_with_initial_conditions);
	if (ngSpiceCircReturnCode !== 0) {
		emitFailMessageAndExitWithFailureCode(
				'ngSpice_Circ for restart returned ' + ngSpiceCircReturnCode);
	}
	sendNgspiceCommand('save none');

	samplesCollectedSinceLastReset.length = 0;
	sendNgspiceCommand('step 1');
	if (samplesCollectedSinceLastReset.length === 0) {
		emitFailMessageAndExitWithFailureCode(
				'restarted run emitted zero samples (ngSpice_Circ may not have loaded the new deck)');
	}
	const first_restarted_sample = samplesCollectedSinceLastReset[0];
	const first_restarted_voltages = first_restarted_sample.namedVoltages;

	for (const one_node_name of Object.keys(snapshot_node_voltages)) {
		if (EXCLUDE_NODES_FROM_RESTART_SNAPSHOT.has(one_node_name)) continue;
		const snapshot_voltage = snapshot_node_voltages[one_node_name];
		const restarted_voltage = first_restarted_voltages[one_node_name];
		if (restarted_voltage === undefined) {
			emitFailMessageAndExitWithFailureCode(
					'node ' + one_node_name + ' missing from restarted run');
		}
		const absolute_voltage_delta = Math.abs(restarted_voltage - snapshot_voltage);
		if (absolute_voltage_delta > RESTART_NODE_VOLTAGE_TOLERANCE_VOLTS) {
			emitFailMessageAndExitWithFailureCode(
					'restart first-sample voltage on ' + one_node_name + ' differs from snapshot by '
					+ absolute_voltage_delta.toFixed(4) + 'V (snapshot='
					+ snapshot_voltage.toFixed(4) + 'V restart=' + restarted_voltage.toFixed(4)
					+ 'V tolerance=' + RESTART_NODE_VOLTAGE_TOLERANCE_VOLTS + 'V)');
		}
	}
	process.stdout.write(
			'  first restarted sample matches snapshot within tolerance ('
			+ RESTART_NODE_VOLTAGE_TOLERANCE_VOLTS + 'V).\n');

	samplesCollectedSinceLastReset.length = 0;
	sendNgspiceCommand('step ' + (POST_RESTART_VERIFICATION_CHUNK_SAMPLE_COUNT - 1));
	const restart_branch_post_snapshot_samples = [first_restarted_sample]
			.concat(samplesCollectedSinceLastReset.slice());

	const sample_count_to_compare = Math.min(
			control_branch_post_snapshot_samples.length,
			restart_branch_post_snapshot_samples.length);
	let largest_per_node_divergence_volts = 0.0;
	let largest_divergence_node_name = '';
	let largest_divergence_sample_index = 0;
	for (let one_sample_index = 0; one_sample_index < sample_count_to_compare; ++one_sample_index) {
		const control_voltages = control_branch_post_snapshot_samples[one_sample_index].namedVoltages;
		const restart_voltages = restart_branch_post_snapshot_samples[one_sample_index].namedVoltages;
		for (const one_node_name of Object.keys(control_voltages)) {
			if (EXCLUDE_NODES_FROM_RESTART_SNAPSHOT.has(one_node_name)) continue;
			const absolute_divergence = Math.abs(
					control_voltages[one_node_name] - restart_voltages[one_node_name]);
			if (absolute_divergence > largest_per_node_divergence_volts) {
				largest_per_node_divergence_volts = absolute_divergence;
				largest_divergence_node_name = one_node_name;
				largest_divergence_sample_index = one_sample_index;
			}
		}
	}
	if (largest_per_node_divergence_volts > EVOLUTION_DIVERGENCE_TOLERANCE_VOLTS) {
		emitFailMessageAndExitWithFailureCode(
				'after ' + sample_count_to_compare + ' post-snapshot samples, control vs restart diverged by '
				+ largest_per_node_divergence_volts.toFixed(4) + 'V on '
				+ largest_divergence_node_name + ' (sample ' + largest_divergence_sample_index
				+ ', tolerance=' + EVOLUTION_DIVERGENCE_TOLERANCE_VOLTS + 'V)');
	}
	process.stdout.write(
			'  steady-state branch: max divergence over ' + sample_count_to_compare
			+ ' samples = ' + largest_per_node_divergence_volts.toFixed(4)
			+ 'V on ' + largest_divergence_node_name + '.\n');

	await verifySnapshotRestartDuringActiveTransient(
			ngspice_module, sendNgspiceCommand, samplesCollectedSinceLastReset,
			externalVoltageSourceStateByLowercaseName);

	process.stdout.write('PASS — snapshot+restart round-trip preserves circuit state\n');
}

async function verifySnapshotRestartDuringActiveTransient(
		ngspice_module, sendNgspiceCommand, samplesCollectedSinceLastReset,
		externalVoltageSourceStateByLowercaseName) {
	externalVoltageSourceStateByLowercaseName['vbutton1'].valueAfterStep = 0.0;

	const original_deck_no_initial_conditions = buildInverterTestbenchDeckLines(
			[],
			SIM_TRANSIENT_TIMESTEP_SECONDS,
			SIM_TRANSIENT_UPPER_BOUND_TSTOP_SECONDS,
			false);
	loadDeckIntoNgspiceViaCircArray(ngspice_module, original_deck_no_initial_conditions);
	sendNgspiceCommand('save none');

	const PRE_TOGGLE_STABILIZATION_SAMPLE_COUNT = 30;
	const POST_TOGGLE_SAMPLES_BEFORE_SNAPSHOT_MID_TRANSITION = 15;
	const POST_RESTART_VERIFICATION_SAMPLE_COUNT = 100;

	samplesCollectedSinceLastReset.length = 0;
	sendNgspiceCommand('step ' + PRE_TOGGLE_STABILIZATION_SAMPLE_COUNT);
	samplesCollectedSinceLastReset.length = 0;

	externalVoltageSourceStateByLowercaseName['vbutton1'].valueAfterStep = VDD_VOLTS;
	sendNgspiceCommand('step ' + POST_TOGGLE_SAMPLES_BEFORE_SNAPSHOT_MID_TRANSITION);
	const mid_transient_snapshot_sample = samplesCollectedSinceLastReset[
			samplesCollectedSinceLastReset.length - 1];
	const mid_transient_snapshot_sim_time = mid_transient_snapshot_sample.simulationTimeAtThisSample;
	const mid_transient_snapshot_voltages = mid_transient_snapshot_sample.namedVoltages;
	process.stdout.write(
			'  mid-transient snapshot at sim_t=' + mid_transient_snapshot_sim_time.toExponential(3)
			+ 's, net1=' + mid_transient_snapshot_voltages['net1'].toFixed(4)
			+ 'V btn_out_n=' + mid_transient_snapshot_voltages['btn_out_n'].toFixed(4) + 'V\n');

	if (mid_transient_snapshot_voltages['btn_out_n'] < 0.2
			|| mid_transient_snapshot_voltages['btn_out_n'] > VDD_VOLTS - 0.2) {
		emitFailMessageAndExitWithFailureCode(
				'mid-transient snapshot was not actually in transition; btn_out_n='
				+ mid_transient_snapshot_voltages['btn_out_n']
				+ 'V — pick a different sample count');
	}

	samplesCollectedSinceLastReset.length = 0;
	sendNgspiceCommand('step ' + POST_RESTART_VERIFICATION_SAMPLE_COUNT);
	const control_branch_post_snapshot_samples = samplesCollectedSinceLastReset.slice();

	const initial_condition_lines_from_mid_transient_snapshot = buildInitialConditionLinesFromCapturedNodeVoltages(
			mid_transient_snapshot_voltages);
	const restarted_deck_with_initial_conditions = buildInverterTestbenchDeckLines(
			initial_condition_lines_from_mid_transient_snapshot,
			SIM_TRANSIENT_TIMESTEP_SECONDS,
			SIM_TRANSIENT_UPPER_BOUND_TSTOP_SECONDS,
			true);
	loadDeckIntoNgspiceViaCircArray(ngspice_module, restarted_deck_with_initial_conditions);
	sendNgspiceCommand('save none');

	samplesCollectedSinceLastReset.length = 0;
	sendNgspiceCommand('step ' + POST_RESTART_VERIFICATION_SAMPLE_COUNT);
	const restart_branch_post_snapshot_samples = samplesCollectedSinceLastReset.slice();

	const largest_per_node_divergence_volts = computeLargestNodeVoltageDivergenceBetweenBranchesAlignedBySimTime(
			control_branch_post_snapshot_samples,
			restart_branch_post_snapshot_samples,
			mid_transient_snapshot_sim_time);
	const final_control_btn_out_n = control_branch_post_snapshot_samples[
			control_branch_post_snapshot_samples.length - 1].namedVoltages['btn_out_n'];
	const final_restart_btn_out_n = restart_branch_post_snapshot_samples[
			restart_branch_post_snapshot_samples.length - 1].namedVoltages['btn_out_n'];
	process.stdout.write(
			'  mid-transient branch: max sim-time-aligned divergence = '
			+ largest_per_node_divergence_volts.peak_voltage_delta.toFixed(4)
			+ 'V on ' + largest_per_node_divergence_volts.peak_voltage_delta_node_name
			+ ' at restart_t=' + largest_per_node_divergence_volts.peak_voltage_delta_restart_relative_sim_time.toExponential(2)
			+ 's (final btn_out_n control='
			+ final_control_btn_out_n.toFixed(4) + 'V restart='
			+ final_restart_btn_out_n.toFixed(4) + 'V).\n');
	if (largest_per_node_divergence_volts.peak_voltage_delta > EVOLUTION_DIVERGENCE_TOLERANCE_VOLTS) {
		emitFailMessageAndExitWithFailureCode(
				'mid-transient restart diverges from control by '
				+ largest_per_node_divergence_volts.peak_voltage_delta.toFixed(4)
				+ 'V even after sim-time alignment (tolerance='
				+ EVOLUTION_DIVERGENCE_TOLERANCE_VOLTS + 'V)');
	}
}


function linearlyInterpolateBranchVoltagesAtTargetSimTime(branch_samples, target_sim_time, node_name) {
	for (let one_sample_index = 1; one_sample_index < branch_samples.length; ++one_sample_index) {
		const previous_sample = branch_samples[one_sample_index - 1];
		const current_sample = branch_samples[one_sample_index];
		if (previous_sample.simulationTimeAtThisSample <= target_sim_time
				&& target_sim_time <= current_sample.simulationTimeAtThisSample) {
			const sim_time_gap = current_sample.simulationTimeAtThisSample
					- previous_sample.simulationTimeAtThisSample;
			if (sim_time_gap <= 0) return current_sample.namedVoltages[node_name];
			const lerp_fraction = (target_sim_time - previous_sample.simulationTimeAtThisSample)
					/ sim_time_gap;
			return previous_sample.namedVoltages[node_name]
					+ (current_sample.namedVoltages[node_name] - previous_sample.namedVoltages[node_name])
					* lerp_fraction;
		}
	}
	return null;
}


function computeLargestNodeVoltageDivergenceBetweenBranchesAlignedBySimTime(
		control_branch_samples, restart_branch_samples, snapshot_sim_time_in_control_branch) {
	let peak_voltage_delta = 0.0;
	let peak_voltage_delta_node_name = '';
	let peak_voltage_delta_restart_relative_sim_time = 0.0;
	const node_names_to_compare = Object.keys(control_branch_samples[0].namedVoltages).filter(
			(one_node_name) => !EXCLUDE_NODES_FROM_RESTART_SNAPSHOT.has(one_node_name));
	for (const one_restart_sample of restart_branch_samples) {
		const restart_relative_sim_time = one_restart_sample.simulationTimeAtThisSample;
		const corresponding_control_sim_time = snapshot_sim_time_in_control_branch
				+ restart_relative_sim_time;
		for (const one_node_name of node_names_to_compare) {
			const control_voltage_at_aligned_time = linearlyInterpolateBranchVoltagesAtTargetSimTime(
					control_branch_samples, corresponding_control_sim_time, one_node_name);
			if (control_voltage_at_aligned_time === null) continue;
			const restart_voltage = one_restart_sample.namedVoltages[one_node_name];
			const absolute_voltage_delta = Math.abs(restart_voltage - control_voltage_at_aligned_time);
			if (absolute_voltage_delta > peak_voltage_delta) {
				peak_voltage_delta = absolute_voltage_delta;
				peak_voltage_delta_node_name = one_node_name;
				peak_voltage_delta_restart_relative_sim_time = restart_relative_sim_time;
			}
		}
	}
	return {
		peak_voltage_delta,
		peak_voltage_delta_node_name,
		peak_voltage_delta_restart_relative_sim_time,
	};
}

bootNgspiceAndVerifySnapshotRestartRoundTrip().catch((unhandled_error) => {
	emitFailMessageAndExitWithFailureCode('uncaught: ' + (unhandled_error && unhandled_error.stack || unhandled_error));
});
