// End-to-end regression test that mirrors the deployed page's whole
// button-click pipeline:
//   - same testbench shape main.gd's convert_xschem_subckt_netlist_into_top_level_testbench
//     emits (lib + include + rails + VBUTTON1 external + sky130_fd_sc_hd__inv_1
//     instance + 7.4 fF FO4 load + .end)
//   - same `external` + GetVSRCData callback the worker registers via
//     _ngSpice_Init_Sync, with the same valueBeforeStep/valueAfterStep
//     state machine and 5 ps linear ramp
//   - same {`save none`, `tran`, `run`} sequence the worker fires per click
//
// Asserts:
//   - initial steady state (V_VBUTTON1=0): net1 ≈ 0 V, btn_out_n ≈ VDD
//   - after toggling to HIGH:                net1 ≈ VDD, btn_out_n ≈ 0 V
//   - after toggling back to LOW:            net1 ≈ 0 V, btn_out_n ≈ VDD
//   - propagation delay (input crosses VDD/2 → output crosses VDD/2)
//     is in the realistic range [15, 100] ps for both transitions. The
//     lower bound is the load-bearing assertion — with no FO4 cap on
//     btn_out_n, the same testbench measures ~5–10 ps tpd (verified by
//     running the test against a netlist with the cap line removed), so
//     anything below 15 ps catches a regression where the cap either
//     never reaches ngspice (.end stripping, cap after .end, broken
//     external callback) or is silently dropped.
//
// Skips with exit code 0 if PDK_ROOT or the bundled FD_SC_HD spice file
// is missing, the same convention scripts/test-button-test-netlist-against-real-ngspice.sh
// uses. The repo bundles sky130_fd_sc_hd.spice itself, but the .lib chain
// (`libs.tech/combined/`) still has to come from a local ciel checkout.

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
const SIM_TRANSIENT_STOP_SECONDS = 5.0e-10;
const EXTERNAL_VOLTAGE_SOURCE_RAMP_DURATION_SECONDS = 5.0e-12;
// With the 7.4 fF FO4 load on btn_out_n, sky130_fd_sc_hd__inv_1's measured
// tpd is ~31 ps for the rising input edge and ~67 ps for the falling edge
// (PMOS is the hvt variant and weaker than the NMOS). Without the FO4 cap
// the same testbench measures ~5 ps and ~10 ps — so the lower bound needs
// to be tight enough to flag a missing-cap regression. 15 ps catches that
// without false-positiving on solver-precision noise.
const ACCEPTABLE_TPD_MINIMUM_PICOSECONDS = 15.0;
const ACCEPTABLE_TPD_MAXIMUM_PICOSECONDS = 100.0;
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

function buildTestbenchNetlistLinesInTheSameShapeMainGdEmits() {
	return [
		'spice3d button-toggle end-to-end test',
		'.lib /sky130A/libs.tech/combined/sky130.lib.spice tt',
		'.include /sky130A/libs.ref/sky130_fd_sc_hd/spice/sky130_fd_sc_hd.spice',
		'V_SPICE3D_TESTBENCH_VPWR VPWR 0 DC 1.8',
		'V_SPICE3D_TESTBENCH_VGND VGND 0 DC 0',
		'V_SPICE3D_TESTBENCH_VPB  VPB  0 DC 1.8',
		'V_SPICE3D_TESTBENCH_VNB  VNB  0 DC 0',
		'VBUTTON1 net1 VGND external',
		'x1 net1 VGND VNB VPB VPWR btn_out_n sky130_fd_sc_hd__inv_1',
		'C_SPICE3D_FO4_LOAD_btn_out_n btn_out_n VGND 7.4f',
		'.end',
	];
}

function readNamedVoltagesAtCurrentTimestepFromVecValuesAllStruct(ngspice_module, allValuesPointer, vectorCount) {
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

async function bootNgspiceAndRunButtonToggleEndToEndTest() {
	const pdk_root_environment_value = process.env[TESTBENCH_PDK_ROOT_ENVIRONMENT_VARIABLE_NAME];
	if (!pdk_root_environment_value || !fs.existsSync(
			path.join(pdk_root_environment_value, 'sky130A', 'libs.tech', 'combined', 'sky130.lib.spice'))) {
		emitSkipMessageAndExitCleanly(
				TESTBENCH_PDK_ROOT_ENVIRONMENT_VARIABLE_NAME
				+ ' is unset or sky130A/libs.tech/combined is missing — see scripts/install-godot.sh-style local setup.');
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

	const samplesCollectedDuringLastTran = [];
	const sendDataCallbackFunctionPointer = ngspice_module.addFunction(
			function captureOneSampleIntoArray(allValuesPointer, vectorCount /* , libId, userData */) {
				samplesCollectedDuringLastTran.push(
						readNamedVoltagesAtCurrentTimestepFromVecValuesAllStruct(
								ngspice_module, allValuesPointer, vectorCount));
				return 0;
			},
			'iiiii');
	const captured_ngspice_diagnostic_lines = [];
	const sendCharCallbackFunctionPointer = ngspice_module.addFunction(
			function capture_ngspice_diagnostic_line(textPointer) {
				captured_ngspice_diagnostic_lines.push(ngspice_module.UTF8ToString(textPointer));
				return 0;
			},
			'iiii');
	const ngSpiceInitReturnCode = ngspice_module._ngSpice_Init(
			sendCharCallbackFunctionPointer,
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
			{ valueBeforeStep: 0.0, valueAfterStep: 0.0 };
	const getVsrcDataCallbackFunctionPointer = ngspice_module.addFunction(
			function returnExternalVoltageSourceValueAtSimulatedTime(
					resultDoublePointer, simulatedTime, sourceNameCharPointer /* , libId, userData */) {
				const sourceName = ngspice_module.UTF8ToString(sourceNameCharPointer);
				const sourceState = externalVoltageSourceStateByLowercaseName[sourceName.toLowerCase()];
				let valueToReturn = 0.0;
				if (sourceState !== undefined) {
					if (simulatedTime <= 0) {
						valueToReturn = sourceState.valueBeforeStep;
					} else if (simulatedTime >= EXTERNAL_VOLTAGE_SOURCE_RAMP_DURATION_SECONDS) {
						valueToReturn = sourceState.valueAfterStep;
					} else {
						const lerpFraction = simulatedTime / EXTERNAL_VOLTAGE_SOURCE_RAMP_DURATION_SECONDS;
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
	for (const one_testbench_line of buildTestbenchNetlistLinesInTheSameShapeMainGdEmits()) {
		sendNgspiceCommand('circbyline ' + one_testbench_line);
	}
	sendNgspiceCommand('save none');

	function runOneEventDrivenTransientAndReturnCapturedSamples() {
		samplesCollectedDuringLastTran.length = 0;
		sendNgspiceCommand(
				'tran ' + SIM_TRANSIENT_TIMESTEP_SECONDS
				+ ' ' + SIM_TRANSIENT_STOP_SECONDS
				+ ' 0 ' + SIM_TRANSIENT_TIMESTEP_SECONDS);
		sendNgspiceCommand('run');
		externalVoltageSourceStateByLowercaseName['vbutton1'].valueBeforeStep =
				externalVoltageSourceStateByLowercaseName['vbutton1'].valueAfterStep;
		return samplesCollectedDuringLastTran.slice();
	}

	function findFirstSampleWhereNodeCrossesThresholdInDirection(
			samples_array, node_name, threshold_volts, direction_indicator) {
		for (let sample_index = 1; sample_index < samples_array.length; ++sample_index) {
			const previous_voltage_at_node = samples_array[sample_index - 1].namedVoltages[node_name];
			const current_voltage_at_node = samples_array[sample_index].namedVoltages[node_name];
			if (direction_indicator === 'rising'
					&& previous_voltage_at_node < threshold_volts
					&& current_voltage_at_node >= threshold_volts) {
				return samples_array[sample_index].simulationTimeAtThisSample;
			}
			if (direction_indicator === 'falling'
					&& previous_voltage_at_node > threshold_volts
					&& current_voltage_at_node <= threshold_volts) {
				return samples_array[sample_index].simulationTimeAtThisSample;
			}
		}
		return null;
	}

	function failIfFinalSteadyStateVoltageIsNotApproximatelyExpected(
			samples_array, node_name, expected_volts, human_phase_description) {
		const final_sample = samples_array[samples_array.length - 1];
		const final_voltage = final_sample.namedVoltages[node_name];
		if (Math.abs(final_voltage - expected_volts) > STEADY_STATE_VOLTAGE_TOLERANCE_VOLTS) {
			emitFailMessageAndExitWithFailureCode(
					human_phase_description + ': expected v(' + node_name + ') ≈ ' + expected_volts.toFixed(3)
					+ ' V at end of tran, got ' + final_voltage.toFixed(6) + ' V'
					+ ' (last few ngspice diagnostic lines:\n  '
					+ captured_ngspice_diagnostic_lines.slice(-5).join('  ') + ')');
		}
	}

	function failIfTpdIsNotInRealisticRange(
			samples_array, input_node_name, input_direction_indicator,
			output_node_name, output_direction_indicator,
			human_phase_description) {
		const input_crossing_time_seconds = findFirstSampleWhereNodeCrossesThresholdInDirection(
				samples_array, input_node_name, VDD_VOLTS / 2, input_direction_indicator);
		const output_crossing_time_seconds = findFirstSampleWhereNodeCrossesThresholdInDirection(
				samples_array, output_node_name, VDD_VOLTS / 2, output_direction_indicator);
		if (input_crossing_time_seconds === null || output_crossing_time_seconds === null) {
			emitFailMessageAndExitWithFailureCode(
					human_phase_description + ': did not observe both an input crossing of '
					+ input_node_name + ' (' + input_direction_indicator + ') and an output crossing of '
					+ output_node_name + ' (' + output_direction_indicator + ') during the tran. '
					+ '(samples=' + samples_array.length + ')');
		}
		const propagation_delay_picoseconds =
				(output_crossing_time_seconds - input_crossing_time_seconds) * 1.0e12;
		if (propagation_delay_picoseconds < ACCEPTABLE_TPD_MINIMUM_PICOSECONDS
				|| propagation_delay_picoseconds > ACCEPTABLE_TPD_MAXIMUM_PICOSECONDS) {
			emitFailMessageAndExitWithFailureCode(
					human_phase_description + ': tpd = ' + propagation_delay_picoseconds.toFixed(2) + ' ps, '
					+ 'expected in [' + ACCEPTABLE_TPD_MINIMUM_PICOSECONDS
					+ ', ' + ACCEPTABLE_TPD_MAXIMUM_PICOSECONDS + '] ps. '
					+ 'Sub-ps tpd usually means the FO4 cap never reached ngspice (.end stripping, '
					+ 'cap appended after .end, or external callback misregistered).');
		}
		process.stdout.write('  ' + human_phase_description + ' tpd = '
				+ propagation_delay_picoseconds.toFixed(2) + ' ps\n');
	}

	function failIfSampleSimTimesAreNotMonotonicAndSpanningExpectedWindow(
			samples_array, human_phase_description) {
		if (samples_array.length === 0) {
			emitFailMessageAndExitWithFailureCode(
					human_phase_description + ': zero samples returned from ngspice (transient never ran?)');
		}
		const first_sample_sim_time = samples_array[0].simulationTimeAtThisSample;
		const last_sample_sim_time = samples_array[samples_array.length - 1].simulationTimeAtThisSample;
		if (first_sample_sim_time !== 0) {
			emitFailMessageAndExitWithFailureCode(
					human_phase_description + ': first sample should be at sim time 0 (initial conditions), got '
					+ first_sample_sim_time.toExponential(3));
		}
		const tolerated_sim_time_under_tran_stop_seconds = SIM_TRANSIENT_STOP_SECONDS * 0.5;
		if (last_sample_sim_time < SIM_TRANSIENT_STOP_SECONDS - tolerated_sim_time_under_tran_stop_seconds) {
			emitFailMessageAndExitWithFailureCode(
					human_phase_description + ': last sample sim time should be ≈ tran_stop ('
					+ SIM_TRANSIENT_STOP_SECONDS.toExponential(3) + ' s), got '
					+ last_sample_sim_time.toExponential(3) + ' s — solver may have bailed early');
		}
		for (let sample_index = 1; sample_index < samples_array.length; ++sample_index) {
			const previous_sim_time = samples_array[sample_index - 1].simulationTimeAtThisSample;
			const current_sim_time = samples_array[sample_index].simulationTimeAtThisSample;
			if (current_sim_time < previous_sim_time) {
				emitFailMessageAndExitWithFailureCode(
						human_phase_description + ': sample sim times must be monotonically non-decreasing; '
						+ 'sample ' + (sample_index - 1) + ' at t=' + previous_sim_time.toExponential(3)
						+ ' followed by sample ' + sample_index + ' at t=' + current_sim_time.toExponential(3));
			}
		}
		const expected_sample_count_lower_bound = Math.floor(
				(SIM_TRANSIENT_STOP_SECONDS / SIM_TRANSIENT_TIMESTEP_SECONDS) * 0.5);
		const expected_sample_count_upper_bound = Math.ceil(
				(SIM_TRANSIENT_STOP_SECONDS / SIM_TRANSIENT_TIMESTEP_SECONDS) * 3.0);
		if (samples_array.length < expected_sample_count_lower_bound
				|| samples_array.length > expected_sample_count_upper_bound) {
			emitFailMessageAndExitWithFailureCode(
					human_phase_description + ': sample count ' + samples_array.length
					+ ' is outside expected range [' + expected_sample_count_lower_bound
					+ ', ' + expected_sample_count_upper_bound
					+ '] for tran_stop=' + SIM_TRANSIENT_STOP_SECONDS.toExponential(3)
					+ ' s / timestep=' + SIM_TRANSIENT_TIMESTEP_SECONDS.toExponential(3) + ' s. '
					+ 'A count near the lower bound suggests ngspice ignored tmax; '
					+ 'a count near zero suggests the netlist failed to load.');
		}
		process.stdout.write('  ' + human_phase_description + ' sim-time window: ['
				+ first_sample_sim_time.toExponential(2) + ', '
				+ last_sample_sim_time.toExponential(2) + '] s, '
				+ samples_array.length + ' samples\n');
	}

	// Phase 1: source held at 0 V — verify the inverter is at the "high" steady state.
	const phase_one_samples = runOneEventDrivenTransientAndReturnCapturedSamples();
	failIfSampleSimTimesAreNotMonotonicAndSpanningExpectedWindow(
			phase_one_samples, 'phase 1 (vbutton=0)');
	failIfFinalSteadyStateVoltageIsNotApproximatelyExpected(
			phase_one_samples, 'net1', 0.0, 'phase 1 (vbutton=0)');
	failIfFinalSteadyStateVoltageIsNotApproximatelyExpected(
			phase_one_samples, 'btn_out_n', VDD_VOLTS, 'phase 1 (vbutton=0)');

	// Phase 2: toggle source to VDD — verify net1 rises, btn_out_n falls,
	// and propagation delay is realistic.
	externalVoltageSourceStateByLowercaseName['vbutton1'].valueAfterStep = VDD_VOLTS;
	const phase_two_samples = runOneEventDrivenTransientAndReturnCapturedSamples();
	failIfSampleSimTimesAreNotMonotonicAndSpanningExpectedWindow(
			phase_two_samples, 'phase 2 (vbutton=VDD)');
	failIfFinalSteadyStateVoltageIsNotApproximatelyExpected(
			phase_two_samples, 'net1', VDD_VOLTS, 'phase 2 (vbutton=VDD)');
	failIfFinalSteadyStateVoltageIsNotApproximatelyExpected(
			phase_two_samples, 'btn_out_n', 0.0, 'phase 2 (vbutton=VDD)');
	failIfTpdIsNotInRealisticRange(
			phase_two_samples, 'net1', 'rising', 'btn_out_n', 'falling',
			'phase 2 (vbutton=VDD)');

	// Phase 3: toggle source back to 0 V — verify net1 falls, btn_out_n rises,
	// and propagation delay is again realistic.
	externalVoltageSourceStateByLowercaseName['vbutton1'].valueAfterStep = 0.0;
	const phase_three_samples = runOneEventDrivenTransientAndReturnCapturedSamples();
	failIfSampleSimTimesAreNotMonotonicAndSpanningExpectedWindow(
			phase_three_samples, 'phase 3 (vbutton=0 again)');
	failIfFinalSteadyStateVoltageIsNotApproximatelyExpected(
			phase_three_samples, 'net1', 0.0, 'phase 3 (vbutton=0 again)');
	failIfFinalSteadyStateVoltageIsNotApproximatelyExpected(
			phase_three_samples, 'btn_out_n', VDD_VOLTS, 'phase 3 (vbutton=0 again)');
	failIfTpdIsNotInRealisticRange(
			phase_three_samples, 'net1', 'falling', 'btn_out_n', 'rising',
			'phase 3 (vbutton=0 again)');

	process.stdout.write('PASS — button toggle end-to-end test\n');
}

bootNgspiceAndRunButtonToggleEndToEndTest().catch((unhandledError) => {
	emitFailMessageAndExitWithFailureCode(
			'unhandled exception: ' + (unhandledError && unhandledError.stack || unhandledError));
});
