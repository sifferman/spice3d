(function installSpice3DBridge() {
	'use strict';

	if (globalThis.spice3d && globalThis.spice3d.installedFromBridgeScript) {
		return;
	}

	const bridge = {
		installedFromBridgeScript: true,
		ngspiceWorker: null,
		isWorkerReady: false,
		isSimulationRunning: false,
		nodeNames: null,
		bufferedSimulationSamples: [],
		pendingExternalVoltagesByLowercaseName: Object.create(null),

		initializeWorker: function initializeWorker() {
			if (this.ngspiceWorker) {
				return true;
			}
			try {
				this.ngspiceWorker = new Worker('ngspice_worker.js');
			} catch (workerConstructionError) {
				console.error('[spice3d] failed to construct ngspice worker', workerConstructionError);
				this.ngspiceWorker = null;
				return false;
			}
			this.ngspiceWorker.addEventListener('message', (workerMessageEvent) => {
				this.handleWorkerMessage(workerMessageEvent.data || {});
			});
			this.ngspiceWorker.addEventListener('error', (workerErrorEvent) => {
				console.error('[spice3d] ngspice worker error', workerErrorEvent.message);
			});
			return true;
		},

		loadNetlistLines: function loadNetlistLines(netlistLines) {
			if (!this.ngspiceWorker) {
				return false;
			}
			this.ngspiceWorker.postMessage({ messageKind: 'loadNetlist', netlistLines: netlistLines });
			return true;
		},

		startTransientAnalysis: function startTransientAnalysis(timestepSeconds, stopTimeSeconds) {
			if (!this.ngspiceWorker) {
				return false;
			}
			this.ngspiceWorker.postMessage({
				messageKind: 'startTransient',
				timestepSeconds: timestepSeconds,
				stopTimeSeconds: stopTimeSeconds,
			});
			this.isSimulationRunning = true;
			return true;
		},

		stopSimulation: function stopSimulation() {
			if (this.ngspiceWorker) {
				this.ngspiceWorker.postMessage({ messageKind: 'halt' });
			}
			this.isSimulationRunning = false;
		},

		setExternalVoltageSource: function setExternalVoltageSource(sourceName, volts) {
			const lowercaseSourceName = String(sourceName).toLowerCase();
			this.pendingExternalVoltagesByLowercaseName[lowercaseSourceName] = volts;
			if (this.ngspiceWorker) {
				this.ngspiceWorker.postMessage({
					messageKind: 'externalVoltage',
					sourceName: lowercaseSourceName,
					volts: volts,
				});
			}
		},

		installFileTextInWorkerFilesystem: function installFileTextInWorkerFilesystem(virtualPath, fileContent) {
			if (!this.ngspiceWorker) return false;
			this.ngspiceWorker.postMessage({
				messageKind: 'installFileText',
				virtualPath: String(virtualPath),
				fileContent: String(fileContent),
			});
			return true;
		},

		setSampleThrottleMaxSamplesPerSecond: function setSampleThrottleMaxSamplesPerSecond(maxSamplesPerSecond) {
			if (!this.ngspiceWorker) return false;
			this.ngspiceWorker.postMessage({
				messageKind: 'setSampleThrottle',
				maxSamplesPerSecond: Number(maxSamplesPerSecond),
			});
			return true;
		},

		takeBufferedSimulationSamples: function takeBufferedSimulationSamples() {
			const drainedSamples = this.bufferedSimulationSamples;
			this.bufferedSimulationSamples = [];
			return drainedSamples;
		},

		decorateSampleWithNamedVoltages: function decorateSampleWithNamedVoltages(rawSample) {
			if (!this.nodeNames || !rawSample || !Array.isArray(rawSample.nodeVoltages)) {
				return rawSample;
			}
			const namedVoltagesBySpiceNodeName = Object.create(null);
			for (let nodeIndex = 0; nodeIndex < this.nodeNames.length; ++nodeIndex) {
				const nodeName = this.nodeNames[nodeIndex];
				if (typeof nodeName === 'string') {
					namedVoltagesBySpiceNodeName[nodeName.toLowerCase()] = rawSample.nodeVoltages[nodeIndex];
				}
			}
			return {
				simulationTimeSeconds: rawSample.simulationTimeSeconds,
				nodeVoltagesByName: namedVoltagesBySpiceNodeName,
			};
		},

		handleWorkerMessage: function handleWorkerMessage(workerMessage) {
			switch (workerMessage.messageKind) {
				case 'workerReady':
					this.isWorkerReady = true;
					if (!workerMessage.isPlaceholder) {
						console.log('[spice3d] ngspice worker ready');
					}
					break;
				case 'ngspiceSmokeTestRan':
					console.log('[spice3d] ngspice smoke test exit=' + workerMessage.exitStatus);
					if (workerMessage.stdoutText) {
						console.log('[spice3d] ngspice smoke test stdout:\n' + workerMessage.stdoutText);
					}
					if (workerMessage.stderrText) {
						console.warn('[spice3d] ngspice smoke test stderr:\n' + workerMessage.stderrText);
					}
					break;
				case 'simulationOutputText':
					console.log('[spice3d] simulation output exit=' + workerMessage.exitStatus);
					if (workerMessage.stdoutText) {
						console.log('[spice3d] simulation stdout:\n' + workerMessage.stdoutText);
					}
					if (workerMessage.stderrText) {
						console.warn('[spice3d] simulation stderr:\n' + workerMessage.stderrText);
					}
					break;
				case 'nodeNames':
					this.nodeNames = workerMessage.nodeNames;
					break;
				case 'simulationSample':
					this.bufferedSimulationSamples.push(this.decorateSampleWithNamedVoltages(workerMessage.sample));
					break;
				case 'runningStateChanged':
					this.isSimulationRunning = Boolean(workerMessage.isSimulationRunning);
					break;
				case 'error':
					console.error('[spice3d] ngspice worker reported error: ' + workerMessage.errorText);
					break;
				case 'ngspiceDiagnostic':
					console.log('[ngspice/' + workerMessage.diagnosticOriginChannel + '] '
							+ workerMessage.diagnosticText);
					break;
			}
		},
	};

	globalThis.spice3d = bridge;
	bridge.initializeWorker();
})();
