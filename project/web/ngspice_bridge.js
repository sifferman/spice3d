// ngspice_bridge.js
//
// Loaded into the page that hosts the Godot web export. Provides a stable
// JavaScript surface under `globalThis.spice3d` that the C++ GDExtension
// (src/sim/web/spice_simulator_web.cpp) calls into via JavaScriptBridge.
//
// Responsibilities (target state — v0 here is scaffolding only):
//   1. Spawn a dedicated Web Worker that hosts the ngspice WASM module.
//   2. Forward netlist / tran / external-source updates to the Worker.
//   3. Receive voltage Samples back from the Worker over a
//      SharedArrayBuffer ring buffer and expose them as a drainable array.
//
// Cross-origin isolation requirement
// ----------------------------------
// SharedArrayBuffer is gated behind cross-origin-isolation. On GitHub Pages
// (which can't serve COOP/COEP headers) we install coi-serviceworker.js
// alongside index.html — see .github/workflows/pages.yml.

(function () {
	'use strict';

	if (globalThis.spice3d && globalThis.spice3d.__loaded_from_bridge_js) {
		return;
	}

	const state = {
		__loaded_from_bridge_js: true,
		worker: null,
		ready: false,
		running: false,
		init_info: null,
		samples: [],
		pending_external: Object.create(null),

		// Spawn the worker, send it the wasm URL. Resolves when the worker
		// reports it has initialized ngspice. v0: stubbed — returns false
		// because the worker script is not yet implemented.
		init: function (options) {
			if (this.worker) return true;
			// TODO: spawn `new Worker('ngspice_worker.js', { type: 'module' })`
			//       once ngspice WASM is built and wired in.
			console.warn('[spice3d] ngspice worker not yet implemented; running in stub mode');
			return false;
		},

		load_netlist: function (lines) {
			if (!this.worker) {
				return false;
			}
			this.worker.postMessage({ type: 'load_netlist', lines: lines });
			return true;
		},

		start_transient: function (step, stop) {
			if (!this.worker) return false;
			this.worker.postMessage({ type: 'tran', step: step, stop: stop });
			this.running = true;
			return true;
		},

		stop: function () {
			if (this.worker) {
				this.worker.postMessage({ type: 'halt' });
			}
			this.running = false;
		},

		set_external: function (name, volts) {
			const key = String(name).toLowerCase();
			this.pending_external[key] = volts;
			if (this.worker) {
				this.worker.postMessage({ type: 'external', name: key, volts: volts });
			}
		},

		// C++ side polls this each frame.
		drain_samples: function () {
			const s = this.samples;
			this.samples = [];
			return s;
		},

		_on_worker_message: function (msg) {
			switch (msg.type) {
				case 'ready':
					this.ready = true;
					break;
				case 'init_info':
					this.init_info = msg.info;
					break;
				case 'sample':
					this.samples.push(msg.sample);
					break;
				case 'running':
					this.running = !!msg.running;
					break;
			}
		},
	};

	globalThis.spice3d = state;
})();
