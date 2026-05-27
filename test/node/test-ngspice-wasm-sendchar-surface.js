// Locks in that SendChar (ngspice's primary diagnostic channel) is
// actually routed somewhere a developer can read. The deployed
// browser worker silently dropped SendChar output once, which made
// a `controlled_exit status=1` impossible to triage from a console
// paste. This test fails if a future refactor regresses to that
// state by registering a discard-all callback.

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

async function exerciseSendCharSurfaceAndExpectNonEmptyCapture() {
	const createNgspiceModule = require(ngspice_module_javascript_path);
	const ngspiceWebAssemblyModule = await createNgspiceModule({
		locateFile: (relativeFileName) =>
				path.resolve(ngspice_emscripten_build_directory, relativeFileName),
		print: () => {},
		printErr: () => {},
		preRun: [
			function stubFakeProcMeminfoIntoModuleMemfs(module) {
				module.FS.mkdirTree('/proc');
				module.FS.writeFile('/proc/meminfo', FAKE_PROC_MEMINFO_TEXT_FOR_NGSPICE);
			},
		],
	});

	const capturedSendCharLinesFromNgspice = [];

	const sendCharCallbackFunctionPointer = ngspiceWebAssemblyModule.addFunction(
			function captureSendCharLineIntoArray(textPointer, libraryInstanceId, userDataPointer) {
				capturedSendCharLinesFromNgspice.push(
						ngspiceWebAssemblyModule.UTF8ToString(textPointer));
				return 0;
			},
			'iiii');

	const ngSpiceInitReturnCode = ngspiceWebAssemblyModule._ngSpice_Init(
			sendCharCallbackFunctionPointer,
			ngspiceWebAssemblyModule.addFunction(() => 0, 'iiii'),
			ngspiceWebAssemblyModule.addFunction(() => 0, 'iiiiii'),
			ngspiceWebAssemblyModule.addFunction(() => 0, 'iiiii'),
			ngspiceWebAssemblyModule.addFunction(() => 0, 'iiii'),
			ngspiceWebAssemblyModule.addFunction(() => 0, 'iiii'),
			0);
	if (ngSpiceInitReturnCode !== 0) {
		abortWithFailureMessage('ngSpice_Init returned ' + ngSpiceInitReturnCode);
	}

	const sendNgspiceCommand = ngspiceWebAssemblyModule.cwrap(
			'ngSpice_Command', 'number', ['string']);

	sendNgspiceCommand('version');

	if (capturedSendCharLinesFromNgspice.length === 0) {
		abortWithFailureMessage(
				'SendChar callback was never invoked after `version` command — '
				+ 'ngspice diagnostics are not reaching the host. '
				+ 'A registered no-op SendChar callback will make `controlled_exit` errors un-triagable.');
	}

	const sendCharBlobLowerCased = capturedSendCharLinesFromNgspice.join('').toLowerCase();
	const expectedSubstringInVersionBanner = 'ngspice';
	if (!sendCharBlobLowerCased.includes(expectedSubstringInVersionBanner)) {
		abortWithFailureMessage(
				'SendChar capture did not contain the expected substring "'
				+ expectedSubstringInVersionBanner + '" from the version banner. '
				+ 'Captured ' + capturedSendCharLinesFromNgspice.length + ' line(s); '
				+ 'first line: ' + JSON.stringify(capturedSendCharLinesFromNgspice[0] || ''));
	}

	process.stdout.write(
			'PASS — SendChar callback received ' + capturedSendCharLinesFromNgspice.length
			+ ' line(s) including the ngspice version banner.\n');
}

exerciseSendCharSurfaceAndExpectNonEmptyCapture().catch((unhandledError) => {
	abortWithFailureMessage('unhandled exception: ' + (unhandledError && unhandledError.message));
});
