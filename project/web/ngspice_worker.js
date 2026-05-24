// Web Worker that hosts the ngspice WebAssembly module. The
// `globalThis.spice3d` bridge in ngspice_bridge.js posts messages here
// asking us to load a netlist, run a transient analysis, etc. We drive
// the CLI build of ngspice via callMain + Emscripten FS for now; an
// interactive sharedspice path can replace this once libtool gets a
// proper wasm32-unknown-emscripten host pattern.

const SMOKE_TEST_NETLIST_TEXT = [
	'spice3d smoke test rc transient',
	'V1 in 0 PULSE(0 1 0 0 0 1u 2u)',
	'R1 in out 1k',
	'C1 out 0 1n',
	'.tran 100n 2u',
	'.print tran v(in) v(out)',
	'.end',
	'',
].join('\n');

const captured_stdout_lines_during_current_invocation = [];
const captured_stderr_lines_during_current_invocation = [];

const emscriptenModuleOptions = {
	noInitialRun: true,
	noExitRuntime: true,
	print: function captureNgspiceStdoutLine(textLine) {
		captured_stdout_lines_during_current_invocation.push(String(textLine));
	},
	printErr: function captureNgspiceStderrLine(textLine) {
		captured_stderr_lines_during_current_invocation.push(String(textLine));
	},
	locateFile: function locateAdjacentNgspiceWasmFile(relativeFileName) {
		return relativeFileName;
	},
};

function postWorkerErrorMessage(errorText) {
	self.postMessage({ messageKind: 'error', errorText: errorText });
}

function postWorkerReadyMessage(smokeTestStdoutText, smokeTestStderrText) {
	self.postMessage({
		messageKind: 'workerReady',
		isPlaceholder: false,
		smokeTestStdoutText: smokeTestStdoutText,
		smokeTestStderrText: smokeTestStderrText,
	});
}

function postSmokeTestRanMessage(stdoutText, stderrText, exitStatus) {
	self.postMessage({
		messageKind: 'ngspiceSmokeTestRan',
		stdoutText: stdoutText,
		stderrText: stderrText,
		exitStatus: exitStatus,
	});
}

function takeCapturedStdoutText() {
	const text = captured_stdout_lines_during_current_invocation.join('\n');
	captured_stdout_lines_during_current_invocation.length = 0;
	return text;
}

function takeCapturedStderrText() {
	const text = captured_stderr_lines_during_current_invocation.join('\n');
	captured_stderr_lines_during_current_invocation.length = 0;
	return text;
}

function writeFileIntoEmscriptenVirtualFileSystem(filePath, fileText) {
	self.Module.FS.writeFile(filePath, fileText);
}

function provideFakeProcMeminfoSoNgspiceDoesNotAbort() {
	// ngspice reads /proc/meminfo on startup to size its output buffers;
	// without it the run aborts with "Setting the output memory is not
	// possible." A reasonable lie keeps the simulator happy.
	const fakeProcMeminfoText = [
		'MemTotal:        1048576 kB',
		'MemFree:         1048576 kB',
		'MemAvailable:    1048576 kB',
		'',
	].join('\n');
	self.Module.FS.mkdirTree('/proc');
	self.Module.FS.writeFile('/proc/meminfo', fakeProcMeminfoText);
}

function runNgspiceInBatchMode(virtualNetlistPath) {
	let exitStatus = 0;
	try {
		self.Module.callMain(['-b', virtualNetlistPath]);
	} catch (ngspiceInvocationError) {
		exitStatus = -1;
		captured_stderr_lines_during_current_invocation.push(
				'callMain threw: ' + ngspiceInvocationError.message);
	}
	return exitStatus;
}

function runSmokeTestAfterModuleReady() {
	provideFakeProcMeminfoSoNgspiceDoesNotAbort();
	const smokeTestNetlistPath = '/spice3d_smoke_test.cir';
	writeFileIntoEmscriptenVirtualFileSystem(smokeTestNetlistPath, SMOKE_TEST_NETLIST_TEXT);
	const exitStatus = runNgspiceInBatchMode(smokeTestNetlistPath);
	const smokeStdout = takeCapturedStdoutText();
	const smokeStderr = takeCapturedStderrText();
	postSmokeTestRanMessage(smokeStdout, smokeStderr, exitStatus);
	postWorkerReadyMessage(smokeStdout, smokeStderr);
}

function handleLoadNetlistMessage(incomingMessage) {
	const netlistText = (incomingMessage.netlistLines || []).join('\n') + '\n';
	writeFileIntoEmscriptenVirtualFileSystem('/spice3d_input.cir', netlistText);
}

function handleStartTransientMessage(incomingMessage) {
	const exitStatus = runNgspiceInBatchMode('/spice3d_input.cir');
	self.postMessage({
		messageKind: 'simulationOutputText',
		stdoutText: takeCapturedStdoutText(),
		stderrText: takeCapturedStderrText(),
		exitStatus: exitStatus,
	});
}

self.addEventListener('message', function handleHostMessage(messageEvent) {
	const incomingMessage = messageEvent.data || {};
	if (!self.Module || typeof self.Module.callMain !== 'function') {
		postWorkerErrorMessage('ngspice module not yet ready');
		return;
	}
	switch (incomingMessage.messageKind) {
		case 'loadNetlist':
			handleLoadNetlistMessage(incomingMessage);
			break;
		case 'startTransient':
			handleStartTransientMessage(incomingMessage);
			break;
		case 'halt':
		case 'externalVoltage':
			// Not meaningful for the CLI driver; ignore until sharedspice
			// is wired in.
			break;
		default:
			postWorkerErrorMessage('unknown messageKind: ' + incomingMessage.messageKind);
	}
});

emscriptenModuleOptions.onRuntimeInitialized = function whenNgspiceWasmReady() {
	try {
		runSmokeTestAfterModuleReady();
	} catch (smokeTestError) {
		postWorkerErrorMessage('smoke test threw: ' + smokeTestError.message);
	}
};

self.Module = emscriptenModuleOptions;
try {
	importScripts('ngspice.js');
} catch (ngspiceScriptLoadError) {
	postWorkerErrorMessage('importScripts(ngspice.js) failed: ' + ngspiceScriptLoadError.message);
}
