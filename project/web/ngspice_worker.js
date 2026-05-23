// ngspice_worker.js — runs on a dedicated Web Worker thread.
//
// v0 status: PLACEHOLDER. Loads no WASM, runs no simulation. The real
// implementation needs:
//   - an ngspice WASM module built via Emscripten (see references/ngspice_example/Dockerfile)
//   - a thin wrapper exposing ngSpice_Init / ngSpice_Init_Sync / ngSpice_Circ /
//     ngSpice_Command / cb_SendData / cb_GetVSRCData via Emscripten exports
//   - a SharedArrayBuffer-backed ring buffer for samples so postMessage isn't
//     on the hot path
//
// This file exists today so the deploy pipeline ships *something* recognizable
// and the bridge has a real path to point a Worker at. Replace as the real
// build pipeline lands.

self.addEventListener('message', (event) => {
	const msg = event.data || {};
	switch (msg.type) {
		case 'load_netlist':
			self.postMessage({ type: 'error', error: 'ngspice WASM module not yet wired in' });
			break;
		case 'tran':
		case 'halt':
		case 'external':
			// Silently ignored in the placeholder.
			break;
		default:
			self.postMessage({ type: 'error', error: 'unknown message: ' + msg.type });
	}
});

self.postMessage({ type: 'ready', placeholder: true });
