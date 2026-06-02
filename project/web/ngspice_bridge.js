(function installSpice3DBridge() {
	'use strict';

	if (globalThis.spice3d && globalThis.spice3d.installedFromBridgeScript) {
		return;
	}

	const MAXIMUM_BUFFERED_SIMULATION_SAMPLES_BEFORE_DROPPING_OLDEST = 200;

	const bridge = {
		installedFromBridgeScript: true,
		maximumBufferedSimulationSamplesBeforeDroppingOldest:
				MAXIMUM_BUFFERED_SIMULATION_SAMPLES_BEFORE_DROPPING_OLDEST,
		ngspiceWorker: null,
		isWorkerReady: false,
		isSimulationRunning: false,
		nodeNames: null,
		bufferedSimulationSamples: [],
		totalBufferedSimulationSamplesDroppedFromOverflow: 0,
		pendingExternalVoltagesByLowercaseName: Object.create(null),

		initializeWorker: function initializeWorker() {
			if (this.ngspiceWorker) {
				return true;
			}
			try {
				const cacheBustQueryParameter = '?v=' + Date.now();
				this.ngspiceWorker = new Worker('ngspice_worker.js' + cacheBustQueryParameter);
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

		loadNetlistLinesWithTimestepAndInternalNetsToSeed: function loadNetlistLinesWithTimestepAndInternalNetsToSeed(
				netlistLines, timestepSeconds, internalNetNamesToSeedAtHalfVdd) {
			if (!this.ngspiceWorker) {
				return false;
			}
			this.ngspiceWorker.postMessage({
				messageKind: 'loadNetlist',
				netlistLines: netlistLines,
				timestepSeconds: timestepSeconds,
				internalNetNamesToSeedAtHalfVdd: internalNetNamesToSeedAtHalfVdd,
			});
			return true;
		},

		updateTimeWarpTimestep: function updateTimeWarpTimestep(timestepSeconds) {
			if (!this.ngspiceWorker) {
				return false;
			}
			this.ngspiceWorker.postMessage({
				messageKind: 'setTimeWarp',
				timestepSeconds: timestepSeconds,
			});
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

		takeBufferedSimulationSamples: function takeBufferedSimulationSamples() {
			const drainedSamples = this.bufferedSimulationSamples;
			this.bufferedSimulationSamples = [];
			return drainedSamples;
		},

		appendDecoratedSampleAndDropOldestIfBufferAtCap: function appendDecoratedSampleAndDropOldestIfBufferAtCap(decoratedSample) {
			if (this.bufferedSimulationSamples.length
					>= this.maximumBufferedSimulationSamplesBeforeDroppingOldest) {
				this.bufferedSimulationSamples.shift();
				this.totalBufferedSimulationSamplesDroppedFromOverflow += 1;
			}
			this.bufferedSimulationSamples.push(decoratedSample);
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
					this.appendDecoratedSampleAndDropOldestIfBufferAtCap(
							this.decorateSampleWithNamedVoltages(workerMessage.sample));
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

		activeStreamingDownloadState: null,

		beginStreamingDownload: function beginStreamingDownload(downloadUrl) {
			this.activeStreamingDownloadState = {
				queuedChunks: [],
				totalBytesReceived: 0,
				isCompletelyDownloaded: false,
				fetchErrorMessage: null,
				httpStatusCode: 0,
			};
			const downloadState = this.activeStreamingDownloadState;
			(async () => {
				try {
					const response = await fetch(downloadUrl);
					downloadState.httpStatusCode = response.status;
					if (!response.ok) {
						downloadState.fetchErrorMessage = 'HTTP ' + response.status + ' ' + response.statusText;
						downloadState.isCompletelyDownloaded = true;
						return;
					}
					const responseBodyReader = response.body.getReader();
					while (true) {
						const { value: chunkUint8Array, done: streamIsExhausted } = await responseBodyReader.read();
						if (streamIsExhausted) {
							break;
						}
						downloadState.queuedChunks.push(chunkUint8Array);
						downloadState.totalBytesReceived += chunkUint8Array.byteLength;
					}
					downloadState.isCompletelyDownloaded = true;
				} catch (fetchOrStreamError) {
					downloadState.fetchErrorMessage = String(fetchOrStreamError && fetchOrStreamError.message || fetchOrStreamError);
					downloadState.isCompletelyDownloaded = true;
				}
			})();
			return true;
		},

		takeNextStreamingChunkAsJsonStatusEnvelope: function takeNextStreamingChunkAsJsonStatusEnvelope() {
			const downloadState = this.activeStreamingDownloadState;
			if (!downloadState) {
				return JSON.stringify({ status: 'no_active_download' });
			}
			if (downloadState.queuedChunks.length > 0) {
				const oneChunkUint8Array = downloadState.queuedChunks.shift();
				return JSON.stringify({
					status: 'chunk',
					base64ChunkBody: this.encodeUint8ArrayAsBase64WithoutStackOverflow(oneChunkUint8Array),
					totalBytesReceivedSoFar: downloadState.totalBytesReceived,
				});
			}
			if (downloadState.fetchErrorMessage) {
				return JSON.stringify({
					status: 'error',
					errorMessage: downloadState.fetchErrorMessage,
					httpStatusCode: downloadState.httpStatusCode,
				});
			}
			if (downloadState.isCompletelyDownloaded) {
				return JSON.stringify({
					status: 'done',
					totalBytesReceivedSoFar: downloadState.totalBytesReceived,
				});
			}
			return JSON.stringify({ status: 'pending', totalBytesReceivedSoFar: downloadState.totalBytesReceived });
		},

		clearStreamingDownloadState: function clearStreamingDownloadState() {
			this.activeStreamingDownloadState = null;
		},

		encodeUint8ArrayAsBase64WithoutStackOverflow: function encodeUint8ArrayAsBase64WithoutStackOverflow(inputUint8Array) {
			const SAFE_FROM_CHAR_CODE_CHUNK_SIZE_TO_AVOID_ARGUMENT_LIMIT = 0x8000;
			let asciiBinaryString = '';
			for (let sliceStart = 0; sliceStart < inputUint8Array.length; sliceStart += SAFE_FROM_CHAR_CODE_CHUNK_SIZE_TO_AVOID_ARGUMENT_LIMIT) {
				const oneSubSlice = inputUint8Array.subarray(sliceStart, sliceStart + SAFE_FROM_CHAR_CODE_CHUNK_SIZE_TO_AVOID_ARGUMENT_LIMIT);
				asciiBinaryString += String.fromCharCode.apply(null, oneSubSlice);
			}
			return btoa(asciiBinaryString);
		},
	};

	globalThis.spice3d = bridge;
	bridge.initializeWorker();
})();
