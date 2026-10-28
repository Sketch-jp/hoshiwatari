// ほしわたり — タップで星から星へ渡るワンタップゲーム
(function () {
  'use strict';

  // ===== 調整値（バランスはここだけで変える） =====
  const CONFIG = {
    viewW: 400,
    minViewH: 600,
    maxViewH: 860,
    flySpeed: 430,          // 飛行中の速さ（px/秒）
    flyTimeout: 1.6,        // これ以上どこにも捕まらなければ迷子（飛べる距離の上限にもなる）
    gravity: 3.0e6,         // 近くの星が飛行経路を曲げる強さ
    gravityRange: 2.5,      // 輪の半径の何倍まで引力が届くか
    grazeRadial: 0.58,      // 進入方向の「半径方向成分」がこれ未満ならギリギリ（でたらめに押して成功の約2割）
    decayTime: 0.55,        // 輪がゼロになってから墜落するまで
    basePoints: 10,
    grazePoints: 10,        // ギリギリ1回あたり ×コンボ数
    skipPoints: 10,         // 星を1つ飛び越えるごとの上乗せ（とびこしは成功の約4割で起きるので控えめ）
    rampPlanets: 45,        // 何個目で最高難度に達するか
    guideLong: 150,         // 最初の数個だけ出す長いガイド線
    guideShort: 46,
    guideLongUntil: 3,
    retryLock: 0.45,        // 結果画面のボタンを押せるまでの秒数
  };

  const STORE_KEY = 'hoshiwatari.save';
  const SAVE_VERSION = 2;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TOP_N = 5;

  // 称号：わたった星の数で決まる（結果画面とシェア文に出す）
  const TITLES = [
    [0, '宇宙のまいご'],
    [3, 'ほしの見習い'],
    [6, 'ほしわたり'],
    [10, '流れ星'],
    [15, '彗星のり'],
    [25, '銀河わたり'],
    [40, '天の川のぬし'],
  ];
  function titleFor(planets) {
    let t = TITLES[0][1];
    for (const [min, name] of TITLES) if (planets >= min) t = name;
    return t;
  }
  const W = CONFIG.viewW;

  // ===== 小道具 =====
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashString(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  // 今日のコースは日本時間の0時で切り替える（どの国の端末でも同じ日に同じコース）
  function todayKey(now) {
    const d = new Date((now === undefined ? Date.now() : now) + 9 * 3600 * 1000);
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return d.getUTCFullYear() + '-' + m + '-' + day;
  }

  function shortDate(key) {
    const p = key.split('-');
    return Number(p[1]) + '/' + Number(p[2]);
  }

  // ===== コース（星の並び）。同じ seed なら必ず同じ並びになる =====
  function createCourse(seed) {
    const rnd = mulberry32(seed);
    const planets = [];

    function next() {
      const i = planets.length;
      const t = Math.min(1, i / CONFIG.rampPlanets);
      const r = i === 0 ? 38 : lerp(36, 24, t) + (rnd() - 0.5) * 10;
      const ring = r + (i === 0 ? 46 : lerp(42, 25, t) + rnd() * 6);
      let x = W / 2, y = 0, amp = 0, freq = 0, phase = 0;
      if (i > 0) {
        const prev = planets[i - 1];
        const margin = r + 24;
        for (let k = 0; k < 8; k++) {
          x = lerp(margin, W - margin, rnd());
          if (Math.abs(x - prev.baseX) > 55) break;
        }
        // 縦の間隔を輪の大きさ以上にとれば、横に動いても輪は重ならない
        const gap = lerp(175, 235, t) + rnd() * 40;
        y = prev.y - Math.max(gap, prev.ring + ring + 24);
        if (i >= 6 && rnd() < Math.min(0.65, 0.2 + (i - 6) * 0.025)) {
          amp = lerp(25, 85, t) * (0.5 + rnd() * 0.5);
          amp = Math.min(amp, x - r - 10, W - r - 10 - x);
          if (amp < 12) amp = 0;
          freq = 0.6 + rnd() * 0.7;
          phase = rnd() * Math.PI * 2;
        }
      }
      planets.push({
        i, baseX: x, x, y, r, ring, amp, freq, phase,
        mass: (r / 30) * (r / 30),
        orbitTime: i === 0 ? Infinity : lerp(4.6, 2.6, t),
        orbitSpeed: lerp(250, 330, t),
        hue: Math.floor(rnd() * 360),
        hue2: Math.floor(rnd() * 360),
        face: i === 0 || rnd() < 0.55,
        band: rnd() < 0.45,
        saturn: rnd() < 0.22,
        mood: 0,
      });
    }

    return {
      seed,
      planets,
      ensure(n) { while (planets.length < n) next(); },
    };
  }

  function planetX(p, time) {
    return p.amp ? p.baseX + p.amp * Math.sin(p.phase + p.freq * time) : p.baseX;
  }

  // 飛行を dt 進める。輪に入った星を返す（なければ null）
  function flightStep(c, course, time, dt) {
    const lo = Math.max(0, c.from - 2), hi = c.from + 4;
    course.ensure(hi + 1);
    let ax = 0, ay = 0;
    for (let k = lo; k <= hi; k++) {
      if (k === c.from) continue;
      const p = course.planets[k];
      const dx = planetX(p, time) - c.x, dy = p.y - c.y;
      const d2 = dx * dx + dy * dy;
      const reach = p.ring * CONFIG.gravityRange;
      if (d2 < reach * reach) {
        const d = Math.sqrt(d2);
        const f = CONFIG.gravity * p.mass / d2;
        ax += f * dx / d; ay += f * dy / d;
      }
    }
    c.vx += ax * dt; c.vy += ay * dt;
    const sp = Math.hypot(c.vx, c.vy) || 1;
    c.vx = c.vx / sp * CONFIG.flySpeed; c.vy = c.vy / sp * CONFIG.flySpeed;
    c.x += c.vx * dt; c.y += c.vy * dt;
    c.flyTime += dt;
    for (let k = lo; k <= hi; k++) {
      if (k === c.from) continue;
      const p = course.planets[k];
      if (Math.hypot(c.x - planetX(p, time), c.y - p.y) < p.ring) return p;
    }
    return null;
  }

  function launchFrom(c) {
    const tx = -Math.sin(c.angle) * c.dir, ty = Math.cos(c.angle) * c.dir;
    return { mode: 'fly', x: c.x, y: c.y, vx: tx * CONFIG.flySpeed, vy: ty * CONFIG.flySpeed, from: c.p, flyTime: 0 };
  }

  // 自動操縦：今飛び出したら前の星に捕まるかを先読みする（デモ画面と試験で使う）
  function botWantsLaunch(g) {
    const c = g.comet;
    if (!c || c.mode !== 'orbit' || c.decaying) return false;
    const sim = launchFrom(c);
    const dt = 1 / 60;
    let t = g.time;
    for (let s = 0; s < CONFIG.flyTimeout / dt; s++) {
      t += dt;
      const hit = flightStep(sim, g.course, t, dt);
      if (hit) return hit.i > c.p;
      if (sim.x < -40 || sim.x > W + 40) return false;
    }
    return false;
  }

  // ===== 結果のシェア文 =====
  function buildStrip(log) {
    const max = 30;
    if (log.length <= max) return log.join('');
    return log.slice(0, max - 1).join('') + '…' + log[log.length - 1];
  }

  function buildShareText(result, url) {
    const head = result.mode === 'daily'
      ? 'ほしわたり 🌠 今日のコース ' + shortDate(result.date) + (result.tries ? '（' + result.tries + '回目）' : '')
      : 'ほしわたり 🌠 フリーコース';
    const lines = [
      head,
      '称号【' + titleFor(result.planets) + '】' + result.score + '点 ／ ' + result.planets + 'こ わたった',
      '✨ギリギリ ' + result.grazes + '回（最大コンボ ' + result.maxCombo + '）' + (result.skips ? ' 🚀とびこし ' + result.skips + '回' : ''),
      buildStrip(result.log),
      '#ほしわたり',   // X でみんなの結果を検索で集められるように（タグは1つだけ）
    ];
    if (url) lines.push(url);
    return lines.join('\n');
  }

  // ===== 保存（このブラウザの中だけ） =====
  const Store = {
    data: null,
    defaults() { return { version: SAVE_VERSION, best: 0, daily: {}, plays: 0, muted: false, seenHelp: false, tries: {}, top: [], dayTop: {} }; },
    load() {
      this.data = this.defaults();
      let raw = null;
      try { raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { raw = null; }
      if (raw && typeof raw === 'object') {
        // 版ごとの移行処理はここに足す（今は version 1 のみ）
        const n = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
        this.data.best = n(raw.best);
        this.data.plays = n(raw.plays);
        this.data.muted = raw.muted === true;
        this.data.seenHelp = raw.seenHelp === true;
        const dateKeys = (o) => (o && typeof o === 'object' ? Object.keys(o).filter((k) => DATE_RE.test(k)).sort().slice(-30) : []);
        dateKeys(raw.daily).forEach((k) => { this.data.daily[k] = n(raw.daily[k]); });
        // version 1 → 2：挑戦回数と自分ランキングを追加（無ければ空のまま）
        dateKeys(raw.tries).forEach((k) => { this.data.tries[k] = n(raw.tries[k]); });
        const run = (r, withDate) => {
          if (!r || typeof r !== 'object') return null;
          const out = { s: n(r.s), p: n(r.p) };
          if (withDate) { if (!DATE_RE.test(r.d)) return null; out.d = r.d; }
          return out;
        };
        const top = (list, withDate) => (Array.isArray(list) ? list.map((r) => run(r, withDate)).filter(Boolean).sort((a, b) => b.s - a.s).slice(0, TOP_N) : []);
        this.data.top = top(raw.top, true);
        dateKeys(raw.dayTop).forEach((k) => { this.data.dayTop[k] = top(raw.dayTop[k], false); });
      }
    },
    // 1回分の結果を記録し、今日の自分順位（1始まり、圏外は 0）を返す
    record(date, score, planets, isDaily) {
      const insert = (list, entry) => {
        list.push(entry);
        list.sort((a, b) => b.s - a.s);
        const rank = list.indexOf(entry) + 1;
        list.length = Math.min(list.length, TOP_N);
        return rank <= TOP_N ? rank : 0;
      };
      this.data.plays++;
      insert(this.data.top, { s: score, p: planets, d: date });
      let rank = 0;
      if (isDaily) {
        this.data.tries[date] = (this.data.tries[date] || 0) + 1;
        rank = insert(this.data.dayTop[date] || (this.data.dayTop[date] = []), { s: score, p: planets });
        const keep = (o) => Object.keys(o).sort().slice(0, -30).forEach((k) => delete o[k]);
        keep(this.data.tries); keep(this.data.dayTop); keep(this.data.daily);
      }
      return rank;
    },
    save() {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(this.data)); } catch (e) { /* 保存できない環境でも遊べる */ }
    },
    resetRecords() {
      const muted = this.data.muted, seenHelp = this.data.seenHelp;
      this.data = this.defaults();
      this.data.muted = muted; this.data.seenHelp = seenHelp;
      this.save();
    },
  };

  // ===== 効果音（その場で合成。音声ファイルは使わない） =====
  const Sound = {
    ctx: null,
    unlock() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) { try { this.ctx = new AC(); } catch (e) { this.ctx = null; } }
      }
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    },
    tone(freq, dur, type, vol, slideTo, delay) {
      if (Store.data.muted || !this.ctx) return;
      const ctx = this.ctx, t0 = ctx.currentTime + (delay || 0);
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, t0);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol || 0.12, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(ctx.destination);
      o.start(t0); o.stop(t0 + dur + 0.02);
    },
    noise(dur, vol) {
      if (Store.data.muted || !this.ctx) return;
      const ctx = this.ctx, len = Math.floor(ctx.sampleRate * dur);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      f.type = 'lowpass'; f.frequency.value = 900;
      g.gain.value = vol;
      src.buffer = buf;
      src.connect(f).connect(g).connect(ctx.destination);
      src.start();
    },
    scale: [523, 587, 659, 784, 880, 1047, 1175, 1319, 1568, 1760, 2093],
    play(name, n) {
      if (game.mode === 'demo') return; // タイトル裏の自動プレイは無音
      switch (name) {
        case 'launch': this.tone(300, 0.12, 'triangle', 0.08, 620); break;
        case 'catch': this.tone(this.scale[Math.min(n || 0, 4)], 0.18, 'sine', 0.14); break;
        case 'graze': {
          const k = Math.min(n || 0, this.scale.length - 2);
          this.tone(this.scale[k], 0.14, 'triangle', 0.12);
          this.tone(this.scale[k + 1] * 2, 0.22, 'sine', 0.07, null, 0.06);
          break;
        }
        case 'warn': this.tone(220, 0.06, 'square', 0.03); break;
        case 'crash': this.noise(0.45, 0.35); this.tone(160, 0.4, 'sawtooth', 0.06, 50); break;
        case 'lost': this.tone(440, 0.5, 'sine', 0.08, 110); break;
        case 'best': [784, 988, 1175, 1568].forEach((f, i) => this.tone(f, 0.2, 'triangle', 0.1, null, i * 0.09)); break;
      }
    },
  };

  // ===== ゲーム状態 =====
  const game = {
    state: 'boot',          // title / play / paused / over
    mode: 'demo',           // demo / daily / free
    date: todayKey(),
    course: null,
    time: 0,
    camY: 0,
    viewH: 760,
    comet: null,
    trail: [],
    particles: [],
    floaters: [],
    score: 0,
    maxIndex: 0,
    combo: 0,
    maxCombo: 0,
    grazes: 0,
    log: [],
    shake: 0,
    deadTimer: 0,
    overAt: 0,
    startedAt: 0,
    lastResult: null,
    manual: false,          // 試験用：true の間は画面の更新ループがゲームを進めない
  };

  const stars = [];
  (function makeStars() {
    const rnd = mulberry32(7);
    for (let i = 0; i < 140; i++) {
      stars.push({ x: rnd() * W, y: rnd() * 1000, depth: [0.15, 0.3, 0.55][i % 3], size: rnd() * 1.4 + 0.4, tw: rnd() * 6 });
    }
  })();

  function resetRun(mode, seed) {
    game.mode = mode;
    game.date = todayKey();
    if (seed === undefined) {
      seed = mode === 'daily' ? hashString('hoshiwatari:' + game.date)
        : mode === 'demo' ? 900 + Math.floor(Math.random() * 1000)
          : Math.floor(Math.random() * 4294967295);
    }
    game.course = createCourse(seed >>> 0);
    game.course.ensure(8);
    game.time = 0;
    const p0 = game.course.planets[0];
    game.comet = { mode: 'orbit', p: 0, angle: Math.PI * 0.75, dir: 1, radius: p0.ring, orbitClock: 0, decaying: false, x: 0, y: 0 };
    placeOnOrbit(game.comet, p0);
    game.camY = p0.y - game.viewH * 0.66;
    game.trail = [];
    game.particles = [];
    game.floaters = [];
    game.score = 0; game.maxIndex = 0; game.combo = 0; game.maxCombo = 0; game.grazes = 0; game.skips = 0;
    game.log = [];
    game.shake = 0; game.deadTimer = 0;
  }

  function placeOnOrbit(c, p) {
    c.x = p.x + Math.cos(c.angle) * c.radius;
    c.y = p.y + Math.sin(c.angle) * c.radius;
  }

  function tap() {
    if (game.state !== 'play') return;
    if (game.time - game.startedAt < 0.12) return;
    const c = game.comet;
    if (c.mode !== 'orbit') return;
    game.comet = launchFrom(c);
    Sound.play('launch');
    burst(c.x, c.y, 8, 'rgba(180,240,255,1)', 90);
  }

  // 輪に入った向きの「半径方向成分」（0＝ふちを横からかすめた、1＝真正面から）
  function entryRadial(c, px, py) {
    const rx = c.x - px, ry = c.y - py;
    const d = Math.hypot(rx, ry) || 1;
    return Math.abs((c.vx * rx + c.vy * ry) / (CONFIG.flySpeed * d));
  }

  function capture(p) {
    const c = game.comet;
    const px = p.x;
    const rx = (c.x - px), ry = (c.y - p.y);
    const radial = entryRadial(c, px, p.y);
    const cross = rx * c.vy - ry * c.vx;
    game.comet = {
      mode: 'orbit', p: p.i, angle: Math.atan2(ry, rx), dir: cross >= 0 ? 1 : -1,
      radius: p.ring, orbitClock: 0, decaying: false, x: c.x, y: c.y,
    };
    p.mood = 1.2;
    if (p.i <= game.maxIndex) {
      // 戻った星では点にならない
      Sound.play('catch', 0);
      return;
    }
    const steps = p.i - game.maxIndex;
    game.maxIndex = p.i;
    game.course.ensure(p.i + 8);
    const skip = steps > 1;
    let pts = CONFIG.basePoints * steps + (skip ? CONFIG.skipPoints * (steps - 1) : 0);
    const graze = radial < CONFIG.grazeRadial;
    const label = [];
    if (skip) { game.skips++; label.push('とびこし！'); }
    if (graze) {
      game.combo++;
      game.grazes++;
      game.maxCombo = Math.max(game.maxCombo, game.combo);
      pts += CONFIG.grazePoints * game.combo;
      label.push('ギリギリ！' + (game.combo > 1 ? '×' + game.combo : ''));
      burst(c.x, c.y, 26, 'rgba(255,214,120,1)', 220);
      ring(px, p.y, p.ring);
      Sound.play('graze', game.combo);
    } else {
      game.combo = 0;
      burst(c.x, c.y, skip ? 24 : 12, skip ? 'rgba(255,160,220,1)' : 'rgba(160,230,255,1)', skip ? 200 : 120);
      Sound.play(skip ? 'graze' : 'catch', skip ? 3 : Math.min(4, p.i % 5));
    }
    game.log.push(graze && skip ? '🌟' : graze ? '✨' : skip ? '🚀' : '🪐');
    floater(c.x, c.y - 18, '+' + pts + (label.length ? '  ' + label.join(' ') : ''), graze ? '#ffcf7a' : skip ? '#ffa8dc' : '#ffffff', label.length ? 18 : 16);
    game.score += pts;
    if (game.mode !== 'demo') updateHud();
  }

  function die(kind) {
    const c = game.comet;
    c.mode = 'dead';
    c.kind = kind;
    game.deadTimer = 0;
    game.log.push(kind === 'crash' ? '💥' : '🌀');
    if (kind === 'crash') {
      burst(c.x, c.y, 50, 'rgba(255,140,90,1)', 260);
      burst(c.x, c.y, 24, 'rgba(255,240,200,1)', 140);
      game.shake = 12;
      Sound.play('crash');
      if (game.mode !== 'demo' && navigator.vibrate) { try { navigator.vibrate(40); } catch (e) { /* 非対応 */ } }
    } else {
      Sound.play('lost');
    }
  }

  function update(dt) {
    game.time += dt;
    const course = game.course;
    const c = game.comet;
    const lo = Math.max(0, game.maxIndex - 4);
    course.ensure(game.maxIndex + 8);
    for (let k = lo; k < Math.min(course.planets.length, game.maxIndex + 8); k++) {
      const p = course.planets[k];
      p.x = planetX(p, game.time);
      if (p.mood > 0) p.mood -= dt;
    }

    if (c.mode === 'orbit') {
      const p = course.planets[c.p];
      c.orbitClock += dt;
      if (c.orbitClock > p.orbitTime) {
        if (!c.decaying) { c.decaying = true; Sound.play('warn'); }
        c.radius -= (p.ring - p.r) * dt / CONFIG.decayTime;
      }
      c.angle += c.dir * (p.orbitSpeed / Math.max(c.radius, 1)) * dt;
      placeOnOrbit(c, p);
      if (c.radius <= p.r + 2) die('crash');
      else if (game.mode === 'demo' && botWantsLaunch(game)) {
        game.comet = launchFrom(c);
      }
    } else if (c.mode === 'fly') {
      const hit = flightStep(c, course, game.time, dt);
      if (hit) capture(hit);
      else if (c.flyTime > CONFIG.flyTimeout || c.x < -40 || c.x > W + 40 || c.y > game.camY + game.viewH + 40) die('lost');
    } else if (c.mode === 'dead') {
      game.deadTimer += dt;
    }

    // 尾
    if (c.mode !== 'dead') {
      game.trail.push({ x: game.comet.x, y: game.comet.y });
      if (game.trail.length > 26) game.trail.shift();
    } else if (game.trail.length) {
      game.trail.shift();
    }

    // カメラ：今の星が画面の下寄りに来るように、飛んでいる間は彗星を追う
    const cc = game.comet;
    const anchor = course.planets[cc.mode === 'orbit' ? cc.p : (cc.from !== undefined ? cc.from : game.maxIndex)] || course.planets[game.maxIndex];
    let target = anchor.y - game.viewH * 0.66;
    if (cc.mode === 'fly') target = Math.min(target, cc.y - game.viewH * 0.42);
    game.camY += (target - game.camY) * (1 - Math.exp(-dt * 3.2));

    updateEffects(dt);
  }

  function updateEffects(dt) {
    for (let i = game.particles.length - 1; i >= 0; i--) {
      const q = game.particles[i];
      q.life -= dt;
      if (q.life <= 0) { game.particles.splice(i, 1); continue; }
      q.x += q.vx * dt; q.y += q.vy * dt;
      q.vx *= 1 - 2.2 * dt; q.vy *= 1 - 2.2 * dt;
    }
    for (let i = game.floaters.length - 1; i >= 0; i--) {
      const f = game.floaters[i];
      f.life -= dt; f.y -= 34 * dt;
      if (f.life <= 0) game.floaters.splice(i, 1);
    }
    game.shake = Math.max(0, game.shake - dt * 40);
  }

  function burst(x, y, n, color, speed) {
    for (let i = 0; i < n && game.particles.length < 500; i++) {
      const a = Math.random() * Math.PI * 2, s = speed * (0.3 + Math.random() * 0.7);
      game.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.4 + Math.random() * 0.5, max: 0.9, color, size: 1.5 + Math.random() * 2.5 });
    }
  }

  function ring(x, y, r) {
    game.particles.push({ x, y, vx: 0, vy: 0, life: 0.5, max: 0.5, color: 'ring', size: r });
  }

  function floater(x, y, text, color, size) {
    game.floaters.push({ x, y, text, color, size, life: 1.1 });
  }

  // ===== 描画 =====
  const canvas = document.getElementById('canvas');
  const ctx = canvas ? canvas.getContext('2d') : null;
  let scale = 1, dpr = 1, fontFamily = 'sans-serif';
  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function resize() {
    const el = document.getElementById('game');
    if (!el) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    game.viewH = clamp(Math.round(W * vh / vw), CONFIG.minViewH, CONFIG.maxViewH);
    scale = Math.min(vw / W, vh / game.viewH);
    const cssW = Math.floor(W * scale), cssH = Math.floor(game.viewH * scale);
    el.style.width = cssW + 'px';
    el.style.height = cssH + 'px';
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }

  function render() {
    const H = game.viewH;
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    const height = Math.max(0, -game.camY);
    const hue = (248 + height / 45) % 360;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, 'hsl(' + hue + ',55%,8%)');
    g.addColorStop(1, 'hsl(' + ((hue + 30) % 360) + ',58%,17%)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    for (const s of stars) {
      const y = ((s.y - game.camY * s.depth) % H + H) % H;
      const a = 0.45 + 0.4 * Math.sin(game.time * 2 + s.tw);
      ctx.fillStyle = 'rgba(255,255,255,' + a.toFixed(2) + ')';
      ctx.fillRect(s.x, y, s.size, s.size);
    }

    ctx.save();
    if (game.shake > 0 && !reducedMotion) ctx.translate((Math.random() - 0.5) * game.shake, (Math.random() - 0.5) * game.shake);
    ctx.translate(0, -game.camY);

    const course = game.course;
    const c = game.comet;
    if (course) {
      const top = game.camY - 120, bottom = game.camY + H + 120;
      for (let k = Math.max(0, game.maxIndex - 4); k < course.planets.length; k++) {
        const p = course.planets[k];
        if (p.y < top) break;
        if (p.y > bottom) continue;
        drawPlanet(p, c);
      }
      drawGuide(c);
      drawTrail();
      drawComet(c);
      drawParticles();
      drawFloaters();
      if (game.state === 'play' && game.maxIndex === 0 && c.mode === 'orbit') {
        const p0 = course.planets[0];
        ctx.fillStyle = 'rgba(255,255,255,' + (0.7 + 0.3 * Math.sin(game.time * 5)).toFixed(2) + ')';
        ctx.font = '800 22px ' + fontFamily;
        ctx.textAlign = 'center';
        ctx.fillText('タップで とびだす！', W / 2, p0.y + p0.ring + 48);
        ctx.font = '600 14px ' + fontFamily;
        ctx.fillStyle = 'rgba(200,220,255,0.85)';
        ctx.fillText('次の星の 点線の輪に入ろう', W / 2, p0.y + p0.ring + 74);
      }
    }
    ctx.restore();
  }

  function drawPlanet(p, c) {
    const x = p.x, y = p.y;
    const current = c && c.mode === 'orbit' && c.p === p.i;

    // 輪
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 7]);
    ctx.strokeStyle = p.i <= game.maxIndex && !current ? 'rgba(255,255,255,0.12)' : 'rgba(127,231,255,0.55)';
    ctx.beginPath(); ctx.arc(x, y, p.ring, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    if (current && Number.isFinite(p.orbitTime)) {
      const left = clamp(1 - c.orbitClock / p.orbitTime, 0, 1);
      ctx.lineWidth = 4;
      ctx.strokeStyle = left > 0.35 ? 'rgba(127,231,255,0.9)' : 'rgba(255,110,110,0.95)';
      ctx.beginPath(); ctx.arc(x, y, p.ring, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left); ctx.stroke();
    }

    // 本体
    if (p.saturn) drawSaturnRing(p, true);
    const g = ctx.createRadialGradient(x - p.r * 0.35, y - p.r * 0.4, p.r * 0.1, x, y, p.r);
    g.addColorStop(0, 'hsl(' + p.hue + ',90%,80%)');
    g.addColorStop(0.65, 'hsl(' + p.hue + ',70%,58%)');
    g.addColorStop(1, 'hsl(' + ((p.hue + 25) % 360) + ',60%,32%)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, p.r, 0, Math.PI * 2); ctx.fill();
    if (p.band) {
      ctx.save();
      ctx.beginPath(); ctx.arc(x, y, p.r, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = 'hsla(' + p.hue2 + ',80%,75%,0.35)';
      ctx.fillRect(x - p.r, y + p.r * 0.25, p.r * 2, p.r * 0.22);
      ctx.fillRect(x - p.r, y - p.r * 0.45, p.r * 2, p.r * 0.12);
      ctx.restore();
    }
    if (p.saturn) drawSaturnRing(p, false);
    if (p.face) drawFace(p, current && c.decaying);
  }

  function drawSaturnRing(p, back) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(-0.35);
    ctx.strokeStyle = 'hsla(' + p.hue2 + ',80%,80%,0.8)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(0, 0, p.r * 1.55, p.r * 0.42, 0, back ? Math.PI : 0, back ? Math.PI * 2 : Math.PI);
    ctx.stroke();
    ctx.restore();
  }

  function drawFace(p, scared) {
    const x = p.x, y = p.y + p.r * 0.08, r = p.r;
    ctx.fillStyle = '#2a1838';
    ctx.strokeStyle = '#2a1838';
    ctx.lineWidth = Math.max(1.5, r * 0.07);
    ctx.lineCap = 'round';
    const ex = r * 0.3, er = r * 0.09;
    const blink = ((game.time + p.i * 1.7) % 3.4) < 0.12;
    if (p.mood > 0) {
      for (const s of [-1, 1]) { ctx.beginPath(); ctx.arc(x + s * ex, y - r * 0.05, er * 1.3, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke(); }
    } else if (blink) {
      for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(x + s * ex - er, y - r * 0.08); ctx.lineTo(x + s * ex + er, y - r * 0.08); ctx.stroke(); }
    } else {
      for (const s of [-1, 1]) { ctx.beginPath(); ctx.arc(x + s * ex, y - r * 0.08, scared ? er * 1.35 : er, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.beginPath();
    if (scared) ctx.arc(x, y + r * 0.22, r * 0.1, 0, Math.PI * 2);
    else ctx.arc(x, y + r * 0.1, r * (p.mood > 0 ? 0.2 : 0.13), Math.PI * 0.15, Math.PI * 0.85);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,120,150,0.45)';
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.arc(x + s * r * 0.5, y + r * 0.1, r * 0.1, 0, Math.PI * 2); ctx.fill(); }
  }

  function drawGuide(c) {
    if (!c || c.mode !== 'orbit' || game.mode === 'demo' || game.state !== 'play') return;
    const len = game.maxIndex < CONFIG.guideLongUntil ? CONFIG.guideLong : CONFIG.guideShort;
    const tx = -Math.sin(c.angle) * c.dir, ty = Math.cos(c.angle) * c.dir;
    ctx.setLineDash([3, 6]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(c.x + tx * len, c.y + ty * len); ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawTrail() {
    const t = game.trail;
    for (let i = 1; i < t.length; i++) {
      const a = i / t.length;
      ctx.strokeStyle = 'rgba(150,230,255,' + (a * 0.6).toFixed(2) + ')';
      ctx.lineWidth = a * 7;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(t[i - 1].x, t[i - 1].y); ctx.lineTo(t[i].x, t[i].y); ctx.stroke();
    }
  }

  function drawComet(c) {
    if (!c || c.mode === 'dead') return;
    const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, 18);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.3, 'rgba(170,240,255,0.9)');
    g.addColorStop(1, 'rgba(120,200,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(c.x, c.y, 18, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(c.x, c.y, 5, 0, Math.PI * 2); ctx.fill();
  }

  function drawParticles() {
    for (const q of game.particles) {
      const a = clamp(q.life / q.max, 0, 1);
      if (q.color === 'ring') {
        ctx.strokeStyle = 'rgba(255,214,120,' + a.toFixed(2) + ')';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(q.x, q.y, q.size * (1.4 - a * 0.4), 0, Math.PI * 2); ctx.stroke();
        continue;
      }
      ctx.globalAlpha = a;
      ctx.fillStyle = q.color;
      ctx.fillRect(q.x - q.size / 2, q.y - q.size / 2, q.size, q.size);
    }
    ctx.globalAlpha = 1;
  }

  function drawFloaters() {
    if (game.mode === 'demo') return;
    ctx.textAlign = 'center';
    for (const f of game.floaters) {
      ctx.globalAlpha = clamp(f.life / 0.5, 0, 1);
      ctx.font = '800 ' + f.size + 'px ' + fontFamily;
      const half = ctx.measureText(f.text).width / 2 + 8;
      const x = clamp(f.x, half, W - half);
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(10,8,30,0.7)';
      ctx.strokeText(f.text, x, f.y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, x, f.y);
    }
    ctx.globalAlpha = 1;
  }

  // ===== 画面とUI =====
  const $ = (id) => document.getElementById(id);
  const screens = ['screen-title', 'screen-help', 'screen-pause', 'screen-over', 'screen-records'];
  let helpThen = null;

  function showScreen(id) {
    for (const s of screens) $(s).classList.toggle('hidden', s !== id);
    $('hud').classList.toggle('hidden', !(game.state === 'play' || game.state === 'paused'));
  }

  function refreshTitle() {
    $('daily-label').textContent = shortDate(todayKey()) + ' の星空・みんな同じ';
    $('best-daily').textContent = Store.data.daily[todayKey()] || 0;
    $('best-all').textContent = Store.data.best;
    $('btn-sound').textContent = '音：' + (Store.data.muted ? 'オフ' : 'オン');
  }

  // 自分ランキング（このブラウザに残った記録だけ。ほかの人の記録は無い）
  function showRecords() {
    const today = todayKey();
    const fill = (id, list, withDate) => {
      const ol = $(id);
      ol.textContent = '';
      if (!list.length) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = 'まだ記録がありません';
        ol.appendChild(li);
        return;
      }
      list.forEach((r, i) => {
        const li = document.createElement('li');
        const rank = document.createElement('span'), main = document.createElement('span'), sub = document.createElement('span');
        rank.className = 'rec-rank'; rank.textContent = (i + 1) + '位';
        main.className = 'rec-score'; main.textContent = r.s + '点';
        sub.className = 'rec-sub';
        sub.textContent = r.p + 'こ・' + titleFor(r.p) + (withDate ? '・' + shortDate(r.d) : '');
        li.append(rank, main, sub);
        ol.appendChild(li);
      });
    };
    $('records-today-label').textContent = '今日のコース ' + shortDate(today) + '（' + (Store.data.tries[today] || 0) + '回挑戦）';
    fill('records-today', Store.data.dayTop[today] || [], false);
    fill('records-all', Store.data.top, true);
    showScreen('screen-records');
    $('btn-records-close').focus();
  }

  function updateHud() {
    $('hud-score').textContent = game.score;
    $('hud-planets').textContent = game.maxIndex + 'こ';
    $('hud-combo').textContent = game.combo > 0 ? 'ギリギリ ×' + game.combo : '';
  }

  function blurFocus() {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }

  function goTitle() {
    game.state = 'title';
    $('reset-confirm').classList.add('hidden');
    resetRun('demo');
    refreshTitle();
    showScreen('screen-title');
  }

  function startRun(mode, seed) {
    Sound.unlock();
    if (!Store.data.seenHelp) {
      helpThen = () => startRun(mode, seed);
      showHelp();
      return;
    }
    resetRun(mode, seed);
    game.state = 'play';
    game.startedAt = 0;
    updateHud();
    showScreen(null);
    blurFocus();
  }

  function showHelp() {
    game.state = game.state === 'boot' ? 'title' : game.state;
    showScreen('screen-help');
    $('btn-help-ok').focus();
  }

  function pause() {
    if (game.state !== 'play') return;
    game.state = 'paused';
    showScreen('screen-pause');
    $('btn-resume').focus();
  }

  function resume() {
    if (game.state !== 'paused') return;
    game.state = 'play';
    showScreen(null);
    blurFocus();
  }

  function finishRun() {
    game.state = 'over';
    const prevBest = Store.data.best;
    const prevDaily = Store.data.daily[game.date] || 0;
    const isDaily = game.mode === 'daily';
    const dayRank = Store.record(game.date, game.score, game.maxIndex, isDaily);
    if (game.score > prevBest) Store.data.best = game.score;
    if (isDaily && game.score > prevDaily) Store.data.daily[game.date] = game.score;
    Store.save();
    const newBest = isDaily ? game.score > prevDaily && game.score > 0 : game.score > prevBest && game.score > 0;
    const tries = isDaily ? Store.data.tries[game.date] : 0;
    game.lastResult = {
      mode: game.mode, date: game.date, score: game.score, planets: game.maxIndex,
      grazes: game.grazes, maxCombo: game.maxCombo, skips: game.skips, log: game.log.slice(), newBest, tries, dayRank,
    };
    $('over-mode').textContent = isDaily ? '今日のコース ' + shortDate(game.date) + '・' + tries + '回目' : 'フリーコース';
    $('over-title').textContent = game.comet.kind === 'crash' ? '墜落…' : '迷子になった…';
    $('over-rank').textContent = '称号【' + titleFor(game.maxIndex) + '】';
    $('over-dayrank').textContent = isDaily && dayRank ? '今日の自分ランキング ' + dayRank + '位 ／ ' : '';
    $('over-score').textContent = game.score;
    $('over-planets').textContent = game.maxIndex;
    $('over-graze').textContent = game.grazes;
    $('over-combo').textContent = game.maxCombo;
    $('over-skip').textContent = game.skips;
    $('over-strip').textContent = buildStrip(game.log);
    $('over-best').textContent = isDaily ? (Store.data.daily[game.date] || 0) : Store.data.best;
    $('over-newbest').classList.toggle('hidden', !newBest);
    $('over-newbest').textContent = isDaily ? '今日のベスト更新！' : '自己ベスト更新！';
    $('share-msg').textContent = '';
    $('share-fallback').classList.add('hidden');
    if (newBest) Sound.play('best');
    showScreen('screen-over');
    game.overAt = performance.now();
    for (const id of ['btn-retry', 'btn-share']) $(id).disabled = true;
    setTimeout(() => {
      for (const id of ['btn-retry', 'btn-share']) $(id).disabled = false;
      if (game.state === 'over') $('btn-retry').focus();
    }, CONFIG.retryLock * 1000);
  }

  function shareUrl() {
    // 埋め込み先で公開すると location が本来のURLと違うので、<meta name="share-url"> があればそちらを使う
    const meta = document.querySelector('meta[name="share-url"]');
    if (meta && /^https:\/\//.test(meta.content)) return meta.content;
    if (!/^https?:$/.test(location.protocol)) return '';
    return location.origin + location.pathname.replace(/index\.html$/, '');
  }

  async function shareResult() {
    const r = game.lastResult;
    if (!r) return;
    const text = buildShareText(r, shareUrl());
    const msg = $('share-msg');
    if (navigator.share) {
      try { await navigator.share({ text }); msg.textContent = 'シェアしました'; return; } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); msg.textContent = 'コピーしました！ SNSに貼りつけてね'; return; } catch (e) { /* 下の手段へ */ }
    }
    const ta = $('share-fallback');
    ta.value = text;
    ta.classList.remove('hidden');
    ta.focus(); ta.select();
    msg.textContent = '下の文を選んでコピーしてください（スマホは長押し、PCは Ctrl+C）';
  }

  function bindUi() {
    $('btn-daily').addEventListener('click', () => startRun('daily'));
    $('btn-free').addEventListener('click', () => startRun('free'));
    $('btn-help').addEventListener('click', () => { helpThen = null; showHelp(); });
    $('btn-records').addEventListener('click', showRecords);
    $('btn-records-close').addEventListener('click', () => { showScreen('screen-title'); refreshTitle(); });
    $('btn-help-ok').addEventListener('click', () => {
      Store.data.seenHelp = true; Store.save();
      const then = helpThen; helpThen = null;
      if (then) then(); else { showScreen('screen-title'); refreshTitle(); }
    });
    $('btn-sound').addEventListener('click', () => {
      Store.data.muted = !Store.data.muted; Store.save(); Sound.unlock(); refreshTitle();
    });
    // 確認は画面内で行う（埋め込み先によっては confirm() が使えないため）
    $('btn-reset').addEventListener('click', () => { $('reset-confirm').classList.remove('hidden'); $('btn-reset-no').focus(); });
    $('btn-reset-yes').addEventListener('click', () => { Store.resetRecords(); $('reset-confirm').classList.add('hidden'); refreshTitle(); });
    $('btn-reset-no').addEventListener('click', () => { $('reset-confirm').classList.add('hidden'); });
    $('btn-pause').addEventListener('click', pause);
    $('btn-resume').addEventListener('click', resume);
    $('btn-restart').addEventListener('click', () => startRun(game.mode));
    $('btn-quit').addEventListener('click', goTitle);
    $('btn-retry').addEventListener('click', () => startRun(game.mode));
    $('btn-share').addEventListener('click', shareResult);
    $('btn-title').addEventListener('click', goTitle);

    canvas.addEventListener('pointerdown', (e) => {
      if (game.state !== 'play') return;
      e.preventDefault();
      Sound.unlock();
      tap();
    });
    document.addEventListener('keydown', (e) => {
      const tag = e.target && e.target.tagName;
      if (tag === 'BUTTON' || tag === 'TEXTAREA') return;
      if (e.code === 'Space' || e.code === 'Enter' || e.code === 'ArrowUp') {
        if (game.state === 'play') { e.preventDefault(); Sound.unlock(); tap(); }
      } else if (e.code === 'Escape' || e.code === 'KeyP') {
        if (game.state === 'play') pause(); else if (game.state === 'paused') resume();
      }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
    window.addEventListener('resize', resize);
    document.addEventListener('dblclick', (e) => e.preventDefault());
  }

  let last = 0;
  function frame(now) {
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    if (!game.manual) step(dt);
    render();
    requestAnimationFrame(frame);
  }

  function step(dt) {
    if (game.state === 'paused' || game.state === 'boot') return;
    if (game.state === 'over') { updateEffects(dt); return; }
    update(dt);
    if (game.comet.mode === 'dead') {
      if (game.mode === 'demo') {
        if (game.deadTimer > 1.2) resetRun('demo');
      } else if (game.state === 'play' && game.deadTimer > 0.8) {
        finishRun();
      }
    }
  }

  function boot() {
    fontFamily = getComputedStyle(document.body).fontFamily || fontFamily;
    Store.load();
    bindUi();
    resize();
    goTitle();
    requestAnimationFrame(frame);
  }

  // 試験や調整のための窓口（ゲームの外へは何も送らない）
  window.Hoshiwatari = {
    CONFIG, createCourse, planetX, flightStep, launchFrom, entryRadial, botWantsLaunch, buildShareText, buildStrip,
    todayKey, hashString, titleFor, TITLES, Store, Sound, game,
    start: startRun, step, tap, pause, resume, goTitle, finishRun, render,
  };

  if (canvas && ctx) boot();
})();
