/* Keeping a stack going while the app is off screen (experimental).
   Android Chrome freezes, then closes, a page that isn't on screen, but it treats a page that is
   playing sound as one the user is listening to: no freezing, a media notification, and (on
   Android) a foreground service that keeps the browser alive. So while a stack runs, this plays
   a near-silent hum (brown noise about 56 dB below full scale: Chrome counts anything above
   -72 dBFS as sound, while a phone speaker barely reproduces it) and puts the stack's progress in
   that notification, with the maths view as its picture.
   SpoodKeepAlive.start()                  -> Promise<boolean>; call from a tap (autoplay rules)
   SpoodKeepAlive.update(title, text, canvas?)   the notification's words and picture
   SpoodKeepAlive.stop()
   SpoodKeepAlive.popOut(canvas)           -> Promise<boolean>; the canvas in a picture-in-picture
                                              window (call from a tap), kept until stop() */
(function (root) {
  'use strict';
  let audio = null, url = null, pip = null, lastArt = 0, timer = 0, playing = false;

  /** a seamless 8 s loop of brown noise, 16-bit mono WAV, at rmsDb (dBFS) */
  function humWav(rmsDb = -56, secs = 8, rate = 22050) {
    const n = secs * rate, x = new Float32Array(n);
    let b = 0, seed = 12345;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
    for (let i = 0; i < n; i++) { b = 0.985 * b + 0.05 * rnd(); x[i] = b; }   // brown-ish: a low rumble a phone speaker hardly plays, steady enough to never dip near -72 dBFS
    // loop seam: cross-fade the last half second into the first
    const f = Math.floor(rate * 0.5);
    for (let i = 0; i < f; i++) { const w = i / f; x[i] = x[i] * w + x[n - f + i] * (1 - w); }
    let mean = 0; for (let i = 0; i < n - f; i++) mean += x[i]; mean /= n - f;
    let ss = 0; for (let i = 0; i < n - f; i++) { x[i] -= mean; ss += x[i] * x[i]; }
    const gain = Math.pow(10, rmsDb / 20) / Math.sqrt(ss / (n - f));
    const len = n - f, buf = new ArrayBuffer(44 + len * 2), v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + len * 2, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, len * 2, true);
    for (let i = 0; i < len; i++) v.setInt16(44 + i * 2, Math.max(-32767, Math.min(32767, Math.round(x[i] * gain * 32767))), true);
    return new Blob([buf], { type: 'audio/wav' });
  }

  async function start() {
    if (playing) return true;
    try {
      if (!url) url = URL.createObjectURL(humWav());
      audio = audio || Object.assign(new Audio(url), { loop: true, preload: 'auto' });
      audio.volume = 1;
      await audio.play();
      playing = true;
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing';
        // the notification's pause button: pausing would let the page freeze, so say so and carry on
        try { navigator.mediaSession.setActionHandler('pause', () => { update('Still stacking', 'Pausing would let the phone stop the stack. Close the app to stop it.'); }); } catch (e) { /* not supported */ }
        try { navigator.mediaSession.setActionHandler('play', () => { audio && audio.play().catch(() => {}); }); } catch (e) { /* not supported */ }
      }
      return true;
    } catch (e) { playing = false; return false; }
  }

  function update(title, text, canvas) {
    if (!playing || !('mediaSession' in navigator) || !root.MediaMetadata) return;
    const meta = { title, artist: text, album: 'Spood Stacker' };
    // the picture: a square crop of the maths view, refreshed every few seconds
    if (canvas && performance.now() - lastArt > 3500) {
      try {
        const s = 256, c = document.createElement('canvas'); c.width = c.height = s;
        const k = Math.min(canvas.width, canvas.height);
        c.getContext('2d').drawImage(canvas, (canvas.width - k) / 2, (canvas.height - k) / 2, k, k, 0, 0, s, s);
        update.art = [{ src: c.toDataURL('image/jpeg', 0.75), sizes: `${s}x${s}`, type: 'image/jpeg' }];
        lastArt = performance.now();
      } catch (e) { /* tainted or unsupported */ }
    }
    if (update.art) meta.artwork = update.art;
    try { navigator.mediaSession.metadata = new MediaMetadata(meta); } catch (e) { /* ignore */ }
  }

  async function popOut(canvas, draw) {
    if (!document.pictureInPictureEnabled || !canvas.captureStream) return false;
    try {
      if (!pip) {
        pip = document.createElement('video');
        pip.muted = true; pip.playsInline = true;
        pip.srcObject = canvas.captureStream(12);
        pip.addEventListener('leavepictureinpicture', () => { clearInterval(timer); timer = 0; });
      }
      await pip.play();
      await pip.requestPictureInPicture();
      // off screen the page gets no animation frames, so the window would freeze: draw on a timer
      clearInterval(timer);
      if (draw) timer = setInterval(() => { if (document.hidden) draw(); }, 120);
      return true;
    } catch (e) { return false; }
  }

  function stop() {
    playing = false; clearInterval(timer); timer = 0;
    if (audio) { try { audio.pause(); audio.currentTime = 0; } catch (e) { /* ignore */ } }
    if ('mediaSession' in navigator) { try { navigator.mediaSession.playbackState = 'none'; navigator.mediaSession.metadata = null; } catch (e) { /* ignore */ } }
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    update.art = null;
  }

  root.SpoodKeepAlive = { start, update, stop, popOut, humWav, get playing() { return playing; }, canPopOut: () => !!(document.pictureInPictureEnabled && HTMLCanvasElement.prototype.captureStream) };
})(self);
