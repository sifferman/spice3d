self.addEventListener('message', function handleHostMessage(messageEvent) {
	const incomingMessage = messageEvent.data || {};
	switch (incomingMessage.messageKind) {
		case 'loadNetlist':
			self.postMessage({
				messageKind: 'error',
				errorText: 'ngspice WASM module not yet wired in',
			});
			break;
		case 'startTransient':
		case 'halt':
		case 'externalVoltage':
			break;
		default:
			self.postMessage({
				messageKind: 'error',
				errorText: 'unknown messageKind: ' + incomingMessage.messageKind,
			});
	}
});

self.postMessage({ messageKind: 'workerReady', isPlaceholder: true });
