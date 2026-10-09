/**
 * player.js — 音频播放控制器
 *
 * 基于 abcjs 的合成器：负责音色切换、预渲染（prime）、播放 / 暂停 / 停止。
 * 与界面解耦：状态通过 onStatus 回调外抛，DOM 只由页面入口（score.js）操作。
 */

const SOUND_FONT_URL = 'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/';
// 音色编号用 abcjs 的 %%MIDI program 取值（0-based GM）：
// 0=钢琴 8=钢片琴 9=钟琴 11=颤音琴 12=马林巴 13=木琴
const DEFAULT_PROGRAM = 13; // 木琴 (Xylophone)

/** 轮询等待外部脚本（如 CDN 上的 abcjs）就绪 */
function waitFor(getValue, { label = '依赖', timeout = 20000, interval = 50 } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    (function tick() {
      const value = getValue();
      if (value) return resolve(value);
      if (Date.now() - startedAt > timeout) {
        return reject(new Error(`${label} 加载超时，请检查网络后刷新`));
      }
      setTimeout(tick, interval);
    })();
  });
}

export class ScorePlayer {
  /**
   * @param {object} options
   * @param {(program: number) => string} options.buildAbc 生成带音色的 ABC 谱
   * @param {(message: string, level?: 'info'|'error') => void} [options.onStatus]
   */
  constructor({ buildAbc, onStatus = () => {} }) {
    this.buildAbc = buildAbc;
    this.onStatus = onStatus;
    this.program = DEFAULT_PROGRAM;
    this.abcjs = null;
    this.synth = null;
    this.audioContext = null;
    this.visualObj = null;
    this.primed = false;
    /** 播放状态：'idle' 未播放/已停止，'playing' 播放中，'paused' 已暂停 */
    this.state = 'idle';
    this.startedAt = 0; // 本次播放起点（AudioContext 时间轴）
    this.pausedAt = 0;  // 暂停时的播放位置（秒）
    this.duration = 0;  // 音频总时长（秒），由初始化后的 abcjs 谱面给出
    this.hiddenDiv = null;
  }

  /** 等待 abcjs 就绪并准备离屏渲染容器 */
  async ready() {
    this.abcjs = await waitFor(() => window.ABCJS, { label: 'abcjs' });

    this.hiddenDiv = document.createElement('div');
    Object.assign(this.hiddenDiv.style, {
      position: 'absolute',
      left: '-9999px',
      top: '0',
      width: '800px',
    });
    document.body.appendChild(this.hiddenDiv);

    this.resetSynth();
    return this;
  }

  resetSynth() {
    if (this.abcjs) {
      this.synth = new this.abcjs.synth.CreateSynth();
    }
  }

  /** abcjs 渲染（离屏，仅用于生成音频所需的 visualObj） */
  renderForAudio() {
    const abc = this.buildAbc(this.program);
    return this.abcjs.renderAbc(this.hiddenDiv, abc, { responsive: 'resize' })[0];
  }

  /** 切换音色：音色写在 ABC 的 %%MIDI program 里，需重新渲染并重新 prime */
  setProgram(program) {
    // 注意：钢琴的编号是 0，是 falsy 值，这里必须用 Number.isInteger 判断，
    // 否则会被 || 回退成默认音色，导致「选钢琴没反应」。
    const parsed = Number.parseInt(program, 10);
    const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= 127;
    this.program = valid ? parsed : DEFAULT_PROGRAM;
    this.stop();
    this.resetSynth();
    this.visualObj = null;
    this.primed = false;
    this.state = 'idle'; // 音色变了，重新初始化后从头播放
    this.startedAt = 0;
    this.pausedAt = 0;
    this.duration = 0;
    this.onStatus('音色已切换，点击播放重新加载');
  }

  async play() {
    if (!this.primed) {
      this.onStatus('正在加载音色并预渲染…');

      if (!this.audioContext) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        this.audioContext = new AudioCtx();
      }
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      if (!this.visualObj) {
        this.visualObj = this.renderForAudio();
      }

      try {
        await this.synth.init({
          audioContext: this.audioContext,
          visualObj: this.visualObj,
          soundFontUrl: SOUND_FONT_URL,
          soundFontVolumeMultiplier: 3.0,
        });
        await this.synth.prime();
        this.primed = true;
        this.state = 'idle'; // 刚初始化好，播放位置在开头
        this.duration = (this.visualObj && typeof this.visualObj.getTotalTime === 'function')
          ? this.visualObj.getTotalTime()
          : 0;
      } catch (err) {
        console.error('音频初始化失败:', err);
        this.onStatus('音频加载失败，请检查网络或浏览器控制台', 'error');
        return false;
      }
    }

    // 暂停后继续：用 resume() 从暂停处接着放。
    // 不能用 stop() —— 它会把播放位置归零，导致「暂停再播放从头开始」。
    if (this.state === 'paused') {
      this.synth.resume();
      this.startedAt = this.audioContext.currentTime - this.pausedAt;
      this.state = 'playing';
      this.onStatus('继续播放…');
      return true;
    }

    try { this.synth.stop(); } catch (err) { /* 忽略 */ }
    this.synth.start();
    this.startedAt = this.audioContext.currentTime;
    this.pausedAt = 0;
    this.state = 'playing';
    this.onStatus('正在播放…');
    return true;
  }

  /** 当前播放位置（秒） */
  currentTime() {
    if (this.state === 'paused') return this.pausedAt;
    if (this.state !== 'playing' || !this.audioContext) return 0;
    return Math.max(0, this.audioContext.currentTime - this.startedAt);
  }

  /**
   * 交给播放进度高亮的位置（秒）。
   * 返回 null 表示当前没有进度（未播放 / 已停止 / 刚放完）。
   * 顺手在这里判定“放到底了”：进度循环每帧都会问一次，正好收尾。
   */
  progressTime() {
    if (this.state === 'idle' || !this.audioContext) return null;
    if (this.state === 'paused') return this.pausedAt;

    const time = Math.max(0, this.audioContext.currentTime - this.startedAt);
    if (this.duration > 0 && time >= this.duration) {
      this.finish();
      return null;
    }
    return time;
  }

  /** 播放到结尾：收尾，并把状态告诉界面 */
  finish() {
    if (this.synth) {
      try { this.synth.stop(); } catch (err) { /* 忽略 */ }
    }
    this.startedAt = 0;
    this.pausedAt = 0;
    this.state = 'idle';
    this.onStatus('播放完毕');
  }

  pause() {
    if (!this.synth || !this.primed) return;
    this.pausedAt = this.currentTime();
    this.synth.pause();
    this.state = 'paused';
    this.onStatus('已暂停');
  }

  stop() {
    if (!this.synth || !this.primed) return;
    try { this.synth.stop(); } catch (err) { /* 忽略 */ }
    this.startedAt = 0;
    this.pausedAt = 0;
    this.state = 'idle';
    this.onStatus('已停止');
  }
}
