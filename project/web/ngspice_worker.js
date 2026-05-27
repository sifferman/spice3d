importScripts('ngspice.js');

const FAKE_PROC_MEMINFO_TEXT_FOR_NGSPICE_BUFFER_SIZING = [
	'MemTotal:        1048576 kB',
	'MemFree:         1048576 kB',
	'MemAvailable:    1048576 kB',
	'',
].join('\n');

const TARGET_SAMPLES_PLAYED_BACK_PER_WALL_SECOND = 30;
const SAMPLES_PER_CHUNK_BETWEEN_SET_TIMEOUT_YIELDS = 6;
const MILLISECONDS_BETWEEN_CONSECUTIVE_CHUNKS_WHEN_NGSPICE_IS_FASTER_THAN_TARGET =
		(SAMPLES_PER_CHUNK_BETWEEN_SET_TIMEOUT_YIELDS * 1000.0)
		/ TARGET_SAMPLES_PLAYED_BACK_PER_WALL_SECOND;
const EXTERNAL_VOLTAGE_SOURCE_RAMP_DURATION_SECONDS = 5e-12;
const SIMULATION_TSTOP_FAR_BEYOND_ANY_SESSION_SECONDS = 1.0e-3;
const INITIAL_CONDITION_SEED_HIGH_VOLTS = 1.8;
const INITIAL_CONDITION_SEED_LOW_VOLTS = 0.0;
const SYNCHRONOUS_FULL_PRECISION_BOOTSTRAP_STEP_COUNT = 50;
const NGSPICE_OPTION_COMMANDS_FOR_LOOSE_RUN_PHASE = [
	'option reltol=1e-2',
	'option abstol=1e-8',
	'option vntol=1e-3',
	'option chgtol=1e-12',
	'option trtol=50',
	'option bypass=1',
	'option gmin=1e-9',
	'option itl4=200',
	'option maxord=2',
];
const NGSPICE_SENDCHAR_LINE_PREFIXES_THAT_ARE_EXPECTED_STEP_N_HALT_NOISE = [
	'stderr simulation interrupted',
	'stderr doAnalyses: pause requested',
	'stdout Doing analysis at TEMP',
	'stdout Note: Stopped after',
	'stderr Warning: can\'t find the initialization file spinit',
];
const MAXIMUM_CONSECUTIVE_ZERO_SAMPLE_CHUNKS_BEFORE_BAILING_OUT = 5;
const THROUGHPUT_WARNING_WINDOW_MILLISECONDS = 5000;
const THROUGHPUT_WARNING_RATIO_BELOW_TARGET = 0.7;
const VECTORS_ALL_COUNT_FIELD_BYTE_OFFSET = 0;
const VECTORS_ALL_ENTRIES_FIELD_BYTE_OFFSET = 8;
const VECTOR_INFO_ALL_COUNT_FIELD_BYTE_OFFSET = 16;
const VECTOR_INFO_ALL_ENTRIES_FIELD_BYTE_OFFSET = 20;
const VECTOR_VALUES_NAME_FIELD_BYTE_OFFSET = 0;
const VECTOR_VALUES_REAL_FIELD_BYTE_OFFSET = 8;
const VECTOR_INFO_NAME_FIELD_BYTE_OFFSET = 4;

let ngspiceWebAssemblyModule = null;
let ngspiceSendCommand = null;
let orderedNodeNamesFromLatestInit = null;
let baseDeckLinesWithoutInitialConditions = [];
let internalNetNamesEligibleForInitialConditionSeed = [];
let currentTransientTimestepInSeconds = 1.0e-12;
let lastObservedSampleSimulationTimeSeconds = 0.0;
let lastObservedNodeVoltagesByName = Object.create(null);
let chunkLoopShouldKeepRunning = false;
let currentChunkLoopGenerationCounter = 0;
let totalChunkCountSinceLastDeckLoad = 0;
let totalSampleCountObservedSinceLastDeckLoad = 0;
let consecutiveZeroSampleChunkCount = 0;
let throughputWindowSampleCount = 0;
let throughputWindowStartWallClockMilliseconds = 0;
const externalVoltageSourceStateByLowercaseName = Object.create(null);

function readCurrentWallClockMilliseconds() {
	return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

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
		sample: { simulationTimeSeconds: simulationTimeSeconds, nodeVoltages: orderedNodeVoltages },
	});
}

function postNgspiceDiagnosticMessage(diagnosticOriginChannel, diagnosticTextFromNgspice) {
	self.postMessage({
		messageKind: 'ngspiceDiagnostic',
		diagnosticOriginChannel: diagnosticOriginChannel,
		diagnosticText: diagnosticTextFromNgspice,
	});
}

function readVectorValuesAllStructIntoSample(vectorValuesAllStructPointer) {
	const vectorCount = ngspiceWebAssemblyModule.HEAP32[
			(vectorValuesAllStructPointer + VECTORS_ALL_COUNT_FIELD_BYTE_OFFSET) >> 2];
	const vectorEntryArrayPointer = ngspiceWebAssemblyModule.HEAPU32[
			(vectorValuesAllStructPointer + VECTORS_ALL_ENTRIES_FIELD_BYTE_OFFSET) >> 2];
	let simulationTimeSeconds = 0.0;
	const orderedNodeVoltages = new Array(vectorCount);
	const nodeVoltagesByName = Object.create(null);
	for (let vectorIndex = 0; vectorIndex < vectorCount; ++vectorIndex) {
		const vectorEntryPointer = ngspiceWebAssemblyModule.HEAPU32[(vectorEntryArrayPointer >> 2) + vectorIndex];
		const namePointer = ngspiceWebAssemblyModule.HEAPU32[
				(vectorEntryPointer + VECTOR_VALUES_NAME_FIELD_BYTE_OFFSET) >> 2];
		const realPartOfValue = ngspiceWebAssemblyModule.HEAPF64[
				(vectorEntryPointer + VECTOR_VALUES_REAL_FIELD_BYTE_OFFSET) >> 3];
		const vectorName = ngspiceWebAssemblyModule.UTF8ToString(namePointer);
		if (vectorName === 'time') simulationTimeSeconds = realPartOfValue;
		orderedNodeVoltages[vectorIndex] = realPartOfValue;
		nodeVoltagesByName[vectorName] = realPartOfValue;
	}
	return { simulationTimeSeconds, orderedNodeVoltages, nodeVoltagesByName };
}

function readVectorInfoAllStructIntoOrderedNodeNames(vectorInfoAllStructPointer) {
	const vectorCount = ngspiceWebAssemblyModule.HEAP32[
			(vectorInfoAllStructPointer + VECTOR_INFO_ALL_COUNT_FIELD_BYTE_OFFSET) >> 2];
	const vectorEntryArrayPointer = ngspiceWebAssemblyModule.HEAPU32[
			(vectorInfoAllStructPointer + VECTOR_INFO_ALL_ENTRIES_FIELD_BYTE_OFFSET) >> 2];
	const orderedNodeNames = [];
	for (let vectorIndex = 0; vectorIndex < vectorCount; ++vectorIndex) {
		const vectorEntryPointer = ngspiceWebAssemblyModule.HEAPU32[(vectorEntryArrayPointer >> 2) + vectorIndex];
		const namePointer = ngspiceWebAssemblyModule.HEAPU32[
				(vectorEntryPointer + VECTOR_INFO_NAME_FIELD_BYTE_OFFSET) >> 2];
		orderedNodeNames.push(ngspiceWebAssemblyModule.UTF8ToString(namePointer));
	}
	return orderedNodeNames;
}

function isExpectedStepNHaltNoiseLine(oneLineFromNgspice) {
	for (const oneExpectedPrefix of NGSPICE_SENDCHAR_LINE_PREFIXES_THAT_ARE_EXPECTED_STEP_N_HALT_NOISE) {
		if (oneLineFromNgspice.startsWith(oneExpectedPrefix)) return true;
	}
	return false;
}

function registerSharedspiceCallbacksWithNgspice() {
	const sendCharCallbackFunctionPointer = ngspiceWebAssemblyModule.addFunction(
			function forwardSendCharOutputToBridge(textPointer) {
				const oneLineFromNgspice = ngspiceWebAssemblyModule.UTF8ToString(textPointer);
				if (isExpectedStepNHaltNoiseLine(oneLineFromNgspice)) return 0;
				postNgspiceDiagnosticMessage('SendChar', oneLineFromNgspice);
				return 0;
			},
			'iiii');
	const sendStatCallbackFunctionPointer = ngspiceWebAssemblyModule.addFunction(
			function forwardSendStatOutputToBridge(textPointer) {
				postNgspiceDiagnosticMessage('SendStat', ngspiceWebAssemblyModule.UTF8ToString(textPointer));
				return 0;
			},
			'iiii');
	const controlledExitCallbackFunctionPointer = ngspiceWebAssemblyModule.addFunction(
			function reportControlledExit(exitStatus) {
				postWorkerErrorMessage('ngspice controlled_exit status=' + exitStatus);
				return 0;
			},
			'iiiiii');
	const sendDataCallbackFunctionPointer = ngspiceWebAssemblyModule.addFunction(
			function publishSimulationSample(vectorValuesAllStructPointer) {
				const sample = readVectorValuesAllStructIntoSample(vectorValuesAllStructPointer);
				lastObservedSampleSimulationTimeSeconds = sample.simulationTimeSeconds;
				lastObservedNodeVoltagesByName = sample.nodeVoltagesByName;
				totalSampleCountObservedSinceLastDeckLoad += 1;
				postSimulationSampleMessage(sample.simulationTimeSeconds, sample.orderedNodeVoltages);
				return 0;
			},
			'iiiii');
	const sendInitDataCallbackFunctionPointer = ngspiceWebAssemblyModule.addFunction(
			function publishOrderedNodeNames(vectorInfoAllStructPointer) {
				orderedNodeNamesFromLatestInit = readVectorInfoAllStructIntoOrderedNodeNames(vectorInfoAllStructPointer);
				postNodeNamesMessage(orderedNodeNamesFromLatestInit);
				return 0;
			},
			'iiii');
	const backgroundThreadRunningCallbackFunctionPointer = ngspiceWebAssemblyModule.addFunction(
			function publishBackgroundThreadRunningState(isNowRunning) {
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

function computeRampInterpolatedVoltageForExternalSourceAtSimulatedTime(sourceState, simulatedTime) {
	const elapsedSinceMostRecentRampStart = simulatedTime - sourceState.rampStartSimulatedTime;
	if (elapsedSinceMostRecentRampStart <= 0) return sourceState.valueBeforeMostRecentRamp;
	if (elapsedSinceMostRecentRampStart >= EXTERNAL_VOLTAGE_SOURCE_RAMP_DURATION_SECONDS) return sourceState.valueAfterMostRecentRamp;
	const lerpFraction = elapsedSinceMostRecentRampStart / EXTERNAL_VOLTAGE_SOURCE_RAMP_DURATION_SECONDS;
	return sourceState.valueBeforeMostRecentRamp
			+ (sourceState.valueAfterMostRecentRamp - sourceState.valueBeforeMostRecentRamp) * lerpFraction;
}

function registerGetVsrcDataCallbackWithNgspiceForExternalVoltageSources() {
	const getVsrcDataCallbackFunctionPointer = ngspiceWebAssemblyModule.addFunction(
			function returnExternalVoltageSourceValueAtSimulatedTime(
					resultDoublePointer, simulatedTime, sourceNameCharPointer) {
				const sourceName = ngspiceWebAssemblyModule.UTF8ToString(sourceNameCharPointer);
				const sourceState = externalVoltageSourceStateByLowercaseName[sourceName.toLowerCase()];
				const valueToReturn = (sourceState === undefined)
						? 0
						: computeRampInterpolatedVoltageForExternalSourceAtSimulatedTime(sourceState, simulatedTime);
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
	postNgspiceDiagnosticMessage('WorkerDiag', 'feeding ' + deckLines.length + ' deck lines via circbyline');
	for (const oneLine of deckLines) {
		const returnCode = ngspiceSendCommand('circbyline ' + String(oneLine));
		if (returnCode !== 0) {
			postNgspiceDiagnosticMessage('WorkerDiag',
					'circbyline returned nonzero (' + returnCode + ') for line: ' + String(oneLine));
		}
	}
	postNgspiceDiagnosticMessage('WorkerDiag', 'finished feeding deck');
}

function buildAlternatingHighLowInitialConditionLinesForInternalNets() {
	const initialConditionLines = [];
	for (let oneNetIndex = 0; oneNetIndex < internalNetNamesEligibleForInitialConditionSeed.length; ++oneNetIndex) {
		const oneInternalNetName = internalNetNamesEligibleForInitialConditionSeed[oneNetIndex];
		const seedVoltageForThisNet = (oneNetIndex % 2 === 0)
				? INITIAL_CONDITION_SEED_HIGH_VOLTS
				: INITIAL_CONDITION_SEED_LOW_VOLTS;
		initialConditionLines.push('.ic v(' + oneInternalNetName + ')=' + seedVoltageForThisNet);
	}
	return initialConditionLines;
}

function buildSnapshotInitialConditionLinesFromLastObservedSample() {
	const snapshotInitialConditionLines = [];
	for (const oneNodeName of Object.keys(lastObservedNodeVoltagesByName)) {
		if (oneNodeName === 'time' || oneNodeName === '0') continue;
		if (oneNodeName.indexOf('#') !== -1) continue;
		snapshotInitialConditionLines.push('.ic v(' + oneNodeName + ')=' + lastObservedNodeVoltagesByName[oneNodeName]);
	}
	return snapshotInitialConditionLines;
}

function buildDeckLinesWithInitialConditionsAndTransientAnalysis(initialConditionLines, useInitialConditionsFlag) {
	const tranLine = '.tran ' + currentTransientTimestepInSeconds
			+ ' ' + SIMULATION_TSTOP_FAR_BEYOND_ANY_SESSION_SECONDS
			+ ' 0 ' + currentTransientTimestepInSeconds
			+ (useInitialConditionsFlag ? ' uic' : '');
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

function loadAssembledDeckIntoNgspice(initialConditionLines, useInitialConditionsFlag) {
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

function applyLooseRunPhaseOptionsViaRuntimeCommands() {
	for (const oneOptionCommand of NGSPICE_OPTION_COMMANDS_FOR_LOOSE_RUN_PHASE) {
		ngspiceSendCommand(oneOptionCommand);
	}
	postNgspiceDiagnosticMessage('WorkerDiag',
			'applied ' + NGSPICE_OPTION_COMMANDS_FOR_LOOSE_RUN_PHASE.length
			+ ' loose-run-phase option overrides');
}

function runSynchronousFullPrecisionBootstrapToBreakMetastableEquilibria() {
	postNgspiceDiagnosticMessage('WorkerDiag',
			'bootstrap: running step ' + SYNCHRONOUS_FULL_PRECISION_BOOTSTRAP_STEP_COUNT
			+ ' with ngspice default tolerances to break metastability');
	const wallClockMillisecondsBeforeBootstrap = readCurrentWallClockMilliseconds();
	ngspiceSendCommand('step ' + SYNCHRONOUS_FULL_PRECISION_BOOTSTRAP_STEP_COUNT);
	const bootstrapWallClockMilliseconds = readCurrentWallClockMilliseconds() - wallClockMillisecondsBeforeBootstrap;
	postNgspiceDiagnosticMessage('WorkerDiag',
			'bootstrap: completed in ' + bootstrapWallClockMilliseconds.toFixed(1)
			+ ' ms; last observed sample t=' + lastObservedSampleSimulationTimeSeconds.toExponential(3) + 's');
}

function emitChunkDiagnosticIfWarrantedForThisChunk(
		chunkOrdinal, samplesEmittedThisChunk, wallClockMillisecondsThisChunk) {
	const isAmongTheFirstFewChunksAfterLoad = chunkOrdinal <= 3;
	const chunkEmittedNoSamples = samplesEmittedThisChunk === 0;
	if (!(isAmongTheFirstFewChunksAfterLoad || chunkEmittedNoSamples)) return;
	postNgspiceDiagnosticMessage('WorkerDiag',
			'chunk ' + chunkOrdinal + ': emitted ' + samplesEmittedThisChunk
			+ ' sample(s) in ' + wallClockMillisecondsThisChunk.toFixed(1) + ' ms (total samples: '
			+ totalSampleCountObservedSinceLastDeckLoad + ')');
}

function emitThroughputSaturationWarningIfBelowTargetForCurrentWindow(wallClockMillisecondsAfterStep) {
	const throughputWindowElapsedMilliseconds = wallClockMillisecondsAfterStep
			- throughputWindowStartWallClockMilliseconds;
	if (throughputWindowElapsedMilliseconds < THROUGHPUT_WARNING_WINDOW_MILLISECONDS) return;
	const measuredSamplesPerSecond = (throughputWindowSampleCount * 1000.0) / throughputWindowElapsedMilliseconds;
	const targetSamplesPerSecond = TARGET_SAMPLES_PLAYED_BACK_PER_WALL_SECOND;
	if (measuredSamplesPerSecond < targetSamplesPerSecond * THROUGHPUT_WARNING_RATIO_BELOW_TARGET) {
		const measuredEffectiveTimeWarpSimSecondsPerRealSecond = measuredSamplesPerSecond * currentTransientTimestepInSeconds;
		const requestedTimeWarpSimSecondsPerRealSecond = targetSamplesPerSecond * currentTransientTimestepInSeconds;
		postNgspiceDiagnosticMessage('WorkerDiag',
				'ngspice compute saturated: producing ' + measuredSamplesPerSecond.toFixed(1)
				+ ' samples/s vs target ' + targetSamplesPerSecond
				+ ' samples/s; effective time-warp ' + measuredEffectiveTimeWarpSimSecondsPerRealSecond.toExponential(2)
				+ ' s sim per s real (requested ' + requestedTimeWarpSimSecondsPerRealSecond.toExponential(2) + ')');
	}
	throughputWindowSampleCount = 0;
	throughputWindowStartWallClockMilliseconds = wallClockMillisecondsAfterStep;
}

function runOneStepNChunkAndYield(thisChunkLoopGenerationId) {
	if (thisChunkLoopGenerationId !== currentChunkLoopGenerationCounter) return;
	if (!chunkLoopShouldKeepRunning) {
		postRunningStateChangedMessage(false);
		return;
	}
	const sampleCountBeforeThisChunk = totalSampleCountObservedSinceLastDeckLoad;
	const wallClockMillisecondsBeforeStep = readCurrentWallClockMilliseconds();
	if (totalChunkCountSinceLastDeckLoad === 0) {
		postNgspiceDiagnosticMessage('WorkerDiag',
				'first chunk: about to call step ' + SAMPLES_PER_CHUNK_BETWEEN_SET_TIMEOUT_YIELDS);
	}
	ngspiceSendCommand('step ' + SAMPLES_PER_CHUNK_BETWEEN_SET_TIMEOUT_YIELDS);
	const wallClockMillisecondsAfterStep = readCurrentWallClockMilliseconds();
	const samplesEmittedThisChunk = totalSampleCountObservedSinceLastDeckLoad - sampleCountBeforeThisChunk;
	const wallClockMillisecondsThisChunk = wallClockMillisecondsAfterStep - wallClockMillisecondsBeforeStep;
	totalChunkCountSinceLastDeckLoad += 1;
	consecutiveZeroSampleChunkCount = (samplesEmittedThisChunk === 0) ? consecutiveZeroSampleChunkCount + 1 : 0;
	throughputWindowSampleCount += samplesEmittedThisChunk;
	emitThroughputSaturationWarningIfBelowTargetForCurrentWindow(wallClockMillisecondsAfterStep);
	emitChunkDiagnosticIfWarrantedForThisChunk(
			totalChunkCountSinceLastDeckLoad, samplesEmittedThisChunk, wallClockMillisecondsThisChunk);
	if (consecutiveZeroSampleChunkCount >= MAXIMUM_CONSECUTIVE_ZERO_SAMPLE_CHUNKS_BEFORE_BAILING_OUT) {
		postNgspiceDiagnosticMessage('WorkerDiag',
				'chunk loop bailing out after ' + consecutiveZeroSampleChunkCount
				+ ' consecutive zero-sample chunks (deck likely failed to load or solver is stuck)');
		chunkLoopShouldKeepRunning = false;
		postRunningStateChangedMessage(false);
		return;
	}
	const millisecondsRemainingUntilNextChunkShouldFire = Math.max(
			0,
			MILLISECONDS_BETWEEN_CONSECUTIVE_CHUNKS_WHEN_NGSPICE_IS_FASTER_THAN_TARGET
					- wallClockMillisecondsThisChunk);
	setTimeout(
			runOneStepNChunkAndYield.bind(null, thisChunkLoopGenerationId),
			millisecondsRemainingUntilNextChunkShouldFire);
}

function startContinuousChunkLoop() {
	currentChunkLoopGenerationCounter += 1;
	totalChunkCountSinceLastDeckLoad = 0;
	totalSampleCountObservedSinceLastDeckLoad = 0;
	consecutiveZeroSampleChunkCount = 0;
	throughputWindowSampleCount = 0;
	throughputWindowStartWallClockMilliseconds = readCurrentWallClockMilliseconds();
	chunkLoopShouldKeepRunning = true;
	postRunningStateChangedMessage(true);
	postNgspiceDiagnosticMessage('WorkerDiag',
			'starting continuous chunk loop (generation ' + currentChunkLoopGenerationCounter + ')');
	setTimeout(runOneStepNChunkAndYield.bind(null, currentChunkLoopGenerationCounter), 0);
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
	const alternatingSeedInitialConditionLines = buildAlternatingHighLowInitialConditionLinesForInternalNets();
	const useInitialConditionsFlag = alternatingSeedInitialConditionLines.length > 0;
	loadAssembledDeckIntoNgspice(alternatingSeedInitialConditionLines, useInitialConditionsFlag);
	runSynchronousFullPrecisionBootstrapToBreakMetastableEquilibria();
	applyLooseRunPhaseOptionsViaRuntimeCommands();
	startContinuousChunkLoop();
}

function handleSetTimeWarpMessage(incomingMessage) {
	const requestedTimestepSeconds = Number(incomingMessage.timestepSeconds);
	postNgspiceDiagnosticMessage('WorkerDiag',
			'setTimeWarp received: requestedTimestepSeconds=' + requestedTimestepSeconds
			+ ' (current=' + currentTransientTimestepInSeconds + ')');
	if (!isFinite(requestedTimestepSeconds) || requestedTimestepSeconds <= 0) {
		postNgspiceDiagnosticMessage('WorkerDiag',
				'setTimeWarp rejected: timestep is not finite or not positive');
		return;
	}
	chunkLoopShouldKeepRunning = false;
	currentTransientTimestepInSeconds = requestedTimestepSeconds;
	const snapshotInitialConditionLines = buildSnapshotInitialConditionLinesFromLastObservedSample();
	loadAssembledDeckIntoNgspice(snapshotInitialConditionLines, snapshotInitialConditionLines.length > 0);
	applyLooseRunPhaseOptionsViaRuntimeCommands();
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
		sourceState = { valueBeforeMostRecentRamp: 0, valueAfterMostRecentRamp: 0, rampStartSimulatedTime: 0 };
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
	print: function discardModuleStdout() {},
	printErr: function discardModuleStderr() {},
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
