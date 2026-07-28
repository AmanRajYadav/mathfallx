import React from 'react';
import { Flame, Timer, Zap } from 'lucide-react';
import type { HudState } from '../../engine/GameCore';
import { POWER_UPS, type PowerUpType } from '../../engine/powerups';

interface Props {
  hud: HudState;
  hudRef: React.RefObject<HTMLDivElement>;
  onActivate: (type: PowerUpType) => void;
}

/**
 * Top HUD. Re-renders about ten times a second from a throttled snapshot,
 * never per frame — the canvas and React are deliberately decoupled.
 */
const Hud: React.FC<Props> = ({ hud, hudRef, onActivate }) => {
  const shields = [];
  for (let i = 0; i < Math.min(hud.maxShield, 5); i++) {
    shields.push(<span key={i} className={`mf-shield${i < hud.shield ? '' : ' mf-shield--lost'}`} />);
  }

  return (
    <div className="mf-hud" ref={hudRef}>
      <div className="mf-hud-row">
        <div className="mf-score">{hud.score.toLocaleString()}</div>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {hud.combo >= 2 && (
            <span className="mf-chip mf-chip--combo">
              <Flame size={12} strokeWidth={2.5} />
              {hud.combo}
              {hud.multiplier > 1 && <>&nbsp;&times;{hud.multiplier}</>}
            </span>
          )}
          {hud.overdriveActive && (
            <span className="mf-chip mf-chip--od">
              <Zap size={12} strokeWidth={2.5} />
              Overdrive
            </span>
          )}
          {hud.maxShield <= 5 ? (
            <span className="mf-shields" aria-label={`${hud.shield} shields remaining`}>{shields}</span>
          ) : null}
        </div>
      </div>

      <div className="mf-hud-row">
        <span className="mf-chip" style={{ borderColor: `${hud.rankColor}66`, color: hud.rankColor }}>
          {hud.rank} · {hud.rating}
        </span>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {hud.total !== null && (
            <span className="mf-chip">{hud.solved}/{hud.total}</span>
          )}
          {hud.timeLeft !== null && (
            <span className="mf-chip" style={hud.timeLeft <= 10 ? { color: '#ff5a78', borderColor: '#ff5a7899' } : undefined}>
              <Timer size={12} strokeWidth={2.5} />
              {hud.timeLeft.toFixed(1)}s
            </span>
          )}
          {hud.total === null && hud.timeLeft === null && (
            <span className="mf-chip">Wave {hud.wave}</span>
          )}
        </div>
      </div>

      <div className="mf-meter" aria-hidden="true">
        <i style={{ width: `${Math.round(hud.overdrive * 100)}%` }} />
      </div>

      {/* Held power-ups are drawn on the canvas beside the ship and tapped
          there. Only what is currently *running* needs a HUD readout. */}
      {hud.activeEffects.length > 0 && (
        <div className="mf-powers">
          {hud.activeEffects.map((e) => {
            const def = POWER_UPS[e.type];
            return (
              <span
                key={`a-${e.type}`}
                className="mf-power mf-power--on"
                style={{ '--pw': `hsl(${def.hue},100%,64%)` } as React.CSSProperties}
              >
                <span className="mf-power-icon">{def.icon}</span>
                <span className="mf-power-label">{e.remaining.toFixed(1)}s</span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default Hud;
