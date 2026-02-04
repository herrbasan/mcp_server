/**
 * Audio Player Module
 * Simple audio playback with volume and pan control
 */

const EventEmitter = require('events');

class AudioPlayer extends EventEmitter {
  constructor(audioContext) {
    super();
    this.ctx = audioContext;
    this.source = null;
    this.gainNode = this.ctx.createGain();
    this.panNode = this.ctx.createStereoPanner();
    this.gainNode.connect(this.panNode);
    this.panNode.connect(this.ctx.destination);
    this.isPlaying = false;
    this.startTime = 0;
    this.pauseTime = 0;
  }

  async load(url) {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
    this.emit('loaded', { duration: this.buffer.duration });
    return this.buffer;
  }

  play(offset = 0) {
    if (this.isPlaying) return;
    
    this.source = this.ctx.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.connect(this.gainNode);
    
    this.source.onended = () => {
      this.isPlaying = false;
      this.emit('ended');
    };
    
    this.startTime = this.ctx.currentTime - offset;
    this.source.start(0, offset);
    this.isPlaying = true;
    this.emit('play');
  }

  pause() {
    if (!this.isPlaying) return;
    this.pauseTime = this.ctx.currentTime - this.startTime;
    this.source.stop();
    this.isPlaying = false;
    this.emit('pause');
  }

  stop() {
    if (this.source) {
      this.source.stop();
      this.source = null;
    }
    this.pauseTime = 0;
    this.isPlaying = false;
    this.emit('stop');
  }

  setVolume(value) {
    // 0.0 to 1.0
    this.gainNode.gain.value = Math.max(0, Math.min(1, value));
  }

  setPan(value) {
    // -1.0 (left) to 1.0 (right)
    this.panNode.pan.value = Math.max(-1, Math.min(1, value));
  }

  getCurrentTime() {
    if (!this.isPlaying) return this.pauseTime;
    return this.ctx.currentTime - this.startTime;
  }

  getDuration() {
    return this.buffer?.duration || 0;
  }
}

// Utility functions
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function dbToGain(db) {
  return Math.pow(10, db / 20);
}

function gainToDb(gain) {
  return 20 * Math.log10(gain);
}

module.exports = { AudioPlayer, formatTime, dbToGain, gainToDb };
