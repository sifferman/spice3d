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
let bufferedSampleCountSinceLastFlush = 0;

const SAMPLE_BUFFER_FLUSH_INTERVAL_IN_SAMPLES = 16;

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
			function discardLogMessages(textPointer, libraryInstanceId, userDataPointer) { return 0; },
			'iiii');
	const sendStatCallbackFunctionPointer = ngspiceWebAssemblyModule.addFunction(
			function discardStatusMessages(textPointer, libraryInstanceId, userDataPointer) { return 0; },
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
				bufferedSampleCountSinceLastFlush = (bufferedSampleCountSinceLastFlush + 1) % SAMPLE_BUFFER_FLUSH_INTERVAL_IN_SAMPLES;
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
}

function handleStartTransientMessage(incomingMessage) {
	const transientCommand = 'tran '
			+ Number(incomingMessage.timestepSeconds) + ' '
			+ Number(incomingMessage.stopTimeSeconds);
	ngspiceSendCommand(transientCommand);
	ngspiceSendCommand('bg_run');
}

function handleHaltMessage() {
	ngspiceSendCommand('bg_halt');
}

function handleExternalVoltageMessage(incomingMessage) {
	const alterCommand = 'alter v.'
			+ String(incomingMessage.sourceName)
			+ ' dc ' + Number(incomingMessage.volts);
	ngspiceSendCommand(alterCommand);
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
	} catch (ngspiceInitError) {
		postWorkerErrorMessage('ngspice init failed: ' + ngspiceInitError.message);
		return;
	}
	postWorkerReadyMessage();
}).catch(function onNgspiceModuleLoadFailed(moduleLoadError) {
	postWorkerErrorMessage('ngspice module failed to load: ' + (moduleLoadError && moduleLoadError.message));
});
