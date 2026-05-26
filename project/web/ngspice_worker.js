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

// ngspice prints these on every `step N` halt because it has no way to
// distinguish a deliberate counter-driven pause from a user-initiated
// abort — all paths go through the same E_PAUSE return in dctran.c:457
// → runcoms2.c which calls fprintf(cp_err, "simulation interrupted\n").
// Under spice3d's chunked-tran architecture this fires once per chunk
// (every ~200 ms), flooding the console with what look like errors.
// Filter them at the worker boundary; the chunk-loop diagnostics already
// surface any real problem (no-progress bail-out, compute saturation).
const NGSPICE_SENDCHAR_LINE_PREFIXES_TO_SUPPRESS_AS_EXPECTED_STEP_N_NOISE = [
	'stderr simulation interrupted',
	'stderr doAnalyses: pause requested',
	'stdout Doing analysis at TEMP',
	'stdout Note: Stopped after',
	'stderr Warning: can\'t find the initialization file spinit',
];

function shouldSuppressNgspiceSendCharLineAsExpectedStepNNoise(oneLineFromNgspice) {
	for (const onePrefix of NGSPICE_SENDCHAR_LINE_PREFIXES_TO_SUPPRESS_AS_EXPECTED_STEP_N_NOISE) {
		if (oneLineFromNgspice.startsWith(onePrefix)) return true;
	}
	return false;
}

function registerSharedspiceCallbacksWithNgspice() {
	const sendCharCallbackFunctionPointer = ngspiceWebAssemblyModule.addFunction(
			function forwardSendCharOutputToBridge(textPointer, libraryInstanceId, userDataPointer) {
				const oneLineFromNgspice = ngspiceWebAssemblyModule.UTF8ToString(textPointer);
				if (shouldSuppressNgspiceSendCharLineAsExpectedStepNNoise(oneLineFromNgspice)) return 0;
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

// When the user changes the time-warp before the worker has had time to emit
// any samples (e.g. they immediately type "10 ns" right after page load),
// lastObservedNodeVoltagesByName is empty, the snapshot has nothing to inject,
// the new tran starts from a fresh DC OP, and for a ring-oscillator that DC
// OP lands at the metastable vdd/2 equilibrium where every inverter holds
// its input at exactly the switching threshold. With bypass=1 the BSIM4
// model evaluations are skipped for non-changing transistors, so the metastable
// equilibrium is numerically stable and the RO just sits there. The fix: when
// we'd otherwise have no snapshot voltages, fall back to the same alternating
// high/low seed that the initial netlist load uses — that's what kicked the
// RO into oscillation on first load in the first place.
function buildEffectiveInitialConditionLinesPreferringSnapshotElseFallingBackToAlternatingSeed() {
	const snapshotInitialConditionLines = buildSnapshotInitialConditionLinesFromLastObservedSample();
	if (snapshotInitialConditionLines.length > 0) {
		return snapshotInitialConditionLines;
	}
	postNgspiceDiagnosticMessage('WorkerDiag',
			'snapshot is empty (no samples observed yet); falling back to alternating IC seed');
	return buildSeedInitialConditionLinesForInternalNets();
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

const MAXIMUM_CONSECUTIVE_ZERO_SAMPLE_CHUNKS_BEFORE_BAILING_OUT = 5;

const THROUGHPUT_WARNING_WINDOW_MILLISECONDS = 5000;
const THROUGHPUT_WARNING_RATIO_BELOW_TARGET = 0.7;

let totalChunkCountSinceLastDeckLoad = 0;
let totalSampleCountObservedSinceLastDeckLoad = 0;
let consecutiveZeroSampleChunkCount = 0;
let currentChunkLoopGenerationCounter = 0;
let throughputWindowSampleCount = 0;
let throughputWindowStartWallClockMilliseconds = 0;

function runOneStepNChunkAndYield(thisChunkLoopGenerationId) {
	if (thisChunkLoopGenerationId !== currentChunkLoopGenerationCounter) {
		return;
	}
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
	if (samplesEmittedThisChunk === 0) {
		consecutiveZeroSampleChunkCount += 1;
	} else {
		consecutiveZeroSampleChunkCount = 0;
	}
	throughputWindowSampleCount += samplesEmittedThisChunk;
	const throughputWindowElapsedMilliseconds = wallClockMillisecondsAfterStep - throughputWindowStartWallClockMilliseconds;
	if (throughputWindowElapsedMilliseconds >= THROUGHPUT_WARNING_WINDOW_MILLISECONDS) {
		const measuredSamplesPerSecond = (throughputWindowSampleCount * 1000.0) / throughputWindowElapsedMilliseconds;
		const targetSamplesPerSecond = TARGET_NUMBER_OF_SAMPLES_PLAYED_BACK_PER_WALL_SECOND;
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
	if (totalChunkCountSinceLastDeckLoad <= 3 || samplesEmittedThisChunk === 0) {
		postNgspiceDiagnosticMessage('WorkerDiag',
				'chunk ' + totalChunkCountSinceLastDeckLoad + ': emitted '
				+ samplesEmittedThisChunk + ' sample(s) in '
				+ wallClockMillisecondsThisChunk.toFixed(1) + ' ms (total samples: '
				+ totalSampleCountObservedSinceLastDeckLoad + ')');
	}
	if (consecutiveZeroSampleChunkCount >= MAXIMUM_CONSECUTIVE_ZERO_SAMPLE_CHUNKS_BEFORE_BAILING_OUT) {
		postNgspiceDiagnosticMessage('WorkerDiag',
				'chunk loop bailing out after ' + consecutiveZeroSampleChunkCount
				+ ' consecutive zero-sample chunks (deck likely failed to load or solver is stuck)');
		chunkLoopShouldKeepRunning = false;
		postRunningStateChangedMessage(false);
		return;
	}
	// Self-paced: cap chunk rate at the design target only when ngspice was
	// faster than that target. When ngspice is the bottleneck (high T, complex
	// circuits), the chunk compute itself already exceeds the target interval,
	// so adding setTimeout(200) on top of a 600 ms chunk wastes 200 ms we don't
	// have. Fire next chunk immediately in that case — playback at the main
	// thread will run as fast as samples arrive.
	const millisecondsRemainingUntilNextChunkShouldFire = Math.max(
			0,
			WALL_CLOCK_MILLISECONDS_BETWEEN_CONSECUTIVE_CHUNKS - wallClockMillisecondsThisChunk);
	setTimeout(
			runOneStepNChunkAndYield.bind(null, thisChunkLoopGenerationId),
			millisecondsRemainingUntilNextChunkShouldFire);
}

function startContinuousChunkLoop() {
	// Increment the generation BEFORE setting chunkLoopShouldKeepRunning so any
	// already-scheduled setTimeout from a previous loop sees a stale generation
	// id when it fires and exits without doing work. Without this, a T-change
	// or click+reload spawns a parallel chunk loop that doubles ngspice's output
	// rate and saturates the playback queue with samples we then have to drop.
	currentChunkLoopGenerationCounter += 1;
	totalChunkCountSinceLastDeckLoad = 0;
	totalSampleCountObservedSinceLastDeckLoad = 0;
	consecutiveZeroSampleChunkCount = 0;
	throughputWindowSampleCount = 0;
	throughputWindowStartWallClockMilliseconds = (typeof performance !== 'undefined' && performance.now)
			? performance.now() : Date.now();
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
	const seedInitialConditionLines = buildSeedInitialConditionLinesForInternalNets();
	const useInitialConditionsFlag = seedInitialConditionLines.length > 0;
	loadAssembledDeckIntoNgspiceAndPrimeForChunking(seedInitialConditionLines, useInitialConditionsFlag);
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
	const effectiveInitialConditionLines = buildEffectiveInitialConditionLinesPreferringSnapshotElseFallingBackToAlternatingSeed();
	const useInitialConditionsFlag = effectiveInitialConditionLines.length > 0;
	loadAssembledDeckIntoNgspiceAndPrimeForChunking(effectiveInitialConditionLines, useInitialConditionsFlag);
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
