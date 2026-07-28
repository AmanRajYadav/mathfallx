import React from 'react';
import {
  ArrowLeft, CalendarDays, ChartNoAxesColumn, Gauge, Infinity as InfinityIcon,
  Mic, Play, RotateCcw, Settings, Sparkles, Sprout, Timer, Trophy,
} from 'lucide-react';
import type { RunSummary } from '../../engine/GameCore';
import { rankFor } from '../../engine/adaptive';
import type { GameMode, Profile } from '../../engine/profile';
import type { Skill } from '../../engine/generator';
import { VOICE_LANGUAGES } from '../../voice/recognizer';

export type Screen = 'title' | 'playing' | 'paused' | 'over' | 'settings' | 'stats';

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
  const rank = rankFor(profile.theta);
  return (
    <div className="mf-overlay">
      <div className="mf-overlay-inner">
        <div>
          <h1 className="mf-title">MATHFALL</h1>
          <p className="mf-tagline">Say the answer · Destroy the block</p>
        </div>

        <div className="mf-rank">
          <div>
            <div className="mf-stat-k">Neural rating</div>
            <div className="mf-rank-name" style={{ color: rank.color }}>{rank.name}</div>
          </div>
          <div className="mf-stat-v">{Math.round(profile.theta)}</div>
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
            <span>Daily Challenge {!dailyDone && <span className="mf-badge-new">NEW</span>}</span>
            <span className="mf-btn-sub">40 problems — identical for everyone today</span>
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

        <div className="mf-grid2">
          <button className="mf-btn mf-btn--ghost" onClick={() => onScreen('stats')}>
            <ChartNoAxesColumn size={17} /> Stats
          </button>
          <button className="mf-btn mf-btn--ghost" onClick={() => onScreen('settings')}>
            <Settings size={17} /> Settings
          </button>
        </div>

        {voiceSupported ? (
          <p className="mf-note">
            <strong>Voice is on.</strong> Just say the answer — &ldquo;forty two&rdquo;, &ldquo;42&rdquo;, even
            &ldquo;four two&rdquo;. Say <strong>bomb</strong> to spend Overdrive, or <strong>pause</strong> to stop.
          </p>
        ) : (
          <p className="mf-note">
            This browser has no speech recognition. The keypad works everywhere — for voice, try Chrome
            on Android or Safari on iOS.
          </p>
        )}

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

export const GameOverScreen: React.FC<{
  summary: RunSummary;
  profile: Profile;
  onAgain: () => void;
  onMenu: () => void;
}> = ({ summary, profile, onAgain, onMenu }) => {
  const delta = summary.ratingAfter - summary.ratingBefore;
  const rank = rankFor(profile.theta);

  return (
    <div className="mf-overlay">
      <div className="mf-overlay-inner">
        <div>
          <h2 className="mf-title" style={{ fontSize: 40 }}>
            {summary.isRecord ? 'NEW RECORD' : 'RUN OVER'}
          </h2>
          <p className="mf-tagline">{summary.mode} · {fmtTime(summary.durationMs)}</p>
        </div>

        <div className="mf-rank">
          <div>
            <div className="mf-stat-k">Score</div>
            <div className="mf-stat-v" style={{ fontSize: 32 }}>{summary.score.toLocaleString()}</div>
          </div>
          {summary.isRecord && <Trophy size={30} color="#ffe66d" />}
        </div>

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
            <div className="mf-stat-k">Neural rating</div>
            <div className="mf-rank-name" style={{ color: rank.color }}>{rank.name}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="mf-stat-v">{summary.ratingAfter}</div>
            <div
              className="mf-stat-k"
              style={{ color: delta >= 0 ? '#39ff88' : '#ff5a78' }}
            >
              {delta >= 0 ? '+' : ''}{delta}
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
            <span className="mf-row-label">Haptics</span>
            <button
              className="mf-switch"
              data-on={s.haptics}
              onClick={() => onChange('haptics', !s.haptics)}
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

// -------------------------------------------------------------------- stats

export const StatsScreen: React.FC<{ profile: Profile; onBack: () => void }> = ({ profile, onBack }) => {
  const rank = rankFor(profile.theta);
  const acc = profile.answers > 0 ? profile.correct / profile.answers : 0;
  const dailyKeys = Object.keys(profile.daily).sort().reverse().slice(0, 7);

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
            <div className="mf-stat-v">{Math.round(profile.theta)}</div>
            <div className="mf-stat-k">peak {Math.round(profile.peakTheta)}</div>
          </div>
        </div>

        <div className="mf-grid2">
          <Stat k="Problems" v={profile.answers.toLocaleString()} />
          <Stat k="Accuracy" v={`${Math.round(acc * 100)}%`} />
          <Stat k="Arcade best" v={profile.modes.arcade.bestScore.toLocaleString()} />
          <Stat k="Blitz best" v={profile.modes.blitz.bestScore.toLocaleString()} />
          <Stat k="Best chain" v={Math.max(...Object.values(profile.modes).map((m) => m.bestStreak))} />
          <Stat k="Time played" v={fmtTime(profile.totalPlayMs)} />
        </div>

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
