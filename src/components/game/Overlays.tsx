import React from 'react';
import {
  ArrowLeft, CalendarDays, ChartNoAxesColumn, Gauge, Infinity as InfinityIcon,
  Lock, Medal, Mic, Play, RotateCcw, Settings, Sparkles, Sprout, Timer, Trophy,
} from 'lucide-react';
import type { RunSummary } from '../../engine/GameCore';
import { RANKS, rankFor } from '../../engine/adaptive';
import { dailyStreak, ratingHistory, type GameMode, type Profile } from '../../engine/profile';
import { dailyKey } from '../../engine/rng';
import type { Skill } from '../../engine/generator';
import { VOICE_LANGUAGES } from '../../voice/recognizer';
import { hapticsSupported, vibrate } from '../../audio/sound';
import { fetchTop, playerId, type LeaderboardResult } from '../../net/leaderboard';

export type Screen =
  | 'title' | 'playing' | 'paused' | 'over' | 'settings' | 'stats' | 'board' | 'achievements';

const SKILL_LABELS: Record<string, string> = {
  add: 'Addition',
  sub: 'Subtraction',
  mul: 'Multiplication',
  div: 'Division',
  pow: 'Powers & roots',
};

const ALL_SKILLS: Skill[] = ['add', 'sub', 'mul', 'div', 'pow'];

function fmtTime(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Fluence mark — an inline SVG so it stays crisp at any density, themes with
 * the page, and costs no extra request. Three ascending strokes reading as
 * flow, wrapped in a rounded token.
 */
export const FluenceMark: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <rect x="1.5" y="1.5" width="29" height="29" rx="9"
      stroke="url(#fl-g)" strokeWidth="2.2" />
    <path d="M10 21.5c0-6 3.2-9 6.4-9 2.2 0 3.4 1.3 3.4 3"
      stroke="url(#fl-g)" strokeWidth="2.6" strokeLinecap="round" />
    <path d="M8.5 16.5h9" stroke="url(#fl-g)" strokeWidth="2.6" strokeLinecap="round" />
    <circle cx="22.5" cy="21" r="1.8" fill="#ff2d95" />
    <defs>
      <linearGradient id="fl-g" x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse">
        <stop stopColor="#00f0ff" />
        <stop offset="0.55" stopColor="#c17bff" />
        <stop offset="1" stopColor="#ff2d95" />
      </linearGradient>
    </defs>
  </svg>
);

export const FluenceBadge: React.FC = () => (
  <div className="mf-brand">
    <img
      className="mf-brand-logo"
      src={`${import.meta.env.BASE_URL}fluence-logo.png`}
      alt="Fluence"
      width={22}
      height={22}
      loading="lazy"
      decoding="async"
    />
    <span>
      made with <span className="mf-brand-heart">❤️</span> by <strong>FLUENCE</strong>
    </span>
  </div>
);

/**
 * Rating over the last N answers.
 *
 * The event log already stores the rating produced by every answer, so this
 * costs nothing to draw — and progress you can see is most of why anyone comes
 * back. A number that only ever appears as a single figure feels static even
 * when it is climbing.
 */
const Sparkline: React.FC<{ values: number[]; color: string }> = ({ values, color }) => {
  if (values.length < 4) return null;
  const w = 300;
  const h = 56;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(30, max - min); // floor stops a flat run looking like noise
  const mid = (min + max) / 2;
  const lo = mid - span / 2;

  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - lo) / span) * h;
    return `${x.toFixed(1)},${Math.max(2, Math.min(h - 2, y)).toFixed(1)}`;
  });

  const rising = values[values.length - 1] >= values[0];

  return (
    <div className="mf-spark">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img"
        aria-label={`Rating trend, ${rising ? 'rising' : 'falling'}`}>
        <defs>
          <linearGradient id="sp-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={`0,${h} ${pts.join(' ')} ${w},${h}`} fill="url(#sp-fill)" />
        <polyline points={pts.join(' ')} fill="none" stroke={color}
          strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mf-spark-legend">
        <span>{Math.round(min)}</span>
        <span>last {values.length} answers</span>
        <span>{Math.round(max)}</span>
      </div>
    </div>
  );
};

function Stat({ k, v, sub }: { k: string; v: React.ReactNode; sub?: string }) {
  return (
    <div className="mf-stat">
      <span className="mf-stat-k">{k}</span>
      <span className="mf-stat-v">
        {v}
        {sub && <small> {sub}</small>}
      </span>
    </div>
  );
}

// ------------------------------------------------------------------- title

interface TitleProps {
  profile: Profile;
  voiceSupported: boolean;
  dailyDone: boolean;
  onStart: (mode: GameMode, skills?: Skill[]) => void;
  onScreen: (s: Screen) => void;
}

export const TitleScreen: React.FC<TitleProps> = ({ profile, voiceSupported, dailyDone, onStart, onScreen }) => {
  const rank = rankFor(profile.xp);
  const streak = dailyStreak(profile);
  const bestScore = Math.max(...Object.values(profile.modes).map((m) => m.bestScore), 0);
  return (
    <div className="mf-overlay">
      <div className="mf-overlay-inner">
        <div>
          <h1 className="mf-title mf-title--anim" aria-label="MathFall">
            {'MATHFALL'.split('').map((ch, i) => (
              <span key={i} style={{ '--d': `${i * 70}ms` } as React.CSSProperties}>{ch}</span>
            ))}
          </h1>
          <p className="mf-tagline">Say the answer · Destroy the block</p>
        </div>

        {/*
          High score leads, rank follows.
          The rating used to be the only number here, and it reads as a score
          because it sits where a score belongs — so a 17,000-point run showed
          "1280" and looked like a bug. It is an ability estimate on a chess
          scale; it belongs next to the rank it produces, not in place of the
          thing the player actually earned.
        */}
        <div className="mf-hero">
          <div className="mf-stat-k">Best score</div>
          <div className="mf-hero-score">{bestScore.toLocaleString()}</div>
          <button className="mf-hero-rank" onClick={() => onScreen('achievements')}>
            <span className="mf-hero-tier" style={{ color: rank.color }}>
              {rank.name}
            </span>
            <span className="mf-hero-sub">
              rank {rank.tier} of {RANKS.length} · {Math.round(profile.xp).toLocaleString()} XP
            </span>
            <span className="mf-meter" style={{ height: 4, marginTop: 6 }}>
              <i style={{ width: `${Math.round(rank.progress * 100)}%`, background: rank.color }} />
            </span>
          </button>
        </div>

        <button className="mf-btn mf-btn--primary" onClick={() => onStart('arcade')}>
          <Play size={20} fill="currentColor" /> PLAY
        </button>

        <div className="mf-h2">Modes</div>

        <button className="mf-btn" onClick={() => onStart('easy')}>
          <Sprout className="mf-btn-icon" size={22} />
          <span className="mf-btn-text">
            <span>Easy</span>
            <span className="mf-btn-sub">Answers under 20, slower fall, 5 shields</span>
          </span>
        </button>

        <button className="mf-btn" onClick={() => onStart('daily')}>
          <CalendarDays className="mf-btn-icon" size={22} />
          <span className="mf-btn-text">
            <span>
              Daily Challenge {!dailyDone && <span className="mf-badge-new">NEW</span>}
              {streak > 1 && <span className="mf-streak">🔥 {streak}</span>}
            </span>
            <span className="mf-btn-sub">
              {streak > 1
                ? `${streak}-day streak — 40 problems, same for everyone`
                : '40 problems — identical for everyone today'}
            </span>
          </span>
        </button>

        <button className="mf-btn" onClick={() => onStart('blitz')}>
          <Timer className="mf-btn-icon" size={22} />
          <span className="mf-btn-text">
            <span>Blitz</span>
            <span className="mf-btn-sub">60 seconds, no shields, maximum chaos</span>
          </span>
        </button>

        <button className="mf-btn" onClick={() => onStart('zen')}>
          <InfinityIcon className="mf-btn-icon" size={22} />
          <span className="mf-btn-text">
            <span>Practice</span>
            <span className="mf-btn-sub">No fail state — drills your weakest skill</span>
          </span>
        </button>

        <button className="mf-btn mf-btn--ghost" onClick={() => onScreen('board')}>
          <Trophy size={17} /> Global leaderboard
        </button>

        <button className="mf-btn mf-btn--ghost" onClick={() => onScreen('achievements')}>
          <Medal size={17} /> Achievements · {rank.tier}/{RANKS.length}
        </button>

        <div className="mf-grid2">
          <button className="mf-btn mf-btn--ghost" onClick={() => onScreen('stats')}>
            <ChartNoAxesColumn size={17} /> Stats
          </button>
          <button className="mf-btn mf-btn--ghost" onClick={() => onScreen('settings')}>
            <Settings size={17} /> Settings
          </button>
        </div>


        <FluenceBadge />
      </div>
    </div>
  );
};

// ------------------------------------------------------------------- paused

export const PauseScreen: React.FC<{
  onResume: () => void;
  onRestart: () => void;
  onMenu: () => void;
}> = ({ onResume, onRestart, onMenu }) => (
  <div className="mf-overlay">
    <div className="mf-overlay-inner">
      <h2 className="mf-title" style={{ fontSize: 42 }}>PAUSED</h2>
      <button className="mf-btn mf-btn--primary" onClick={onResume}>
        <Play size={19} fill="currentColor" /> Resume
      </button>
      <button className="mf-btn mf-btn--ghost" onClick={onRestart}>
        <RotateCcw size={17} /> Restart
      </button>
      <button className="mf-btn mf-btn--ghost" onClick={onMenu}>
        <ArrowLeft size={17} /> Main menu
      </button>
    </div>
  </div>
);

// ---------------------------------------------------------------- game over

/**
 * `queued` is not a failure. The run is already written to durable storage and
 * will be sent on its own; the network simply has not cooperated yet. Showing
 * it as an error is what made players replay runs that were never lost.
 */
export type SubmitState = 'idle' | 'sending' | 'done' | 'queued' | 'failed';

export const GameOverScreen: React.FC<{
  summary: RunSummary;
  profile: Profile;
  name: string;
  submitState: SubmitState;
  submitError: string;
  /** Placement on the board after a successful save, if known. */
  placement: number | null;
  /** True when this run was rebuilt from a snapshot after the app was killed. */
  recovered?: boolean;
  /** Name the run will be auto-saved under while the grace window is open. */
  pendingAs?: string | null;
  onName: (v: string) => void;
  onSubmit: () => void;
  /** Cancel the pending auto-save / reopen the name field to correct it. */
  onChangeName: () => void;
  onViewBoard: () => void;
  onAgain: () => void;
  onMenu: () => void;
}> = ({
  summary, profile, name, submitState, submitError, placement, recovered, pendingAs,
  onName, onSubmit, onChangeName, onViewBoard, onAgain, onMenu,
}) => {
  const delta = summary.xpGained;
  const rank = rankFor(profile.xp);

  return (
    <div className="mf-overlay">
      <div className="mf-overlay-inner">
        <div>
          <h2 className="mf-title" style={{ fontSize: 40 }}>
            {recovered ? 'RUN RECOVERED' : summary.isRecord ? 'NEW RECORD' : 'RUN OVER'}
          </h2>
          <p className="mf-tagline">{summary.mode} · {fmtTime(summary.durationMs)}</p>
          {recovered && (
            <p className="mf-note" style={{ textAlign: 'center' }}>
              The app closed mid-run. Your progress was saved — nothing is lost.
            </p>
          )}
        </div>

        <div className="mf-rank">
          <div>
            <div className="mf-stat-k">Score</div>
            <div className="mf-stat-v" style={{ fontSize: 32 }}>{summary.score.toLocaleString()}</div>
          </div>
          {summary.isRecord && <Trophy size={30} color="#ffe66d" />}
        </div>

        {/*
          Name first, before the stats.
          The moment a run ends is the only moment anyone cares enough to type
          their name, and on a shared classroom phone the next player is
          already reaching for it. Burying the field under six stat tiles meant
          it was routinely missed.
        */}
        {summary.score > 0 && (
          pendingAs ? (
            /* Auto-save is about to fire. The only job of this state is to be
               interruptible: on a shared phone the prefilled name is the
               PREVIOUS player's, and this is the moment to say so. */
            <div className="mf-placed">
              <span className="mf-placed-text">Saving as <b>{pendingAs}</b>…</span>
              <button className="mf-btn mf-btn--ghost" onClick={onChangeName}>
                Not {pendingAs}? Change name
              </button>
            </div>
          ) : submitState === 'done' || submitState === 'queued' ? (
            <div className="mf-placed">
              {submitState === 'queued' ? (
                <span className="mf-placed-text">
                  Saved as {name} — it will reach the board as soon as you have signal.
                </span>
              ) : placement !== null ? (
                <>
                  <span className="mf-placed-rank">#{placement}</span>
                  <span className="mf-placed-text">
                    {name} on the {summary.mode} board
                  </span>
                </>
              ) : (
                <span className="mf-placed-text">Saved as {name}</span>
              )}
              <button className="mf-btn mf-btn--ghost" onClick={onViewBoard}>
                <Trophy size={16} /> View leaderboard
              </button>
              <button className="mf-btn mf-btn--ghost" onClick={onChangeName}>
                Wrong name? Fix it
              </button>
            </div>
          ) : (
            <div className="mf-save">
              <div className="mf-h2">Save your score</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="mf-select"
                  style={{ flex: 1, maxWidth: 'none' }}
                  value={name}
                  maxLength={16}
                  autoFocus
                  placeholder="Your name"
                  onChange={(e) => onName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) onSubmit(); }}
                  aria-label="Leaderboard name"
                />
                <button
                  className="mf-btn mf-btn--primary"
                  style={{ width: 'auto', padding: '0 18px', minHeight: 46 }}
                  disabled={!name.trim() || submitState === 'sending'}
                  onClick={onSubmit}
                >
                  {submitState === 'sending' ? 'Saving…' : 'Save'}
                </button>
              </div>
              {submitState === 'failed' && (
                <p className="mf-note">{submitError || 'Submission failed.'}</p>
              )}
              <p className="mf-row-hint">
                Playing on a shared phone? Each name keeps its own place.
              </p>
            </div>
          )
        )}

        <div className="mf-grid2">
          <Stat k="Solved" v={summary.solved} />
          <Stat k="Best chain" v={summary.bestCombo} />
          <Stat k="Accuracy" v={`${Math.round(summary.accuracy * 100)}%`} />
          <Stat k="Avg answer" v={(summary.avgRtMs / 1000).toFixed(1)} sub="s" />
          <Stat
            k="Fastest"
            v={summary.fastestRtMs !== null ? (summary.fastestRtMs / 1000).toFixed(2) : '—'}
            sub={summary.fastestRtMs !== null ? 's' : undefined}
          />
          <Stat k="By voice" v={`${Math.round(summary.voiceShare * 100)}%`} />
        </div>

        <div className="mf-rank">
          <div>
            <div className="mf-stat-k">XP earned</div>
            <div className="mf-rank-name" style={{ color: rank.color }}>{rank.name}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="mf-stat-v">{summary.xpAfter.toLocaleString()}</div>
            <div
              className="mf-stat-k"
              style={{ color: delta >= 0 ? '#39ff88' : '#ff5a78' }}
            >
              +{delta.toLocaleString()} XP
            </div>
          </div>
        </div>

        <button className="mf-btn mf-btn--primary" onClick={onAgain}>
          <RotateCcw size={19} /> Play again
        </button>
        <button className="mf-btn mf-btn--ghost" onClick={onMenu}>
          <ArrowLeft size={17} /> Main menu
        </button>

        <FluenceBadge />
      </div>
    </div>
  );
};

// ----------------------------------------------------------------- settings

interface SettingsProps {
  profile: Profile;
  voiceSupported: boolean;
  onChange: <K extends keyof Profile['settings']>(key: K, value: Profile['settings'][K]) => void;
  onBack: () => void;
  onReset: () => void;
  onTestVoice: (phrase: string) => void;
  testResult: string;
  diagnostics: Record<string, string | number | boolean>;
  history: string[];
  onRestartVoice: () => void;
}

export const SettingsScreen: React.FC<SettingsProps> = ({
  profile, voiceSupported, onChange, onBack, onReset, onTestVoice, testResult,
  diagnostics, history, onRestartVoice,
}) => {
  const s = profile.settings;
  const [testPhrase, setTestPhrase] = React.useState('forty two');

  return (
    <div className="mf-overlay">
      <div className="mf-overlay-inner">
        <h2 className="mf-title" style={{ fontSize: 34 }}>SETTINGS</h2>

        <div className="mf-h2">Voice</div>
        <div>
          <div className="mf-row">
            <span className="mf-row-label">
              Voice input
              {!voiceSupported && <span className="mf-row-hint">Unavailable in this browser</span>}
            </span>
            <button
              className="mf-switch"
              data-on={s.voiceEnabled && voiceSupported}
              disabled={!voiceSupported}
              onClick={() => onChange('voiceEnabled', !s.voiceEnabled)}
              aria-label="Toggle voice input"
            />
          </div>

          <div className="mf-row">
            <span className="mf-row-label">
              Recognition language
              <span className="mf-row-hint">Matching your accent helps a lot</span>
            </span>
            <select
              className="mf-select"
              value={s.voiceLang}
              onChange={(e) => onChange('voiceLang', e.target.value)}
            >
              {VOICE_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>{l.label}</option>
              ))}
            </select>
          </div>

          <div className="mf-row">
            <span className="mf-row-label">
              Show keypad
              <span className="mf-row-hint">Always available as a fallback</span>
            </span>
            <button
              className="mf-switch"
              data-on={s.showKeypad}
              onClick={() => onChange('showKeypad', !s.showKeypad)}
              aria-label="Toggle keypad"
            />
          </div>
        </div>

        <div className="mf-h2">Test the parser</div>
        <p className="mf-note">
          Type what you would say. This runs the exact pipeline the microphone feeds, so you can check
          how a phrase is interpreted without a mic.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="mf-select"
            style={{ flex: 1, maxWidth: 'none' }}
            value={testPhrase}
            onChange={(e) => setTestPhrase(e.target.value)}
            placeholder="e.g. twenty two"
          />
          <button className="mf-btn mf-btn--ghost" style={{ width: 'auto', padding: '0 16px' }} onClick={() => onTestVoice(testPhrase)}>
            <Mic size={16} /> Test
          </button>
        </div>
        {testResult && (
          <div className="mf-stat" style={{ fontSize: 13, fontWeight: 700 }} aria-live="polite">
            {testResult}
          </div>
        )}

        <div className="mf-h2">Voice diagnostics</div>
        <p className="mf-note">
          If voice stops responding mid-run, open this and screenshot it. <strong>rebuilds</strong>{' '}
          climbing means the recogniser wedged and was replaced; a stuck{' '}
          <strong>secSinceActivity</strong> means it went deaf.
        </p>
        <div className="mf-diag">
          {Object.entries(diagnostics).map(([k, v]) => (
            <div key={k}>
              <span>{k}</span>
              <b>{String(v)}</b>
            </div>
          ))}
        </div>
        {history.length > 0 && (
          <div className="mf-diag mf-diag--log">
            {history.map((line, i) => <div key={i}>{line}</div>)}
          </div>
        )}
        <button className="mf-btn mf-btn--ghost" onClick={onRestartVoice}>
          <RotateCcw size={16} /> Restart microphone
        </button>

        <div className="mf-h2">Game</div>
        <div>
          <div className="mf-row">
            <span className="mf-row-label">
              Gentle fall
              <span className="mf-row-hint">Slower blocks, same problem difficulty</span>
            </span>
            <button
              className="mf-switch"
              data-on={s.gentleFall}
              onClick={() => onChange('gentleFall', !s.gentleFall)}
              aria-label="Toggle gentle fall"
            />
          </div>
          <div className="mf-row">
            <span className="mf-row-label">
              Shake to nuke
              <span className="mf-row-hint">Shake the phone to spend a held nuke</span>
            </span>
            <button
              className="mf-switch"
              data-on={s.shakeToNuke}
              onClick={() => onChange('shakeToNuke', !s.shakeToNuke)}
              aria-label="Toggle shake to nuke"
            />
          </div>
          <div className="mf-row">
            <span className="mf-row-label">
              Haptics
              {!hapticsSupported() && (
                <span className="mf-row-hint">Not available in this browser</span>
              )}
            </span>
            <button
              className="mf-switch"
              data-on={s.haptics && hapticsSupported()}
              disabled={!hapticsSupported()}
              onClick={() => {
                const next = !s.haptics;
                onChange('haptics', next);
                // Fire one immediately so the toggle proves itself. On iOS the
                // Taptic route is fixed-intensity and easy to doubt.
                if (next) vibrate(30);
              }}
              aria-label="Toggle haptics"
            />
          </div>
          <div className="mf-row">
            <span className="mf-row-label">
              <Gauge size={14} style={{ display: 'inline', marginRight: 6 }} />
              Graphics
            </span>
            <select
              className="mf-select"
              value={s.quality}
              onChange={(e) => onChange('quality', e.target.value as 'auto' | 'low' | 'high')}
            >
              <option value="auto">Auto</option>
              <option value="high">High</option>
              <option value="low">Battery saver</option>
            </select>
          </div>
        </div>

        <div className="mf-h2">Audio</div>
        <div>
          <div className="mf-row">
            <span className="mf-row-label">Sound effects</span>
            <input
              className="mf-range"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={s.sfx}
              onChange={(e) => onChange('sfx', Number(e.target.value))}
              aria-label="Sound effects volume"
            />
          </div>
          <div className="mf-row">
            <span className="mf-row-label">Music</span>
            <input
              className="mf-range"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={s.music}
              onChange={(e) => onChange('music', Number(e.target.value))}
              aria-label="Music volume"
            />
          </div>
        </div>

        {/* So "am I actually running the new version?" is answerable on a
            phone, where a stale cache looks exactly like a fix that failed. */}
        <div className="mf-build">build {__BUILD_ID__} · {__BUILD_TIME__} UTC</div>

        <button className="mf-btn mf-btn--primary" onClick={onBack}>
          <ArrowLeft size={18} /> Done
        </button>
        <button
          className="mf-btn mf-btn--ghost"
          style={{ borderColor: 'rgba(255,90,120,0.4)', color: '#ff8fa3' }}
          onClick={onReset}
        >
          Reset all progress
        </button>
      </div>
    </div>
  );
};

// -------------------------------------------------------------------- ranks

/**
 * The full ladder, laid out like an achievement list.
 *
 * A rank name on its own is meaningless — "Prism" tells a student nothing
 * about what they can do, and nothing about what comes next. Showing all
 * twenty at once turns the rating into a map: here is what you have passed,
 * here is exactly what the next one asks for, here is how far off it is.
 */
export const AchievementsScreen: React.FC<{ profile: Profile; onBack: () => void }> = ({ profile, onBack }) => {
  const current = rankFor(profile.xp);
  const xp = Math.round(profile.xp);
  const currentRef = React.useRef<HTMLDivElement>(null);

  // Open on the player's own rank rather than at the top of a 20-row list.
  React.useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'center' });
  }, []);

  return (
    <div className="mf-overlay">
      <div className="mf-overlay-inner">
        <h2 className="mf-title" style={{ fontSize: 34 }}>ACHIEVEMENTS</h2>
        <p className="mf-tagline">{current.name} · {xp.toLocaleString()} XP</p>

        <div className="mf-ranks">
          {RANKS.map((r) => {
            const unlocked = xp >= r.at;
            const isCurrent = r.tier === current.tier;
            return (
              <div
                key={r.tier}
                ref={isCurrent ? currentRef : undefined}
                className={
                  'mf-rankrow'
                  + (unlocked ? ' mf-rankrow--on' : '')
                  + (isCurrent ? ' mf-rankrow--now' : '')
                }
                style={{ '--rk': r.color } as React.CSSProperties}
              >
                <span className="mf-rankrow-tier">{unlocked ? r.tier : <Lock size={13} />}</span>
                <span className="mf-rankrow-body">
                  <span className="mf-rankrow-name">{r.name}</span>
                  <span className="mf-rankrow-blurb">{r.blurb}</span>
                  {isCurrent && current.next !== null && (
                    <span className="mf-rankrow-next">
                      {(current.next - xp).toLocaleString()} XP to {RANKS[r.tier].name}
                    </span>
                  )}
                </span>
                <span className="mf-rankrow-at">{r.at ? r.at.toLocaleString() : '—'}</span>
              </div>
            );
          })}
        </div>

        <p className="mf-note">
          XP is earned on every correct answer, weighted by how hard the problem was and how fast you
          answered. It only ever goes up — a bad run still banks everything you earned in it, so a
          rank once reached is yours.
        </p>

        <button className="mf-btn mf-btn--primary" onClick={onBack}>
          <ArrowLeft size={18} /> Back
        </button>
      </div>
    </div>
  );
};

// -------------------------------------------------------------- leaderboard

const MODE_LABELS: Record<string, string> = {
  easy: 'Easy', arcade: 'Arcade', daily: 'Daily', blitz: 'Blitz', zen: 'Practice',
};

export const LeaderboardScreen: React.FC<{
  mode: GameMode;
  onMode: (m: GameMode) => void;
  onBack: () => void;
}> = ({ mode, onMode, onBack }) => {
  const [state, setState] = React.useState<LeaderboardResult>({
    status: 'loading', rows: [], selfIndex: -1,
  });
  const me = React.useMemo(() => playerId(), []);

  React.useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', rows: [], selfIndex: -1 });
    void fetchTop(mode, 50).then((r) => { if (!cancelled) setState(r); });
    return () => { cancelled = true; };
  }, [mode]);

  return (
    <div className="mf-overlay">
      <div className="mf-overlay-inner">
        <h2 className="mf-title" style={{ fontSize: 34 }}>GLOBAL</h2>

        <div className="mf-pill-row">
          {(['easy', 'arcade', 'daily', 'blitz'] as GameMode[]).map((m) => (
            <button key={m} className="mf-pill" data-on={m === mode} onClick={() => onMode(m)}>
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>

        {state.status === 'loading' && <p className="mf-note">Loading…</p>}
        {state.status === 'offline' && (
          <p className="mf-note">You&rsquo;re offline. The board needs a connection; the game doesn&rsquo;t.</p>
        )}
        {state.status === 'error' && (
          <p className="mf-note">
            Couldn&rsquo;t reach the leaderboard. If this is a fresh project, run{' '}
            <strong>supabase/schema.sql</strong> in the SQL editor first.
          </p>
        )}
        {state.status === 'ok' && state.rows.length === 0 && (
          <p className="mf-note">No scores yet in {MODE_LABELS[mode]}. Be the first.</p>
        )}

        {state.rows.length > 0 && (
          <div className="mf-board">
            {state.rows.map((r, i) => (
              <div
                key={`${r.player_id}-${i}`}
                className={'mf-board-row' + (r.player_id === me ? ' mf-board-row--me' : '')}
              >
                <span className="mf-board-rank">{i + 1}</span>
                <span className="mf-board-name">{r.name}</span>
                <span className="mf-board-meta">w{r.wave} · {Math.round(r.accuracy * 100)}%</span>
                <span className="mf-board-score">{r.score.toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}

        <button className="mf-btn mf-btn--primary" onClick={onBack}>
          <ArrowLeft size={18} /> Back
        </button>
        <FluenceBadge />
      </div>
    </div>
  );
};

// -------------------------------------------------------------------- stats

export const StatsScreen: React.FC<{ profile: Profile; onBack: () => void }> = ({ profile, onBack }) => {
  const rank = rankFor(profile.xp);
  const acc = profile.answers > 0 ? profile.correct / profile.answers : 0;
  const dailyKeys = Object.keys(profile.daily).sort().reverse().slice(0, 7);
  const streak = dailyStreak(profile);
  const today = profile.days[dailyKey()];
  const weekKeys = Object.keys(profile.days).sort().reverse().slice(0, 7);

  return (
    <div className="mf-overlay">
      <div className="mf-overlay-inner">
        <h2 className="mf-title" style={{ fontSize: 34 }}>STATS</h2>

        <div className="mf-rank">
          <div>
            <div className="mf-stat-k">Rank</div>
            <div className="mf-rank-name" style={{ color: rank.color }}>{rank.name}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="mf-stat-v">{Math.round(profile.xp).toLocaleString()}</div>
            <div className="mf-stat-k">XP · rating {Math.round(profile.theta)}</div>
          </div>
        </div>

        <Sparkline values={ratingHistory(profile, 200)} color={rank.color} />

        {/* Today first: for a teacher checking a student's phone, "what did
            you do today" is the question — lifetime totals cannot answer it. */}
        {today && (
          <div className="mf-grid2">
            <Stat k="Solved today" v={today.solved.toLocaleString()} />
            <Stat k="Played today" v={fmtTime(today.ms)} sub={`${today.runs} ${today.runs === 1 ? 'run' : 'runs'}`} />
          </div>
        )}

        <div className="mf-grid2">
          <Stat k="Daily streak" v={streak} sub={streak === 1 ? 'day' : 'days'} />
          <Stat k="Problems" v={profile.answers.toLocaleString()} />
          <Stat k="Accuracy" v={`${Math.round(acc * 100)}%`} />
          <Stat k="Best chain" v={Math.max(...Object.values(profile.modes).map((m) => m.bestStreak))} />
          <Stat k="Easy best" v={profile.modes.easy.bestScore.toLocaleString()} />
          <Stat k="Arcade best" v={profile.modes.arcade.bestScore.toLocaleString()} />
          <Stat k="Blitz best" v={profile.modes.blitz.bestScore.toLocaleString()} />
          <Stat k="Time played" v={fmtTime(profile.totalPlayMs)} />
        </div>

        {weekKeys.length > 0 && (
          <>
            <div className="mf-h2">
              <CalendarDays size={13} style={{ display: 'inline', marginRight: 5 }} />
              Last 7 days
            </div>
            <div>
              {weekKeys.map((k) => {
                const d = profile.days[k];
                const dayAcc = d.solved + d.missed > 0 ? Math.round((d.solved / (d.solved + d.missed)) * 100) : 0;
                return (
                  <div className="mf-row" key={k}>
                    <span className="mf-row-label">
                      {k.slice(5)}
                      <span className="mf-row-hint">{d.runs} {d.runs === 1 ? 'run' : 'runs'} · {dayAcc}% accuracy</span>
                    </span>
                    <span className="mf-stat-v" style={{ fontSize: 17 }}>
                      {d.solved.toLocaleString()}
                      <span className="mf-stat-k" style={{ marginLeft: 6 }}>{fmtTime(d.ms)}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div className="mf-h2">Skill mastery</div>
        <div>
          {ALL_SKILLS.map((sk) => {
            const st = profile.skills[sk];
            const m = st ? st.mastery : 0;
            const seen = st ? st.seen : 0;
            return (
              <div className="mf-row" key={sk}>
                <span className="mf-row-label">
                  {SKILL_LABELS[sk]}
                  <span className="mf-row-hint">
                    {seen > 0
                      ? `${seen} seen · ${(st!.avgRtMs / 1000).toFixed(1)}s avg`
                      : 'not seen yet'}
                  </span>
                </span>
                <span style={{ flex: '0 0 92px' }}>
                  <span className="mf-meter" style={{ height: 6 }}>
                    <i style={{ width: `${Math.round(m * 100)}%` }} />
                  </span>
                </span>
              </div>
            );
          })}
        </div>

        {dailyKeys.length > 0 && (
          <>
            <div className="mf-h2">
              <CalendarDays size={13} style={{ display: 'inline', marginRight: 5 }} />
              Recent dailies
            </div>
            <div>
              {dailyKeys.map((k) => {
                const d = profile.daily[k];
                return (
                  <div className="mf-row" key={k}>
                    <span className="mf-row-label">
                      {k}
                      <span className="mf-row-hint">{d.correct}/{d.total} solved</span>
                    </span>
                    <span className="mf-stat-v" style={{ fontSize: 17 }}>{d.score.toLocaleString()}</span>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <p className="mf-note">
          <Sparkles size={13} style={{ display: 'inline', marginRight: 5 }} />
          Your rating tracks <strong>fluency</strong>, not just correctness. Answering fast moves it more
          than answering slowly, and a fast wrong answer costs more than a slow one.
        </p>

        <button className="mf-btn mf-btn--primary" onClick={onBack}>
          <ArrowLeft size={18} /> Back
        </button>
      </div>
    </div>
  );
};
