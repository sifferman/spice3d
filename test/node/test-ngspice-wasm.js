// Headless functional test for the ngspice sharedspice WebAssembly
// module produced by scripts/build-ngspice-for-emscripten.sh. Loads
// the module under Node, runs an RC transient through ngSpice_Init's
// SendData callback, and asserts the resulting waveform looks right.
// Exits 0 on success, non-zero with a diagnostic on failure.

const path = require('path');

const ngspice_emscripten_build_directory =
		path.resolve(__dirname, '..', 'third_party', 'ngspice', 'build-emscripten');
const ngspice_module_javascript_path =
		path.resolve(ngspice_emscripten_build_directory, 'ngspice.js');

const FAKE_PROC_MEMINFO_TEXT_FOR_NGSPICE = [
	'MemTotal:        1048576 kB',
	'MemFree:         1048576 kB',
	'MemAvailable:    1048576 kB',
	'',
].join('\n');

const SMOKE_TEST_RC_TRANSIENT_NETLIST_LINES = [
	'spice3d ngspice wasm smoke',
	'V1 in 0 PULSE(0 1 0 0 0 1u 2u)',
	'R1 in out 1k',
	'C1 out 0 1n',
	'.tran 100n 1u',
	'.end',
];

const MINIMUM_EXPECTED_TRANSIENT_SAMPLE_COUNT = 20;
const MINIMUM_EXPECTED_INPUT_PULSE_PEAK_VOLTAGE = 0.99;
const MINIMUM_EXPECTED_OUTPUT_AT_END_OF_RUN_VOLTAGE = 0.3;

function abortWithFailureMessage(failureMessage) {
	process.stderr.write('FAIL: ' + failureMessage + '\n');
	process.exit(1);
}

function findVectorIndexByName(orderedNodeNames, targetName) {
	for (let i = 0; i < orderedNodeNames.length; ++i) {
		if (orderedNodeNames[i] === targetName) return i;
	}
	return -1;
}

function readSampleFromVecValuesAll(module, allVectorValuesPointer) {
	const vectorCount = module.HEAP32[allVectorValuesPointer >> 2];
	const vectorEntryArrayPointer = module.HEAPU32[(allVectorValuesPointer + 8) >> 2];
	const orderedValues = new Array(vectorCount);
	for (let vectorIndex = 0; vectorIndex < vectorCount; ++vectorIndex) {
		const vectorEntryPointer = module.HEAPU32[(vectorEntryArrayPointer >> 2) + vectorIndex];
		const realPart = module.HEAPF64[(vectorEntryPointer + 8) >> 3];
		orderedValues[vectorIndex] = realPart;
	}
	return orderedValues;
}

function readOrderedNodeNamesFromVecInfoAll(module, initialVectorInfoPointer) {
	const vectorCount = module.HEAP32[(initialVectorInfoPointer + 16) >> 2];
	const vectorEntryArrayPointer = module.HEAPU32[(initialVectorInfoPointer + 20) >> 2];
	const orderedNames = [];
	for (let vectorIndex = 0; vectorIndex < vectorCount; ++vectorIndex) {
		const vectorEntryPointer = module.HEAPU32[(vectorEntryArrayPointer >> 2) + vectorIndex];
		const vecnamePointer = module.HEAPU32[(vectorEntryPointer + 4) >> 2];
		orderedNames.push(module.UTF8ToString(vecnamePointer));
	}
	return orderedNames;
}

async function runRcTransientSimulationAndCollectSamples() {
	const createNgspiceModule = require(ngspice_module_javascript_path);
	const module = await createNgspiceModule({
		locateFile: (relativeFileName) => path.resolve(ngspice_emscripten_build_directory, relativeFileName),
		print: () => {},
		printErr: () => {},
	});

	module.FS.mkdirTree('/proc');
	module.FS.writeFile('/proc/meminfo', FAKE_PROC_MEMINFO_TEXT_FOR_NGSPICE);

	const collectedSamples = [];
	let orderedNodeNamesFromInit = null;

	const sendCharCallbackFunctionPointer = module.addFunction((p, l, u) => 0, 'iiii');
	const sendStatCallbackFunctionPointer = module.addFunction((p, l, u) => 0, 'iiii');
	const controlledExitCallbackFunctionPointer = module.addFunction((s, u1, q, l, u2) => 0, 'iiiiii');
	const sendDataCallbackFunctionPointer = module.addFunction((allValsPointer, vectorCount, libraryId, userData) => {
		collectedSamples.push(readSampleFromVecValuesAll(module, allValsPointer));
		return 0;
	}, 'iiiii');
	const sendInitDataCallbackFunctionPointer = module.addFunction((vecInfoAllPointer, libraryId, userData) => {
		orderedNodeNamesFromInit = readOrderedNodeNamesFromVecInfoAll(module, vecInfoAllPointer);
		return 0;
	}, 'iiii');
	const backgroundThreadRunningCallbackFunctionPointer = module.addFunction((isRunning, libraryId, userData) => 0, 'iiii');

	const ngSpiceInitReturnCode = module._ngSpice_Init(
			sendCharCallbackFunctionPointer,
			sendStatCallbackFunctionPointer,
			controlledExitCallbackFunctionPointer,
			sendDataCallbackFunctionPointer,
			sendInitDataCallbackFunctionPointer,
			backgroundThreadRunningCallbackFunctionPointer,
			0);
	if (ngSpiceInitReturnCode !== 0) {
		abortWithFailureMessage('ngSpice_Init returned ' + ngSpiceInitReturnCode);
	}

	const sendNgspiceCommand = module.cwrap('ngSpice_Command', 'number', ['string']);
	for (const oneNetlistLine of SMOKE_TEST_RC_TRANSIENT_NETLIST_LINES) {
		sendNgspiceCommand('circbyline ' + oneNetlistLine);
	}
	sendNgspiceCommand('run');

	return { collectedSamples, orderedNodeNamesFromInit };
}

function assertCondition(conditionIsTrue, failureMessage) {
	if (!conditionIsTrue) abortWithFailureMessage(failureMessage);
}

(async function main() {
	const { collectedSamples, orderedNodeNamesFromInit } = await runRcTransientSimulationAndCollectSamples();

	assertCondition(
			orderedNodeNamesFromInit !== null,
			'SendInitData callback never fired; expected the vector name list.');
	assertCondition(
			collectedSamples.length >= MINIMUM_EXPECTED_TRANSIENT_SAMPLE_COUNT,
			'Expected at least ' + MINIMUM_EXPECTED_TRANSIENT_SAMPLE_COUNT
					+ ' transient samples, got ' + collectedSamples.length + '.');

	const inputVectorIndex = findVectorIndexByName(orderedNodeNamesFromInit, 'in');
	const outputVectorIndex = findVectorIndexByName(orderedNodeNamesFromInit, 'out');
	assertCondition(
			inputVectorIndex !== -1 && outputVectorIndex !== -1,
			'Expected vectors named "in" and "out" in the init list; got: '
					+ orderedNodeNamesFromInit.join(', '));

	let peakInputVoltageDuringRun = 0.0;
	for (const oneSample of collectedSamples) {
		const inputVoltage = oneSample[inputVectorIndex];
		if (inputVoltage > peakInputVoltageDuringRun) peakInputVoltageDuringRun = inputVoltage;
	}
	assertCondition(
			peakInputVoltageDuringRun >= MINIMUM_EXPECTED_INPUT_PULSE_PEAK_VOLTAGE,
			'Input pulse never reached its peak; max v(in) observed = '
					+ peakInputVoltageDuringRun + '.');

	const finalSample = collectedSamples[collectedSamples.length - 1];
	const finalOutputVoltage = finalSample[outputVectorIndex];
	assertCondition(
			finalOutputVoltage >= MINIMUM_EXPECTED_OUTPUT_AT_END_OF_RUN_VOLTAGE,
			'Output node failed to charge through the RC; final v(out) = '
					+ finalOutputVoltage + '.');

	process.stdout.write('PASS — ' + collectedSamples.length
			+ ' samples, peak v(in)=' + peakInputVoltageDuringRun.toFixed(4)
			+ ', final v(out)=' + finalOutputVoltage.toFixed(4) + '\n');
})().catch((error) => abortWithFailureMessage(error && (error.stack || error.message) || 'unknown'));
