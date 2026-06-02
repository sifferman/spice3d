const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SAMPLES_TO_PUMP_WITHOUT_ANY_DRAIN = 100000;
const STUB_NODE_NAMES_FOR_DECORATION = ['time', 'net1', 'btn_out_n', 'clk', 'state_q', 'state_d'];
const STUB_NODE_VOLTAGES_PER_SAMPLE = [0.0, 0.0, 1.8, 0.0, 0.9, 0.9];

function abortWithFailureMessage(failureMessage) {
	process.stderr.write('FAIL: ' + failureMessage + '\n');
	process.exit(1);
}

function buildBridgeSandboxWithStubWorker() {
	class StubWorkerThatDoesNothing {
		constructor() {}
		addEventListener() {}
		removeEventListener() {}
		postMessage() {}
		terminate() {}
	}
	const sandbox = {
		Worker: StubWorkerThatDoesNothing,
		console: { log() {}, warn() {}, error() {} },
		btoa: (asciiBinaryString) => Buffer.from(asciiBinaryString, 'binary').toString('base64'),
		Date: Date,
	};
	sandbox.globalThis = sandbox;
	return sandbox;
}

function loadBridgeIntoSandbox(sandbox) {
	const bridgeScriptText = fs.readFileSync(
			path.resolve(__dirname, '..', '..', 'project', 'web', 'ngspice_bridge.js'),
			'utf8');
	vm.createContext(sandbox);
	vm.runInContext(bridgeScriptText, sandbox, { filename: 'ngspice_bridge.js' });
	if (!sandbox.spice3d || !sandbox.spice3d.installedFromBridgeScript) {
		abortWithFailureMessage('bridge did not install onto sandbox.spice3d');
	}
	return sandbox.spice3d;
}

function buildSimulationSampleMessageForIndex(sampleIndex) {
	return {
		messageKind: 'simulationSample',
		sample: {
			simulationTimeSeconds: sampleIndex * 1.0e-12,
			nodeVoltages: STUB_NODE_VOLTAGES_PER_SAMPLE.slice(),
		},
	};
}

function pumpSimulationSampleMessagesWithoutAnyDrain(bridge, sampleCount) {
	for (let sampleIndex = 0; sampleIndex < sampleCount; ++sampleIndex) {
		bridge.handleWorkerMessage(buildSimulationSampleMessageForIndex(sampleIndex));
	}
}

const bridge = loadBridgeIntoSandbox(buildBridgeSandboxWithStubWorker());
const bufferCap = bridge.maximumBufferedSimulationSamplesBeforeDroppingOldest;
if (!(bufferCap > 0 && bufferCap < SAMPLES_TO_PUMP_WITHOUT_ANY_DRAIN)) {
	abortWithFailureMessage('expected a positive cap smaller than the pump count, got ' + bufferCap);
}

bridge.handleWorkerMessage({ messageKind: 'nodeNames', nodeNames: STUB_NODE_NAMES_FOR_DECORATION });

pumpSimulationSampleMessagesWithoutAnyDrain(bridge, SAMPLES_TO_PUMP_WITHOUT_ANY_DRAIN);

if (bridge.bufferedSimulationSamples.length !== bufferCap) {
	abortWithFailureMessage(
			'after pumping ' + SAMPLES_TO_PUMP_WITHOUT_ANY_DRAIN
			+ ' samples without draining, buffer length must equal cap '
			+ bufferCap + ', got ' + bridge.bufferedSimulationSamples.length);
}

const expectedDropCount = SAMPLES_TO_PUMP_WITHOUT_ANY_DRAIN - bufferCap;
if (bridge.totalBufferedSimulationSamplesDroppedFromOverflow !== expectedDropCount) {
	abortWithFailureMessage(
			'expected ' + expectedDropCount + ' drops, got '
			+ bridge.totalBufferedSimulationSamplesDroppedFromOverflow);
}

const drainedSamples = bridge.takeBufferedSimulationSamples();
if (drainedSamples.length !== bufferCap) {
	abortWithFailureMessage(
			'drain returned ' + drainedSamples.length + ' samples, expected ' + bufferCap);
}

const expectedOldestSurvivingSampleIndex = SAMPLES_TO_PUMP_WITHOUT_ANY_DRAIN - bufferCap;
const expectedNewestSurvivingSampleIndex = SAMPLES_TO_PUMP_WITHOUT_ANY_DRAIN - 1;
const oldestSurvivingSampleSimulationTime = drainedSamples[0].simulationTimeSeconds;
const newestSurvivingSampleSimulationTime = drainedSamples[drainedSamples.length - 1].simulationTimeSeconds;
if (oldestSurvivingSampleSimulationTime !== expectedOldestSurvivingSampleIndex * 1.0e-12) {
	abortWithFailureMessage(
			'oldest surviving sample is not the (pump_count - cap)-th sample: expected t='
			+ (expectedOldestSurvivingSampleIndex * 1.0e-12)
			+ ', got t=' + oldestSurvivingSampleSimulationTime);
}
if (newestSurvivingSampleSimulationTime !== expectedNewestSurvivingSampleIndex * 1.0e-12) {
	abortWithFailureMessage(
			'newest surviving sample is not the very last one pumped: expected t='
			+ (expectedNewestSurvivingSampleIndex * 1.0e-12)
			+ ', got t=' + newestSurvivingSampleSimulationTime);
}

if (bridge.bufferedSimulationSamples.length !== 0) {
	abortWithFailureMessage(
			'after drain, buffer should be empty, got length '
			+ bridge.bufferedSimulationSamples.length);
}

process.stdout.write(
		'PASS: bridge buffer stayed at cap=' + bufferCap
		+ ' under ' + SAMPLES_TO_PUMP_WITHOUT_ANY_DRAIN + ' samples of drain starvation, '
		+ 'dropped ' + expectedDropCount + ' oldest samples, kept newest\n');
