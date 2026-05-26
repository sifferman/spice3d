// Web Worker that hosts the ngspice sharedspice WebAssembly module
// (built with --with-ngshared). The host sends:
//   loadNetlist       — initial deck (with deck-level `.tran`)
//   externalVoltage   — update a `external` voltage source mid-sim
//   setTimeWarp       — change simulated-seconds-per-real-second
//   installFileText   — stage one PDK file into the worker's memfs
//   halt              — pause the chunk loop
//
// We stream samples back via SendData → simulationSample postMessage.
//
// Execution model: one in-progress ngspice `tran` is kept alive
// indefinitely via `step <samples_per_chunk>` issued between
// `setTimeout` yields. Voltage changes mutate per-source ramp state
// between chunks; the next solver step picks up the new target.
// Time-warp changes snapshot every node voltage from the last
// emitted sample, rebuild the deck with `.ic v(node)=value` + a new
// `.tran` line, and reload via ngSpice_Circ — preserving circuit
// trajectory across the TSTEP change (validated by
// scripts/test-ngspice-wasm-snapshot-restart-correctness.js).

importScripts('ngspice.js');

const FAKE_PROC_MEMINFO_TEXT_FOR_NGSPICE_BUFFER_SIZING = [
	'MemTotal:        1048576 kB',
	'MemFree:         1048576 kB',
	'MemAvailable:    1048576 kB',
	'',
].join('\n');

const TARGET_NUMBER_OF_SAMPLES_PLAYED_BACK_PER_WALL_SECOND = 30;
const NUMBER_OF_SAMPLES_PER_CHUNK_BETWEEN_SET_TIMEOUT_YIELDS = 6;
const WALL_CLOCK_MILLISECONDS_BETWEEN_CONSECUTIVE_CHUNKS =
		(NUMBER_OF_SAMPLES_PER_CHUNK_BETWEEN_SET_TIMEOUT_YIELDS * 1000.0)
		/ TARGET_NUMBER_OF_SAMPLES_PLAYED_BACK_PER_WALL_SECOND;
const EXTERNAL_VOLTAGE_SOURCE_RAMP_DURATION_SECONDS = 5e-12;
const SIMULATION_TSTOP_FAR_BEYOND_ANY_SESSION_SECONDS = 1.0e-3;
const INITIAL_CONDITION_SEED_HIGH_VOLTS = 1.8;
const INITIAL_CONDITION_SEED_LOW_VOLTS = 0.0;

let ngspiceWebAssemblyModule = null;
let ngspiceSendCommand = null;
let orderedNodeNamesFromLatestInit = null;
let baseDeckLinesWithoutInitialConditions = [];
let internalNetNamesEligibleForInitialConditionSeed = [];
let currentTransientTimestepInSeconds = 1.0e-12;
let lastObservedSampleSimulationTimeSeconds = 0.0;
let lastObservedNodeVoltagesByName = Object.create(null);
let chunkLoopShouldKeepRunning = false;
const externalVoltageSourceStateByLowercaseName = Object.create(null);

function postWorkerErrorMessage(errorText) {
	self.postMessage({ messageKind: 'error', errorText: errorText });
}

function postWorkerReadyMessage() {
	self.postMessage({ messageKind: 'workerReady', isPlaceholder: false });
}

function postRunningStateChangedMessage(isSimulationRunning) {
	self.postMessage({ messageKind: 'runningStateChanged', isSimulationRunning: Boolean(isSimulationRunning) });
}

function postNodeNamesMessage(orderedNodeNames) {
	self.postMessage({ messageKind: 'nodeNames', nodeNames: orderedNodeNames });
}

function postSimulationSampleMessage(simulationTimeSeconds, orderedNodeVoltages) {
	self.postMessage({
		messageKind: 'simulationSample',
		sample: {
			simulationTimeSeconds: simulationTimeSeconds,
			nodeVoltages: orderedNodeVoltages,
		},
	});
}

function postNgspiceDiagnosticMessage(diagnosticOriginChannel, diagnosticTextFromNgspice) {
	self.postMessage({
		messageKind: 'ngspiceDiagnostic',
		diagnosticOriginChannel: diagnosticOriginChannel,
		diagnosticText: diagnosticTextFromNgspice,
	});
}

function readVecValuesAllStructIntoSample(allVectorValuesPointer) {
	const vectorCount = ngspiceWebAssemblyModule.HEAP32[allVectorValuesPointer >> 2];
	const vectorEntryArrayPointer = ngspiceWebAssemblyModule.HEAPU32[(allVectorValuesPointer + 8) >> 2];
	let simulationTimeSeconds = 0.0;
	const orderedNodeVoltages = new Array(vectorCount);
	const nodeVoltagesByName = Object.create(null);
	for (let vectorIndex = 0; vectorIndex < vectorCount; ++vectorIndex) {
		const vectorEntryPointer = ngspiceWebAssemblyModule.HEAPU32[(vectorEntryArrayPointer >> 2) + vectorIndex];
		const namePointer = ngspiceWebAssemblyModule.HEAPU32[vectorEntryPointer >> 2];
		const realPartOfValue = ngspiceWebAssemblyModule.HEAPF64[(vectorEntryPointer + 8) >> 3];
		const vectorName = ngspiceWebAssemblyModule.UTF8ToString(namePointer);
		if (vectorName === 'time') simulationTimeSeconds = realPartOfValue;
		orderedNodeVoltages[vectorIndex] = realPartOfValue;
		nodeVoltagesByName[vectorName] = realPartOfValue;
	}
	return { simulationTimeSeconds, orderedNodeVoltages, nodeVoltagesByName };
}

function readVecInfoAllStructIntoOrderedNodeNames(initialVectorInfoPointer) {
	const vectorCountFieldOffsetInBytes = 16;
	const vectorEntryArrayFieldOffsetInBytes = 20;
	const vectorCount = ngspiceWebAssemblyModule.HEAP32[(initialVectorInfoPointer + vectorCountFieldOffsetInBytes) >> 2];
	const vectorEntryArrayPointer = ngspiceWebAssemblyModule.HEAPU32[(initialVectorInfoPointer + vectorEntryArrayFieldOffsetInBytes) >> 2];
	const orderedNodeNames = [];
	for (let vectorIndex = 0; vectorIndex < vectorCount; ++vectorIndex) {
		const vectorEntryPointer = ngspiceWebAssemblyModule.HEAPU32[(vectorEntryArrayPointer >> 2) + vectorIndex];
		const vecnamePointer = ngspiceWebAssemblyModule.HEAPU32[(vectorEntryPointer + 4) >> 2];
		orderedNodeNames.push(ngspiceWebAssemblyModule.UTF8ToString(vecnamePointer));
	}
	return orderedNodeNames;
}

function registerSharedspiceCallbacksWithNgspice() {
	const sendCharCallbackFunctionPointer = ngspiceWebAssemblyModule.addFunction(
			function forwardSendCharOutputToBridge(textPointer, libraryInstanceId, userDataPointer) {
				const oneLineFromNgspice = ngspiceWebAssemblyModule.UTF8ToString(textPointer);
				postNgspiceDiagnosticMessage('SendChar', oneLineFromNgspice);
				return 0;
			},
			'iiii');
	const sendStatCallbackFunctionPointer = ngspiceWebAssemblyModule.addFunction(
			function forwardSendStatOutputToBridge(textPointer, libraryInstanceId, userDataPointer) {
				const oneStatusLineFromNgspice = ngspiceWebAssemblyModule.UTF8ToString(textPointer);
				postNgspiceDiagnosticMessage('SendStat', oneStatusLineFromNgspice);
				return 0;
			},
			'iiii');
	const controlledExitCallbackFunctionPointer = ngspiceWebAssemblyModule.addFunction(
			function reportControlledExit(exitStatus, unloadImmediately, requestQuit, libraryInstanceId, userDataPointer) {
				postWorkerErrorMessage('ngspice controlled_exit status=' + exitStatus);
				return 0;
			},
			'iiiiii');
	const sendDataCallbackFunctionPointer = ngspiceWebAssemblyModule.addFunction(
			function publishSimulationSample(allVectorValuesPointer, vectorCount, libraryInstanceId, userDataPointer) {
				const sample = readVecValuesAllStructIntoSample(allVectorValuesPointer);
				lastObservedSampleSimulationTimeSeconds = sample.simulationTimeSeconds;
				lastObservedNodeVoltagesByName = sample.nodeVoltagesByName;
				totalSampleCountObservedSinceLastDeckLoad += 1;
				postSimulationSampleMessage(sample.simulationTimeSeconds, sample.orderedNodeVoltages);
				return 0;
			},
			'iiiii');
	const sendInitDataCallbackFunctionPointer = ngspiceWebAssemblyModule.addFunction(
			function publishOrderedNodeNames(initialVectorInfoPointer, libraryInstanceId, userDataPointer) {
				orderedNodeNamesFromLatestInit = readVecInfoAllStructIntoOrderedNodeNames(initialVectorInfoPointer);
				postNodeNamesMessage(orderedNodeNamesFromLatestInit);
				return 0;
			},
			'iiii');
	const backgroundThreadRunningCallbackFunctionPointer = ngspiceWebAssemblyModule.addFunction(
			function publishBackgroundThreadRunningState(isNowRunning, libraryInstanceId, userDataPointer) {
				postRunningStateChangedMessage(Boolean(isNowRunning));
				return 0;
			},
			'iiii');
	const initReturnCode = ngspiceWebAssemblyModule._ngSpice_Init(
			sendCharCallbackFunctionPointer,
			sendStatCallbackFunctionPointer,
			controlledExitCallbackFunctionPointer,
			sendDataCallbackFunctionPointer,
			sendInitDataCallbackFunctionPointer,
			backgroundThreadRunningCallbackFunctionPointer,
			0);
	if (initReturnCode !== 0) {
		throw new Error('ngSpice_Init returned ' + initReturnCode);
	}
}

function registerGetVsrcDataCallbackWithNgspiceForExternalVoltageSources() {
	const getVsrcDataCallbackFunctionPointer = ngspiceWebAssemblyModule.addFunction(
			function returnExternalVoltageSourceValueAtSimulatedTime(
					resultDoublePointer, simulatedTime, sourceNameCharPointer,
					libraryInstanceId, userDataPointer) {
				const sourceName = ngspiceWebAssemblyModule.UTF8ToString(sourceNameCharPointer);
				const sourceState = externalVoltageSourceStateByLowercaseName[sourceName.toLowerCase()];
				let valueToReturn = 0;
				if (sourceState !== undefined) {
					const elapsedSinceMostRecentRampStart = simulatedTime - sourceState.rampStartSimulatedTime;
					if (elapsedSinceMostRecentRampStart <= 0) {
						valueToReturn = sourceState.valueBeforeMostRecentRamp;
					} else if (elapsedSinceMostRecentRampStart >= EXTERNAL_VOLTAGE_SOURCE_RAMP_DURATION_SECONDS) {
						valueToReturn = sourceState.valueAfterMostRecentRamp;
					} else {
						const lerpFraction = elapsedSinceMostRecentRampStart / EXTERNAL_VOLTAGE_SOURCE_RAMP_DURATION_SECONDS;
						valueToReturn = sourceState.valueBeforeMostRecentRamp
								+ (sourceState.valueAfterMostRecentRamp - sourceState.valueBeforeMostRecentRamp) * lerpFraction;
					}
				}
				ngspiceWebAssemblyModule.HEAPF64[resultDoublePointer >> 3] = valueToReturn;
				return 0;
			},
			'iidiii');
	const ngSpiceInitSyncReturnCode = ngspiceWebAssemblyModule._ngSpice_Init_Sync(
			getVsrcDataCallbackFunctionPointer, 0, 0, 0, 0);
	if (ngSpiceInitSyncReturnCode !== 0) {
		throw new Error('ngSpice_Init_Sync returned ' + ngSpiceInitSyncReturnCode);
	}
}

function provideFakeProcMeminfoSoNgspiceDoesNotAbort() {
	ngspiceWebAssemblyModule.FS.mkdirTree('/proc');
	ngspiceWebAssemblyModule.FS.writeFile('/proc/meminfo', FAKE_PROC_MEMINFO_TEXT_FOR_NGSPICE_BUFFER_SIZING);
}

function feedDeckLinesIntoNgspiceViaCircByline(deckLines) {
	postNgspiceDiagnosticMessage('WorkerDiag',
			'feeding ' + deckLines.length + ' deck lines via circbyline');
	for (const oneLine of deckLines) {
		const returnCode = ngspiceSendCommand('circbyline ' + String(oneLine));
		if (returnCode !== 0) {
			postNgspiceDiagnosticMessage('WorkerDiag',
					'circbyline returned nonzero (' + returnCode + ') for line: ' + String(oneLine));
		}
	}
	postNgspiceDiagnosticMessage('WorkerDiag', 'finished feeding deck');
}

function buildSeedInitialConditionLinesForInternalNets() {
	// Alternate seed voltages around the ring so an odd-stage ring oscillator
	// breaks symmetry on the very first solver step instead of sitting at the
	// metastable vdd/2 equilibrium. Combinational circuits with external
	// sources will have those external sources override the seed anyway.
	const seedInitialConditionLines = [];
	for (let oneNetIndex = 0; oneNetIndex < internalNetNamesEligibleForInitialConditionSeed.length; ++oneNetIndex) {
		const oneInternalNetName = internalNetNamesEligibleForInitialConditionSeed[oneNetIndex];
		const seedVoltageForThisNet = (oneNetIndex % 2 === 0)
				? INITIAL_CONDITION_SEED_HIGH_VOLTS
				: INITIAL_CONDITION_SEED_LOW_VOLTS;
		seedInitialConditionLines.push(
				'.ic v(' + oneInternalNetName + ')=' + seedVoltageForThisNet);
	}
	return seedInitialConditionLines;
}

function buildSnapshotInitialConditionLinesFromLastObservedSample() {
	const snapshotInitialConditionLines = [];
	for (const oneNodeName of Object.keys(lastObservedNodeVoltagesByName)) {
		if (oneNodeName === 'time' || oneNodeName === '0') continue;
		if (oneNodeName.indexOf('#') !== -1) continue;
		const oneVoltageVolts = lastObservedNodeVoltagesByName[oneNodeName];
		snapshotInitialConditionLines.push(
				'.ic v(' + oneNodeName + ')=' + oneVoltageVolts);
	}
	return snapshotInitialConditionLines;
}

function buildDeckLinesWithInitialConditionsAndTransientAnalysis(initialConditionLines, useInitialConditionsFlag) {
	const tranTrailingUicSuffix = useInitialConditionsFlag ? ' uic' : '';
	const tranLine = '.tran ' + currentTransientTimestepInSeconds
			+ ' ' + SIMULATION_TSTOP_FAR_BEYOND_ANY_SESSION_SECONDS
			+ ' 0 ' + currentTransientTimestepInSeconds
			+ tranTrailingUicSuffix;
	const fullyAssembledDeckLines = [];
	for (const oneBaseDeckLine of baseDeckLinesWithoutInitialConditions) {
		if (String(oneBaseDeckLine).trim().toLowerCase() === '.end') continue;
		fullyAssembledDeckLines.push(oneBaseDeckLine);
	}
	for (const oneInitialConditionLine of initialConditionLines) {
		fullyAssembledDeckLines.push(oneInitialConditionLine);
	}
	fullyAssembledDeckLines.push(tranLine);
	fullyAssembledDeckLines.push('.end');
	return fullyAssembledDeckLines;
}

function loadAssembledDeckIntoNgspiceAndPrimeForChunking(initialConditionLines, useInitialConditionsFlag) {
	const fullyAssembledDeckLines = buildDeckLinesWithInitialConditionsAndTransientAnalysis(
			initialConditionLines, useInitialConditionsFlag);
	postNgspiceDiagnosticMessage('WorkerDiag', '--- assembled deck (' + fullyAssembledDeckLines.length + ' lines) ---');
	for (const oneDeckLine of fullyAssembledDeckLines) {
		postNgspiceDiagnosticMessage('WorkerDiag', '  | ' + String(oneDeckLine));
	}
	postNgspiceDiagnosticMessage('WorkerDiag', '--- end assembled deck ---');
	feedDeckLinesIntoNgspiceViaCircByline(fullyAssembledDeckLines);
	ngspiceSendCommand('save none');
}

let totalChunkCountSinceLastDeckLoad = 0;
let totalSampleCountObservedSinceLastDeckLoad = 0;

function runOneStepNChunkAndYield() {
	if (!chunkLoopShouldKeepRunning) {
		postRunningStateChangedMessage(false);
		return;
	}
	const sampleCountBeforeThisChunk = totalSampleCountObservedSinceLastDeckLoad;
	const wallClockMillisecondsBeforeStep = (typeof performance !== 'undefined' && performance.now)
			? performance.now() : Date.now();
	if (totalChunkCountSinceLastDeckLoad === 0) {
		postNgspiceDiagnosticMessage('WorkerDiag', 'first chunk: about to call step '
				+ NUMBER_OF_SAMPLES_PER_CHUNK_BETWEEN_SET_TIMEOUT_YIELDS);
	}
	ngspiceSendCommand('step ' + NUMBER_OF_SAMPLES_PER_CHUNK_BETWEEN_SET_TIMEOUT_YIELDS);
	const wallClockMillisecondsAfterStep = (typeof performance !== 'undefined' && performance.now)
			? performance.now() : Date.now();
	const samplesEmittedThisChunk = totalSampleCountObservedSinceLastDeckLoad - sampleCountBeforeThisChunk;
	const wallClockMillisecondsThisChunk = wallClockMillisecondsAfterStep - wallClockMillisecondsBeforeStep;
	totalChunkCountSinceLastDeckLoad += 1;
	if (totalChunkCountSinceLastDeckLoad <= 3 || samplesEmittedThisChunk === 0) {
		postNgspiceDiagnosticMessage('WorkerDiag',
				'chunk ' + totalChunkCountSinceLastDeckLoad + ': emitted '
				+ samplesEmittedThisChunk + ' sample(s) in '
				+ wallClockMillisecondsThisChunk.toFixed(1) + ' ms (total samples: '
				+ totalSampleCountObservedSinceLastDeckLoad + ')');
	}
	setTimeout(runOneStepNChunkAndYield, WALL_CLOCK_MILLISECONDS_BETWEEN_CONSECUTIVE_CHUNKS);
}

function startContinuousChunkLoop() {
	if (chunkLoopShouldKeepRunning) return;
	totalChunkCountSinceLastDeckLoad = 0;
	totalSampleCountObservedSinceLastDeckLoad = 0;
	chunkLoopShouldKeepRunning = true;
	postRunningStateChangedMessage(true);
	postNgspiceDiagnosticMessage('WorkerDiag', 'starting continuous chunk loop');
	setTimeout(runOneStepNChunkAndYield, 0);
}

function handleLoadNetlistMessage(incomingMessage) {
	chunkLoopShouldKeepRunning = false;
	lastObservedSampleSimulationTimeSeconds = 0.0;
	lastObservedNodeVoltagesByName = Object.create(null);
	for (const oneSourceName of Object.keys(externalVoltageSourceStateByLowercaseName)) {
		delete externalVoltageSourceStateByLowercaseName[oneSourceName];
	}
	baseDeckLinesWithoutInitialConditions = (incomingMessage.netlistLines || []).slice();
	internalNetNamesEligibleForInitialConditionSeed = (incomingMessage.internalNetNamesToSeedAtHalfVdd || []).slice();
	currentTransientTimestepInSeconds = Number(incomingMessage.timestepSeconds) || 1.0e-12;
	const seedInitialConditionLines = buildSeedInitialConditionLinesForInternalNets();
	const useInitialConditionsFlag = seedInitialConditionLines.length > 0;
	loadAssembledDeckIntoNgspiceAndPrimeForChunking(seedInitialConditionLines, useInitialConditionsFlag);
	startContinuousChunkLoop();
}

function handleSetTimeWarpMessage(incomingMessage) {
	const requestedTimestepSeconds = Number(incomingMessage.timestepSeconds);
	if (!isFinite(requestedTimestepSeconds) || requestedTimestepSeconds <= 0) return;
	chunkLoopShouldKeepRunning = false;
	currentTransientTimestepInSeconds = requestedTimestepSeconds;
	const snapshotInitialConditionLines = buildSnapshotInitialConditionLinesFromLastObservedSample();
	const useInitialConditionsFlag = snapshotInitialConditionLines.length > 0;
	loadAssembledDeckIntoNgspiceAndPrimeForChunking(snapshotInitialConditionLines, useInitialConditionsFlag);
	for (const oneSourceName of Object.keys(externalVoltageSourceStateByLowercaseName)) {
		const oneSourceState = externalVoltageSourceStateByLowercaseName[oneSourceName];
		oneSourceState.rampStartSimulatedTime = 0.0;
		oneSourceState.valueBeforeMostRecentRamp = oneSourceState.valueAfterMostRecentRamp;
	}
	lastObservedSampleSimulationTimeSeconds = 0.0;
	startContinuousChunkLoop();
}

function handleExternalVoltageMessage(incomingMessage) {
	const externalSourceNameLowercase = String(incomingMessage.sourceName).toLowerCase();
	const newTargetValueOfExternalSourceInVolts = Number(incomingMessage.volts);
	let sourceState = externalVoltageSourceStateByLowercaseName[externalSourceNameLowercase];
	if (sourceState === undefined) {
		sourceState = {
			valueBeforeMostRecentRamp: 0,
			valueAfterMostRecentRamp: 0,
			rampStartSimulatedTime: 0,
		};
		externalVoltageSourceStateByLowercaseName[externalSourceNameLowercase] = sourceState;
	}
	sourceState.valueBeforeMostRecentRamp = sourceState.valueAfterMostRecentRamp;
	sourceState.valueAfterMostRecentRamp = newTargetValueOfExternalSourceInVolts;
	sourceState.rampStartSimulatedTime = lastObservedSampleSimulationTimeSeconds;
}

function handleInstallFileTextMessage(incomingMessage) {
	const virtualPath = String(incomingMessage.virtualPath || '');
	const fileContent = String(incomingMessage.fileContent || '');
	if (virtualPath.length === 0) return;
	const lastSlashIndex = virtualPath.lastIndexOf('/');
	if (lastSlashIndex > 0) {
		const parentDirectoryPath = virtualPath.substring(0, lastSlashIndex);
		try {
			ngspiceWebAssemblyModule.FS.mkdirTree(parentDirectoryPath);
		} catch (mkdirTreeError) {
			postWorkerErrorMessage('mkdirTree(' + parentDirectoryPath + ') failed: ' + mkdirTreeError.message);
			return;
		}
	}
	try {
		ngspiceWebAssemblyModule.FS.writeFile(virtualPath, fileContent);
	} catch (writeFileError) {
		postWorkerErrorMessage('writeFile(' + virtualPath + ') failed: ' + writeFileError.message);
	}
}

function handleHaltMessage() {
	chunkLoopShouldKeepRunning = false;
	postRunningStateChangedMessage(false);
}

self.addEventListener('message', function handleHostMessage(messageEvent) {
	const incomingMessage = messageEvent.data || {};
	if (!ngspiceWebAssemblyModule) {
		postWorkerErrorMessage('ngspice module not yet ready');
		return;
	}
	switch (incomingMessage.messageKind) {
		case 'loadNetlist':     handleLoadNetlistMessage(incomingMessage); break;
		case 'setTimeWarp':     handleSetTimeWarpMessage(incomingMessage); break;
		case 'externalVoltage': handleExternalVoltageMessage(incomingMessage); break;
		case 'installFileText': handleInstallFileTextMessage(incomingMessage); break;
		case 'halt':            handleHaltMessage(); break;
		default:
			postWorkerErrorMessage('unknown messageKind: ' + incomingMessage.messageKind);
	}
});

createNgspiceModule({
	locateFile: function locateNgspiceWasm(relativeFileName) { return relativeFileName; },
	print: function discardModuleStdout(textLine) {},
	printErr: function discardModuleStderr(textLine) {},
}).then(function onNgspiceModuleReady(moduleInstance) {
	ngspiceWebAssemblyModule = moduleInstance;
	ngspiceSendCommand = ngspiceWebAssemblyModule.cwrap('ngSpice_Command', 'number', ['string']);
	try {
		provideFakeProcMeminfoSoNgspiceDoesNotAbort();
		registerSharedspiceCallbacksWithNgspice();
		registerGetVsrcDataCallbackWithNgspiceForExternalVoltageSources();
	} catch (ngspiceInitError) {
		postWorkerErrorMessage('ngspice init failed: ' + ngspiceInitError.message);
		return;
	}
	postWorkerReadyMessage();
}).catch(function onNgspiceModuleLoadFailed(moduleLoadError) {
	postWorkerErrorMessage('ngspice module failed to load: ' + (moduleLoadError && moduleLoadError.message));
});
