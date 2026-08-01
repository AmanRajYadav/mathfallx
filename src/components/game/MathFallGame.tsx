import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GameCore, type GameEvent, type HudState, type RunSummary } from '../../engine/GameCore';
import { POWER_UP_LIST } from '../../engine/powerups';
import type { Skill } from '../../engine/generator';
import { dailyKey } from '../../engine/rng';
import {
  defaultProfile, flushProfile, loadProfile, resetProfile, saveProfile,
  type GameMode, type Profile,
} from '../../engine/profile';
import { Renderer } from '../../render/Renderer';
import { VoiceInput, numbersIn } from '../../voice/VoiceInput';
import {
  initAudio, musicForWave, playMusic, playSfx, setMusicVolume, setSfxVolume, stopMusic, vibrate,
} from '../../audio/sound';
import Hud from './Hud';
import Controls, { type VoiceUiState } from './Controls';
import {
  GameOverScreen, LeaderboardScreen, PauseScreen, AchievementsScreen, SettingsScreen,
  StatsScreen, TitleScreen, type Screen, type SubmitState,
} from './Overlays';
import { fetchRank, submitScore } from '../../net/leaderboard';
import '../../styles/game.css';

const EMPTY_HUD: HudState = {
  score: 0, combo: 0, multiplier: 1, shield: 3, maxShield: 3, wave: 1,
  overdrive: 0, overdriveActive: false, xp: 0, xpGained: 0,
  rank: 'SPARK', rankColor: '#8b93b0', mode: 'arcade', timeLeft: null,
  solved: 0, total: null, accuracy: 1, status: 'idle', lastRt: null,
  inventory: [], activeEffects: [],
};

const MathFallGame: React.FC = () => {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const gameRef = useRef<GameCore | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const voiceRef = useRef<VoiceInput | null>(null);
  const rafRef = useRef<number>(0);
  const wakeLockRef = useRef<{ release(): Promise<void> } | null>(null);

  // The profile is a mutable object shared with the engine; this counter is
  // what tells React something inside it changed.
  const profileRef = useRef<Profile>(typeof window === 'undefined' ? defaultProfile() : loadProfile());
  const [profileVersion, setProfileVersion] = useState(0);
  const bumpProfile = useCallback(() => setProfileVersion((v) => v + 1), []);

  const [screen, setScreen] = useState<Screen>('title');
  const screenRef = useRef<Screen>('title');
  const [hud, setHud] = useState<HudState>(EMPTY_HUD);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [input, setInput] = useState('');
  /** Mirrors `input` so the key handler can read it without a stale closure. */
  const inputRef = useRef('');
  const [keypadOpen, setKeypadOpen] = useState(false);

  const [voiceUi, setVoiceUi] = useState<VoiceUiState>({
    supported: false, enabled: false, state: 'idle', heard: '', lastMatch: null, lastMatchAt: 0, miss: null,
  });

  const setScreenBoth = useCallback((s: Screen) => {
    screenRef.current = s;
    setScreen(s);
  }, []);

  // ------------------------------------------------------------ engine setup

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const profile = profileRef.current;
    setSfxVolume(profile.settings.sfx);
    setMusicVolume(profile.settings.music);

    const renderer = new Renderer(canvas, profile.settings.quality);
    rendererRef.current = renderer;

    let missTimer = 0;

    const voice = new VoiceInput({
      lang: profile.settings.voiceLang,
      onMatch: (m) => {
        const g = gameRef.current;
        if (!g || g.status !== 'playing') return;
        if (g.submit(m.value, 'voice')) {
          voiceRef.current?.markConsumed(m.value);
          setVoiceUi((v) => ({ ...v, lastMatch: m.value, lastMatchAt: Date.now(), heard: '', miss: null }));
        }
      },
      // Show only the numeric reading, never the raw transcript. Echoing words
      // back implies the game is listening for words, which it is not — and a
      // stray sentence scrolling through the field is pure noise next to the
      // one thing that matters, which is what number it thinks you said.
      onHeard: (text) => {
        const nums = numbersIn(text);
        const shown = nums.length ? nums.join(' ') : '';
        setVoiceUi((v) => (v.heard === shown ? v : { ...v, heard: shown, miss: null }));
      },
      onNoMatch: (heard) => {
        setVoiceUi((v) => ({ ...v, miss: heard[0] ?? null, heard: '' }));
        // Clear it on a timer. A message that lingers indefinitely reads as a
        // frozen microphone even when everything is working fine.
        window.clearTimeout(missTimer);
        missTimer = window.setTimeout(() => setVoiceUi((v) => ({ ...v, miss: null })), 2200);
      },
      onState: (state) => setVoiceUi((v) => (v.state === state ? v : { ...v, state })),
    });
    voiceRef.current = voice;
    setVoiceUi((v) => ({ ...v, supported: voice.supported }));

    const game = new GameCore({
      profile,
      onHud: setHud,
      onTargets: (answers) => {
        voice.setTargets(answers);
        // Drop a half-typed entry whose target no longer exists. Solve 8 x 5 by
        // voice while "4" is sitting in the field and that orphaned digit stays
        // there, silently prefixing whatever you type next.
        //
        // handleKey guarantees the field only ever holds a viable prefix, so
        // this can only ever fire when the board changed underneath it — it
        // will never fight a keypress the way the earlier version did.
        const prev = inputRef.current;
        if (prev && !answers.some((a) => String(a).startsWith(prev))) {
          inputRef.current = '';
          setInput('');
        }
      },
      onEvent: (e) => handleEvent(e),
    });
    gameRef.current = game;

    const handleEvent = (e: GameEvent) => {
      const haptics = profileRef.current.settings.haptics;
      switch (e.type) {
        case 'hit':
          playSfx(e.kind === 'boss' ? 'boss' : 'zap', e.combo);
          if (e.kind !== 'normal') playSfx('explode');
          if (haptics) vibrate(e.kind === 'boss' ? [18, 22, 30] : e.fast ? 14 : 22);
          // Any successful destruction ends the current entry, whatever
          // destroyed it. Previously the field only cleared when the keypad
          // itself completed an answer, so typing "10" to kill 5x2 could leave
          // "10" behind — and the next digit appended to it. Typing 4 for a
          // 2x2 then produced "104", which matches nothing, and the block
          // could not be shot at all.
          inputRef.current = '';
          setInput('');
          break;
        case 'armorHit':
          playSfx('armor');
          if (haptics) vibrate(10);
          break;
        case 'reject':
          playSfx('reject');
          if (haptics) vibrate([8, 40, 8]);
          break;
        case 'miss':
          playSfx('miss');
          if (haptics) vibrate([40, 30, 60]);
          break;
        case 'wave':
          playSfx('wave');
          playMusic(musicForWave(e.wave));
          break;
        case 'overdrive':
          playSfx('overdrive');
          if (haptics) vibrate([25, 20, 25, 20, 45]);
          break;
        case 'praise': {
          const tiers = { good: 0, great: 1, amazing: 2, legendary: 3 } as const;
          playSfx('praise', tiers[e.tier]);
          if (haptics && (e.tier === 'amazing' || e.tier === 'legendary')) vibrate([14, 30, 14]);
          break;
        }
        case 'rankUp':
          playSfx('record');
          if (haptics) vibrate([30, 30, 30, 30, 70]);
          bumpProfile();
          break;
        case 'record':
          playSfx('record');
          if (haptics) vibrate([40, 40, 40, 40, 90]);
          break;
        case 'collect':
          playSfx('ui');
          if (haptics) vibrate([10, 30, 14]);
          break;
        case 'power':
          playSfx(e.power === 'nuke' ? 'overdrive' : 'wave');
          if (haptics) vibrate([30, 20, 40]);
          break;
        case 'powerFail':
          playSfx('reject');
          break;
        case 'shard':
          playSfx('shard');
          break;
        case 'shardKill':
          playSfx('shardKill');
          if (haptics) vibrate(10);
          inputRef.current = '';
          setInput('');
          break;
        case 'shipHit':
          playSfx('shipHit');
          if (haptics) vibrate([60, 40, 90]);
          break;
        case 'gameover':
          stopMusic();
          playMusic('over', false);
          voiceRef.current?.setEnabled(false);
          setSummary(e.summary);
          setScreenBoth('over');
          bumpProfile();
          break;
      }
    };

    // Single animation frame loop. Nothing here allocates or touches React
    // state directly — the HUD arrives via the throttled onHud callback.
    //
    // The next frame is scheduled FIRST, and the body is wrapped, because this
    // loop previously scheduled at the end with no guard. A single throw
    // anywhere in tick or render — one bad gradient, one NaN coordinate —
    // permanently killed the game, and the failure was almost invisible:
    // submit() still ran and still played its hit sound, but update() never
    // ran again to remove the block, so it looked like the shot fired and the
    // problem simply refused to die. Reported from real play as "sound comes
    // but the problem is not being shot".
    //
    // A dropped frame is survivable. A dropped loop is not.
    let loopErrors = 0;
    const loop = (now: number) => {
      rafRef.current = requestAnimationFrame(loop);
      try {
        if (game.status === 'playing' || game.status === 'paused') {
          game.tick(now);
          renderer.render(game, now);
        } else {
          // Menus get a live backdrop rather than a frozen last frame.
          renderer.renderAttract(now);
        }
      } catch (err) {
        loopErrors += 1;
        if (loopErrors <= 3) {
          console.error('[mathfall] frame failed, continuing', err);
        }
        // Persistent failure means something is structurally wrong rather than
        // a one-off. Drop to the cheap renderer, which avoids most of the
        // paths that can throw, and keep going.
        if (loopErrors === 12) renderer.setQuality('low');
      }
    };
    rafRef.current = requestAnimationFrame(loop);

    // Dev-only inspection handle. requestAnimationFrame is throttled to zero in
    // a backgrounded or non-compositing tab, so `step()` exists to advance the
    // simulation by hand when debugging or driving automated checks.
    if (import.meta.env.DEV) {
      // A virtual clock that persists across calls, so stepping one frame at a
      // time advances the simulation exactly as a real rAF stream would.
      let vt = performance.now();
      (window as unknown as Record<string, unknown>).__mathfall = {
        game, renderer, voice, profile,
        get now() { return vt; },
        step(frames = 60, ms = 16.7) {
          for (let i = 0; i < frames; i++) {
            vt += ms;
            game.tick(vt);
            renderer.render(game, vt);
          }
          return game.liveAnswers();
        },
      };
    }

    return () => {
      cancelAnimationFrame(rafRef.current);
      voice.destroy();
      stopMusic();
      flushProfile();
    };
    // Intentionally mounts once: the engine owns its own lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------- layout

  const measure = useCallback(() => {
    const root = rootRef.current;
    const game = gameRef.current;
    const renderer = rendererRef.current;
    if (!root || !game || !renderer) return;

    const w = root.clientWidth;
    const h = root.clientHeight;
    if (w === 0 || h === 0) return;

    renderer.resize(w, h);

    // Blocks live strictly between the HUD and the bottom controls, so nothing
    // important is ever hidden behind a notch, the keypad, or the home bar.
    const hudH = hudRef.current?.offsetHeight ?? 80;
    const bottomH = bottomRef.current?.offsetHeight ?? 70;
    game.resize(w, h, hudH + 6, h - bottomH - 8);
  }, []);

  useEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (rootRef.current) ro.observe(rootRef.current);
    if (bottomRef.current) ro.observe(bottomRef.current);
    if (hudRef.current) ro.observe(hudRef.current);
    window.addEventListener('orientationchange', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('orientationchange', measure);
    };
  }, [measure, keypadOpen, screen]);

  // ----------------------------------------------------------------- screen

  /** Keeps the display awake during a run. */
  const requestWakeLock = useCallback(async () => {
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> };
      };
      if (nav.wakeLock) wakeLockRef.current = await nav.wakeLock.request('screen');
    } catch {
      /* denied or unsupported — not worth surfacing */
    }
  }, []);

  const releaseWakeLock = useCallback(() => {
    void wakeLockRef.current?.release().catch(() => undefined);
    wakeLockRef.current = null;
  }, []);

  const startGame = useCallback((mode: GameMode, skills?: Skill[]) => {
    const game = gameRef.current;
    if (!game) return;

    // Must happen inside the click handler: browsers only unlock audio, and on
    // iOS only permit speech recognition, from a real user gesture.
    initAudio();
    const profile = profileRef.current;
    setSfxVolume(profile.settings.sfx);
    setMusicVolume(profile.settings.music);
    playMusic('play');

    if (profile.settings.voiceEnabled && voiceRef.current?.supported) {
      voiceRef.current.setLanguage(profile.settings.voiceLang);
      voiceRef.current.setEnabled(true);
      setVoiceUi((v) => ({ ...v, enabled: true }));
      // With voice on, the keypad starts collapsed so the play area is as tall
      // as possible; the toggle brings it back any time.
      setKeypadOpen(false);
    } else {
      setKeypadOpen(profile.settings.showKeypad);
    }

    // Everything the previous run left behind, cleared together. A stale digit
    // or a stale transcript reappearing on replay makes it look like the game
    // is still reacting to something you said a minute ago.
    // iOS 13+ gates the motion sensors behind a permission that can only be
    // requested from a user gesture, so it has to happen here rather than in
    // the effect that installs the listener.
    if (profile.settings.shakeToNuke) {
      const DME = window.DeviceMotionEvent as unknown as {
        requestPermission?: () => Promise<'granted' | 'denied'>;
      } | undefined;
      if (DME && typeof DME.requestPermission === 'function') {
        void DME.requestPermission().catch(() => undefined);
      }
    }

    // Everything the previous run left behind, cleared together.
    inputRef.current = '';
    setInput('');
    setSummary(null);
    setSubmitState('idle');
    setPlacement(null);
    setVoiceUi((v) => ({ ...v, heard: '', lastMatch: null, lastMatchAt: 0, miss: null }));
    setScreenBoth('playing');
    game.start(mode, skills);
    void requestWakeLock();
    requestAnimationFrame(measure);
  }, [measure, requestWakeLock, setScreenBoth]);

  const goMenu = useCallback(() => {
    gameRef.current?.pause();
    voiceRef.current?.setEnabled(false);
    setVoiceUi((v) => ({ ...v, enabled: false }));
    releaseWakeLock();
    stopMusic();
    playMusic('menu');
    setScreenBoth('title');
    bumpProfile();
  }, [bumpProfile, releaseWakeLock, setScreenBoth]);

  const pauseGame = useCallback(() => {
    const g = gameRef.current;
    if (!g || g.status !== 'playing') return;
    g.pause();
    voiceRef.current?.setEnabled(false);
    setScreenBoth('paused');
  }, [setScreenBoth]);

  const resumeGame = useCallback(() => {
    const g = gameRef.current;
    if (!g) return;
    initAudio();
    g.resume();
    if (profileRef.current.settings.voiceEnabled && voiceRef.current?.supported) {
      voiceRef.current.setEnabled(true);
    }
    setScreenBoth('playing');
    void requestWakeLock();
  }, [requestWakeLock, setScreenBoth]);

  // ------------------------------------------------------------------ input

  /**
   * Keypad entry.
   *
   * The whole thing runs off `inputRef` rather than inside a `setInput`
   * updater. Firing `game.submit` from within an updater made the shot a side
   * effect of rendering, which React is free to run twice — and it made the
   * entry rules impossible to reason about against the separate clear in
   * `onTargets`.
   *
   * Those two rules used to disagree: a digit that could not begin any live
   * answer was *kept* here and then *wiped* by the next target change, so it
   * vanished as fast as it was pressed and the keypad looked dead. There is
   * now exactly one rule — a dead entry is rejected immediately, audibly, and
   * never enters the field at all.
   */
  const handleKey = useCallback((k: string) => {
    initAudio();
    const game = gameRef.current;
    if (!game || game.status !== 'playing') return;

    const setBoth = (v: string) => { inputRef.current = v; setInput(v); };

    if (k === 'del') { setBoth(inputRef.current.slice(0, -1)); playSfx('tick'); return; }
    if (k === 'clear') { setBoth(''); playSfx('tick'); return; }

    if (k === 'go') {
      const v = inputRef.current;
      setBoth('');
      if (v) game.submit(parseInt(v, 10), 'touch');
      return;
    }

    if (k < '0' || k > '9') return;

    const live = game.liveAnswers();
    const next = (inputRef.current + k).slice(0, 4);
    const value = parseInt(next, 10);

    // Exact hit: fire straight away so a two-digit answer needs no submit.
    if (live.includes(value)) {
      setBoth('');
      playSfx('tick');
      game.submit(value, 'touch');
      return;
    }

    // Still a viable prefix of something on screen — keep building.
    if (live.some((a) => String(a).startsWith(next))) {
      setBoth(next);
      playSfx('tick');
      return;
    }

    // Dead end. Restart from this digit if it can begin an answer on its own,
    // which is what a player correcting a mistyped first digit expects;
    // otherwise reject it outright rather than parking an entry that can never
    // complete.
    if (live.some((a) => String(a).startsWith(k))) {
      setBoth(k);
      playSfx('tick');
    } else {
      setBoth('');
      playSfx('reject');
    }
  }, []);

  const toggleVoice = useCallback(() => {
    initAudio();
    const voice = voiceRef.current;
    if (!voice?.supported) return;

    // When permission was refused, the obvious gesture is to tap the mic again
    // after granting it in system settings. Toggling *off* at that point — which
    // is what a plain toggle does, since it is still nominally enabled — leaves
    // no way back in. Treat a tap in that state as "try again".
    if (voiceUi.state === 'denied' || voiceUi.state === 'error') {
      voice.restart();
      voice.setEnabled(screenRef.current === 'playing');
      setVoiceUi((v) => ({ ...v, enabled: true }));
      playSfx('ui');
      return;
    }

    const next = !voiceUi.enabled;
    const profile = profileRef.current;
    profile.settings.voiceEnabled = next;
    saveProfile(profile);
    voice.setLanguage(profile.settings.voiceLang);
    voice.setEnabled(next && screenRef.current === 'playing');
    setVoiceUi((v) => ({ ...v, enabled: next }));
    if (!next) setKeypadOpen(true);
    playSfx('ui');
  }, [voiceUi.enabled, voiceUi.state]);

  // Desktop keyboard.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const game = gameRef.current;
      if (!game) return;

      if (e.key === 'Escape') {
        if (screenRef.current === 'playing') pauseGame();
        else if (screenRef.current === 'paused') resumeGame();
        return;
      }
      if (screenRef.current !== 'playing') {
        if (e.key === ' ' && screenRef.current === 'title') {
          e.preventDefault();
          startGame('arcade');
        }
        return;
      }
      if (e.key >= '0' && e.key <= '9') { e.preventDefault(); handleKey(e.key); }
      else if (e.key === 'Backspace') { e.preventDefault(); handleKey('del'); }
      else if (e.key === 'Enter') { e.preventDefault(); handleKey('go'); }
      // Space wipes the entry. It is the fastest key to hit blind, which is
      // what you want when a half-typed number is blocking the next answer.
      else if (e.key === ' ') { e.preventDefault(); handleKey('clear'); }
      else if (e.key === 'b' || e.key === 'B') { e.preventDefault(); game.triggerOverdrive(); }
      else {
        // Power-up shortcuts: f freeze, s slow, n nuke, d double, h shield.
        const key = e.key.toLowerCase();
        const def = POWER_UP_LIST.find((p) => p.key === key);
        if (def) {
          e.preventDefault();
          game.activate(def.type);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleKey, pauseGame, resumeGame, startGame]);

  /**
   * Shake to nuke.
   *
   * Detects a jerk — the rate of change of acceleration — rather than raw
   * magnitude. Plain magnitude triggers constantly from ordinary hand movement
   * while playing; a sharp reversal only happens when you deliberately shake
   * the phone. A cooldown stops one shake registering as several.
   */
  useEffect(() => {
    if (!profileRef.current.settings.shakeToNuke) return;

    let lastX = 0, lastY = 0, lastZ = 0;
    let lastFire = 0;
    let primed = false;

    const onMotion = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null || a.y == null || a.z == null) return;

      const jerk = Math.abs(a.x - lastX) + Math.abs(a.y - lastY) + Math.abs(a.z - lastZ);
      lastX = a.x; lastY = a.y; lastZ = a.z;

      // Two-stage: a shake has to cross the bar, drop below it, and cross
      // again. That is the difference between a shake and a single knock.
      if (jerk > 34) {
        const now = Date.now();
        if (primed && now - lastFire > 1200) {
          lastFire = now;
          primed = false;
          const g = gameRef.current;
          if (g?.status === 'playing') {
            initAudio();
            if (!g.activate('nuke') && profileRef.current.settings.haptics) vibrate(20);
          }
        }
      } else if (jerk < 12) {
        primed = true;
      }
    };

    window.addEventListener('devicemotion', onMotion);
    return () => window.removeEventListener('devicemotion', onMotion);
  }, [profileVersion]);

  // Leaving the tab kills the microphone anyway, so pause rather than let the
  // player return to a dead run.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden && screenRef.current === 'playing') pauseGame();
    };
    const onHide = () => flushProfile();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHide);
    };
  }, [pauseGame]);

  // --------------------------------------------------------------- settings

  const changeSetting = useCallback(<K extends keyof Profile['settings']>(
    key: K, value: Profile['settings'][K],
  ) => {
    const profile = profileRef.current;
    profile.settings[key] = value;
    saveProfile(profile);

    if (key === 'sfx') setSfxVolume(value as number);
    if (key === 'music') setMusicVolume(value as number);
    if (key === 'quality') rendererRef.current?.setQuality(value as 'auto' | 'low' | 'high');
    if (key === 'voiceLang') voiceRef.current?.setLanguage(value as string);
    if (key === 'voiceEnabled') {
      const on = value as boolean;
      voiceRef.current?.setEnabled(on && screenRef.current === 'playing');
      setVoiceUi((v) => ({ ...v, enabled: on }));
    }
    if (key === 'showKeypad') setKeypadOpen(value as boolean);

    bumpProfile();
  }, [bumpProfile]);

  const [testResult, setTestResult] = useState('');
  const [boardName, setBoardName] = useState(() => profileRef.current.name);
  const [boardMode, setBoardMode] = useState<GameMode>('arcade');
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const [submitError, setSubmitError] = useState('');
  const [placement, setPlacement] = useState<number | null>(null);

  const submitRun = useCallback(() => {
    const s = summary;
    const name = boardName.trim();
    if (!s || !name) return;

    // Remember the name so it is only ever typed once.
    profileRef.current.name = name;
    saveProfile(profileRef.current);

    setSubmitState('sending');
    void submitScore({
      name,
      score: s.score,
      mode: s.mode,
      wave: hud.wave,
      solved: s.solved,
      accuracy: s.accuracy,
      bestCombo: s.bestCombo,
      rating: Math.round(profileRef.current.theta),
      voiceShare: s.voiceShare,
      durationMs: s.durationMs,
    }).then((res) => {
      setSubmitState(res.ok ? 'done' : 'failed');
      setSubmitError(res.reason ?? '');
      if (!res.ok) return;
      setBoardMode(s.mode);
      playSfx('record');
      // Report the placement straight away. "You're 4th" is the answer the
      // player actually wanted when they typed their name.
      void fetchRank(s.mode, name).then(setPlacement).catch(() => setPlacement(null));
    });
  }, [summary, boardName, hud.wave]);

  const testVoice = useCallback((phrase: string) => {
    const voice = voiceRef.current;
    if (!voice || !phrase.trim()) return;
    initAudio();
    // A representative answer set covering the classic ambiguities: 15 vs 50,
    // and the small digits that homophones collapse onto.
    const targets = [42, 15, 50, 7, 8, 4, 2, 22, 105, 63];
    const hit = voice.probe(phrase, targets);
    setTestResult(
      hit
        ? `“${phrase}” → ${hit.value}  (confidence ${(hit.score * 100).toFixed(0)}%)`
        : `“${phrase}” → no match against ${targets.join(', ')}`,
    );
    playSfx(hit ? 'zap' : 'reject');
  }, []);

  const doReset = useCallback(() => {
    if (!window.confirm('Erase all progress, ratings and settings? This cannot be undone.')) return;
    profileRef.current = resetProfile();
    bumpProfile();
    setScreenBoth('title');
  }, [bumpProfile, setScreenBoth]);

  // ------------------------------------------------------------------ render

  const profile = profileRef.current;
  const dailyDone = !!profile.daily[dailyKey()];
  void profileVersion; // re-render trigger for the mutable profile

  return (
    <div className="mf-root" ref={rootRef}>
      <canvas
        className="mf-canvas"
        ref={canvasRef}
        onPointerDown={(e) => {
          const g = gameRef.current;
          if (!g || g.status !== 'playing') return;
          const rect = e.currentTarget.getBoundingClientRect();
          // Canvas coordinates are CSS pixels from the element's top-left,
          // which is exactly the space powerSlots() reports in.
          if (g.activateAt(e.clientX - rect.left, e.clientY - rect.top)) {
            initAudio();
            e.preventDefault();
            return;
          }
          // Anywhere else on the board wipes the entry. A wrong number left in
          // the field blocks everything typed after it, and hunting for a
          // specific small target to fix that — while blocks are falling — is
          // the opposite of what the moment calls for. The whole play area is
          // the undo button.
          if (inputRef.current) {
            inputRef.current = '';
            setInput('');
            playSfx('tick');
            if (profileRef.current.settings.haptics) vibrate(8);
          }
        }}
      />
      <div className="mf-crt" />

      {(screen === 'playing' || screen === 'paused') && (
        <>
          <Hud
            hud={hud}
            hudRef={hudRef}
            onActivate={(type) => { initAudio(); gameRef.current?.activate(type); }}
          />
          <Controls
            bottomRef={bottomRef}
            voice={voiceUi}
            onToggleVoice={toggleVoice}
            keypadOpen={keypadOpen}
            onToggleKeypad={() => setKeypadOpen((v) => !v)}
            input={input}
            onKey={handleKey}
            onPause={pauseGame}
            onMenu={goMenu}
          />
        </>
      )}

      {screen === 'title' && (
        <TitleScreen
          profile={profile}
          voiceSupported={voiceUi.supported}
          dailyDone={dailyDone}
          onStart={startGame}
          onScreen={setScreenBoth}
        />
      )}

      {screen === 'paused' && (
        <PauseScreen
          onResume={resumeGame}
          onRestart={() => startGame(hud.mode)}
          onMenu={goMenu}
        />
      )}

      {screen === 'over' && summary && (
        <GameOverScreen
          summary={summary}
          profile={profile}
          name={boardName}
          submitState={submitState}
          submitError={submitError}
          placement={placement}
          onName={setBoardName}
          onSubmit={submitRun}
          onViewBoard={() => { setBoardMode(summary.mode); setScreenBoth('board'); }}
          onAgain={() => startGame(summary.mode)}
          onMenu={goMenu}
        />
      )}

      {screen === 'board' && (
        <LeaderboardScreen
          mode={boardMode}
          onMode={setBoardMode}
          onBack={() => setScreenBoth(summary ? 'over' : 'title')}
        />
      )}

      {screen === 'settings' && (
        <SettingsScreen
          profile={profile}
          voiceSupported={voiceUi.supported}
          onChange={changeSetting}
          onBack={() => setScreenBoth('title')}
          onReset={doReset}
          onTestVoice={testVoice}
          testResult={testResult}
          diagnostics={voiceRef.current?.diagnostics() ?? {}}
          history={voiceRef.current?.history() ?? []}
          onRestartVoice={() => {
            initAudio();
            voiceRef.current?.restart();
            setTestResult('Microphone restarted.');
          }}
        />
      )}

      {screen === 'achievements' && (
        <AchievementsScreen profile={profile} onBack={() => setScreenBoth('title')} />
      )}

      {screen === 'stats' && (
        <StatsScreen profile={profile} onBack={() => setScreenBoth('title')} />
      )}

      {/* A tap target for pausing that does not fight the keypad for space. */}
      {screen === 'playing' && (
        <button
          type="button"
          onClick={pauseGame}
          aria-label="Pause"
          style={{
            position: 'absolute', top: 'calc(env(safe-area-inset-top, 0px) + 6px)',
            right: 'calc(env(safe-area-inset-right, 0px) + 6px)',
            width: 34, height: 34, zIndex: 12, opacity: 0,
          }}
        />
      )}
    </div>
  );
};

export default MathFallGame;
