(function installVerilogSynthBridge() {
	'use strict';

	if (!globalThis.spice3d || !globalThis.spice3d.installedFromBridgeScript) {
		console.error('[spice3d] verilog_synth_bridge requires ngspice_bridge.js to be loaded first');
		return;
	}
	if (globalThis.spice3d.installedVerilogSynthBridge) {
		return;
	}

	const RELATIVE_URL_OF_YOWASP_YOSYS_ESM_BUNDLE = './yowasp/gen/bundle.js';

	let lazilyImportedYowaspYosysRunnerPromise = null;
	function getLazilyImportedYowaspYosysRunnerPromise() {
		if (lazilyImportedYowaspYosysRunnerPromise === null) {
			lazilyImportedYowaspYosysRunnerPromise = import(RELATIVE_URL_OF_YOWASP_YOSYS_ESM_BUNDLE)
					.then(function pickRunYosysExportOffBundle(yowaspYosysBundleModule) {
						return yowaspYosysBundleModule.runYosys;
					});
		}
		return lazilyImportedYowaspYosysRunnerPromise;
	}

	function buildSpicePortOrderBlackboxVerilogFromStdcellSubcktSpiceText(stdcellSubcktSpiceText) {
		const blackboxModuleDeclarationLines = [];
		const subcktHeaderRegex = /^\.subckt\s+(\S+)\s+(.*)$/i;
		for (const oneLineFromStdcellSubcktSpice of stdcellSubcktSpiceText.split('\n')) {
			const matchedSubcktHeader = oneLineFromStdcellSubcktSpice.match(subcktHeaderRegex);
			if (!matchedSubcktHeader) continue;
			const stdcellName = matchedSubcktHeader[1];
			const subcktPortListInSpiceOrder = matchedSubcktHeader[2].trim().split(/\s+/);
			blackboxModuleDeclarationLines.push('(* blackbox *)');
			blackboxModuleDeclarationLines.push(
					'module ' + stdcellName + '(' + subcktPortListInSpiceOrder.join(', ') + ');');
			for (const oneSubcktPortName of subcktPortListInSpiceOrder) {
				blackboxModuleDeclarationLines.push('  inout ' + oneSubcktPortName + ';');
			}
			blackboxModuleDeclarationLines.push('endmodule', '');
		}
		return blackboxModuleDeclarationLines.join('\n');
	}

	function substituteUnconnectedRailFillerNetsInBareXLineSpiceText(bareXLineSpiceText, pdkRailNamesInSubcktOrder) {
		const unconnectedRailFillerNetRegex = /^_NC[0-9]+$/;
		const xLineFirstCharRegex = /^X/;
		const splitSpiceLines = bareXLineSpiceText.split('\n');
		for (let lineIndex = 0; lineIndex < splitSpiceLines.length; ++lineIndex) {
			if (!xLineFirstCharRegex.test(splitSpiceLines[lineIndex])) continue;
			const oneXLineFields = splitSpiceLines[lineIndex].split(/\s+/);
			let railSubstitutionCountWithinThisXLine = 0;
			for (let fieldIndex = 0; fieldIndex < oneXLineFields.length; ++fieldIndex) {
				if (!unconnectedRailFillerNetRegex.test(oneXLineFields[fieldIndex])) continue;
				oneXLineFields[fieldIndex] = pdkRailNamesInSubcktOrder[
						railSubstitutionCountWithinThisXLine % pdkRailNamesInSubcktOrder.length];
				railSubstitutionCountWithinThisXLine += 1;
			}
			splitSpiceLines[lineIndex] = oneXLineFields.join(' ');
		}
		return splitSpiceLines.join('\n');
	}

	function extractPortNamesInDeclarationOrderFromSynthesizedVerilog(synthesizedVerilogText) {
		const inputPortNamesInOrder = [];
		const outputPortNamesInOrder = [];
		const inputDeclarationRegex = /^\s*input\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/;
		const outputDeclarationRegex = /^\s*output\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/;
		for (const oneLineFromSynthesizedVerilog of synthesizedVerilogText.split('\n')) {
			const matchedInputDeclaration = oneLineFromSynthesizedVerilog.match(inputDeclarationRegex);
			if (matchedInputDeclaration) {
				inputPortNamesInOrder.push(matchedInputDeclaration[1]);
				continue;
			}
			const matchedOutputDeclaration = oneLineFromSynthesizedVerilog.match(outputDeclarationRegex);
			if (matchedOutputDeclaration) {
				outputPortNamesInOrder.push(matchedOutputDeclaration[1]);
			}
		}
		return inputPortNamesInOrder.concat(outputPortNamesInOrder);
	}

	function extractOnlyXLineRowsFromBareSpiceText(bareSpiceText) {
		const onlyXLineRows = [];
		for (const oneLine of bareSpiceText.split('\n')) {
			if (oneLine.startsWith('X')) onlyXLineRows.push(oneLine);
		}
		return onlyXLineRows.join('\n');
	}

	function wrapSynthesizedXLinesInTopLevelSubcktBlock(
			topModuleName,
			topModulePortNamesInDeclarationOrder,
			pdkRailNamesInSubcktOrder,
			railSubstitutedXLineRows) {
		const fullPortList = topModulePortNamesInDeclarationOrder.concat(pdkRailNamesInSubcktOrder);
		return [
			'* SPICE subckt synthesized from ' + topModuleName + ' by browser-side YoWASP yosys',
			'.subckt ' + topModuleName + ' ' + fullPortList.join(' '),
			railSubstitutedXLineRows,
			'.ends ' + topModuleName,
		].join('\n');
	}

	async function runOneVerilogSynthRequestAsync(
			requestId, stagedInputFiles, topModuleName, pdkRailNamesInSubcktOrder, bridgeOwningRequestStateMap) {
		try {
			const runYowaspYosys = await getLazilyImportedYowaspYosysRunnerPromise();
			const synthesizedBlackboxVerilog = buildSpicePortOrderBlackboxVerilogFromStdcellSubcktSpiceText(
					stagedInputFiles['stdcell_subckt.spice']);
			const yosysInputFilesTreeForRunYowaspYosys = {
				'blackbox.v': synthesizedBlackboxVerilog,
				'input.v': stagedInputFiles['input.v'],
				'timing.lib': stagedInputFiles['timing.lib'],
			};
			const yosysCommandScript = [
				'read_verilog -lib blackbox.v',
				'read_verilog input.v',
				'synth -top ' + topModuleName,
				'dfflibmap -liberty timing.lib',
				'abc -liberty timing.lib',
				'opt_clean',
				'write_verilog -noattr synth.v',
				'write_spice synth.sp',
			].join('; ');
			let capturedYosysStdout = '';
			let capturedYosysStderr = '';
			const yosysOutputFilesTree = await runYowaspYosys(
					['-p', yosysCommandScript],
					yosysInputFilesTreeForRunYowaspYosys,
					{
						decodeASCII: true,
						stdout: function appendYosysStdoutChunk(oneStdoutChunk) {
							if (oneStdoutChunk !== null) capturedYosysStdout += oneStdoutChunk;
						},
						stderr: function appendYosysStderrChunk(oneStderrChunk) {
							if (oneStderrChunk !== null) capturedYosysStderr += oneStderrChunk;
						},
					});
			const bareSpiceTextFromYosys = String(yosysOutputFilesTree['synth.sp'] || '');
			const synthesizedVerilogTextFromYosys = String(yosysOutputFilesTree['synth.v'] || '');
			const railSubstitutedBareSpice = substituteUnconnectedRailFillerNetsInBareXLineSpiceText(
					bareSpiceTextFromYosys, pdkRailNamesInSubcktOrder);
			const railSubstitutedXLineRowsOnly = extractOnlyXLineRowsFromBareSpiceText(railSubstitutedBareSpice);
			const topModulePortNamesInDeclarationOrder = extractPortNamesInDeclarationOrderFromSynthesizedVerilog(
					synthesizedVerilogTextFromYosys);
			const wrappedTopLevelSubcktSpiceText = wrapSynthesizedXLinesInTopLevelSubcktBlock(
					topModuleName,
					topModulePortNamesInDeclarationOrder,
					pdkRailNamesInSubcktOrder,
					railSubstitutedXLineRowsOnly);
			bridgeOwningRequestStateMap.verilogSynthRequestStateByRequestId[requestId] = {
				isComplete: true,
				synthesizedSpiceText: wrappedTopLevelSubcktSpiceText,
				yosysStdoutForDiagnostics: capturedYosysStdout,
				yosysStderrForDiagnostics: capturedYosysStderr,
			};
		} catch (verilogSynthFailureReason) {
			bridgeOwningRequestStateMap.verilogSynthRequestStateByRequestId[requestId] = {
				isComplete: true,
				errorMessage: String(verilogSynthFailureReason && verilogSynthFailureReason.message
						|| verilogSynthFailureReason),
			};
		}
	}

	globalThis.spice3d.installedVerilogSynthBridge = true;
	globalThis.spice3d.verilogSynthRequestStateByRequestId = Object.create(null);
	globalThis.spice3d.verilogSynthStagedInputFilesByVirtualName = Object.create(null);

	globalThis.spice3d.stageOneInputFileForNextVerilogSynth = function stageOneInputFileForNextVerilogSynth(
			virtualInputFileName, inputFileText) {
		this.verilogSynthStagedInputFilesByVirtualName[String(virtualInputFileName)] = String(inputFileText);
	};

	globalThis.spice3d.beginVerilogSynthRequestUsingPreviouslyStagedInputs = function beginVerilogSynthRequestUsingPreviouslyStagedInputs(
			requestId, topModuleName, pdkRailNamesInSubcktOrderJsonArray) {
		const stagedInputFilesForThisRequest = this.verilogSynthStagedInputFilesByVirtualName;
		this.verilogSynthStagedInputFilesByVirtualName = Object.create(null);
		const pdkRailNamesInSubcktOrder = JSON.parse(String(pdkRailNamesInSubcktOrderJsonArray));
		this.verilogSynthRequestStateByRequestId[String(requestId)] = { isComplete: false };
		runOneVerilogSynthRequestAsync(
				String(requestId),
				stagedInputFilesForThisRequest,
				String(topModuleName),
				pdkRailNamesInSubcktOrder,
				this);
	};

	globalThis.spice3d.takeVerilogSynthResultAsJsonStatusEnvelope = function takeVerilogSynthResultAsJsonStatusEnvelope(requestId) {
		const requestState = this.verilogSynthRequestStateByRequestId[String(requestId)];
		if (!requestState) {
			return JSON.stringify({ status: 'unknown_request_id' });
		}
		if (!requestState.isComplete) {
			return JSON.stringify({ status: 'pending' });
		}
		delete this.verilogSynthRequestStateByRequestId[String(requestId)];
		if (requestState.errorMessage) {
			return JSON.stringify({
				status: 'error',
				errorMessage: requestState.errorMessage,
			});
		}
		return JSON.stringify({
			status: 'done',
			synthesizedSpiceText: requestState.synthesizedSpiceText,
			yosysStdoutForDiagnostics: requestState.yosysStdoutForDiagnostics,
			yosysStderrForDiagnostics: requestState.yosysStderrForDiagnostics,
		});
	};
})();
