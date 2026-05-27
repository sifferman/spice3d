// Verifies the live `alter` command path: load an RC netlist with
// V1 driven at 0 V, run a tiny transient, then alter V1 to 1 V and
// run a longer transient. The output node v(out) must be near 0 in
// the first run and approach VDD by the end of the second.

const path = require('path');

const ngspice_emscripten_build_directory =
		path.resolve(__dirname, '..', '..', 'third_party', 'ngspice', 'build-emscripten');
const ngspice_module_javascript_path =
		path.resolve(ngspice_emscripten_build_directory, 'ngspice.js');

const FAKE_PROC_MEMINFO_TEXT_FOR_NGSPICE = [
	'MemTotal:        1048576 kB',
	'MemFree:         1048576 kB',
	'MemAvailable:    1048576 kB',
	'',
].join('\n');

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

async function bootNgspiceAndExerciseAlterCommand() {
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

	const sendDataCallbackFunctionPointer = module.addFunction((allValsPointer, vectorCount, libraryId, userData) => {
		collectedSamples.push(readSampleFromVecValuesAll(module, allValsPointer));
		return 0;
	}, 'iiiii');
	const sendInitDataCallbackFunctionPointer = module.addFunction((vecInfoAllPointer, libraryId, userData) => {
		orderedNodeNamesFromInit = readOrderedNodeNamesFromVecInfoAll(module, vecInfoAllPointer);
		return 0;
	}, 'iiii');

	const ngSpiceInitReturnCode = module._ngSpice_Init(
			module.addFunction(() => 0, 'iiii'),
			module.addFunction(() => 0, 'iiii'),
			module.addFunction(() => 0, 'iiiiii'),
			sendDataCallbackFunctionPointer,
			sendInitDataCallbackFunctionPointer,
			module.addFunction(() => 0, 'iiii'),
			0);
	if (ngSpiceInitReturnCode !== 0) abortWithFailureMessage('ngSpice_Init returned ' + ngSpiceInitReturnCode);

	const sendNgspiceCommand = module.cwrap('ngSpice_Command', 'number', ['string']);
	const initialNetlistLines = [
		'spice3d alter test',
		'V1 in 0 DC 0',
		'R1 in out 1k',
		'C1 out 0 1n',
		'.tran 50n 1u',
		'.end',
	];
	for (const oneLine of initialNetlistLines) sendNgspiceCommand('circbyline ' + oneLine);

	sendNgspiceCommand('run');
	const samplesAfterInitialDcZeroRun = collectedSamples.slice();
	collectedSamples.length = 0;

	if (orderedNodeNamesFromInit === null) abortWithFailureMessage('SendInitData never fired.');
	const outputVectorIndex = findVectorIndexByName(orderedNodeNamesFromInit, 'out');
	if (outputVectorIndex === -1) abortWithFailureMessage('No "out" vector reported.');

	const finalOutputVoltageWhileInputZero = samplesAfterInitialDcZeroRun[samplesAfterInitialDcZeroRun.length - 1][outputVectorIndex];
	if (Math.abs(finalOutputVoltageWhileInputZero) > 0.01) {
		abortWithFailureMessage('v(out) should be ~0 V while V1=0; observed '
				+ finalOutputVoltageWhileInputZero + '.');
	}

	sendNgspiceCommand('alter v1 dc 1.0');
	sendNgspiceCommand('tran 50n 10u');
	sendNgspiceCommand('run');

	if (collectedSamples.length === 0) abortWithFailureMessage('No samples after alter+run.');
	const finalOutputVoltageAfterAlter = collectedSamples[collectedSamples.length - 1][outputVectorIndex];
	if (finalOutputVoltageAfterAlter < 0.98) {
		abortWithFailureMessage('After altering V1 to 1V and running 10us, v(out) should approach 1 V; observed '
				+ finalOutputVoltageAfterAlter + '.');
	}

	process.stdout.write('PASS — V1=0: v(out)=' + finalOutputVoltageWhileInputZero.toFixed(6)
			+ '   after alter V1=1, 10us: v(out)=' + finalOutputVoltageAfterAlter.toFixed(6) + '\n');
}

bootNgspiceAndExerciseAlterCommand().catch(
		(error) => abortWithFailureMessage((error && (error.stack || error.message)) || 'unknown'));
