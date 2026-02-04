'use strict';

const { ipcRenderer, webUtils } = require("electron");
const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const helper = require('../libs/electron_helper/helper_new.js');
const tools = helper.tools;
const app = helper.app;
const os = require('node:os');
const registry = require('../js/registry.js');
const shortcuts = require('../js/shortcuts.js');
const RubberbandPipeline = require('./rubberband-pipeline.js');
const waveformAnalyzer = require('./waveform_analyzer.js');

let player;
let midi;
let g = {};
g.test = {};
g.audioContext = null;
g.rubberbandContext = null;
g.rubberbandPlayer = null;
g.ffmpegPlayer = null;
g.activePipeline = 'normal';
g.parametersOpen = false;
g.windows = { help: null, settings: null, playlist: null, mixer: null, pitchtime: null, 'midi': null, parameters: null, monitoring: null };
g.windowsVisible = { help: false, settings: false, playlist: false, mixer: false, pitchtime: false, 'midi': false, parameters: false, monitoring: false };
g.windowsClosing = { help: false, settings: false, playlist: false, mixer: false, pitchtime: false, 'midi': false, parameters: false, monitoring: false };
g.monitoringReady = false;
g.monitoringLoop = null;
g.monitoringAnalyserL = null;
g.monitoringAnalyserR = null;
g.monitoringSplitter = null;
g.monitoringAnalyserL_RB = null;
g.monitoringAnalyserR_RB = null;
g.monitoringSplitter_RB = null;
g.lastNavTime = 0;
g.mixerPlaying = false;
g.music = [];
g.idx = 0;
g.max = -1;

g.midiSettings = { pitch: 0, speed: null };
g.audioParams = {
	mode: 'tape',      // 'tape' or 'pitchtime'
	tapeSpeed: 0,      // -12 to +12 semitones
	pitch: 0,          // -12 to +12 semitones (for rubberband)
	tempo: 1.0,        // 0.5 to 1.5 ratio (for rubberband)
	formant: false,    // formant preservation
	locked: false      // lock settings across track changes
};

// Init
// ###########################################################################

async function detectMaxSampleRate() {
	const rates = [192000, 176400, 96000, 88200, 48000, 44100];
	for (let i = 0; i < rates.length; i++) {
		const ctx = new AudioContext({ sampleRate: rates[i] });
		console.log('Testing rate:', rates[i], '-> Got:', ctx.sampleRate);
		if (ctx.sampleRate === rates[i]) {
			await ctx.close();
			console.log('Max rate detected:', rates[i]);
			return rates[i];
		}
		await ctx.close();
	}
	console.log('Fallback to 48000');
	return 48000;
}

init();
async function init() {
	fb('Init Stage')
	g.win = helper.window;
	g.main_env = await helper.global.get('main_env');
	g.basePath = await helper.global.get('base_path');
	g.isPackaged = await helper.global.get('isPackaged');
	g.cache_path = await helper.global.get('temp_path');
	g.start_vars = await helper.global.get('start_vars');
	g.app_path = await helper.app.getAppPath();

	g.configName = g.main_env.configName || 'user';
	g.config_obj = await helper.config.initRenderer(g.configName, async (newData) => {
		const oldConfig = g.config || {};
		const oldBuffer = (oldConfig && oldConfig.ffmpeg && oldConfig.ffmpeg.stream) ? oldConfig.ffmpeg.stream.prebufferChunks : undefined;
		const oldThreads = (oldConfig && oldConfig.ffmpeg && oldConfig.ffmpeg.decoder) ? oldConfig.ffmpeg.decoder.threads : undefined;
		g.config = newData || {};

		const oldTheme = (oldConfig && oldConfig.ui) ? oldConfig.ui.theme : undefined;
		const theme = (g.config && g.config.ui) ? g.config.ui.theme : 'dark';
		const oldDeviceId = (oldConfig && oldConfig.audio && oldConfig.audio.output) ? oldConfig.audio.output.deviceId : undefined;
		const deviceId = (g.config && g.config.audio && g.config.audio.output) ? g.config.audio.output.deviceId : '';
		const oldHq = !!(oldConfig && oldConfig.audio ? oldConfig.audio.hqMode : false);
		const hq = !!(g.config && g.config.audio ? g.config.audio.hqMode : false);
		const oldStereoSep = (oldConfig && oldConfig.tracker) ? oldConfig.tracker.stereoSeparation : undefined;
		const stereoSep = (g.config && g.config.tracker) ? g.config.tracker.stereoSeparation : undefined;

		if (oldTheme !== theme) {
			if (theme === 'dark') {
				document.body.classList.add('dark');
			}
			else {
				document.body.classList.remove('dark');
			}
			tools.sendToMain('command', { command: 'set-theme', theme: theme });
		}

		if (oldDeviceId !== deviceId) {
			const contexts = [g.audioContext, g.rubberbandContext].filter(ctx => ctx && typeof ctx.setSinkId === 'function');
			for (const ctx of contexts) {
				try {
					if (deviceId) {
						await ctx.setSinkId(deviceId);
					}
					else {
						await ctx.setSinkId('');
					}
				}
				catch (err) {
					console.error('Failed to change output device for context:', err);
				}
			}
			console.log(deviceId ? `Output device changed to: ${deviceId}` : 'Output device reset to system default');
		}

		if (oldHq !== hq) {
			await toggleHQMode(hq, true);
			if (g.windows.settings) {
				tools.sendToId(g.windows.settings, 'sample-rate-updated', { currentSampleRate: g.audioContext?.sampleRate });
			}
			if (g.windows.mixer) {
				tools.sendToId(g.windows.mixer, 'sample-rate-updated', { currentSampleRate: g.audioContext?.sampleRate, maxSampleRate: g.maxSampleRate });
			}
		}

		if (oldStereoSep !== stereoSep) {
			if (player && g.currentAudio?.isMod) {
				player.setStereoSeparation(stereoSep);
			}
		}

		const oldShowControls = (oldConfig && oldConfig.ui) ? !!oldConfig.ui.showControls : false;
		const showControls = (g.config && g.config.ui) ? !!g.config.ui.showControls : false;
		if (oldShowControls !== showControls) {
			applyShowControls(showControls, true);
		}

		const newBuffer = (g.config && g.config.ffmpeg && g.config.ffmpeg.stream) ? g.config.ffmpeg.stream.prebufferChunks : undefined;
		const newThreads = (g.config && g.config.ffmpeg && g.config.ffmpeg.decoder) ? g.config.ffmpeg.decoder.threads : undefined;
		if (g.ffmpegPlayer && (oldBuffer !== newBuffer || oldThreads !== newThreads)) {
			if (g.currentAudio && g.currentAudio.isFFmpeg) {
				console.log('Streaming settings changed, resetting player...');
				const pos = g.ffmpegPlayer.getCurrentTime();
				const wasPlaying = g.ffmpegPlayer.isPlaying;

				g.ffmpegPlayer.prebufferSize = (newBuffer !== undefined) ? (newBuffer | 0) : 10;
				g.ffmpegPlayer.threadCount = (newThreads !== undefined) ? (newThreads | 0) : 0;

				try {
					await g.ffmpegPlayer.open(g.currentAudio.fp);
					if (pos > 0) g.ffmpegPlayer.seek(pos);
					if (wasPlaying) await g.ffmpegPlayer.play();
				} catch (err) {
					console.error('Failed to reset player after config change:', err);
				}
			} else {
				g.ffmpegPlayer.prebufferSize = (newBuffer !== undefined) ? (newBuffer | 0) : 10;
				g.ffmpegPlayer.threadCount = (newThreads !== undefined) ? (newThreads | 0) : 0;
			}
		}
	});
	g.config = g.config_obj.get();
	let saveCnf = false;
	if (!g.config || typeof g.config !== 'object') g.config = {};
	if (!g.config.windows) g.config.windows = {};
	if (!g.config.windows.main) g.config.windows.main = {};
	let s = (g.config.windows.main.scale !== undefined) ? (g.config.windows.main.scale | 0) : 14;
	if (s < 14) { s = 14; saveCnf = true; }
	if ((g.config.windows.main.scale | 0) !== s) { g.config.windows.main.scale = s; saveCnf = true; }
	if (saveCnf) { g.config_obj.set(g.config); }

	const theme0 = (g.config && g.config.ui) ? g.config.ui.theme : 'dark';
	if (theme0 === 'dark') {
		document.body.classList.add('dark');
	} else {
		document.body.classList.remove('dark');
	}
	tools.sendToMain('command', { command: 'set-theme', theme: theme0 });

	const showControls0 = (g.config && g.config.ui && g.config.ui.showControls) ? true : false;
	applyShowControls(showControls0);

	ut.setCssVar('--space-base', s);

	let b = (g.config.windows && g.config.windows.main && g.config.windows.main.width && g.config.windows.main.height) ? g.config.windows.main : null;
	if (b) {
		const { MIN_WIDTH, MIN_HEIGHT_WITH_CONTROLS, MIN_HEIGHT_WITHOUT_CONTROLS } = require('./config-defaults.js').WINDOW_DIMENSIONS;
		const baseMinH = showControls0 ? MIN_HEIGHT_WITH_CONTROLS : MIN_HEIGHT_WITHOUT_CONTROLS;
		const scale0 = _getMainScale();
		const minW = _scaledDim(MIN_WIDTH, scale0);
		const minH = _scaledDim(baseMinH, scale0);
		const nb = { width: b.width | 0, height: b.height | 0 };
		if (b.x !== undefined && b.x !== null) nb.x = b.x | 0;
		if (b.y !== undefined && b.y !== null) nb.y = b.y | 0;
		if (nb.width < minW) nb.width = minW;
		if (nb.height < minH) nb.height = minH;
		await g.win.setBounds(nb);
		g.config.windows.main = { ...g.config.windows.main, x: nb.x, y: nb.y, width: nb.width, height: nb.height, scale: s | 0 };
	}
	await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
	g.win.show();
	if (!g.isPackaged) { g.win.toggleDevTools() }

	let fp = g.app_path;
	if (g.isPackaged) { fp = path.dirname(fp); }

	if (os.platform() == 'linux') {
		g.ffmpeg_napi_path = path.resolve(fp + '/bin/linux_bin/ffmpeg_napi.node');
		g.ffmpeg_player_path = path.resolve(fp + '/bin/linux_bin/player-sab.js');
		g.ffmpeg_worklet_path = path.resolve(fp + '/bin/linux_bin/ffmpeg-worklet-sab.js');
		g.ffmpeg_player_pm_path = path.resolve(fp + '/bin/linux_bin/player-pm.js');
		g.ffmpeg_worklet_pm_path = path.resolve(fp + '/bin/linux_bin/ffmpeg-worklet-pm.js');
		g.ffmpeg_player_sab_path = path.resolve(fp + '/bin/linux_bin/player-sab.js');
		g.ffmpeg_worklet_sab_path = path.resolve(fp + '/bin/linux_bin/ffmpeg-worklet-sab.js');
		g.rubberband_worklet_path = path.resolve(fp + '/bin/linux_bin/realtime-pitch-shift-processor.js');
	}
	else {
		g.ffmpeg_napi_path = path.resolve(fp + '/bin/win_bin/ffmpeg_napi.node');
		g.ffmpeg_player_path = path.resolve(fp + '/bin/win_bin/player-sab.js');
		g.ffmpeg_worklet_path = path.resolve(fp + '/bin/win_bin/ffmpeg-worklet-sab.js');
		g.ffmpeg_player_pm_path = path.resolve(fp + '/bin/win_bin/player-pm.js');
		g.ffmpeg_worklet_pm_path = path.resolve(fp + '/bin/win_bin/ffmpeg-worklet-pm.js');
		g.ffmpeg_player_sab_path = path.resolve(fp + '/bin/win_bin/player-sab.js');
		g.ffmpeg_worklet_sab_path = path.resolve(fp + '/bin/win_bin/ffmpeg-worklet-sab.js');
		g.rubberband_worklet_path = path.resolve(fp + '/bin/win_bin/realtime-pitch-shift-processor.js');
	}

	g.maxSampleRate = await detectMaxSampleRate();
	console.log('Max supported sample rate:', g.maxSampleRate);

	// Contexts will be initialized or re-applied via toggleHQMode or lazy init
	// We ensure it exists here if not already done by config handler
	if (!g.audioContext || g.audioContext.state === 'closed') {
		const targetRate = (g.config && g.config.audio && g.config.audio.hqMode) ? g.maxSampleRate : 48000;
		g.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: targetRate });
		console.log('Normal pipeline AudioContext initialized:', g.audioContext.sampleRate, 'Hz');
	}

	if (!g.rubberbandContext || g.rubberbandContext.state === 'closed') {
		g.rubberbandContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
		console.log('Rubberband pipeline AudioContext initialized (48kHz)');
	}

	const outDevId = (g.config && g.config.audio && g.config.audio.output) ? g.config.audio.output.deviceId : '';
	if (outDevId) {
		try {
			await g.audioContext.setSinkId(outDevId);
			await g.rubberbandContext.setSinkId(outDevId);
			console.log('Output device set to:', outDevId);
		} catch (err) {
			console.error('Failed to set output device, using system default:', err);
			if (g.config && g.config.audio && g.config.audio.output) g.config.audio.output.deviceId = '';
			g.config_obj.set(g.config);
		}
	}

	const { FFmpegDecoder, getMetadata } = require(g.ffmpeg_napi_path);
	g.getMetadata = getMetadata;
	g.FFmpegDecoder = FFmpegDecoder;

	const { FFmpegStreamPlayerSAB } = require(g.ffmpeg_player_path);
	FFmpegStreamPlayerSAB.setDecoder(FFmpegDecoder);
	const threadCount = (g.config && g.config.ffmpeg && g.config.ffmpeg.decoder && g.config.ffmpeg.decoder.threads !== undefined) ? (g.config.ffmpeg.decoder.threads | 0) : 0;

	if (!g.ffmpegPlayer) {
		g.ffmpegPlayer = new FFmpegStreamPlayerSAB(g.audioContext, g.ffmpeg_worklet_path, 'ffmpeg-stream-sab', 2, threadCount, false);
		try { g.ffmpegPlayer.reuseWorkletNode = true; } catch (e) { }
		try {
			await g.ffmpegPlayer.init();

			// Setup monitoring tap
			initMonitoring();

			// Connect FFmpeg player to both destination and monitoring tap
			g.ffmpegPlayer.gainNode.connect(g.audioContext.destination);
			if (g.monitoringSplitter) {
				g.ffmpegPlayer.gainNode.connect(g.monitoringSplitter);
			}
		} catch (err) {
			console.error('Failed to initialize FFmpeg player:', err);
		}
	}

	if (!g.rubberbandPlayer) {
		g.rubberbandPlayer = new RubberbandPipeline(g.rubberbandContext, g.FFmpegDecoder, g.ffmpeg_player_path, g.ffmpeg_worklet_path, g.rubberband_worklet_path, threadCount);
		try {
			await g.rubberbandPlayer.init();
			console.log('Rubberband pipeline initialized (48kHz)');

			g.rubberbandPlayer.connect(g.rubberbandContext.destination);
			if (g.monitoringSplitter_RB) {
				g.rubberbandPlayer.connect(g.monitoringSplitter_RB);
			}
		} catch (err) {
			console.error('Failed to initialize Rubberband player:', err);
			g.rubberbandPlayer = null;
		}
	}

	// Initialize MIDI player BEFORE tracker player callbacks
	// (appStart() may be triggered by onInitialized before this function returns)
	await initMidiPlayer();

	if (!player) {
		const modConfig = {
			repeatCount: 0,
			stereoSeparation: (g.config && g.config.tracker && g.config.tracker.stereoSeparation !== undefined) ? (g.config.tracker.stereoSeparation | 0) : 100,
			context: g.audioContext
		};
		player = new window.chiptune(modConfig);
		player.onMetadata(async (meta) => {
			if (g.currentAudio) {
				g.currentAudio.duration = player.duration;
				g.playremain.innerText = ut.playTime(g.currentAudio.duration * 1000).minsec;
				await renderInfo(g.currentAudio.fp, meta);
			}
			g.blocky = false;
		});
		player.onProgress((e) => {
			if (g.currentAudio) {
				g.currentAudio.currentTime = e.pos || 0;
			}
			// Forward VU data to Parameters window
			if (e.vu && g.windows.parameters) {
				tools.sendToId(g.windows.parameters, 'tracker-vu', { vu: e.vu, channels: e.vu.length });
			}
		});
		player.onEnded(audioEnded);
		player.onError((err) => { console.log(err); audioEnded(); g.blocky = false; });
		player.onInitialized(() => {
			console.log('Player Initialized');
			// player.gain.connect(g.audioContext.destination); // Old direct connection
			player.gain.connect(g.audioContext.destination);
			if (g.monitoringSplitter) {
				player.gain.connect(g.monitoringSplitter);
			}
			g.blocky = false;
			appStart();
		});
	} else {
		// Already initialized (likely by toggleHQMode), but we still need to trigger appStart
		appStart();
	}

	ipcRenderer.on('main', async (e, data) => {
		if (data.length == 1) {
			await playListFromSingle(data[0], false);
		}
		else {
			await playListFromMulti(data, false, false);
		}
		playAudio(g.music[g.idx], 0, false);
		g.win.focus();
	})
	console.log(g.main_env)
	ipcRenderer.on('log', (e, data) => {
		console.log('%c' + data.context, 'color:#6058d6', data.data);
	});

	ipcRenderer.on('window-closed', (e, data) => {
		if (g.windows[data.type] === data.windowId) {
			g.windows[data.type] = null;
			g.windowsVisible[data.type] = false;

			if (data.type === 'monitoring') {
				g.monitoringReady = false;
			}

			if (data.type === 'midi') {
				g.midiSettings = { pitch: 0, speed: null };
				if (midi) {
					if (midi.setPitchOffset) midi.setPitchOffset(0);
					if (midi.resetPlaybackSpeed) midi.resetPlaybackSpeed();
					if (midi.setMetronome) midi.setMetronome(false);
				}
			}


		}
		if (g.windowsClosing && g.windowsClosing[data.type] !== undefined) g.windowsClosing[data.type] = false;
		setTimeout(() => g.win.focus(), 50);
	});

	ipcRenderer.on('window-hidden', async (e, data) => {
		g.windowsVisible[data.type] = false;
		if (g.windowsClosing && g.windowsClosing[data.type] !== undefined) g.windowsClosing[data.type] = false;

		if (data.type === 'monitoring') {
			g.monitoringReady = false;
		}

		if (data.type === 'midi') {
			g.midiSettings = { pitch: 0, speed: null };
			if (midi) {
				if (midi.setPitchOffset) midi.setPitchOffset(0);
				if (midi.resetPlaybackSpeed) midi.resetPlaybackSpeed();
				if (midi.setMetronome) midi.setMetronome(false);
			}
		}

		if (data.type === 'parameters') {
			g.parametersOpen = false;

			// Reset audio params to defaults
			const wasTapeMode = g.audioParams.mode === 'tape';
			const hadTapeSpeed = g.audioParams.tapeSpeed !== 0;

			g.audioParams.mode = 'tape';
			g.audioParams.tapeSpeed = 0;
			g.audioParams.pitch = 0;
			g.audioParams.tempo = 1.0;
			g.audioParams.formant = false;
			g.audioParams.locked = false; // Reset lock state

			// Reset tape speed on current player if it was applied
			if (hadTapeSpeed) {
				if (g.currentAudio?.isFFmpeg && g.currentAudio.player) {
					g.currentAudio.player.setPlaybackRate(0);
				}
				if (g.currentAudio?.isMod && player) {
					player.setTempo(1.0);
				}
			}

			if (g.currentAudio && g.currentAudio.isFFmpeg && g.activePipeline === 'rubberband') {
				try {
					g.rubberbandPlayer.reset();
					g.rubberbandPlayer.disconnect();
					await switchPipeline('normal');
				} catch (err) {
					console.error('Failed to switch to normal pipeline:', err);
				}
			} else if (g.rubberbandPlayer) {
				g.rubberbandPlayer.reset();
			}

			if (g.midiSettings) {
				g.midiSettings.pitch = 0;
				g.midiSettings.speed = 1.0;
				g.midiSettings.metronome = false;

				if (midi && g.currentAudio && g.currentAudio.isMidi) {
					if (midi.setTranspose) midi.setTranspose(0);
					if (midi.setBPM) {
						const orig = midi.getOriginalBPM ? midi.getOriginalBPM() : 120;
						midi.setBPM(orig);
					}
					if (midi.setMetronome) midi.setMetronome(false);
				}
			}
		}

		g.win.focus();
	});

	ipcRenderer.on('browse-directory', async (e, data) => {
		const result = await helper.dialog.showOpenDialog({
			properties: ['openDirectory']
		});
		if (!result.canceled && result.filePaths.length > 0) {
			if (g.windows.settings) {
				tools.sendToId(g.windows.settings, 'directory-selected', result.filePaths[0]);
			}
		}
	});

	ipcRenderer.on('register-file-types', async (e, data) => {
		try {
			const registry = require('./registry.js');
			const path = require('path');
			let exe_path = process.execPath;
			if (g.isPackaged) {
				exe_path = path.resolve(path.dirname(exe_path), '..', path.basename(exe_path));
			}
			await registry('register', exe_path, g.app_path);
			if (g.windows.settings) {
				tools.sendToId(g.windows.settings, 'registry-action-complete', { success: true });
			}
		} catch (err) {
			console.error('Failed to register file types:', err);
			if (g.windows.settings) {
				tools.sendToId(g.windows.settings, 'registry-action-complete', { success: false, error: err.message });
			}
		}
	});

	ipcRenderer.on('unregister-file-types', async (e, data) => {
		try {
			const registry = require('./registry.js');
			const path = require('path');
			let exe_path = process.execPath;
			if (g.isPackaged) {
				exe_path = path.resolve(path.dirname(exe_path), '..', path.basename(exe_path));
			}
			await registry('unregister', exe_path, g.app_path);
			if (g.windows.settings) {
				tools.sendToId(g.windows.settings, 'registry-action-complete', { success: true });
			}
		} catch (err) {
			console.error('Failed to unregister file types:', err);
			if (g.windows.settings) {
				tools.sendToId(g.windows.settings, 'registry-action-complete', { success: false, error: err.message });
			}
		}
	});

	ipcRenderer.on('open-default-programs', (e, data) => {
		const { openDefaultProgramsUI } = require('./registry.js');
		openDefaultProgramsUI();
	});

	ipcRenderer.on('shortcut', (e, data) => {
		if (data.action === 'toggle-help') {
			openWindow('help');
		}
		else if (data.action === 'toggle-settings') {
			openWindow('settings');
		}
		else if (data.action === 'toggle-mixer') {
			const fp = (g.currentAudio && g.currentAudio.fp) ? g.currentAudio.fp : ((g.music && g.music[g.idx]) ? g.music[g.idx] : null);
			if (g.currentAudio && !g.currentAudio.paused) {
				g.currentAudio.pause();
				checkState();
			}
			openWindow('mixer', false, fp);
		}
		else if (data.action === 'toggle-pitchtime') {
			openWindow('parameters');
		}
		else if (data.action === 'toggle-monitoring') {
			openWindow('monitoring');
		}
		else if (data.action === 'toggle-theme') {
			tools.sendToMain('command', { command: 'toggle-theme' });
		}
	});

	ipcRenderer.on('stage-keydown', (e, data) => {
		if (!data) return;
		const ev = {
			keyCode: data.keyCode | 0,
			ctrlKey: !!data.ctrlKey,
			shiftKey: !!data.shiftKey,
			altKey: !!data.altKey,
			metaKey: !!data.metaKey,
			code: data.code || '',
			key: data.key || '',
			preventDefault: () => { },
			stopPropagation: () => { }
		};
		onKey(ev);
	});

	ipcRenderer.on('theme-changed', (e, data) => {
		if (data.dark) {
			document.body.classList.add('dark');
		} else {
			document.body.classList.remove('dark');
		}
		if (!g.config.ui) g.config.ui = {};
		g.config.ui.theme = data.dark ? 'dark' : 'light';
		g.config_obj.set(g.config);

	});

	ipcRenderer.on('open-soundfonts-folder', async () => {
		const userDataPath = await helper.app.getPath('userData');
		const userSoundfontsPath = path.join(userDataPath, 'soundfonts');
		try {
			await fs.mkdir(userSoundfontsPath, { recursive: true });
			await helper.shell.openPath(userSoundfontsPath);
		} catch (err) {
			console.error('[MIDI] Failed to open soundfonts folder:', err);
		}
	});

	ipcRenderer.on('midi-soundfont-changed', async (e, soundfontFile) => {
		const wasPlaying = g.currentAudio && !g.currentAudio.paused;
		const currentFile = g.currentAudio ? g.currentAudio.fp : null;
		const currentTime = g.currentAudio ? g.currentAudio.getCurrentTime() : 0;
		const currentLoop = g.isLoop;
		const isMIDI = currentFile && g.supportedMIDI && g.supportedMIDI.includes(path.extname(currentFile).toLowerCase());

		if (midi) {
			midi.dispose();
			midi = null;
		}

		await initMidiPlayer();

		if (isMIDI && currentFile) {
			try {
				await playAudio(currentFile, currentTime, !wasPlaying);

				await new Promise(resolve => setTimeout(resolve, 100));

				if (g.currentAudio && wasPlaying) {
					g.currentAudio.play();
				}

				checkState();
			} catch (err) {
				console.error('Failed to reload MIDI file after soundfont change:', err);
			}
		}
	});

	ipcRenderer.on('midi-metronome-toggle', (e, enabled) => {
		if (!g.midiSettings) g.midiSettings = {};
		g.midiSettings.metronome = enabled;
		if (midi && midi.setMetronome) {
			midi.setMetronome(enabled);
		}
	});

	ipcRenderer.on('midi-pitch-changed', (e, val) => {
		if (!g.midiSettings) g.midiSettings = {};
		g.midiSettings.pitch = val;
		if (midi && midi.setPitchOffset) {
			midi.setPitchOffset(val);
		}
	});

	ipcRenderer.on('midi-speed-changed', (e, val) => {
		if (!g.midiSettings) g.midiSettings = {};
		g.midiSettings.speed = val;
		if (midi && midi.setPlaybackSpeed) {
			midi.setPlaybackSpeed(val);
		}
	});

	ipcRenderer.on('midi-reset-params', () => {
		if (!g.midiSettings) g.midiSettings = {};
		g.midiSettings.pitch = 0;
		g.midiSettings.speed = null;
		g.midiSettings.metronome = false;

		if (midi) {
			if (midi.setPitchOffset) midi.setPitchOffset(0);
			if (midi.resetPlaybackSpeed) midi.resetPlaybackSpeed();
			else if (midi.setPlaybackSpeed) midi.setPlaybackSpeed(1.0);
			if (midi.setMetronome) midi.setMetronome(false);
		}
	});

	ipcRenderer.on('tracker-reset-params', () => {
		g.trackerParams = { pitch: 1.0, tempo: 1.0, stereoSeparation: 100 };

		if (player && player.setPitch) player.setPitch(1.0);
		if (player && player.setTempo) player.setTempo(1.0);
		if (player && player.setStereoSeparation) player.setStereoSeparation(100);
	});

	ipcRenderer.on('param-change', async (e, data) => {
		if (data.mode === 'midi') {
			if (!g.midiSettings) g.midiSettings = { pitch: 0, speed: null, metronome: false };

			if (data.param === 'transpose') {
				g.midiSettings.pitch = data.value;
				if (midi && midi.setPitchOffset) midi.setPitchOffset(data.value);
			}
			else if (data.param === 'bpm') {
				const orig = (midi && midi.getOriginalBPM) ? midi.getOriginalBPM() : 120;
				const safeOrig = orig > 0 ? orig : 120;
				const ratio = data.value / safeOrig;
				g.midiSettings.speed = ratio;
				if (midi && midi.setPlaybackSpeed) midi.setPlaybackSpeed(ratio);
			}
			else if (data.param === 'metronome') {
				g.midiSettings.metronome = !!data.value;
				if (midi && midi.setMetronome) midi.setMetronome(!!data.value);
			}
			else if (data.param === 'soundfont') {
				console.log('[MIDI] Soundfont change requested:', data.value);
				console.log('[MIDI] Current soundfont:', g.config?.midiSoundfont);
				console.log('[MIDI] midi player exists:', !!midi);
				console.log('[MIDI] midi.setSoundFont exists:', !!(midi && midi.setSoundFont));
				if (g.config && g.config.midiSoundfont !== data.value) {
					if (g.config_obj) {
						let c = g.config_obj.get();
						c.midiSoundfont = data.value;
						g.config_obj.set(c);
						g.config = c;
					}
					if (midi && midi.setSoundFont) {
						let fp = g.app_path;
						if (g.isPackaged) { fp = path.dirname(fp); }
						const userDataPath = await helper.app.getPath('userData');
						const userDir = path.join(userDataPath, 'soundfonts');
						const userPath = path.join(userDir, data.value);
						const bundledPath = path.resolve(fp + '/bin/soundfonts/' + data.value);
						let soundfontPath = bundledPath;
						try {
							await fs.access(userPath);
							soundfontPath = userPath;
						} catch (e) {
							// Use bundled path
						}
						const soundfontUrl = 'file:///' + soundfontPath.replace(/\\/g, '/');
						console.log('[MIDI] Calling midi.setSoundFont with URL:', soundfontUrl);
						midi.setSoundFont(soundfontUrl);
					}
				} else {
					console.log('[MIDI] Soundfont not changed - already set to:', data.value);
				}
			}
		}
		else if (data.mode === 'audio') {
			console.log('[Stage] param-change audio:', data.param, '=', data.value);
			if (data.param === 'audioMode') {
				const newMode = data.value; // 'tape' or 'pitchtime'
				const oldMode = g.audioParams.mode;
				console.log('[Stage] audioMode change:', oldMode, '→', newMode);
				g.audioParams.mode = newMode;

				// Switch pipeline based on mode
				if (newMode === 'pitchtime' && g.activePipeline !== 'rubberband') {
					console.log('[Stage] Switching to rubberband pipeline');
					await switchPipeline('rubberband');
				} else if (newMode === 'tape' && g.activePipeline === 'rubberband') {
					console.log('[Stage] Switching to normal pipeline');
					await switchPipeline('normal');
				}
			}
			else if (data.param === 'tapeSpeed') {
				console.log('[Stage] tapeSpeed:', data.value, 'currentAudio:', g.currentAudio?.isFFmpeg, g.currentAudio?.isMod);
				g.audioParams.tapeSpeed = data.value;
				applyTapeSpeed(data.value);
			}
			else if (data.param === 'locked') {
				g.audioParams.locked = !!data.value;
			}
			else if (data.param === 'pipeline') {
				switchPipeline(data.value);
			}
			else if (data.param === 'pitch') {
				g.audioParams.pitch = data.value;
				if (g.activePipeline === 'rubberband' && g.rubberbandPlayer) {
					const ratio = Math.pow(2, data.value / 12.0);
					if (typeof g.rubberbandPlayer.setPitch === 'function') {
						g.rubberbandPlayer.setPitch(ratio);
					}
				}
			}
			else if (data.param === 'tempo') {
				g.audioParams.tempo = data.value;
				if (g.activePipeline === 'rubberband' && g.rubberbandPlayer) {
					if (typeof g.rubberbandPlayer.setTempo === 'function') {
						g.rubberbandPlayer.setTempo(data.value);
					}
				}
			}
			else if (data.param === 'formant') {
				g.audioParams.formant = !!data.value;
				if (g.activePipeline === 'rubberband' && g.rubberbandPlayer) {
					// Options changes: use fade + stabilization pattern
					// (rubberband internally recreates kernel, which needs settling time)
					if (g.rubberbandPlayer.isPlaying && typeof g.rubberbandPlayer.fadeOut === 'function') {
						try {
							await g.rubberbandPlayer.fadeOut();

							if (typeof g.rubberbandPlayer.setOptions === 'function') {
								g.rubberbandPlayer.setOptions({ formantPreserved: !!data.value });
							}

							// 300ms stabilization for kernel recreation
							await new Promise(resolve => setTimeout(resolve, 300));

							await g.rubberbandPlayer.fadeIn();
							console.log('[Stage] Formant option changed with fade+stabilization');
						} catch (err) {
							console.error('[Stage] Error during formant change:', err);
						}
					} else {
						// Not playing - just apply option directly
						if (typeof g.rubberbandPlayer.setOptions === 'function') {
							g.rubberbandPlayer.setOptions({ formantPreserved: !!data.value });
						}
					}
				}
			}
		}
		else if (data.mode === 'tracker') {
			if (!g.trackerParams) g.trackerParams = { pitch: 1.0, tempo: 1.0, stereoSeparation: 100 };

			if (data.param === 'pitch') {
				g.trackerParams.pitch = data.value;
				if (player && player.setPitch) player.setPitch(data.value);
			}
			else if (data.param === 'tempo') {
				g.trackerParams.tempo = data.value;
				if (player && player.setTempo) player.setTempo(data.value);
			}
			else if (data.param === 'stereoSeparation') {
				g.trackerParams.stereoSeparation = data.value;
				if (player && player.setStereoSeparation) player.setStereoSeparation(data.value);
			}
			else if (data.param === 'channelMute') {
				if (player && player.setChannelMute) player.setChannelMute(data.value.channel, data.value.mute);
			}
		}
	});

	ipcRenderer.on('get-available-soundfonts', async (e, data) => {
		let fp = g.app_path;
		if (g.isPackaged) { fp = path.dirname(fp); }
		const bundledDir = path.resolve(fp + '/bin/soundfonts/');
		const userDataPath = await helper.app.getPath('userData');
		const userDir = path.join(userDataPath, 'soundfonts');

		const availableFonts = [];

		// Scan bundled soundfonts
		try {
			const files = await fs.readdir(bundledDir);
			const soundfontFiles = files.filter(f => f.endsWith('.sf2') || f.endsWith('.sf3'));
			for (const filename of soundfontFiles) {
				let label = filename.replace(/\.(sf2|sf3)$/i, '');
				label = label.replace(/_/g, ' ');
				availableFonts.push({ filename, label, location: 'bundled' });
			}
		} catch (err) {
			console.error('[MIDI] Failed to read bundled soundfonts directory:', err);
		}

		// Scan user soundfonts (AppData)
		try {
			await fs.mkdir(userDir, { recursive: true });
			const files = await fs.readdir(userDir);
			const soundfontFiles = files.filter(f => f.endsWith('.sf2') || f.endsWith('.sf3'));
			for (const filename of soundfontFiles) {
				// Skip if already in bundled list
				if (availableFonts.some(f => f.filename === filename)) continue;
				let label = filename.replace(/\.(sf2|sf3)$/i, '');
				label = label.replace(/_/g, ' ');
				availableFonts.push({ filename, label, location: 'user' });
			}
		} catch (err) {
			console.error('[MIDI] Failed to read user soundfonts directory:', err);
		}

		// Sort: TimGM first, then alphabetically
		availableFonts.sort((a, b) => {
			if (a.filename.startsWith('TimGM')) return -1;
			if (b.filename.startsWith('TimGM')) return 1;
			return a.label.localeCompare(b.label);
		});

		// Fallback if no fonts found
		if (availableFonts.length === 0) {
			availableFonts.push({ filename: 'default.sf2', label: 'Default', location: 'bundled' });
		}

		const targetWindow = data.windowId || g.windows.parameters || g.windows['midi'];
		tools.sendToId(targetWindow, 'available-soundfonts', { fonts: availableFonts });
	});

	ipcRenderer.on('theme-changed', (e, data) => {
		if (g.windows.settings) {
			tools.sendToId(g.windows.settings, 'theme-changed', data);
		}
		if (g.windows.help) {
			tools.sendToId(g.windows.help, 'theme-changed', data);
		}
		if (g.windows.playlist) {
			tools.sendToId(g.windows.playlist, 'theme-changed', data);
		}
		if (g.windows.mixer) {
			tools.sendToId(g.windows.mixer, 'theme-changed', data);
		}
		if (g.windows.pitchtime) {
			tools.sendToId(g.windows.pitchtime, 'theme-changed', data);
		}
		if (g.windows['midi']) {
			tools.sendToId(g.windows['midi'], 'theme-changed', data);
		}
	});

	ipcRenderer.on('toggle-theme', (e, data) => {
		tools.sendToMain('command', { command: 'toggle-theme' });
	});

	ipcRenderer.on('mixer-state', (e, data) => {
		g.mixerPlaying = !!(data && data.playing);
	});

	ipcRenderer.on('monitoring-ready', async (e, data) => {
		console.log('[Monitoring] Window signaled ready (id:', data.windowId, ')');
		// Mark window as ready to receive messages
		g.monitoringReady = true;
		const currentFile = (g.currentAudio && g.currentAudio.fp) ? g.currentAudio.fp : null;
		if (currentFile && g.windows.monitoring) {
			// Send file-change so monitoring can parse MIDI timeline if applicable
			const ext = path.extname(currentFile).toLowerCase();
			const isMIDI = g.supportedMIDI && g.supportedMIDI.includes(ext);
			const isTracker = g.supportedMpt && g.supportedMpt.includes(ext);
			try {
				tools.sendToId(g.windows.monitoring, 'file-change', {
					filePath: currentFile,
					fileUrl: tools.getFileURL(currentFile),
					fileType: isMIDI ? 'MIDI' : isTracker ? 'Tracker' : 'FFmpeg',
					isMIDI: isMIDI,
					isTracker: isTracker
				});
			} catch (err) {
				console.warn('[Monitoring] Failed to send file-change on ready:', err && err.message);
			}
			// Send initial waveform for non-MIDI files
			console.log('[Monitoring] Sending initial waveform to ready window');
			extractAndSendWaveform(currentFile);
		}
	});

	ipcRenderer.on('waveform-chunk', (e, chunk) => {
		if (!g.windows.monitoring) return;
		try {
			tools.sendToId(g.windows.monitoring, 'waveform-chunk', {
				...chunk,
				filePath: g.currentAudio ? path.basename(g.currentAudio.fp) : ''
			});
		} catch (err) {
			console.warn('[Monitoring] Failed to send waveform chunk (window may be closing):', err.message);
		}
	});

	// Forward analysis data and source-selection commands from other windows (e.g. Mixer)
	ipcRenderer.on('ana-data', (e, data) => {
		if (!g.windows.monitoring) return;
		try {
			console.log('[Stage] forwarding ana-data to monitoring (source=' + (data && data.source) + ')');
			tools.sendToId(g.windows.monitoring, 'ana-data', data);
		} catch (err) {
			console.warn('[Stage] failed to forward ana-data', err && err.message);
		}
	});

	ipcRenderer.on('set-monitoring-source', (e, src) => {
		if (!g.windows.monitoring) {
			console.warn('[Stage] set-monitoring-source received but monitoring window not open');
			return;
		}
		try {
			console.log('[Stage] set-monitoring-source:', src);
			tools.sendToId(g.windows.monitoring, 'set-monitoring-source', src);
		} catch (err) {
			console.warn('[Stage] failed to forward set-monitoring-source', err && err.message);
		}
	});

    // Handle announce-monitoring-focus from other windows (e.g. Mixer)
    ipcRenderer.on('announce-monitoring-focus', (e, src) => {
        // Only track non-monitoring sources
        if (!src) return;
        g.lastFocusedSource = src;
        console.log('[Stage] announce-monitoring-focus received, lastFocusedSource=', g.lastFocusedSource);
        if (g.windows.monitoring) {
            try { tools.sendToId(g.windows.monitoring, 'set-monitoring-source', g.lastFocusedSource); } catch (err) {}
        }
    });

	ipcRenderer.on('player-seek', (e, data) => {
		if (data && typeof data.time === 'number') {
			console.log('[Stage] Received seek command from window:', data.time.toFixed(2));
			seekTo(data.time);
		}
	});

}

async function appStart() {
	window.addEventListener("keydown", onKey);
	// Stage focus implies main player is the last focused non-monitor source
	window.addEventListener('focus', () => {
		g.lastFocusedSource = 'main';
		if (g.windows.monitoring) {
			try { tools.sendToId(g.windows.monitoring, 'set-monitoring-source', 'main'); } catch (e) {}
		}
	});
	window.addEventListener('wheel', onWheelVolume, { passive: false });
	g.scale = window.devicePixelRatio || 1;
	g.body = document.body;
	g.frame = ut.el('.frame');
	g.top = ut.el('.top');
	g.top_num = g.top.el('.num');
	g.top_close = g.top.el('.close')

	g.time_controls = ut.el('.time_controls');
	g.playhead = ut.el('.playhead');
	g.prog = ut.el('.playhead .prog');
	g.cover = ut.el('.info .cover');
	g.type_band = g.cover.el('.filetype .type');
	g.playtime = ut.el('.playtime .time');
	g.playvolume = ut.el('.playtime .volume span');
	g.playremain = ut.el('.playtime .remain');
	g.top_btn_loop = ut.el('.top .content .loop');
	g.top_btn_shuffle = ut.el('.top .content .shuffle');
	g.top_btn_playpause = ut.el('.top .content .playpause');

	g.ctrl_btn_prev = ut.el('.controls .button.prev');
	g.ctrl_btn_next = ut.el('.controls .button.next');
	g.ctrl_btn_shuffle = ut.el('.controls .button.shuffle');
	g.ctrl_btn_play = ut.el('.controls .button.play');
	g.ctrl_btn_loop = ut.el('.controls .button.loop');
	g.ctrl_btn_settings = ut.el('.controls .button.settings');
	g.ctrl_btn_parameters = ut.el('.controls .button.parameters');
	g.ctrl_volume = ut.el('.controls .volume');
	g.ctrl_volume_bar = g.ctrl_volume ? g.ctrl_volume.el('.volume-bar') : null;
	g.ctrl_volume_bar_inner = g.ctrl_volume ? g.ctrl_volume.el('.volume-bar-inner') : null;

	g.text = ut.el('.info .text');
	g.text.innerHTML = '';
	g.blocky = false;


	g.supportedMpt = ['.mptm', '.mod', '.mo3', '.s3m', '.xm', '.it', '.669', '.amf', '.ams', '.c67', '.dbm', '.digi', '.dmf',
		'.dsm', '.dsym', '.dtm', '.far', '.fmt', '.imf', '.ice', '.j2b', '.m15', '.mdl', '.med', '.mms', '.mt2', '.mtm', '.mus',
		'.nst', '.okt', '.plm', '.psm', '.pt36', '.ptm', '.sfx', '.sfx2', '.st26', '.stk', '.stm', '.stx', '.stp', '.symmod',
		'.ult', '.wow', '.gdm', '.mo3', '.oxm', '.umx', '.xpk', '.ppm', '.mmcmp'];
	g.supportedMIDI = ['.mid', '.midi', '.kar', '.rmi'];
	g.supportedChrome = ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.m4b', '.aac', '.webm'];
	g.supportedFFmpeg = ['.mpg', '.mp2', '.aif', '.aiff', '.aa', '.wma', '.asf', '.ape', '.wv', '.wvc', '.tta', '.mka',
		'.amr', '.3ga', '.ac3', '.eac3', '.dts', '.dtshd', '.caf', '.au', '.snd', '.voc', '.tak', '.mpc', '.mp+'];

	g.supportedFilter = [...g.supportedChrome, ...g.supportedFFmpeg, ...g.supportedMpt, ...g.supportedMIDI]

	function canFFmpegPlayFile(filePath) {
		console.log('FFmpeg probe:', filePath);
		const decoder = new g.FFmpegDecoder();
		try {
			if (decoder.open(filePath)) {
				const duration = decoder.getDuration();
				decoder.close();
				console.log('  ✓ FFmpeg can play (duration:', duration, 's)');
				return duration > 0;
			}
			decoder.close();
			console.log('  ✗ FFmpeg open failed');
			return false;
		} catch (e) {
			try { decoder.close(); } catch (e2) { }
			console.log('  ✗ FFmpeg error:', e.message);
			return false;
		}
	}
	g.canFFmpegPlayFile = canFFmpegPlayFile;

	g.music = [];
	g.idx = 0;
	g.isLoop = false;

	if (!g.config.audio) g.config.audio = {};

	setupWindow();
	setupDragDrop();

	let arg = g.start_vars[g.start_vars.length - 1];

	if (arg != '.' && g.start_vars.length > 1 && arg != '--squirrel-firstrun') {
		await playListFromSingle(arg);
	}
	else {
		const dir = (g.config && g.config.ui && g.config.ui.defaultDir) ? g.config.ui.defaultDir : '';
		if (dir) {
			await playListFromSingle(dir);
		}
	}

	if (g.music.length > 0) {

		g.max = g.music.length - 1;
		playAudio(g.music[g.idx])
	}

	g.top_close.addEventListener('click', () => {
		const cfg = g.config_obj ? g.config_obj.get() : g.config;
		const keep = cfg && cfg.ui && cfg.ui.keepRunningInTray;
		if (keep) {
			if (g.currentAudio && !g.currentAudio.paused) g.currentAudio.pause();
			g.win.hide();
		} else {
			g.win.close();
		}
	});

	g.top_btn_loop.addEventListener('click', toggleLoop);
	g.top_btn_shuffle.addEventListener('click', shufflePlaylist);
	g.top_btn_playpause.addEventListener('click', playPause);

	g.ctrl_btn_prev.addEventListener('click', playPrev);
	g.ctrl_btn_next.addEventListener('click', playNext);
	g.ctrl_btn_shuffle.addEventListener('click', shufflePlaylist);
	g.ctrl_btn_play.addEventListener('click', playPause);
	g.ctrl_btn_loop.addEventListener('click', toggleLoop);
	g.ctrl_btn_settings.addEventListener('click', () => openWindow('settings'));
	g.ctrl_btn_parameters.addEventListener('click', () => openWindow('parameters'));
	if (ut.dragSlider && g.ctrl_volume && g.ctrl_volume_bar) {
		g.ctrl_volume_slider = ut.dragSlider(g.ctrl_volume, volumeSlider, -1, g.ctrl_volume_bar);
	}
	if (ut.dragSlider && g.time_controls && g.playhead) {
		g.timeline_slider = ut.dragSlider(g.time_controls, timelineSlider, -1, g.playhead);
	}

	loop();

}

function onWheelVolume(e) {
	if (e.ctrlKey || e.metaKey) return;
	if (!e) return;
	const dy = +e.deltaY;
	if (!isFinite(dy) || dy === 0) return;
	if (!g.wheel_vol) g.wheel_vol = { acc: 0, t: 0 };
	const now = performance.now();
	if (now - g.wheel_vol.t > 250) { g.wheel_vol.acc = 0; }
	g.wheel_vol.t = now;
	g.wheel_vol.acc += dy;

	const step = 80;
	while (g.wheel_vol.acc <= -step) {
		g.wheel_vol.acc += step;
		volumeUp();
	}
	while (g.wheel_vol.acc >= step) {
		g.wheel_vol.acc -= step;
		volumeDown();
	}

	e.preventDefault();
}

function _clamp01(v) {
	v = +v;
	if (!(v >= 0)) return 0;
	if (v > 1) return 1;
	return v;
}

function setVolume(v, persist = false) {
	v = _clamp01(v);
	if (!g.config.audio) g.config.audio = {};
	g.config.audio.volume = v;
	if (player) {
		try { player.gain.gain.value = v; } catch (e) { }
	}
	if (midi) {
		try { midi.setVol(v); } catch (e) { }
	}
	if (g.currentAudio?.isFFmpeg && g.currentAudio.player) {
		g.currentAudio.player.volume = v;
	}
	if (g.playvolume) g.playvolume.innerText = (Math.round(v * 100)) + '%';
	if (g.ctrl_volume_bar_inner) g.ctrl_volume_bar_inner.style.width = (v * 100) + '%';
	if (persist && g.config_obj) g.config_obj.set(g.config);
}

function volumeSlider(e) {
	if (e.type == 'start' || e.type == 'move') {
		setVolume(e.prozX, false);
	}
	else if (e.type == 'end') {
		setVolume(e.prozX, true);
	}
}

function setupDragDrop() {
	g.dropZone = window.nui_app.dropZone(
		[
			{ name: 'drop_add', label: 'Add to Playlist' },
			{ name: 'drop_replace', label: 'Replace Playlist' },
			{ name: 'drop_mixer', label: 'Multitrack<br>Preview' }
		],
		dropHandler,
		document.body
	);
	async function dropHandler(e) {
		console.log(e);
		e.preventDefault();
		if (e.target.id == 'drop_add') {
			let files = fileListArray(e.dataTransfer.files);
			const wasEmpty = g.music.length === 0;
			await playListFromMulti(files, true, !e.ctrlKey);
			if (wasEmpty) playAudio(g.music[g.idx], 0, false);
			g.win.focus();
		}
		if (e.target.id == 'drop_replace') {
			let files = fileListArray(e.dataTransfer.files);
			await playListFromMulti(files, false, !e.ctrlKey);
			playAudio(g.music[g.idx], 0, false);
			g.win.focus();
		}
		if (e.target.id == 'drop_mixer') {
			let files = fileListArray(e.dataTransfer.files);



			let pl = [];
			for (let i = 0; i < files.length; i++) {
				let fp = files[i];
				let stat = await fs.lstat(path.normalize(fp));
				if (stat.isDirectory()) {
					let folder_files = [];
					if (!e.ctrlKey) {
						folder_files = await tools.getFilesRecursive(fp, g.supportedFilter);
					}
					else {
						folder_files = await tools.getFiles(fp, g.supportedFilter);
					}
					pl = pl.concat(folder_files);
				}
				else {
					if (tools.checkFileType(fp, g.supportedFilter) || g.canFFmpegPlayFile(fp)) {
						pl.push(fp);
					}
				}
			}

			if (g.currentAudio && !g.currentAudio.paused) {
				g.currentAudio.pause();
				checkState();
			}




			openWindow('mixer', true, pl);
			return;
		}
		renderTopInfo();
	}

	function fileListArray(fl) {
		let out = [];
		for (let i = 0; i < fl.length; i++) {
			out.push(webUtils.getPathForFile(fl[i]));
		}
		return out;
	}
}

function setupWindow() {
	g.win.hook_event('blur', handler);
	g.win.hook_event('focus', handler);
	g.win.hook_event('move', handler);
	g.win.hook_event('resized', handler);
	g.win.hook_event('resize', handler);

	function handler(e, data) {
		if (data.type == 'blur') {
			g.frame.classList.remove('focus');
		}
		if (data.type == 'focus') {
			g.frame.classList.add('focus');
		}
		if (data.type == 'move' || data.type == 'resized' || data.type == 'resize') {
			clearTimeout(g.window_move_timeout);
			g.window_move_timeout = setTimeout(async () => {
				let bounds = await g.win.getBounds();
				if (!g.config.windows) g.config.windows = {};
				if (!g.config.windows.main) g.config.windows.main = {};
				const scale = (g.config.windows.main.scale !== undefined) ? (g.config.windows.main.scale | 0) : 14;
				g.config.windows.main = {
					...g.config.windows.main,
					x: bounds.x,
					y: bounds.y,
					width: bounds.width,
					height: bounds.height,
					scale: scale
				};
				g.config_obj.set(g.config);
			}, 500)
		}
	}
}

function timelineSlider(e) {
	console.log('[Timeline] dragSlider event:', e.type, 'prozX:', e.prozX);
	
	// Ignore end event - it causes duplicate seeks after start/move
	// Seek on start (immediate feedback) and move (drag updates)
	if (e.type === 'end') {
		console.log('[Timeline] Ignoring end event to prevent duplicate seek');
		return;
	}
	
	if (!g.currentAudio) return;
	let dur = g.currentAudio.duration;
	if (!(dur > 0)) {
		if (g.currentAudio.isMod && player && player.duration) dur = player.duration;
		else if (g.currentAudio.isFFmpeg && g.currentAudio.player && g.currentAudio.player.duration) dur = g.currentAudio.player.duration;
		else if (g.currentAudio.isMidi && midi && midi.duration) dur = midi.duration;
	}
	if (!(dur > 0)) return;

	const s = dur * e.prozX;
	console.log('[Timeline] Seeking to:', s);
	seekTo(s);
}

function playListFromSingle(fp, rec = true) {
	return new Promise(async (resolve, reject) => {
		let pl = [];
		let idx = 0;
		let stat = await fs.lstat(path.normalize(fp));
		if (stat.isDirectory()) {
			if (rec) {
				pl = await tools.getFilesRecursive(fp, g.supportedFilter);
			}
			else {
				pl = await tools.getFiles(fp, g.supportedFilter);
			}
		}
		else {
			if (tools.checkFileType(fp, g.supportedFilter)) {
				let info = path.parse(fp);
				pl = await tools.getFiles(info.dir, g.supportedFilter);
				idx = pl.findIndex(item => item == path.join(info.dir, info.base));
				if (idx == -1) { idx = 0 };
			}
			else {
				console.log('Unsupported File Type')
			}
		}
		if (pl.length > 0) {
			g.music = pl;
			g.max = g.music.length - 1;
			g.idx = idx;
		}
		resolve();
	})
}

function playListFromMulti(ar, add = false, rec = false) {
	return new Promise(async (resolve, reject) => {
		let pl = [];
		for (let i = 0; i < ar.length; i++) {
			let fp = ar[i];
			let stat = await fs.lstat(path.normalize(fp));
			if (stat.isDirectory()) {
				let folder_files = [];
				if (rec) {
					folder_files = await tools.getFilesRecursive(fp, g.supportedFilter);
				}
				else {
					folder_files = await tools.getFiles(fp, g.supportedFilter);
				}
				pl = pl.concat(folder_files);
			}
			else {
				if (tools.checkFileType(fp, g.supportedFilter) || g.canFFmpegPlayFile(fp)) {
					pl.push(fp);
				}
				else {
					console.log('Unsupported File Type:', fp)
				}
			}
		}
		if (pl.length > 0) {
			if (add && g.music.length > 0) {
				g.music = g.music.concat(pl);
				g.max = g.music.length - 1;
			}
			else {
				g.idx = 0;
				g.music = pl;
				g.max = g.music.length - 1;
			}
		}
		resolve(pl);
	})
}

async function playAudio(fp, n, startPaused = false, autoAdvance = false) {
	if (!g.blocky) {
		if (fp && g.music && g.music.length > 0) {
			const idx = g.music.indexOf(fp);
			if (idx >= 0 && g.idx !== idx) {
				g.idx = idx;
				try { renderTopInfo(); } catch (e) { }
				if (g.info_win) {
					tools.sendToId(g.info_win, 'info', { list: g.music, idx: g.idx });
				}
			}
		}
		let parse = path.parse(fp);
		let bench = performance.now();

		if (!autoAdvance && g.currentAudio && !g.currentAudio.paused) {
			if (g.currentAudio.isFFmpeg && g.currentAudio.player && typeof g.currentAudio.player.fadeOut === 'function' && g.activePipeline !== 'rubberband') {
				await g.currentAudio.player.fadeOut();
			}
		}

		g.blocky = true;
		clearAudio();

		if (player) { player.stop(); }
		if (midi) { midi.stop(); }

		const ext = parse.ext.toLocaleLowerCase();
		const isMIDI = g.supportedMIDI && g.supportedMIDI.includes(ext);
		const isTracker = g.supportedMpt.includes(ext);
		console.log('[playAudio] File:', parse.base, 'Type:', isMIDI ? 'MIDI' : isTracker ? 'Tracker' : 'FFmpeg', 'parametersOpen:', g.parametersOpen, 'activePipeline:', g.activePipeline);

		// Notify monitoring window of file change (include file URL for renderer fetch)
		if (g.windows.monitoring) {
			try {
				tools.sendToId(g.windows.monitoring, 'file-change', {
					filePath: fp,
					fileUrl: tools.getFileURL(fp),
					fileType: isMIDI ? 'MIDI' : isTracker ? 'Tracker' : 'FFmpeg',
					isMIDI: isMIDI,
					isTracker: isTracker
				});
			} catch (err) {
				console.warn('[Stage] Failed to notify monitoring window of file change:', err && err.message);
			}
		}

		if (isMIDI) {
			console.log('[playAudio] Starting MIDI playback');
			if (!midi) {
				g.text.innerHTML += (g.midiInitError || 'MIDI playback not initialized.') + '<br>';
				g.blocky = false;
				return false;
			}
			const targetVol = (g && g.config && g.config.audio && g.config.audio.volume !== undefined) ? +g.config.audio.volume : 0.5;
			const initialVol = startPaused ? 0 : targetVol;
			g.currentAudio = {
				isMidi: true,
				fp: fp,
				bench: bench,
				currentTime: 0,
				get paused() { return midi ? midi.paused : true; },
				duration: 0,
				play: () => {
					try { midi.setVol((g && g.config && g.config.audio && g.config.audio.volume !== undefined) ? +g.config.audio.volume : targetVol); } catch (e) { }
					midi.play();
				},
				pause: () => { midi.pause(); },
				seek: (time) => midi.seek(time),
				getCurrentTime: () => midi.getCurrentTime()
			};
			try {
				await midi.load(tools.getFileURL(fp));

				if (!g.currentAudio.duration && midi.getDuration() > 0) {
					g.currentAudio.duration = midi.getDuration();
				}

				midi.setVol(initialVol);
				midi.setLoop(g.isLoop);
				if (n > 0) {
					midi.seek(n);
					g.currentAudio.currentTime = n;
				}
				if (startPaused) {
					try { midi.setVol(0); } catch (e) { }
					midi.pause();
				} else {
					midi.play();
				}

				await renderInfo(fp, g.currentAudio.metadata);
				g.blocky = false;
				checkState();

				if (g.windows.parameters) {
					console.log('[playAudio] Updating parameters window for MIDI');
					const orig = midi.getOriginalBPM ? midi.getOriginalBPM() : 120;
					const speed = (g.midiSettings && g.midiSettings.speed) ? g.midiSettings.speed : 1.0;
					const params = {
						transpose: g.midiSettings ? g.midiSettings.pitch : 0,
						bpm: Math.round(orig * speed),
						metronome: g.midiSettings ? g.midiSettings.metronome : false,
						soundfont: (g.config && g.config.midiSoundfont) ? g.config.midiSoundfont : 'TimGM6mb.sf2',
						originalBPM: orig
					};
					tools.sendToId(g.windows.parameters, 'set-mode', { mode: 'midi', params });
				}
			} catch (err) {
				console.error('MIDI playback error:', err);
				g.text.innerHTML += 'Error loading MIDI file!<br>';
				g.blocky = false;
				return false;
			}
		}
		else if (isTracker) {
			const targetVol = (g && g.config && g.config.audio && g.config.audio.volume !== undefined) ? +g.config.audio.volume : 0.5;
			const initialVol = startPaused ? 0 : targetVol;
			g.currentAudio = {
				isMod: true,
				fp: fp,
				bench: bench,
				currentTime: 0,
				paused: startPaused,
				duration: 0,
				play: () => {
					g.currentAudio.paused = false;
					try { player.gain.gain.value = (g && g.config && g.config.audio && g.config.audio.volume !== undefined) ? +g.config.audio.volume : targetVol; } catch (e) { }
					player.unpause();
				},
				pause: () => { g.currentAudio.paused = true; player.pause() },
				getCurrentTime: () => player.getCurrentTime(),
				seek: (n) => player.seek(n)
			};
			if (g.windows.monitoring) {
				extractAndSendWaveform(fp);
			}
			player.load(tools.getFileURL(fp));
			player.gain.gain.value = initialVol;

			// Reset tracker params on new file (no lock feature for tracker)
			g.trackerParams = { pitch: 1.0, tempo: 1.0, stereoSeparation: 100 };

			// Apply tape speed if locked and in tape mode (overrides tracker params)
			const locked = g.audioParams && g.audioParams.locked;
			if (locked && g.audioParams.mode === 'tape' && g.audioParams.tapeSpeed !== 0) {
				const tempoFactor = Math.pow(2, g.audioParams.tapeSpeed / 12.0);
				player.setTempo(tempoFactor);
			}

			if (g.windows.parameters) {
				const params = {
					pitch: 1.0,
					tempo: 1.0,
					stereoSeparation: 100,
					reset: true  // Signal new file loaded
				};
				tools.sendToId(g.windows.parameters, 'set-mode', { mode: 'tracker', params });
			}

			if (n > 0) {
				const seekTime = n;
				const seekFp = fp;
				let attempts = 0;
				const doSeek = () => {
					if (!g.currentAudio || !g.currentAudio.isMod || g.currentAudio.fp !== seekFp) return;
					if (!player || typeof player.seek !== 'function') return;
					if (player.duration && player.duration > 0) {
						player.seek(seekTime);
						g.currentAudio.currentTime = seekTime;
						return;
					}
					attempts++;
					if (attempts < 60) {
						setTimeout(doSeek, 25);
					}
				};
				setTimeout(doSeek, 25);
			}
			if (startPaused) {
				try { player.gain.gain.value = 0; } catch (e) { }
				try { player.pause(); } catch (e) { }
				setTimeout(() => {
					try {
						if (g.currentAudio && g.currentAudio.isMod && g.currentAudio.fp === fp && g.currentAudio.paused) {
							try { player.gain.gain.value = 0; } catch (e) { }
							player.pause();
						}
					} catch (e) { }
				}, 30);
				setTimeout(() => {
					try {
						if (g.currentAudio && g.currentAudio.isMod && g.currentAudio.fp === fp && g.currentAudio.paused) {
							try { player.gain.gain.value = 0; } catch (e) { }
							player.pause();
						}
					} catch (e) { }
				}, 250);
			}
			checkState();
		}
		else {
			console.log('[playAudio] FFmpeg section - parametersOpen:', g.parametersOpen, 'audioMode:', g.audioParams?.mode, 'activePipeline:', g.activePipeline);
			try {
				// Determine which pipeline to use based on audio mode (not just window state)
				const shouldUseRubberband = g.parametersOpen && g.audioParams && g.audioParams.mode === 'pitchtime';
				
				if (shouldUseRubberband && g.rubberbandPlayer && g.activePipeline !== 'rubberband') {
					console.log('[playAudio] Need to switch to rubberband - was:', g.activePipeline);
					g.activePipeline = 'rubberband';
					g.rubberbandPlayer.connect(); // Connect to destination for audio output
					if (g.monitoringSplitter_RB) {
						g.rubberbandPlayer.connect(g.monitoringSplitter_RB); // Also connect to monitoring
					}
					console.log('[playAudio] Switched to rubberband pipeline');
				} else if (!shouldUseRubberband && g.activePipeline === 'rubberband') {
					console.log('[playAudio] Should use normal pipeline (tape mode or params closed) - switching from rubberband');
					g.rubberbandPlayer.disconnect();
					g.activePipeline = 'normal';
				}

				const ffPlayer = (g.activePipeline === 'rubberband' && g.rubberbandPlayer) ? g.rubberbandPlayer : g.ffmpegPlayer;
				console.log('[playAudio] Selected player:', g.activePipeline === 'rubberband' ? 'rubberbandPlayer' : 'ffmpegPlayer');

				if (g.activePipeline === 'rubberband' && g.rubberbandPlayer && !g.rubberbandPlayer.isConnected) {
					console.log('[playAudio] Reconnecting rubberband player (was disconnected by clearAudio)');
					g.rubberbandPlayer.connect(); // destination
					if (g.monitoringSplitter_RB) {
						g.rubberbandPlayer.connect(g.monitoringSplitter_RB);
					}
				}

				ffPlayer.onEnded(audioEnded);

				console.log('[playAudio] Opening file with', g.activePipeline, 'player...');
				const metadata = await ffPlayer.open(fp);

				if (g.windows.monitoring) {
					extractAndSendWaveform(fp);
				}

				console.log('[playAudio] File opened, duration:', metadata?.duration, 'sampleRate:', metadata?.sampleRate);
				ffPlayer.setLoop(g.isLoop);

				g.currentAudio = {
					isFFmpeg: true,
					pipeline: g.activePipeline,
					fp: fp,
					bench: bench,
					currentTime: 0,
					paused: startPaused,
					duration: metadata.duration,
					player: ffPlayer,
					volume: (g.config && g.config.audio && g.config.audio.volume !== undefined) ? +g.config.audio.volume : 0.5,
					play: () => { g.currentAudio.paused = false; ffPlayer.play(); },
					pause: () => { g.currentAudio.paused = true; ffPlayer.pause(); },
					seek: (time) => ffPlayer.seek(time),
					getCurrentTime: () => ffPlayer.getCurrentTime()
				};

				ffPlayer.volume = (g.config && g.config.audio && g.config.audio.volume !== undefined) ? +g.config.audio.volume : 0.5;

				// Apply locked settings based on mode
				const locked = g.audioParams && g.audioParams.locked;
				if (locked) {
					if (g.audioParams.mode === 'tape' && g.audioParams.tapeSpeed !== 0) {
						// Tape mode: apply playback rate
						ffPlayer.setPlaybackRate(g.audioParams.tapeSpeed);
						console.log('[playAudio] Applied locked tape speed:', g.audioParams.tapeSpeed);
					} else if (g.audioParams.mode === 'pitchtime' && g.activePipeline === 'rubberband') {
						// Pitch/Time mode: apply rubberband parameters
						if (typeof ffPlayer.setPitch === 'function') {
							const pitchRatio = Math.pow(2, (g.audioParams.pitch || 0) / 12.0);
							ffPlayer.setPitch(pitchRatio);
							console.log('[playAudio] Applied locked pitch:', g.audioParams.pitch, '→ ratio:', pitchRatio);
						}
						if (typeof ffPlayer.setTempo === 'function') {
							ffPlayer.setTempo(g.audioParams.tempo || 1.0);
							console.log('[playAudio] Applied locked tempo:', g.audioParams.tempo || 1.0);
						}
						if (typeof ffPlayer.setOptions === 'function') {
							ffPlayer.setOptions({ formantPreserved: !!g.audioParams.formant });
							console.log('[playAudio] Applied locked formant:', !!g.audioParams.formant);
						}
					}
				}

				if (!startPaused) {
					console.log('[playAudio] Starting playback...');
					await ffPlayer.play();
					console.log('[playAudio] Playback started, isPlaying:', ffPlayer.isPlaying);
				}
				else {
					console.log('[playAudio] Pausing (startPaused=true)');
					if (typeof ffPlayer.pause === 'function') await ffPlayer.pause();
				}

				checkState();
				await renderInfo(fp);
				g.blocky = false;

				if (g.windows.parameters) {
					// If locked, preserve all settings; otherwise reset to defaults
					const locked = g.audioParams && g.audioParams.locked;
					const params = locked ? {
						audioMode: g.audioParams.mode,
						tapeSpeed: g.audioParams.tapeSpeed,
						pitch: g.audioParams.pitch,
						tempo: g.audioParams.tempo,
						formant: g.audioParams.formant,
						locked: true,
						reset: false
					} : {
						audioMode: 'tape',
						tapeSpeed: 0,
						pitch: 0,
						tempo: 1.0,
						formant: false,
						locked: false,
						reset: true
					};

					// If not locked, also reset to tape mode and normal pipeline
					if (!locked) {
						g.audioParams.mode = 'tape';
						g.audioParams.tapeSpeed = 0;
						g.audioParams.pitch = 0;
						g.audioParams.tempo = 1.0;
						if (g.activePipeline === 'rubberband') {
							await switchPipeline('normal');
						}
					} else {
						// If locked, apply the appropriate settings for the current mode
						if (g.audioParams.mode === 'tape') {
							// Tape mode: apply tape speed
							if (g.audioParams.tapeSpeed !== 0) {
								applyTapeSpeed(g.audioParams.tapeSpeed);
							}
						} else if (g.audioParams.mode === 'pitchtime') {
							// Pitchtime mode: switch to rubberband and apply pitch/tempo
							if (g.activePipeline !== 'rubberband') {
								await switchPipeline('rubberband');
							} else {
								// Already on rubberband, just apply the settings
								if (g.rubberbandPlayer) {
									if (typeof g.rubberbandPlayer.setPitch === 'function') {
										const pitchRatio = Math.pow(2, (g.audioParams.pitch || 0) / 12.0);
										g.rubberbandPlayer.setPitch(pitchRatio);
									}
									if (typeof g.rubberbandPlayer.setTempo === 'function') {
										g.rubberbandPlayer.setTempo(g.audioParams.tempo || 1.0);
									}
								}
							}
						}
					}

					tools.sendToId(g.windows.parameters, 'set-mode', { mode: 'audio', params });
				}
			}
			catch (err) {
				console.error('FFmpeg playback error:', err);
				g.text.innerHTML += 'Error loading file!<br>';
				g.blocky = false;
				return false;
			}
		}
	}
	if (g.info_win) {
		tools.sendToId(g.info_win, 'info', { list: g.music, idx: g.idx });
	}
}

function renderInfo(fp, metadata) {
	g.currentInfo = { duration: g.currentAudio.duration };
	return new Promise(async (resolve, reject) => {
		let parse = path.parse(fp);
		let parent = path.basename(parse.dir);
		g.playremain.innerText = ut.playTime(g.currentAudio.duration * 1000).minsec;
		ut.killKids(g.text);
		g.text.appendChild(renderInfoItem('Folder:', parent))
		g.text.appendChild(renderInfoItem('File:', parse.base))
		g.text.appendChild(ut.htmlObject(`<div class="space"></div>`))
		let ext_string = parse.ext.substring(1).toLowerCase();
		g.type_band.className = 'type ' + ext_string;
		g.type_band.innerText = ext_string;

		let prevCovers = g.cover.els('img');
		for (let i = 0; i < prevCovers.length; i++) {
			let el = prevCovers[i];
			el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, delay: 200, fill: 'forwards' })
				.onfinish = () => ut.killMe(el);
		}
		renderTopInfo();

		if (g.currentAudio.isMod) {
			g.currentInfo.metadata = metadata;
			g.text.appendChild(renderInfoItem('Format:', metadata.tracker))
			g.text.appendChild(ut.htmlObject(`<div class="space"></div>`))
			if (metadata) {
				if (metadata.artist) { g.text.appendChild(renderInfoItem('Artist:', metadata.artist)) }
				if (metadata.title) { g.text.appendChild(renderInfoItem('Title:', metadata.title)) }
				if (metadata.date) { g.text.appendChild(renderInfoItem('Date:', metadata.date)) }
			}
			resolve();
		}
		else if (g.currentAudio.isMidi) {
			const md = metadata || g.currentAudio.metadata || {};
			g.currentInfo.metadata = md;

			if (md.duration && md.duration > 0) {
				g.currentAudio.duration = md.duration;
				g.playremain.innerText = ut.playTime(g.currentAudio.duration * 1000).minsec;
			}
			g.text.appendChild(renderInfoItem('Format:', 'MIDI'))
			g.text.appendChild(ut.htmlObject(`<div class="space"></div>`))

			if (md.title) g.text.appendChild(renderInfoItem('Title:', md.title));
			if (md.copyright) g.text.appendChild(renderInfoItem('Copyright:', md.copyright));

			const infoParts = [];
			if (md.timeSignature) infoParts.push(md.timeSignature);
			if (md.originalBPM) infoParts.push(Math.round(md.originalBPM) + ' BPM');
			if (md.keySignature) infoParts.push('Key: ' + md.keySignature);

			if (infoParts.length > 0) {
				g.text.appendChild(renderInfoItem('Info:', infoParts.join(' - ')));
			}

			if (md.markers && md.markers.length > 0) {
			}

			resolve();
		}
		else {

			let meta = await getFileInfo(fp);
			g.currentInfo.file = meta;

			if (meta.formatLongName && meta.formatLongName.includes('Tracker')) {
				g.text.appendChild(renderInfoItem('Format:', 'Tracker Format'))
			}
			else {
				g.text.appendChild(renderInfoItem('Format:', meta.codecLongName || meta.codec || 'Unknown'))
			}

			let bitrateStr = meta.bitrate ? Math.round(meta.bitrate / 1000) + ' kbps' : '';
			let channelStr = meta.channels == 2 ? 'stereo' : (meta.channels == 1 ? 'mono' : (meta.channels ? meta.channels + ' ch' : ''));
			let sampleStr = meta.sampleRate ? meta.sampleRate + ' Hz' : '';
			if (meta.bitsPerSample && sampleStr) sampleStr += ' @ ' + meta.bitsPerSample + ' Bit';
			let infoLine = [bitrateStr, channelStr, sampleStr].filter(s => s).join(' / ');
			if (infoLine) g.text.appendChild(renderInfoItem(' ', infoLine))

			g.text.appendChild(ut.htmlObject(`<div class="space"></div>`))

			if (meta.artist) { g.text.appendChild(renderInfoItem('Artist:', meta.artist)) }
			if (meta.album) { g.text.appendChild(renderInfoItem('Album:', meta.album)) }
			if (meta.title) { g.text.appendChild(renderInfoItem('Title:', meta.title)) }



			let cover;
			let id3_cover = await getCoverArt(meta);
			if (id3_cover) {
				cover = id3_cover;
			}
			else {
				let images = await tools.getFiles(parse.dir, ['.jpg', '.jpeg', '.png', '.gif']);
				if (images.length > 0) {
					cover = await tools.loadImage(images[images.length - 1])
				}
			}

			if (cover) {
				g.cover.appendChild(cover)
				cover.style.opacity = '0';
				cover.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: 'forwards' });
				g.currentInfo.cover_src = cover.src;
			}

			resolve();
		}
	})
}

function renderInfoItem(label, text) {
	let el = ut.htmlObject(`
		<div id="#item_folder" class="item">
			<div class="label">${label}</div>
			<div class="content">${text}</div>
		</div>`)
	return el;
}

function renderTopInfo() {
	g.top_num.innerText = (g.idx + 1) + ' of ' + (g.max + 1);
}

async function switchPipeline(newMode) {
	if (g.activePipeline === newMode) return;
	if (!g.currentAudio || !g.currentAudio.isFFmpeg) return;

	console.log('Switching pipeline:', g.activePipeline, '->', newMode);

	const wasPlaying = g.currentAudio.player ? g.currentAudio.player.isPlaying : false;
	const currentTime = g.currentAudio.getCurrentTime ? g.currentAudio.getCurrentTime() : 0;

	if (g.currentAudio.player) {
		try { await g.currentAudio.player.stop(true); } catch (e) { }
	}

	g.activePipeline = newMode;
	const newPlayer = (newMode === 'rubberband') ? g.rubberbandPlayer : g.ffmpegPlayer;

	if (newPlayer) {
		try {
			await newPlayer.open(g.currentAudio.fp);

			g.currentAudio.player = newPlayer;

			g.currentAudio.play = () => { g.currentAudio.paused = false; newPlayer.play(); };
			g.currentAudio.pause = () => { g.currentAudio.paused = true; newPlayer.pause(); };
			g.currentAudio.seek = (t) => newPlayer.seek(t);
			g.currentAudio.getCurrentTime = () => newPlayer.getCurrentTime();

			const vol = (g.config && g.config.audio && g.config.audio.volume !== undefined) ? +g.config.audio.volume : 0.5;
			newPlayer.volume = vol;
			newPlayer.setLoop(g.isLoop);

			// Apply stored audio params when switching to rubberband
			if (newMode === 'rubberband' && g.audioParams) {
				// Ensure monitoring taps are correctly initialized for this context
				initMonitoring();

				// Connect rubberband to both audio destination and monitoring tap (T-junction)
				if (typeof newPlayer.connect === 'function') {
					newPlayer.connect(); // Connects to destination by default
					if (g.monitoringSplitter_RB) {
						newPlayer.connect(g.monitoringSplitter_RB);
						console.log('[switchPipeline] Connected rubberband player to destination and monitor');
					} else {
						console.log('[switchPipeline] Connected rubberband player to destination only (monitor tap missing)');
					}
				}
				if (typeof newPlayer.setPitch === 'function') {
					const pitchRatio = Math.pow(2, (g.audioParams.pitch || 0) / 12.0);
					newPlayer.setPitch(pitchRatio);
					console.log('[switchPipeline] Applied pitch:', g.audioParams.pitch, '→ ratio:', pitchRatio);
				}
				if (typeof newPlayer.setTempo === 'function') {
					newPlayer.setTempo(g.audioParams.tempo || 1.0);
					console.log('[switchPipeline] Applied tempo:', g.audioParams.tempo || 1.0);
				}
				if (typeof newPlayer.setOptions === 'function') {
					newPlayer.setOptions({ formantPreserved: !!g.audioParams.formant });
				}
			}

			// Apply tape speed when switching to normal
			if (newMode === 'normal') {
				// Disconnect rubberband when switching away from it
				if (g.rubberbandPlayer && typeof g.rubberbandPlayer.disconnect === 'function') {
					g.rubberbandPlayer.disconnect();
					console.log('[switchPipeline] Disconnected rubberband player');
				}
				if (g.audioParams && g.audioParams.tapeSpeed !== undefined) {
					applyTapeSpeed(g.audioParams.tapeSpeed);
					console.log('[switchPipeline] Applied tapeSpeed:', g.audioParams.tapeSpeed);
				}
			}

			if (currentTime > 0) newPlayer.seek(currentTime);

			if (wasPlaying) {
				g.currentAudio.paused = false;
				await newPlayer.play();
			} else {
				g.currentAudio.paused = true;
			}
		} catch (err) {
			console.error('Pipeline switch failed:', err);
		}
	}
}

function clearAudio() {
	console.log('[clearAudio] Stopping current audio, pipeline:', g.activePipeline);
	if (g.ffmpegPlayer) {
		if (typeof g.ffmpegPlayer.clearBuffer === 'function') g.ffmpegPlayer.clearBuffer();
		g.ffmpegPlayer.stop(true);
		console.log('[clearAudio] Stopped ffmpegPlayer');
	}
	if (g.rubberbandPlayer) {
		g.rubberbandPlayer.disconnect();

		// Dispose worklet to flush internal buffers and prevent audio bleed
		if (typeof g.rubberbandPlayer.disposeWorklet === 'function') {
			g.rubberbandPlayer.disposeWorklet().catch(e => {
				console.error('[clearAudio] Failed to dispose rubberband worklet:', e);
			});
		}

		g.rubberbandPlayer.reset();
		if (g.rubberbandPlayer.player && typeof g.rubberbandPlayer.player.clearBuffer === 'function') {
			g.rubberbandPlayer.player.clearBuffer();
		}
		g.rubberbandPlayer.stop(false);
		console.log('[clearAudio] Stopped, reset, and disposed rubberband worklet');
		g.activePipeline = 'normal';
	}
	if (g.currentAudio) {
		if (g.currentAudio.isMod) player.stop();
		if (g.currentAudio.isMidi && midi) midi.stop();
		console.log('[clearAudio] Cleared currentAudio, was:', g.currentAudio.isMidi ? 'MIDI' : g.currentAudio.isMod ? 'Tracker' : g.currentAudio.isFFmpeg ? 'FFmpeg' : 'Unknown');
		g.currentAudio = undefined;
	}
}

function audioEnded(e) {
	if ((g.currentAudio?.isMod || g.currentAudio?.isMidi) && g.isLoop) {
		playAudio(g.music[g.idx], 0, false, true);
	}
	else {
		playNext(null, true);
	}
}

function checkState() {
	if (g.currentAudio) {
		if (g.isLoop) {
			g.body.addClass('loop')
		}
		else {
			g.body.removeClass('loop')
		}
		if (g.currentAudio.paused) {
			g.body.addClass('pause')
		}
		else {
			g.body.removeClass('pause')
		}
	}
}

function flashButton(btn) {
	if (!btn) return;
	btn.classList.add('flash');
	setTimeout(() => { btn.classList.remove('flash'); }, 50);
}

function shufflePlaylist() {
	ut.shuffleArray(g.music);
	g.idx = 0;
	playAudio(g.music[g.idx]);
}

function playNext(e, autoAdvance = false) {
	if (!g.blocky) {
		if (g.idx == g.max) { g.idx = -1; }
		g.idx++;
		playAudio(g.music[g.idx], 0, false, autoAdvance)
	}
}

function playPrev(e) {
	if (!g.blocky) {
		if (g.idx == 0) { g.idx = g.max + 1; }
		g.idx--;
		playAudio(g.music[g.idx])
	}
}

function playPause() {
	if (!g.currentAudio) {
		if (g.music && g.music.length > 0) {
			playAudio(g.music[g.idx]);
		}
		return;
	}

	if (g.currentAudio.paused) {
		g.currentAudio.play();
	}
	else {
		g.currentAudio.pause();
	}
	checkState();
}

function toggleLoop() {
	g.isLoop = !g.isLoop;
	if (g.currentAudio && g.currentAudio.isFFmpeg && g.currentAudio.player) {
		g.currentAudio.player.setLoop(g.isLoop);
	}
	if (g.currentAudio && g.currentAudio.isMidi && midi) {
		midi.setLoop(g.isLoop);
	}
	checkState();
}

function toggleControls() {
	if (!g.config.ui) g.config.ui = {};
	const current = !!g.config.ui.showControls;
	const next = !current;
	g.config.ui.showControls = next;
	g.config_obj.set(g.config);
	applyShowControls(next, true);
}

function _getMainScale() {
	let s = 14;
	if (g.config && g.config.windows && g.config.windows.main && g.config.windows.main.scale !== undefined) {
		s = g.config.windows.main.scale | 0;
	}
	if (s < 14) s = 14;
	return s;
}

function _scaledDim(base, scale) {
	const v = Math.round((base / 14) * scale);
	return (v > base) ? v : base;
}

function applyShowControls(show, resetSize = false) {
	const { MIN_WIDTH, MIN_HEIGHT_WITH_CONTROLS, MIN_HEIGHT_WITHOUT_CONTROLS } = require('./config-defaults.js').WINDOW_DIMENSIONS;
	const minH = show ? MIN_HEIGHT_WITH_CONTROLS : MIN_HEIGHT_WITHOUT_CONTROLS;
	const scale = _getMainScale();
	const scaledMinW = _scaledDim(MIN_WIDTH, scale);
	const scaledMinH = _scaledDim(minH, scale);
	if (show) {
		document.body.classList.add('show-controls');
	} else {
		document.body.classList.remove('show-controls');
	}
	tools.sendToMain('command', { command: 'set-min-height', minHeight: scaledMinH, minWidth: scaledMinW });
	if (resetSize) {
		g.win.setBounds({ width: scaledMinW, height: scaledMinH });
	}
}

async function initMidiPlayer() {
	if (!window.midi || !g.audioContext) return;
	let fp = g.app_path;
	if (g.isPackaged) { fp = path.dirname(fp); }
	const soundfontFile = (g.config && g.config.midiSoundfont) ? g.config.midiSoundfont : 'default.sf2';
	
	// Check user directory first, then bundled
	const userDataPath = await helper.app.getPath('userData');
	const userDir = path.join(userDataPath, 'soundfonts');
	const userPath = path.join(userDir, soundfontFile);
	const bundledPath = path.resolve(fp + '/bin/soundfonts/' + soundfontFile);

	let soundfontPath = null;
	try {
		await fs.access(userPath);
		soundfontPath = userPath;
		console.log('[MIDI] Using user soundfont:', soundfontFile);
	} catch (e) {
		try {
			await fs.access(bundledPath);
			soundfontPath = bundledPath;
			console.log('[MIDI] Using bundled soundfont:', soundfontFile);
		} catch (e2) {
			console.warn('[MIDI] SoundFont not found:', soundfontFile, '- falling back to default.sf2');
			const defaultPath = path.resolve(fp + '/bin/soundfonts/default.sf2');
			const soundfontUrl = tools.getFileURL(defaultPath);
			await initMidiWithSoundfont(soundfontUrl, defaultPath);
			return;
		}
	}

	const soundfontUrl = tools.getFileURL(soundfontPath);
	await initMidiWithSoundfont(soundfontUrl, soundfontPath);
}

async function initMidiWithSoundfont(soundfontUrl, soundfontPath) {
	if (!g.audioContext) return;
	const context = g.audioContext; // Capture stable context reference

	const midiConfig = {
		context: context,
		soundfontUrl: soundfontUrl,
		soundfontPath: soundfontPath
	};

	let tempMidi;
	try {
		tempMidi = new window.midi(midiConfig);
	} catch (e) {
		console.error('MIDI init failed:', e);
		g.midiInitError = 'MIDI init failed: ' + e.message;
		return;
	}

	tempMidi.onMetadata((meta) => {
		console.log('[Stage] Received MIDI Metadata:', meta);
		if (g.currentAudio && g.currentAudio.isMidi) {
			const dur = (meta && meta.duration) ? meta.duration : tempMidi.getDuration();
			if (dur > 0) {
				g.currentAudio.duration = dur;
				g.playremain.innerText = ut.playTime(dur * 1000).minsec;
			}

			if (meta) {
				g.currentAudio.metadata = meta;
			}


			let keepMetronome = false;
			if (g.midiSettings && g.midiSettings.metronome !== undefined) {
				keepMetronome = !!g.midiSettings.metronome;
			} else if (tempMidi) {
				keepMetronome = !!tempMidi.metronomeEnabled;
				if (keepMetronome) {
					if (!g.midiSettings) g.midiSettings = {};
					g.midiSettings.metronome = true;
				}
			}

			if (!g.midiSettings) g.midiSettings = {};

			g.midiSettings.pitch = 0;
			g.midiSettings.speed = null;

			if (tempMidi && tempMidi.setMetronome) {
				tempMidi.setMetronome(keepMetronome);
			}

			if (tempMidi && tempMidi.setPitchOffset) tempMidi.setPitchOffset(0);
			if (tempMidi && tempMidi.resetPlaybackSpeed) tempMidi.resetPlaybackSpeed();

			if (g.windows.parameters) {
				const originalBPM = (tempMidi.getOriginalBPM && typeof tempMidi.getOriginalBPM === 'function') ? tempMidi.getOriginalBPM() : 120;
				const params = {
					transpose: 0,
					bpm: Math.round(originalBPM),
					metronome: keepMetronome,
					soundfont: (g.config && g.config.midiSoundfont) ? g.config.midiSoundfont : 'TimGM6mb.sf2',
					originalBPM: originalBPM
				};
				tools.sendToId(g.windows.parameters, 'set-mode', { mode: 'midi', params });
				tools.sendToId(g.windows.parameters, 'update-params', { mode: 'midi', params });
			}

			if (g.windows['midi']) {
				const originalBPM = (tempMidi.getOriginalBPM && typeof tempMidi.getOriginalBPM === 'function') ? tempMidi.getOriginalBPM() : 120;
				let currentBPM = originalBPM;

				tools.sendToId(g.windows['midi'], 'update-ui', {
					originalBPM: originalBPM,
					speed: currentBPM,
					pitch: 0,
					metronome: keepMetronome
				});
			}
		}
	});
	tempMidi.onProgress((e) => {
		if (g.currentAudio && g.currentAudio.isMidi) {
			g.currentAudio.currentTime = e.pos || 0;
		}
	});
	tempMidi.onEnded(audioEnded);
	tempMidi.onError((err) => { console.log(err); audioEnded(); g.blocky = false; });

	try {
		await tempMidi.init();

		// Ensure monitoring taps are correctly initialized for this context
		initMonitoring();

		// MIDI library internally connects to context.destination (via resampling if needed).
		// We only need to handle the monitoring bridge here.
		// If resampling is active, the node in the main context is resamplerSource.
		if (g.monitoringSplitter && g.monitoringSplitter.context === context) {
			const sourceNode = tempMidi.needsResampling ? tempMidi.resamplerSource : tempMidi.gain;
			if (sourceNode) {
				sourceNode.connect(g.monitoringSplitter);
				console.log('[MIDI] Connected to monitoring tap' + (tempMidi.needsResampling ? ' (via resampler)' : ''));
			}
		}

		// Sync to global as last step
		midi = tempMidi;
	} catch (e) {
		console.error('[MIDI] Failed to initialize MIDI player:', e);
		g.midiInitError = 'MIDI init failed: ' + e.message;
	}
}

async function toggleHQMode(desiredState, skipPersist = false) {
	if (!g.config.audio) g.config.audio = {};
	let next = !!g.config.audio.hqMode;
	if (typeof desiredState === 'boolean') { next = desiredState; }
	else { next = !g.config.audio.hqMode; }
	if (!!g.config.audio.hqMode !== next) {
		g.config.audio.hqMode = next;
		if (!skipPersist) { g.config_obj.set(g.config); }
	}

	const targetRate = g.config.audio.hqMode ? g.maxSampleRate : 48000;
	console.log('Switching to', g.config.audio.hqMode ? 'Max output sample rate' : 'Standard mode', '(' + targetRate + 'Hz)');

	let wasPlaying = false;
	if (g.currentAudio) {
		if (g.currentAudio.isFFmpeg && g.currentAudio.player && typeof g.currentAudio.player.isPlaying !== 'undefined') {
			wasPlaying = !!g.currentAudio.player.isPlaying;
		}
		else {
			wasPlaying = !g.currentAudio.paused;
		}
	}
	const currentFile = (g.currentAudio && g.currentAudio.fp) ? g.currentAudio.fp : g.music[g.idx];
	const currentIdx = (currentFile && g.music && g.music.length > 0) ? g.music.indexOf(currentFile) : -1;
	const wasMod = g.currentAudio?.isMod;
	const wasMidi = g.currentAudio?.isMidi;
	const currentTime = wasMod ? (player?.getCurrentTime() || 0) : (wasMidi ? (midi?.getCurrentTime() || 0) : (g.currentAudio?.player?.getCurrentTime() || 0));

	if (g.currentAudio) {
		if (g.currentAudio.isMod) {
			player.stop();
		} else if (g.currentAudio.isMidi && midi) {
			midi.stop();
		} else if (g.currentAudio.player) {
			if (typeof g.currentAudio.player.stop === 'function') {
				g.currentAudio.player.stop();
			}
			if (typeof g.currentAudio.player.close === 'function') {
				await g.currentAudio.player.close();
			}
		}
		g.currentAudio = null;
	}

	if (g.audioContext && g.audioContext.state !== 'closed') {
		await g.audioContext.close();
	}

	g.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: targetRate });
	console.log('New AudioContext sample rate:', g.audioContext.sampleRate);

	const devId = (g.config && g.config.audio && g.config.audio.output) ? g.config.audio.output.deviceId : '';
	if (devId) {
		try {
			await g.audioContext.setSinkId(devId);
			console.log('Output device re-applied:', devId);
		} catch (err) {
			console.error('Failed to re-apply output device, using system default:', err);
			if (g.config && g.config.audio && g.config.audio.output) g.config.audio.output.deviceId = '';
			if (!skipPersist) { g.config_obj.set(g.config); }
		}
	}

	if (g.ffmpegPlayer) {
		try { g.ffmpegPlayer.dispose(); } catch (e) { console.warn('ffmpegPlayer dispose error:', e); }
		g.ffmpegPlayer = null;
	}

	const { FFmpegDecoder } = require(g.ffmpeg_napi_path);
	const { FFmpegStreamPlayerSAB } = require(g.ffmpeg_player_path);
	FFmpegStreamPlayerSAB.setDecoder(FFmpegDecoder);
	const threadCount = (g.config && g.config.ffmpeg && g.config.ffmpeg.decoder && g.config.ffmpeg.decoder.threads !== undefined) ? (g.config.ffmpeg.decoder.threads | 0) : 0;
	g.ffmpegPlayer = new FFmpegStreamPlayerSAB(g.audioContext, g.ffmpeg_worklet_path, 'ffmpeg-stream-sab', 2, threadCount, false); // Internal connect off
	try { g.ffmpegPlayer.reuseWorkletNode = true; } catch (e) { }
	await g.ffmpegPlayer.init();

	// Ensure monitoring taps are correctly initialized for this context
	initMonitoring();

	// Connect to both destination and monitor (T-junction)
	g.ffmpegPlayer.gainNode.connect(g.audioContext.destination);
	if (g.monitoringSplitter) {
		g.ffmpegPlayer.gainNode.connect(g.monitoringSplitter);
	}

	const modConfig = {
		repeatCount: 0,
		stereoSeparation: (g.config && g.config.tracker && g.config.tracker.stereoSeparation !== undefined) ? (g.config.tracker.stereoSeparation | 0) : 100,
		context: g.audioContext
	};
	player = new window.chiptune(modConfig);

	await new Promise((resolve) => {
		player.onInitialized(() => {
			console.log('Player Initialized after HQ toggle');
			initMonitoring();
			player.gain.connect(g.audioContext.destination);
			if (g.monitoringSplitter) {
				player.gain.connect(g.monitoringSplitter);
			}
			resolve();
		});
	});

	player.onMetadata(async (meta) => {
		if (g.currentAudio) {
			g.currentAudio.duration = player.duration;
			g.playremain.innerText = ut.playTime(g.currentAudio.duration * 1000).minsec;
			await renderInfo(g.currentAudio.fp, meta);
		}
		g.blocky = false;
	});
	player.onProgress((e) => {
		if (g.currentAudio) {
			g.currentAudio.currentTime = e.pos || 0;
		}
		// Forward VU data to Parameters window
		if (e.vu && g.windows.parameters) {
			tools.sendToId(g.windows.parameters, 'tracker-vu', { vu: e.vu, channels: e.vu.length });
		}
	});
	player.onEnded(audioEnded);
	player.onError((err) => { console.log(err); audioEnded(); g.blocky = false; });
	await initMidiPlayer();

	if (currentFile) {
		if (currentIdx >= 0) {
			g.idx = currentIdx;
		}
		await playAudio(currentFile, currentTime, !wasPlaying);

		if (wasPlaying && g.currentAudio && g.currentAudio.paused && g.currentAudio.play) {
			g.currentAudio.play();
		}
	}

	checkState();
}

function volumeUp() {
	const v = (g.config && g.config.audio && g.config.audio.volume !== undefined) ? (+g.config.audio.volume + 0.05) : 0.55;
	setVolume(v, true);
}

function volumeDown() {
	const v = (g.config && g.config.audio && g.config.audio.volume !== undefined) ? (+g.config.audio.volume - 0.05) : 0.45;
	setVolume(v, true);
}

function applyTapeSpeed(semitones) {
	semitones = Math.max(-12, Math.min(12, semitones | 0));
	console.log('[Stage] applyTapeSpeed:', semitones);
	console.log('[Stage] currentAudio:', g.currentAudio ? { isFFmpeg: g.currentAudio.isFFmpeg, isMod: g.currentAudio.isMod, hasPlayer: !!g.currentAudio.player } : null);
	g.audioParams.tapeSpeed = semitones;

	if (g.currentAudio?.isFFmpeg && g.currentAudio.player) {
		console.log('[Stage] Calling ffPlayer.setPlaybackRate(' + semitones + ')');
		g.currentAudio.player.setPlaybackRate(semitones);
	}

	if (g.currentAudio?.isMod && player) {
		const tempoFactor = Math.pow(2, semitones / 12.0);
		console.log('[Stage] Calling player.setTempo(' + tempoFactor + ')');
		player.setTempo(tempoFactor);
	}

	// Note: MIDI has its own tempo controls, tape speed does not apply
}

function seek(mx) {
	if (!g.currentAudio) return;
	let dur = g.currentAudio.duration;
	if (!(dur > 0)) {
		if (g.currentAudio.isMod && player && player.duration) dur = player.duration;
		else if (g.currentAudio.isFFmpeg && g.currentAudio.player && g.currentAudio.player.duration) dur = g.currentAudio.player.duration;
		else if (g.currentAudio.isMidi && midi && midi.duration) dur = midi.duration;
	}
	if (!(dur > 0)) return;
	let max = g.time_controls.offsetWidth;
	let x = mx - ut.offset(g.time_controls).left;
	if (x < 0) { x = 0; }
	if (x > max) { x = max; }
	let proz = x / max;
	let s = dur * proz;
	if (s < 0) s = 0;
	if (s > dur) s = dur;
	seekTo(s);
}

function seekTo(s) {
	if (g.currentAudio) {
		if (g.currentAudio.isMod) {
			player.seek(s);
			g.currentAudio.currentTime = s;
		}
		else if (g.currentAudio.isMidi) {
			g.currentAudio.seek(s);
			g.currentAudio.currentTime = s;
		}
		else {
			g.currentAudio.seek(s);
		}
	}
}

function seekFore() {
	if (g.currentAudio) {
		if (g.currentAudio.currentTime + 10 < g.currentAudio.duration) {
			seekTo(g.currentAudio.currentTime + 10)
		}
	}
}

function seekBack() {
	if (g.currentAudio) {
		if (g.currentAudio.currentTime - 10 > 0) {
			seekTo(g.currentAudio.currentTime - 10)
		}
		else {
			seekTo(0);
		}
	}
}

function loadImage(url) {
	return new Promise((resolve, reject) => {
		let image = new Image();
		image.src = url;
		image.addEventListener('load', done);
		function done(e) {
			image.removeEventListener('load', done);
			resolve(image);
		}
	})
}

function initMonitoring() {
	if (!g.audioContext) return;

	// Reset standard monitoring if context changed (e.g. HQ toggle)
	if (g.monitoringSplitter && g.monitoringSplitter.context !== g.audioContext) {
		console.log('[Monitoring] Standard context changed, re-initializing taps');
		g.monitoringSplitter = null;
		g.monitoringAnalyserL = null;
		g.monitoringAnalyserR = null;
	}

	if (!g.monitoringSplitter) {
		g.monitoringSplitter = g.audioContext.createChannelSplitter(2);
		g.monitoringAnalyserL = g.audioContext.createAnalyser();
		g.monitoringAnalyserR = g.audioContext.createAnalyser();

		// Use larger FFT for high sample rates to maintain frequency resolution
		const fftSize = g.audioContext.sampleRate > 48000 ? 8192 : 2048;
		g.monitoringAnalyserL.fftSize = fftSize;
		g.monitoringAnalyserR.fftSize = fftSize;

		g.monitoringSplitter.connect(g.monitoringAnalyserL, 0);
		g.monitoringSplitter.connect(g.monitoringAnalyserR, 1);
		// Tap only - do not connect to destination here!
	}

	// Context 2 (Rubberband) - Always 48kHz
	if (g.rubberbandContext) {
		if (g.monitoringSplitter_RB && g.monitoringSplitter_RB.context !== g.rubberbandContext) {
			console.log('[Monitoring] Rubberband context changed, re-initializing taps');
			g.monitoringSplitter_RB = null;
			g.monitoringAnalyserL_RB = null;
			g.monitoringAnalyserR_RB = null;
		}

		if (!g.monitoringSplitter_RB) {
			g.monitoringSplitter_RB = g.rubberbandContext.createChannelSplitter(2);
			g.monitoringAnalyserL_RB = g.rubberbandContext.createAnalyser();
			g.monitoringAnalyserR_RB = g.rubberbandContext.createAnalyser();

			g.monitoringAnalyserL_RB.fftSize = 2048;
			g.monitoringAnalyserR_RB.fftSize = 2048;

			g.monitoringSplitter_RB.connect(g.monitoringAnalyserL_RB, 0);
			g.monitoringSplitter_RB.connect(g.monitoringAnalyserR_RB, 1);
			// Tap only - do not connect to destination here!
		}
	}

	console.log('[Monitoring] Stereo Analyser taps ready');

	// Pre-allocate reusable buffers for monitoring data
	if (!g.monitoringBuffers) {
		g.monitoringBuffers = {
			freqL: null,
			freqR: null,
			timeL: null,
			timeR: null
		};
	}

	if (!g.monitoringLoop) {
		// Use setInterval for reliable timing (RAF pauses when window not visible)
		g.monitoringLoop = setInterval(updateMonitoring, 1000 / 60);
	}
}

function updateMonitoring() {
	if (!g.windows.monitoring || !g.windowsVisible.monitoring || !g.monitoringReady) return;

	// Determine which analysers to use
	let aL = g.monitoringAnalyserL;
	let aR = g.monitoringAnalyserR;

	if (g.activePipeline === 'rubberband' && g.monitoringAnalyserL_RB) {
		aL = g.monitoringAnalyserL_RB;
		aR = g.monitoringAnalyserR_RB;
	}

	if (!aL || !aR) {
		console.log('[Monitoring] No analysers available');
		return;
	}

	// Reuse buffers if size matches, otherwise recreate
	const buf = g.monitoringBuffers;
	if (!buf.freqL || buf.freqL.length !== aL.frequencyBinCount) {
		buf.freqL = new Uint8Array(aL.frequencyBinCount);
		buf.freqR = new Uint8Array(aR.frequencyBinCount);
		buf.timeL = new Uint8Array(aL.fftSize);
		buf.timeR = new Uint8Array(aR.fftSize);
	}

	aL.getByteFrequencyData(buf.freqL);
	aR.getByteFrequencyData(buf.freqR);
	aL.getByteTimeDomainData(buf.timeL);
	aR.getByteTimeDomainData(buf.timeR);

	const pos = (g.currentAudio && typeof g.currentAudio.getCurrentTime === 'function') ? g.currentAudio.getCurrentTime() : 0;
	const dur = (g.currentAudio && g.currentAudio.duration) ? g.currentAudio.duration : 0;

		try {
			tools.sendToId(g.windows.monitoring, 'ana-data', {
				source: 'main',
				freqL: Array.from(buf.freqL),
				freqR: Array.from(buf.freqR),
				timeL: Array.from(buf.timeL),
				timeR: Array.from(buf.timeR),
				pos,
				duration: dur,
				sampleRate: (g.activePipeline === 'rubberband' && g.rubberbandContext) ? g.rubberbandContext.sampleRate : (g.audioContext ? g.audioContext.sampleRate : 48000)
			});
		} catch (err) {
			// Silently ignore - window may be closing
		}
}

async function extractAndSendWaveform(fp) {
	if (!g.windows.monitoring || !g.monitoringReady) return;

	// Clear existing waveform immediately to avoid visual persistence
	try {
		tools.sendToId(g.windows.monitoring, 'clear-waveform');
	} catch (err) {
		console.warn('[Monitoring] Failed to clear waveform (window may be closing):', err.message);
		return;
	}

	// Check if this is a MIDI file (FFmpeg cannot decode MIDI)
	const ext = path.extname(fp).toLowerCase();
	const isMIDI = g.supportedMIDI && g.supportedMIDI.includes(ext);
	
	if (isMIDI) {
		console.log('[Monitoring] MIDI files not supported in monitoring window');
		// Send file info so monitoring window shows the filename
		try {
			tools.sendToId(g.windows.monitoring, 'waveform-data', {
				peaksL: null,
				peaksR: null,
				points: 0,
				duration: 0,
				filePath: fp,
				isMIDI: true
			});
		} catch (err) {
			console.warn('[Monitoring] Failed to send MIDI info:', err.message);
		}
		return;
	}

	console.log('[Monitoring] Requesting async waveform for:', path.basename(fp));

	try {
		const workerPath = path.join(g.app_path, 'js', 'monitoring', 'waveform_worker.js');

		// Use Main process to handle the worker - avoid V8 platform limitations in renderer
		const peaks = await ipcRenderer.invoke('extract-waveform', {
			filePath: fp,
			binPath: g.ffmpeg_napi_path,
			numPoints: 1900,
			workerPath: workerPath
		});

		if (peaks && peaks.aborted) {
			console.log('[Monitoring] Waveform extraction aborted (file changed)');
			return;
		}

		if (peaks && peaks.error) {
			console.error('[Monitoring] Waveform worker error:', peaks.error);
			return;
		}

		if (!peaks) {
			console.warn('[Monitoring] Waveform worker returned no data');
			return;
		}

		const hasData = peaks.peaksL && peaks.peaksL.some(p => p > 0);
		console.log('[Monitoring] Waveform received. Points:', peaks.points, 'hasData:', hasData, 'duration:', peaks.duration);

		if (g.windows.monitoring) {
			try {
				tools.sendToId(g.windows.monitoring, 'waveform-data', {
					...peaks,
					filePath: path.basename(fp)
				});
			} catch (err) {
				console.warn('[Monitoring] Failed to send waveform data (window may be closing):', err.message);
			}
		}
	} catch (err) {
		console.error('[Monitoring] Waveform extraction IPC failed:', err);
	}
}

function getFileInfo(fp) {
	return new Promise((resolve, reject) => {
		setTimeout(() => {
			let meta = g.getMetadata(fp);
			resolve(meta);
		}, 0);
	})
}

function getCoverArt(meta) {
	return new Promise((resolve, reject) => {
		if (meta && meta.coverArt && meta.coverArt.length > 0) {
			let img = new Image();
			let mime = meta.coverArtMimeType || 'image/jpeg';
			img.src = 'data:' + mime + ';base64,' + meta.coverArt.toString('base64');
			img.addEventListener('load', () => {
				resolve(img);
			}, { once: true });
			img.addEventListener('error', () => {
				resolve();
			}, { once: true });
		}
		else {
			resolve();
		}
	})
}

function loop() {
	if (g.currentAudio && !g.currentAudio.paused) {
		renderBar();
	}
	requestAnimationFrame(loop);
}

function renderBar() {
	let proz = 0;
	let time = 0;
	if (g.currentAudio) {
		if (g.currentAudio.isFFmpeg && g.currentAudio.player) {
			g.currentAudio.currentTime = g.currentAudio.player.getCurrentTime();
		}
		else if (g.currentAudio.isMidi && g.currentAudio.getCurrentTime) {
			g.currentAudio.currentTime = g.currentAudio.getCurrentTime();
		}

		if (g.currentAudio.lastTime != g.currentAudio.currentTime) {
			g.currentAudio.lastTime = g.currentAudio.currentTime;
			time = g.currentAudio.currentTime;
			if (g.currentAudio.duration > 0) {
				proz = time / g.currentAudio.duration;
			}
			g.prog.style.width = (proz * 100) + '%';
			let minsec = ut.playTime(time * 1000).minsec;
			if (g.lastMinsec != minsec) {
				g.playtime.innerText = minsec;
				g.lastMinsec = minsec;
			}
		}
	}


	const vol = (g.config && g.config.audio && g.config.audio.volume !== undefined) ? +g.config.audio.volume : 0.5;
	if (g.last_vol != vol) {
		g.playvolume.innerText = (Math.round(vol * 100)) + '%';
		if (g.ctrl_volume_bar_inner) g.ctrl_volume_bar_inner.style.width = (vol * 100) + '%';
		g.last_vol = vol;
	}

}

// ###########################################################################

async function onKey(e) {
	let shortcutAction = null;
	if (shortcuts && shortcuts.handleShortcut) {
		shortcutAction = shortcuts.handleShortcut(e, 'stage');
	} else if (window.shortcuts && window.shortcuts.handleShortcut) {
		shortcutAction = window.shortcuts.handleShortcut(e, 'stage');
	}

	if (shortcutAction === 'toggle-parameters') {
		openWindow('parameters');
		flashButton(g.ctrl_btn_parameters);
	}
	else if (shortcutAction === 'toggle-settings') {
		openWindow('settings');
		flashButton(g.ctrl_btn_settings);
	}
	else if (shortcutAction === 'toggle-theme') {
		tools.sendToMain('command', { command: 'toggle-theme' });
	}
	else if (shortcutAction === 'toggle-mixer') {
		const fp = g.currentAudio ? g.currentAudio.fp : null;
		openWindow('mixer', false, fp);
	}
	else if (shortcutAction === 'toggle-pitchtime') {
		openWindow('parameters');
	}
	else if (shortcutAction === 'toggle-controls') {
		toggleControls();
	}
	else if (shortcutAction === 'toggle-monitoring') {
		openWindow('monitoring');
	}
	else if (e.keyCode == 70 || e.keyCode == 102) {
		console.log(g.currentAudio.src)
	}

	if (e.keyCode == 123) {
		g.win.toggleDevTools();
	}
	else if (e.keyCode == 76) {
		toggleLoop();
		flashButton(g.ctrl_btn_loop);
	}

	if (e.keyCode == 27) {
		g.config_obj.set(g.config);
		const cfg = g.config_obj ? g.config_obj.get() : g.config;
		const keep = cfg && cfg.ui && cfg.ui.keepRunningInTray;
		if (keep) {
			if (g.currentAudio && !g.currentAudio.paused) g.currentAudio.pause();
			g.win.hide();
		} else {
			g.win.close();
		}
	}
	if (e.keyCode == 39) {
		if (e.ctrlKey) { seekFore() }
		else {
			let now = Date.now();
			if (now - g.lastNavTime >= 100) {
				g.lastNavTime = now;
				playNext();
				flashButton(g.ctrl_btn_next);
			}
		}
	}
	if (e.keyCode == 37) {
		if (e.ctrlKey) { seekBack() }
		else {
			let now = Date.now();
			if (now - g.lastNavTime >= 100) {
				g.lastNavTime = now;
				playPrev();
				flashButton(g.ctrl_btn_prev);
			}
		}
	}
	if (e.keyCode == 38) {
		volumeUp();
	}
	if (e.keyCode == 40) {
		volumeDown();
	}



	if (e.keyCode == 82) {
		shufflePlaylist();
		flashButton(g.ctrl_btn_shuffle);
	}
	if (e.keyCode == 73) {
		helper.shell.showItemInFolder(g.music[g.idx]);
	}

	if (e.keyCode == 32) {
		playPause();
		flashButton(g.ctrl_btn_play);
	}

	// Ctrl+/- for window scaling only (speed control moved to Parameters window)
	if (e.keyCode == 189 || e.keyCode == 109 || e.keyCode == 173) {
		if (e.ctrlKey) {
			console.log('Scaling down');
			let val = ut.getCssVar('--space-base').value;
			scaleWindow(val - 1)
		}
	}
	if (e.keyCode == 187 || e.keyCode == 107 || e.keyCode == 61) {
		if (e.ctrlKey) {
			console.log('Scaling up');
			let val = ut.getCssVar('--space-base').value;
			scaleWindow(val + 1)
		}
	}
}

async function getMixerPlaylist(contextFile = null) {
	if (Array.isArray(contextFile)) {
		return { paths: contextFile, idx: 0 };
	}
	let fp = contextFile;
	if (!fp && g.currentAudio && g.currentAudio.fp) {
		fp = g.currentAudio.fp;
	}

	if (fp) {
		try {
			const dir = path.dirname(fp);
			const files = await tools.getFiles(dir, g.supportedFilter);

			const currentPath = path.normalize(fp);
			let idx = files.findIndex(f => path.normalize(f) === currentPath);
			if (idx === -1) idx = 0;

			return { paths: files, idx: idx };
		} catch (e) {
			console.error('Error getting siblings for mixer:', e);
		}
	}
	const list = Array.isArray(g.music) ? g.music : [];
	return { paths: list, idx: g.idx | 0 };
}

async function openWindow(type, forceShow = false, contextFile = null) {
	console.log('[openWindow] type:', type, 'forceShow:', forceShow, 'exists:', !!g.windows[type]);
	async function waitForWindowClosed(t, id, timeoutMs = 2000) {
		return await new Promise((resolve) => {
			let done = false;
			const to = setTimeout(() => {
				if (done) return;
				done = true;
				ipcRenderer.removeListener('window-closed', onClosed);
				resolve(false);
			}, timeoutMs | 0);
			function onClosed(e, data) {
				if (done) return;
				if (!data || data.type !== t || data.windowId !== id) return;
				done = true;
				clearTimeout(to);
				ipcRenderer.removeListener('window-closed', onClosed);
				resolve(true);
			}
			ipcRenderer.on('window-closed', onClosed);
		});
	}

	if (g.windows[type] && g.windowsClosing[type]) {
		await waitForWindowClosed(type, g.windows[type], 2000);
	}

	if (g.windows[type]) {
		if (type === 'midi' && g.midiSettings) {
			tools.sendToId(g.windows[type], 'update-ui', {
				pitch: g.midiSettings.pitch,
				speed: g.midiSettings.speed,
				metronome: !!g.midiSettings.metronome
			});
		}

		if (forceShow) {
			if (type === 'mixer') {
				if (g.currentAudio && !g.currentAudio.paused) {
					g.currentAudio.pause();
					checkState();
				}
				const playlist = await getMixerPlaylist(contextFile);
				tools.sendToId(g.windows[type], 'mixer-playlist', {
					paths: playlist.paths.slice(0, 20),
					idx: playlist.idx
				});
				if (!g.windowsVisible[type]) {
					tools.sendToId(g.windows[type], 'show-window');
					g.windowsVisible[type] = true;
				} else {
					tools.sendToId(g.windows[type], 'show-window');
				}
				return;
			} else {
				if (!g.windowsVisible[type]) {
					tools.sendToId(g.windows[type], 'show-window');
					g.windowsVisible[type] = true;
				} else {
					tools.sendToId(g.windows[type], 'show-window');
				}
				if (type === 'monitoring') {
					g.monitoringReady = true;
				}
				if (type === 'pitchtime') {
					const currentFile = (g.currentAudio && g.currentAudio.fp) ? g.currentAudio.fp : null;
					const currentTime = g.currentAudio ? g.currentAudio.currentTime : 0;
					if (currentFile) {
						if (g.currentAudio && !g.currentAudio.paused) {
							g.currentAudio.pause();
							checkState();
						}
						const ext = path.extname(currentFile).toLowerCase();
						if (g.supportedMIDI && g.supportedMIDI.includes(ext)) {
							tools.sendToId(g.windows[type], 'pitchtime-error', { message: 'MIDI files are not supported in Pitch/Time.' });
						} else {
							tools.sendToId(g.windows[type], 'pitchtime-file', { currentFile, currentTime });
						}
					}
				}
				if (type === 'parameters') {
					g.parametersOpen = true;
					// Only switch to rubberband if pitchtime mode is active
					if (g.audioParams.mode === 'pitchtime' && g.currentAudio && g.currentAudio.isFFmpeg && g.rubberbandPlayer) {
						if (g.activePipeline !== 'rubberband') {
							try {
								await switchPipeline('rubberband');
								g.rubberbandPlayer.connect();
								console.log('[Parameters] Switched to rubberband pipeline (existing window)');
							} catch (err) {
								console.error('[Parameters] Failed to switch to rubberband pipeline:', err);
							}
						}
					}
				}
				return;
			}
		}

		if (g.windowsVisible[type]) {
			tools.sendToId(g.windows[type], 'hide-window');
			g.windowsVisible[type] = false;

			if (type === 'midi') {
				g.midiSettings = { pitch: 0, speed: null };
				if (midi) {
					if (midi.setPitchOffset) midi.setPitchOffset(0);
					if (midi.resetPlaybackSpeed) midi.resetPlaybackSpeed();
					if (midi.setMetronome) midi.setMetronome(false);
				}
			}

			g.win.focus();

		} else {
			tools.sendToId(g.windows[type], 'show-window');
			g.windowsVisible[type] = true;
			if (type === 'monitoring') {
				g.monitoringReady = true;
			}
			if (type === 'mixer') {
				if (g.currentAudio && !g.currentAudio.paused) {
					g.currentAudio.pause();
					checkState();
				}
				const playlist = await getMixerPlaylist(contextFile);
				tools.sendToId(g.windows[type], 'mixer-playlist', {
					paths: playlist.paths.slice(0, 20),
					idx: playlist.idx
				});
			}
			if (type === 'midi' && g.midiSettings) {
				tools.sendToId(g.windows[type], 'update-ui', {
					pitch: g.midiSettings.pitch,
					speed: g.midiSettings.speed,
					metronome: !!g.midiSettings.metronome
				});
			}
			if (type === 'pitchtime') {
				const currentFile = (g.currentAudio && g.currentAudio.fp) ? g.currentAudio.fp : null;
				const currentTime = g.currentAudio ? g.currentAudio.currentTime : 0;
				if (currentFile) {
					if (g.currentAudio && !g.currentAudio.paused) {
						g.currentAudio.pause();
						checkState();
					}
					const ext = path.extname(currentFile).toLowerCase();
					if (g.supportedMIDI && g.supportedMIDI.includes(ext)) {
						tools.sendToId(g.windows[type], 'pitchtime-error', { message: 'MIDI files are not supported in Pitch/Time.' });
					} else {
						tools.sendToId(g.windows[type], 'pitchtime-file', { currentFile, currentTime });
					}
				}
			}
			if (type === 'parameters') {
				g.parametersOpen = true;
				if (g.currentAudio && g.currentAudio.isFFmpeg && g.rubberbandPlayer) {
					if (g.activePipeline !== 'rubberband') {
						try {
							await switchPipeline('rubberband');
							g.rubberbandPlayer.connect();
							console.log('[Parameters] Switched to rubberband pipeline (toggled visible)');
						} catch (err) {
							console.error('[Parameters] Failed to switch to rubberband pipeline:', err);
						}
					}
				}
			}
		}
		return;
	}

	let stageBounds = await g.win.getBounds();
	let displays = await helper.screen.getAllDisplays();
	let targetDisplay = displays.find(d =>
		stageBounds.x >= d.bounds.x &&
		stageBounds.x < d.bounds.x + d.bounds.width &&
		stageBounds.y >= d.bounds.y &&
		stageBounds.y < d.bounds.y + d.bounds.height
	) || displays[0];

	const configDefaults = require('./config-defaults.js');
	const defaultWinSettings = (configDefaults && configDefaults.windows && configDefaults.windows[type]) || {};
	const userWinSettings = (g.config.windows && g.config.windows[type]) || {};
	const winSettings = { ...defaultWinSettings, ...userWinSettings };

	let windowWidth = winSettings.width || 960;
	let windowHeight = winSettings.height || 800;

	let x = targetDisplay.workArea.x + Math.round((targetDisplay.workArea.width - windowWidth) / 2);
	let y = targetDisplay.workArea.y + Math.round((targetDisplay.workArea.height - windowHeight) / 2);

	if (winSettings.x !== null && winSettings.x !== undefined) x = winSettings.x;
	if (winSettings.y !== null && winSettings.y !== undefined) y = winSettings.y;

	const init_data = {
		type: type,
		stageId: await g.win.getId(),
		configName: g.configName,
		config: g.config,
		maxSampleRate: g.maxSampleRate,
		currentSampleRate: g.audioContext.sampleRate,
		ffmpeg_napi_path: g.ffmpeg_napi_path,
		ffmpeg_player_path: g.ffmpeg_player_path,
		ffmpeg_worklet_path: g.ffmpeg_worklet_path
	};

	if (type === 'parameters') {
		const currentFile = (g.currentAudio && g.currentAudio.fp) ? g.currentAudio.fp : null;
		let mode = 'audio';
		if (currentFile) {
			const ext = path.extname(currentFile).toLowerCase();
			if (g.supportedMIDI && g.supportedMIDI.includes(ext)) {
				mode = 'midi';
			} else if (g.currentAudio && g.currentAudio.isMod) {
				mode = 'tracker';
			}
		}
		init_data.mode = mode;
		init_data.params = {};

		if (mode === 'midi') {
			init_data.params = {
				transpose: g.midiSettings ? g.midiSettings.pitch : 0,
				metronome: g.midiSettings ? !!g.midiSettings.metronome : false,
				soundfont: (g.config && g.config.midiSoundfont) ? g.config.midiSoundfont : 'TimGM6mb.sf2'
			};
			const orig = (midi && midi.getOriginalBPM) ? midi.getOriginalBPM() : 120;
			const speed = (g.midiSettings && g.midiSettings.speed) ? g.midiSettings.speed : 1.0;
			init_data.params.bpm = Math.round(orig * speed);
			init_data.params.originalBPM = orig;
			init_data.originalBPM = orig;
		}
		else if (mode === 'audio') {
			init_data.params = {
				audioMode: g.audioParams ? g.audioParams.mode : 'tape',
				tapeSpeed: g.audioParams ? g.audioParams.tapeSpeed : 0,
				pitch: g.audioParams ? g.audioParams.pitch : 0,
				tempo: g.audioParams ? g.audioParams.tempo : 1.0,
				formant: g.audioParams ? !!g.audioParams.formant : false,
				locked: g.audioParams ? !!g.audioParams.locked : false,
				reset: false
			};
		}
	}

	if (type === 'mixer') {
		if (g.currentAudio && !g.currentAudio.paused) {
			g.currentAudio.pause();
			checkState();
		}
		const playlist = await getMixerPlaylist(contextFile);
		init_data.playlist = {
			paths: playlist.paths.slice(0, 20),
			idx: playlist.idx
		};
	}

	if (type === 'pitchtime') {
		const currentFile = (g.currentAudio && g.currentAudio.fp) ? g.currentAudio.fp : null;
		const currentTime = g.currentAudio ? g.currentAudio.currentTime : 0;
		const currentVolume = (g.config && g.config.audio && typeof g.config.audio.volume === 'number') ? g.config.audio.volume : 1.0;
		if (currentFile) {
			if (g.currentAudio && !g.currentAudio.paused) {
				g.currentAudio.pause();
				checkState();
			}
			const ext = path.extname(currentFile).toLowerCase();
			if (g.supportedMIDI && g.supportedMIDI.includes(ext)) {
				init_data.pitchtimeError = 'MIDI files are not supported in Pitch/Time.';
			} else {
				init_data.currentFile = currentFile;
				init_data.currentTime = currentTime;
			}
		}
		init_data.currentVolume = currentVolume;
	}

	if (type === 'midi') {
		init_data.metronome = g.midiSettings ? !!g.midiSettings.metronome : false;
		init_data.midiPitch = g.midiSettings ? g.midiSettings.pitch : 0;

		if (midi && midi.getOriginalBPM) {
			init_data.originalBPM = midi.getOriginalBPM();
		} else {
			init_data.originalBPM = 120;
		}

		if (g.midiSettings && g.midiSettings.speed) {
			init_data.midiSpeed = g.midiSettings.speed;
		} else {
			init_data.midiSpeed = init_data.originalBPM || 120;
		}
	}

	if (type === 'monitoring') {
		const currentFile = (g.currentAudio && g.currentAudio.fp) ? g.currentAudio.fp : null;
		init_data.filePath = currentFile ? path.basename(currentFile) : '';
		// Don't extract waveform here - wait for 'monitoring-ready' signal from the window
	}

	g.windows[type] = await tools.browserWindow('frameless', {
		file: `./html/${type}.html`,
		show: false,
		width: windowWidth,
		height: windowHeight,
		x: x,
		y: y,
		backgroundColor: '#323232',
		hasShadow: true,
		init_data: init_data
	});

	console.log('[openWindow] Created window:', type, 'id:', g.windows[type]);

	g.windowsVisible[type] = true;

	if (type === 'parameters') {
		g.parametersOpen = true;
		// Only switch to rubberband if pitchtime mode is active
		if (g.audioParams.mode === 'pitchtime' && g.currentAudio && g.currentAudio.isFFmpeg && g.rubberbandPlayer) {
			if (g.activePipeline !== 'rubberband') {
				try {
					await switchPipeline('rubberband');
					g.rubberbandPlayer.connect(g.monitoringSplitter_RB);
					console.log('[Parameters] Switched to rubberband pipeline');
				} catch (err) {
					console.error('[Parameters] Failed to switch to rubberband pipeline:', err);
				}
			}
		}
	}

	setTimeout(() => {
		tools.sendToId(g.windows[type], 'show-window');
	}, 100);
}

async function scaleWindow(val) {
	const { MIN_WIDTH, MIN_HEIGHT_WITH_CONTROLS, MIN_HEIGHT_WITHOUT_CONTROLS } = require('./config-defaults.js').WINDOW_DIMENSIONS;
	const showControls = (g.config && g.config.ui && g.config.ui.showControls) ? true : false;
	const MIN_H = showControls ? MIN_HEIGHT_WITH_CONTROLS : MIN_HEIGHT_WITHOUT_CONTROLS;
	let w_scale = MIN_WIDTH / 14;
	let h_scale = MIN_H / 14;
	if (!g.config.windows) g.config.windows = {};
	if (!g.config.windows.main) g.config.windows.main = {};
	let curBounds = await g.win.getBounds();
	if (!curBounds) curBounds = { x: 0, y: 0, width: MIN_WIDTH, height: MIN_H };
	let nb = {
		x: curBounds.x,
		y: curBounds.y,
		width: parseInt(w_scale * val),
		height: parseInt(h_scale * val)
	};
	if (nb.width < MIN_WIDTH) { nb.width = MIN_WIDTH; val = 14 };
	if (nb.height < MIN_H) { nb.height = MIN_H; val = 14 };
	await g.win.setBounds(nb);
	g.config.windows.main = { ...g.config.windows.main, x: nb.x, y: nb.y, width: nb.width, height: nb.height, scale: val | 0 };
	ut.setCssVar('--space-base', val);
	g.config_obj.set(g.config);
	const scaledMinW = _scaledDim(MIN_WIDTH, val | 0);
	const scaledMinH = _scaledDim(MIN_H, val | 0);
	tools.sendToMain('command', { command: 'set-min-height', minHeight: scaledMinH, minWidth: scaledMinW });
}

function fb(o) {
	console.log(o);
}

module.exports.init = init;