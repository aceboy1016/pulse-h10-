/*
 * PULSE — 心拍の入力源
 *   HeartRateMonitor : Web Bluetooth 標準 Heart Rate Service (0x180D) / Measurement (0x2A37)
 *   DemoSource       : 動作確認用の模擬信号（実測ではない。記録には source='demo' を付ける）
 * どちらも 'hr' {t, bpm, contact} / 'state' {state, message} / 'disconnect' イベントを出す。
 */
(function (root) {
  'use strict';
  const HR_SERVICE = 0x180d;
  const HR_MEASUREMENT = 0x2a37;

  function emit(target, type, detail) { target.dispatchEvent(new CustomEvent(type, { detail: detail })); }

  class HeartRateMonitor extends EventTarget {
    constructor() {
      super();
      this.device = null;
      this.characteristic = null;
      this.state = 'idle';
      this.manual = false;
      this.retry = 0;
      this.retryTimer = null;
      this._onValue = this._onValue.bind(this);
      this._onDisconnected = this._onDisconnected.bind(this);
    }

    static support() {
      if (!root.isSecureContext) return { ok: false, reason: 'insecure' };
      if (!navigator.bluetooth) return { ok: false, reason: 'unsupported' };
      return { ok: true };
    }

    _setState(state, message) { this.state = state; emit(this, 'state', { state: state, message: message || '' }); }

    async connect() {
      const sup = HeartRateMonitor.support();
      if (!sup.ok) { this._setState('unsupported'); throw new Error(sup.reason); }
      this.manual = false;
      let device;
      try {
        this._setState('requesting', 'デバイスを選択してください');
        device = await navigator.bluetooth.requestDevice({
          filters: [{ services: [HR_SERVICE] }],
          optionalServices: [HR_SERVICE]
        });
      } catch (e) {
        if (e && e.name === 'NotFoundError') this._setState('idle', '選択がキャンセルされました');
        else if (e && e.name === 'SecurityError') this._setState('error', 'Bluetoothの使用が許可されていません');
        else this._setState('error', 'デバイスを選択できませんでした');
        throw e;
      }
      if (this.device && this.device !== device) this.device.removeEventListener('gattserverdisconnected', this._onDisconnected);
      this.device = device;
      device.addEventListener('gattserverdisconnected', this._onDisconnected);
      await this._connectGatt();
    }

    async _connectGatt() {
      this._setState('connecting', '接続中…');
      try {
        const server = await this.device.gatt.connect();
        const service = await server.getPrimaryService(HR_SERVICE);
        const ch = await service.getCharacteristic(HR_MEASUREMENT);
        if (this.characteristic) this.characteristic.removeEventListener('characteristicvaluechanged', this._onValue);
        ch.addEventListener('characteristicvaluechanged', this._onValue);
        await ch.startNotifications();
        this.characteristic = ch;
        this.retry = 0;
        this._setState('connected', this.device.name || '心拍センサー');
      } catch (e) {
        this._setState('error', '接続に失敗しました');
        throw e;
      }
    }

    _onValue(ev) {
      const r = root.PulsePhysio.parseHeartRate(ev.target.value);
      if (!r) return;
      emit(this, 'hr', { t: Date.now(), bpm: r.bpm, contact: r.contact, rr: r.rr });
    }

    _onDisconnected() {
      emit(this, 'disconnect', { t: Date.now(), manual: this.manual });
      if (this.manual) { this._setState('idle', '切断しました'); return; }
      // 意図しない切断：最大3回まで自動再接続を試みる
      if (this.retry < 3) {
        const wait = 1000 * Math.pow(2, this.retry);
        this.retry++;
        this._setState('reconnecting', '切断されました。再接続中…（' + this.retry + '/3）');
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
          if (this.manual || !this.device) return;
          this._connectGatt().catch(() => { if (!this.device.gatt.connected) this._onDisconnected(); });
        }, wait);
      } else {
        this._setState('lost', '接続が切れました。「H10に接続」から再接続してください');
      }
    }

    async disconnect() {
      this.manual = true;
      clearTimeout(this.retryTimer);
      try { if (this.characteristic) await this.characteristic.stopNotifications(); } catch (_) { /* 切断済み */ }
      if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
      else this._setState('idle', '切断しました');
    }
  }

  // 模擬信号：フェーズに応じて心拍を目標値へ近づける（1秒ごと）
  class DemoSource extends EventTarget {
    constructor() {
      super();
      this.timer = null;
      this.bpm = 72;
      this.mode = 'rest';      // rest | exercise | recovery
      this.state = 'idle';
    }
    start() {
      if (this.timer) return;
      this.state = 'connected';
      emit(this, 'state', { state: 'connected', message: 'デモ信号（実測ではありません）' });
      this.timer = setInterval(() => this._tick(), 1000);
      this._tick();
    }
    stop() {
      clearInterval(this.timer); this.timer = null;
      this.state = 'idle';
      emit(this, 'disconnect', { t: Date.now(), manual: true });
      emit(this, 'state', { state: 'idle', message: 'デモを停止しました' });
    }
    setMode(mode) { this.mode = mode; }
    _tick() {
      const target = this.mode === 'exercise' ? 152 : this.mode === 'recovery' ? 96 : 70;
      const k = this.mode === 'recovery' ? 0.02 : this.mode === 'exercise' ? 0.06 : 0.08;
      this.bpm += (target - this.bpm) * k + (Math.random() - 0.5) * 2.2;
      emit(this, 'hr', { t: Date.now(), bpm: Math.round(this.bpm), contact: true, rr: [] });
    }
  }

  root.HeartRateMonitor = HeartRateMonitor;
  root.DemoSource = DemoSource;
})(window);
