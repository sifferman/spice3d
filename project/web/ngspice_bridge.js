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
			console.warn('[spice3d] ngspice worker not yet implemented');
			return false;
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

		takeBufferedSimulationSamples: function takeBufferedSimulationSamples() {
			const drainedSamples = this.bufferedSimulationSamples;
			this.bufferedSimulationSamples = [];
			return drainedSamples;
		},

		handleWorkerMessage: function handleWorkerMessage(workerMessage) {
			switch (workerMessage.messageKind) {
				case 'workerReady':
					this.isWorkerReady = true;
					break;
				case 'nodeNames':
					this.nodeNames = workerMessage.nodeNames;
					break;
				case 'simulationSample':
					this.bufferedSimulationSamples.push(workerMessage.sample);
					break;
				case 'runningStateChanged':
					this.isSimulationRunning = Boolean(workerMessage.isSimulationRunning);
					break;
			}
		},
	};

	globalThis.spice3d = bridge;
})();
