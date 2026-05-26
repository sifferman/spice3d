// Head-to-head benchmark of two ways to drive an interactive voltage
// source in ngspice's shared library:
//
//   (1) PULSE source + `alter @source[pulse] = [...]` on each click
//   (2) external source + `ngSpice_Init_Sync(GetVSRCData *, ...)` callback
//
// Identical RC test circuit, identical toggle sequence, identical tran
// params. Only the source mechanism differs. Reports per-tran wall
// time stats, final settled voltages (sanity check that both reach the
// same answer), and the last tran's sample count (proxy for ngspice's
// adaptive timestep count).

const path = require('path');
const performanceNow = () => (typeof performance !== 'undefined' && performance.now)
		? performance.now() : Date.now();

const ngspice_emscripten_build_directory =
		path.resolve(__dirname, '..', 'third_party', 'ngspice', 'build-emscripten');
const ngspice_module_javascript_path =
		path.resolve(ngspice_emscripten_build_directory, 'ngspice.js');

const FAKE_PROC_MEMINFO_TEXT_FOR_NGSPICE_BUFFER_SIZING = [
	'MemTotal:        1048576 kB',
	'MemFree:         1048576 kB',
	'MemAvailable:    1048576 kB',
	'',
].join('\n');

const TRANSIENT_TIMESTEP_SECONDS = 5e-12;
const TRANSIENT_STOP_TIME_SECONDS = 2e-10;
const SOURCE_RAMP_DURATION_SECONDS = 5e-12;
const NUMBER_OF_BUTTON_TOGGLES_TO_RUN_PER_BENCHMARK = 50;

const RC_NETLIST_WITH_PULSE_SOURCE = [
	'pulse-vs-external benchmark',
	'V_INPUT n1 0 PULSE(0 0 0 5e-12 5e-12 1e-2 2e-2)',
	'R1 n1 out 1k',
	'C1 out 0 1p',
	'.end',
];
const RC_NETLIST_WITH_EXTERNAL_SOURCE = [
	'pulse-vs-external benchmark',
	'V_INPUT n1 0 external',
	'R1 n1 out 1k',
	'C1 out 0 1p',
	'.end',
];

async function createBlankNgspiceModuleInstance() {
	const createNgspiceModule = require(ngspice_module_javascript_path);
	const ngspice_module = await createNgspiceModule({
		locateFile: (relativeFileName) =>
				path.resolve(ngspice_emscripten_build_directory, relativeFileName),
		print: () => {},
		printErr: () => {},
		preRun: [
			function stubFakeProcMeminfoIntoModuleMemfs(module) {
				module.FS.mkdirTree('/proc');
				module.FS.writeFile('/proc/meminfo', FAKE_PROC_MEMINFO_TEXT_FOR_NGSPICE_BUFFER_SIZING);
			},
		],
	});
	return ngspice_module;
}

function readNamedSampleVoltagesFromVecValuesAllStruct(module, allVectorValuesPointer, vectorCount) {
	const vectorEntryArrayPointer = module.HEAPU32[(allVectorValuesPointer + 8) >> 2];
	const namedVoltages = Object.create(null);
	for (let vectorIndex = 0; vectorIndex < vectorCount; ++vectorIndex) {
		const vectorEntryPointer = module.HEAPU32[(vectorEntryArrayPointer >> 2) + vectorIndex];
		const namePointer = module.HEAPU32[vectorEntryPointer >> 2];
		const realPart = module.HEAPF64[(vectorEntryPointer + 8) >> 3];
		const name = module.UTF8ToString(namePointer);
		namedVoltages[name] = realPart;
	}
	return namedVoltages;
}

function registerCommonNoopCallbacksAndReturnSendDataCallbackTrackerObject(module) {
	const sampleStatsTracker = {
		samplesInLastTran: 0,
		lastSampleVoltagesByName: null,
	};
	const sendDataCallbackFunctionPointer = module.addFunction(
			function captureLastSampleVoltages(allValuesPointer, vectorCount) {
				sampleStatsTracker.samplesInLastTran += 1;
				sampleStatsTracker.lastSampleVoltagesByName =
						readNamedSampleVoltagesFromVecValuesAllStruct(module, allValuesPointer, vectorCount);
				return 0;
			},
			'iiiii');
	const ngSpiceInitReturnCode = module._ngSpice_Init(
			module.addFunction(() => 0, 'iiii'),
			module.addFunction(() => 0, 'iiii'),
			module.addFunction(() => 0, 'iiiiii'),
			sendDataCallbackFunctionPointer,
			module.addFunction(() => 0, 'iiii'),
			module.addFunction(() => 0, 'iiii'),
			0);
	if (ngSpiceInitReturnCode !== 0) {
		throw new Error('ngSpice_Init returned ' + ngSpiceInitReturnCode);
	}
	return sampleStatsTracker;
}

function summarizeMillisecondTimings(timingsInMilliseconds) {
	const sorted = timingsInMilliseconds.slice().sort((a, b) => a - b);
	const sum = sorted.reduce((acc, v) => acc + v, 0);
	return {
		count: sorted.length,
		mean: sum / sorted.length,
		median: sorted[Math.floor(sorted.length / 2)],
		min: sorted[0],
		max: sorted[sorted.length - 1],
	};
}

async function benchmarkPulseAlterApproach() {
	const module = await createBlankNgspiceModuleInstance();
	const sampleStatsTracker = registerCommonNoopCallbacksAndReturnSendDataCallbackTrackerObject(module);
	const sendNgspiceCommand = module.cwrap('ngSpice_Command', 'number', ['string']);

	for (const oneLine of RC_NETLIST_WITH_PULSE_SOURCE) sendNgspiceCommand('circbyline ' + oneLine);
	sendNgspiceCommand('save none');

	const wallClockMillisecondsPerTran = [];
	let currentSourceValueInVolts = 0;
	for (let buttonToggleIndex = 0; buttonToggleIndex < NUMBER_OF_BUTTON_TOGGLES_TO_RUN_PER_BENCHMARK; ++buttonToggleIndex) {
		const previousValue = currentSourceValueInVolts;
		const newValue = (buttonToggleIndex % 2 === 0) ? 1.8 : 0;
		sendNgspiceCommand('alter @v_input[pulse] = [ '
				+ previousValue + ' ' + newValue + ' 0 5e-12 5e-12 1e-2 2e-2 ]');
		sampleStatsTracker.samplesInLastTran = 0;
		const wallStartMs = performanceNow();
		sendNgspiceCommand('tran ' + TRANSIENT_TIMESTEP_SECONDS + ' ' + TRANSIENT_STOP_TIME_SECONDS);
		sendNgspiceCommand('run');
		wallClockMillisecondsPerTran.push(performanceNow() - wallStartMs);
		currentSourceValueInVolts = newValue;
	}
	return {
		wallTimesMs: wallClockMillisecondsPerTran,
		samplesInLastTran: sampleStatsTracker.samplesInLastTran,
		finalSampleVoltagesByName: sampleStatsTracker.lastSampleVoltagesByName,
	};
}

async function benchmarkExternalCallbackApproach() {
	const module = await createBlankNgspiceModuleInstance();
	const sampleStatsTracker = registerCommonNoopCallbacksAndReturnSendDataCallbackTrackerObject(module);

	const externalSourceStateByLowercaseName = Object.create(null);
	externalSourceStateByLowercaseName['v_input'] = { valueBeforeStep: 0, valueAfterStep: 0 };

	const getvsrcdataCallbackFunctionPointer = module.addFunction(
			function returnExternalVoltageSourceValueAtSimulatedTime(
					resultDoublePointer, simulatedTime, sourceNameCharPointer /* ident, userData omitted */) {
				const sourceName = module.UTF8ToString(sourceNameCharPointer);
				const sourceState = externalSourceStateByLowercaseName[sourceName.toLowerCase()];
				let value = 0;
				if (sourceState) {
					if (simulatedTime <= 0) {
						value = sourceState.valueBeforeStep;
					} else if (simulatedTime >= SOURCE_RAMP_DURATION_SECONDS) {
						value = sourceState.valueAfterStep;
					} else {
						const lerpFraction = simulatedTime / SOURCE_RAMP_DURATION_SECONDS;
						value = sourceState.valueBeforeStep
								+ (sourceState.valueAfterStep - sourceState.valueBeforeStep) * lerpFraction;
					}
				}
				module.HEAPF64[resultDoublePointer >> 3] = value;
				return 0;
			},
			'iidiii');
	const ngSpiceInitSyncReturnCode = module._ngSpice_Init_Sync(
			getvsrcdataCallbackFunctionPointer, 0, 0, 0, 0);
	if (ngSpiceInitSyncReturnCode !== 0) {
		throw new Error('ngSpice_Init_Sync returned ' + ngSpiceInitSyncReturnCode);
	}

	const sendNgspiceCommand = module.cwrap('ngSpice_Command', 'number', ['string']);
	for (const oneLine of RC_NETLIST_WITH_EXTERNAL_SOURCE) sendNgspiceCommand('circbyline ' + oneLine);
	sendNgspiceCommand('save none');

	const wallClockMillisecondsPerTran = [];
	for (let buttonToggleIndex = 0; buttonToggleIndex < NUMBER_OF_BUTTON_TOGGLES_TO_RUN_PER_BENCHMARK; ++buttonToggleIndex) {
		const sourceState = externalSourceStateByLowercaseName['v_input'];
		sourceState.valueBeforeStep = sourceState.valueAfterStep;
		sourceState.valueAfterStep = (buttonToggleIndex % 2 === 0) ? 1.8 : 0;
		sampleStatsTracker.samplesInLastTran = 0;
		const wallStartMs = performanceNow();
		sendNgspiceCommand('tran ' + TRANSIENT_TIMESTEP_SECONDS + ' ' + TRANSIENT_STOP_TIME_SECONDS);
		sendNgspiceCommand('run');
		wallClockMillisecondsPerTran.push(performanceNow() - wallStartMs);
	}
	return {
		wallTimesMs: wallClockMillisecondsPerTran,
		samplesInLastTran: sampleStatsTracker.samplesInLastTran,
		finalSampleVoltagesByName: sampleStatsTracker.lastSampleVoltagesByName,
	};
}

function formatVoltagesByNameForReport(voltagesByName) {
	if (!voltagesByName) return '(none)';
	return Object.keys(voltagesByName).filter(n => n !== 'time')
			.map(n => n + '=' + voltagesByName[n].toExponential(3))
			.join(' ');
}

async function main() {
	process.stdout.write('Toggles per benchmark: ' + NUMBER_OF_BUTTON_TOGGLES_TO_RUN_PER_BENCHMARK + '\n');
	process.stdout.write('Tran params: tstep=' + TRANSIENT_TIMESTEP_SECONDS
			+ 's tstop=' + TRANSIENT_STOP_TIME_SECONDS + 's\n\n');

	process.stdout.write('-- PULSE + alter @v_input[pulse] --\n');
	const pulseStats = await benchmarkPulseAlterApproach();
	const pulseTimings = summarizeMillisecondTimings(pulseStats.wallTimesMs);
	process.stdout.write('  per-tran wall ms: mean=' + pulseTimings.mean.toFixed(2)
			+ ' median=' + pulseTimings.median.toFixed(2)
			+ ' min=' + pulseTimings.min.toFixed(2)
			+ ' max=' + pulseTimings.max.toFixed(2) + '\n');
	process.stdout.write('  total wall ms: '
			+ pulseStats.wallTimesMs.reduce((a, b) => a + b, 0).toFixed(2) + '\n');
	process.stdout.write('  samples in last tran: ' + pulseStats.samplesInLastTran + '\n');
	process.stdout.write('  final voltages: '
			+ formatVoltagesByNameForReport(pulseStats.finalSampleVoltagesByName) + '\n\n');

	process.stdout.write('-- external + GetVSRCData callback --\n');
	const externalStats = await benchmarkExternalCallbackApproach();
	const externalTimings = summarizeMillisecondTimings(externalStats.wallTimesMs);
	process.stdout.write('  per-tran wall ms: mean=' + externalTimings.mean.toFixed(2)
			+ ' median=' + externalTimings.median.toFixed(2)
			+ ' min=' + externalTimings.min.toFixed(2)
			+ ' max=' + externalTimings.max.toFixed(2) + '\n');
	process.stdout.write('  total wall ms: '
			+ externalStats.wallTimesMs.reduce((a, b) => a + b, 0).toFixed(2) + '\n');
	process.stdout.write('  samples in last tran: ' + externalStats.samplesInLastTran + '\n');
	process.stdout.write('  final voltages: '
			+ formatVoltagesByNameForReport(externalStats.finalSampleVoltagesByName) + '\n\n');

	const meanRatio = externalTimings.mean / pulseTimings.mean;
	process.stdout.write('External/PULSE mean tran-time ratio: ' + meanRatio.toFixed(2) + 'x\n');
}

main().catch((unhandledError) => {
	process.stderr.write('FAIL: ' + (unhandledError && unhandledError.stack || unhandledError) + '\n');
	process.exit(1);
});
