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
    this.duration = 0;  // 音频总时长（秒），由页面通过 setDuration 传入
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

  /**
   * 声明音频会话类型（iOS 专有 API，Safari 16.4+ / iOS 17+）。
   *
   * iOS 上 Web Audio 默认走 `ambient` 类别，**会被手机侧边的静音开关掐掉**：
   * 页面照常显示“正在播放”、Safari 也亮着扬声器图标、进度条也在走，
   * 但一点声音都出不来（WebKit bug 237322：By default the type is ambient
   * and so audio will be muted if the phone is muted）。
   * 声明成 `playback` 就按媒体播放处理，与视频 / 音乐播放器一致，不受静音开关影响。
   *
   * 桌面浏览器、旧 Safari、Node 没有这个 API，直接跳过。
   */
  usePlaybackSession() {
    if (typeof navigator === 'undefined' || !navigator.audioSession) return;
    try {
      navigator.audioSession.type = 'playback';
    } catch (err) {
      // 只读或未实现：不影响播放，忽略
    }
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
    this.onStatus('音色已切换，点击播放重新加载');
  }

  async play() {
    // 每次播放都声明一次：系统有可能把它重置回默认类别
    this.usePlaybackSession();

    if (!this.primed) {
      this.onStatus('正在加载音色并预渲染…');

      if (!this.audioContext) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        this.audioContext = new AudioCtx();
      }
      // 不能只认 'suspended'：iOS 在切后台 / 来电 / 锁屏之后会把 AudioContext
      // 置成它专有的 'interrupted'，只判断 'suspended' 会让之后再播放永远没声音。
      if (this.audioContext.state !== 'running') {
        try {
          await this.audioContext.resume();
        } catch (err) {
          console.warn('音频上下文恢复失败:', err);
        }
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

  /**
   * 设置音频总时长（秒）——“播放到底”的判定靠它。
   *
   * 由页面在渲染完简谱后传入简谱时间轴的总长。不用 abcjs 的 getTotalTime()：
   * 它只有在传 tempo 调过 millisecondsPerMeasure() 之后才有值，是内部实现细节，
   * 直接读会拿到 undefined，于是“播放到底”永远不触发。
   * 简谱时间轴与音频时长一致：两边速度由 tools/check.mjs 强制相等。
   */
  setDuration(seconds) {
    this.duration = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
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
