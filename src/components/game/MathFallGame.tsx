import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GameCore, type GameEvent, type HudState, type RunSummary } from '../../engine/GameCore';
import type { Skill } from '../../engine/generator';
import { dailyKey } from '../../engine/rng';
import {
  defaultProfile, flushProfile, loadProfile, resetProfile, saveProfile,
  type GameMode, type Profile,
} from '../../engine/profile';
import { Renderer } from '../../render/Renderer';
import { VoiceInput } from '../../voice/VoiceInput';
import {
  initAudio, musicForWave, playMusic, playSfx, setMusicVolume, setSfxVolume, stopMusic, vibrate,
} from '../../audio/sound';
import Hud from './Hud';
import Controls, { type VoiceUiState } from './Controls';
import {
  GameOverScreen, PauseScreen, SettingsScreen, StatsScreen, TitleScreen, type Screen,
} from './Overlays';
import '../../styles/game.css';

const EMPTY_HUD: HudState = {
  score: 0, combo: 0, multiplier: 1, shield: 3, maxShield: 3, wave: 1,
  overdrive: 0, overdriveActive: false, rating: 1000, ratingDelta: 0,
  rank: 'INITIATE', rankColor: '#8b93b0', mode: 'arcade', timeLeft: null,
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
      onHeard: (text) => setVoiceUi((v) => (v.heard === text ? v : { ...v, heard: text, miss: null })),
      onNoMatch: (heard) => setVoiceUi((v) => ({ ...v, miss: heard[0] ?? null, heard: '' })),
      onState: (state) => setVoiceUi((v) => (v.state === state ? v : { ...v, state })),
      onCommand: (cmd) => {
        const g = gameRef.current;
        if (!g) return;
        if (cmd === 'pause' && g.status === 'playing') { g.pause(); setScreenBoth('paused'); }
        else if (cmd === 'resume' && g.status === 'paused') { g.resume(); setScreenBoth('playing'); }
        else if (cmd === 'bomb') g.triggerOverdrive();
      },
      onPowerUp: (power) => {
        const g = gameRef.current;
        if (!g || g.status !== 'playing') return;
        g.activate(power);
      },
    });
    voiceRef.current = voice;
    setVoiceUi((v) => ({ ...v, supported: voice.supported }));

    const game = new GameCore({
      profile,
      onHud: setHud,
      onTargets: (answers) => voice.setTargets(answers),
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
    const loop = (now: number) => {
      game.tick(now);
      renderer.render(game, now);
      rafRef.current = requestAnimationFrame(loop);
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
    setInput('');
    setSummary(null);
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

  const handleKey = useCallback((k: string) => {
    initAudio();
    const game = gameRef.current;
    if (!game || game.status !== 'playing') return;

    if (k === 'del') {
      setInput((v) => v.slice(0, -1));
      playSfx('tick');
      return;
    }

    if (k === 'clear') {
      setInput('');
      playSfx('tick');
      return;
    }

    if (k === 'go') {
      setInput((v) => {
        if (v) game.submit(parseInt(v, 10), 'touch');
        return '';
      });
      return;
    }

    if (k < '0' || k > '9') return;

    setInput((prev) => {
      const next = (prev + k).slice(0, 4);
      playSfx('tick');
      // Auto-fire as soon as the digits match something on screen, so a
      // two-digit answer needs no explicit submit. Typing continues to work if
      // nothing matches yet.
      const value = parseInt(next, 10);
      const matches = game.liveAnswers().includes(value);
      if (matches) {
        game.submit(value, 'touch');
        return '';
      }
      // Nothing on screen can start with these digits: clear rather than let
      // the player build a dead string.
      const anyPrefix = game.liveAnswers().some((a) => String(a).startsWith(next));
      return anyPrefix ? next : k;
    });
  }, []);

  const toggleVoice = useCallback(() => {
    initAudio();
    const voice = voiceRef.current;
    if (!voice?.supported) return;
    const next = !voiceUi.enabled;
    const profile = profileRef.current;
    profile.settings.voiceEnabled = next;
    saveProfile(profile);
    voice.setLanguage(profile.settings.voiceLang);
    voice.setEnabled(next && screenRef.current === 'playing');
    setVoiceUi((v) => ({ ...v, enabled: next }));
    if (!next) setKeypadOpen(true);
    playSfx('ui');
  }, [voiceUi.enabled]);

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
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleKey, pauseGame, resumeGame, startGame]);

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
      <canvas className="mf-canvas" ref={canvasRef} />
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
          onAgain={() => startGame(summary.mode)}
          onMenu={goMenu}
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
        />
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
