// Web Worker that hosts the ngspice sharedspice WebAssembly module
// (built with --with-ngshared). The bridge in ngspice_bridge.js posts
// messages here describing what the host wants (loadNetlist /
// startTransient / halt / externalVoltage), and we stream simulation
// samples back via postMessage as ngspice's SendData callback fires.

importScripts('ngspice.js');

const FAKE_PROC_MEMINFO_TEXT_FOR_NGSPICE_BUFFER_SIZING = [
	'MemTotal:        1048576 kB',
	'MemFree:         1048576 kB',
	'MemAvailable:    1048576 kB',
	'',
].join('\n');

let ngspiceWebAssemblyModule = null;
let ngspiceSendCommand = null;
let orderedNodeNamesFromLatestInit = null;

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
	for (let vectorIndex = 0; vectorIndex < vectorCount; ++vectorIndex) {
		const vectorEntryPointer = ngspiceWebAssemblyModule.HEAPU32[(vectorEntryArrayPointer >> 2) + vectorIndex];
		const namePointer = ngspiceWebAssemblyModule.HEAPU32[vectorEntryPointer >> 2];
		const realPartOfValue = ngspiceWebAssemblyModule.HEAPF64[(vectorEntryPointer + 8) >> 3];
		const vectorName = ngspiceWebAssemblyModule.UTF8ToString(namePointer);
		if (vectorName === 'time') simulationTimeSeconds = realPartOfValue;
		orderedNodeVoltages[vectorIndex] = realPartOfValue;
	}
	return { simulationTimeSeconds, orderedNodeVoltages };
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

function provideFakeProcMeminfoSoNgspiceDoesNotAbort() {
	ngspiceWebAssemblyModule.FS.mkdirTree('/proc');
	ngspiceWebAssemblyModule.FS.writeFile('/proc/meminfo', FAKE_PROC_MEMINFO_TEXT_FOR_NGSPICE_BUFFER_SIZING);
}

function feedNetlistLinesIntoNgspice(netlistLines) {
	for (const oneLine of netlistLines) {
		ngspiceSendCommand('circbyline ' + String(oneLine));
	}
}

function handleLoadNetlistMessage(incomingMessage) {
	feedNetlistLinesIntoNgspice(incomingMessage.netlistLines || []);
	ngspiceSendCommand('save none');
}

const EXTERNAL_VOLTAGE_SOURCE_RAMP_DURATION_SECONDS = 5e-12;

let configuredTransientTimestepInSeconds = 0;
let configuredTransientStopTimeInSecondsPerEventDrivenRun = 0;

// State for each ngspice "external" voltage source. ngspice's
// GetVSRCData callback (registered via ngSpice_Init_Sync) asks for
// the source value at a given simulated time on every solver step.
// At t = 0 we return valueBeforeStep so ngspice's IC solver settles
// to the previous steady state; for t > 0 we linearly ramp toward
// valueAfterStep over EXTERNAL_VOLTAGE_SOURCE_RAMP_DURATION_SECONDS,
// then hold there. After each tran completes, valueBeforeStep
// catches up to valueAfterStep so the next click's IC starts from
// this click's end state.
const externalVoltageSourceStateByLowercaseName = Object.create(null);

function registerGetVsrcDataCallbackWithNgspiceForExternalVoltageSources() {
	const getVsrcDataCallbackFunctionPointer = ngspiceWebAssemblyModule.addFunction(
			function returnExternalVoltageSourceValueAtSimulatedTime(
					resultDoublePointer, simulatedTime, sourceNameCharPointer,
					libraryInstanceId, userDataPointer) {
				const sourceName = ngspiceWebAssemblyModule.UTF8ToString(sourceNameCharPointer);
				const sourceState = externalVoltageSourceStateByLowercaseName[sourceName.toLowerCase()];
				let valueToReturn = 0;
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

function runEventDrivenShortTransientFromInitialConditionsBlocking() {
	postRunningStateChangedMessage(true);
	// Pass tstep as the 4th argument (tmax) too so ngspice's adaptive solver
	// can't take strides larger than tstep once the inverter settles. Without
	// this the solver leaps from ~200 ps straight to tstop with no samples
	// in between, leaving the playback animation visibly choppy.
	ngspiceSendCommand('tran '
			+ configuredTransientTimestepInSeconds + ' '
			+ configuredTransientStopTimeInSecondsPerEventDrivenRun + ' 0 '
			+ configuredTransientTimestepInSeconds);
	ngspiceSendCommand('run');
	for (const oneSourceName in externalVoltageSourceStateByLowercaseName) {
		const sourceState = externalVoltageSourceStateByLowercaseName[oneSourceName];
		sourceState.valueBeforeStep = sourceState.valueAfterStep;
	}
	postRunningStateChangedMessage(false);
}

function handleStartTransientMessage(incomingMessage) {
	configuredTransientTimestepInSeconds = Number(incomingMessage.timestepSeconds);
	configuredTransientStopTimeInSecondsPerEventDrivenRun = Number(incomingMessage.stopTimeSeconds);
	runEventDrivenShortTransientFromInitialConditionsBlocking();
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
	postRunningStateChangedMessage(false);
}

function handleExternalVoltageMessage(incomingMessage) {
	const externalSourceNameLowercase = String(incomingMessage.sourceName).toLowerCase();
	const newTargetValueOfExternalSourceInVolts = Number(incomingMessage.volts);
	let sourceState = externalVoltageSourceStateByLowercaseName[externalSourceNameLowercase];
	if (sourceState === undefined) {
		sourceState = { valueBeforeStep: 0, valueAfterStep: 0 };
		externalVoltageSourceStateByLowercaseName[externalSourceNameLowercase] = sourceState;
	}
	sourceState.valueAfterStep = newTargetValueOfExternalSourceInVolts;
	runEventDrivenShortTransientFromInitialConditionsBlocking();
}

self.addEventListener('message', function handleHostMessage(messageEvent) {
	const incomingMessage = messageEvent.data || {};
	if (!ngspiceWebAssemblyModule) {
		postWorkerErrorMessage('ngspice module not yet ready');
		return;
	}
	switch (incomingMessage.messageKind) {
		case 'loadNetlist':         handleLoadNetlistMessage(incomingMessage); break;
		case 'startTransient':      handleStartTransientMessage(incomingMessage); break;
		case 'halt':                handleHaltMessage(); break;
		case 'externalVoltage':     handleExternalVoltageMessage(incomingMessage); break;
		case 'installFileText':     handleInstallFileTextMessage(incomingMessage); break;
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
