import type { CSSProperties } from "react";

type ArtProps = { size?: number; style?: CSSProperties; className?: string };

export function Sprout({
  size = 96,
  growth = 0.5,
  mood = "happy",
  style,
  className,
}: ArtProps & { growth?: number; mood?: "happy" | "tired" | "sleepy" }) {
  const g = Math.max(0, Math.min(1, growth));
  const leafCount = 1 + Math.floor(g * 5);
  const stemH = 18 + g * 28;
  const eyeY = 78 - stemH * 0.5;
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" style={style} className={className}>
      <ellipse cx="60" cy="108" rx="28" ry="3" fill="rgba(43,36,24,0.18)" />
      <path d="M32 84 L88 84 L82 108 Q60 112 38 108 Z" fill="#c9805a" stroke="var(--ink)" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M30 80 L90 80 L88 88 L32 88 Z" fill="#a7654a" stroke="var(--ink)" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M34 82 Q60 76 86 82" stroke="var(--soil-dark)" strokeWidth="1.5" fill="none" />
      <path
        d={`M60 80 Q 58 ${80 - stemH * 0.5} 60 ${80 - stemH}`}
        stroke="var(--moss-deep)"
        strokeWidth="2.2"
        fill="none"
        strokeLinecap="round"
      />
      {Array.from({ length: leafCount }).map((_, i) => {
        const t = (i + 1) / (leafCount + 1);
        const y = 80 - stemH * t;
        const left = i % 2 === 0;
        const lx = left ? 60 - 16 : 60 + 16;
        return (
          <g key={i}>
            <path
              d={
                left
                  ? `M60 ${y} Q ${lx + 4} ${y - 8}, ${lx} ${y - 4} Q ${lx + 8} ${y + 6}, 60 ${y + 1}`
                  : `M60 ${y} Q ${lx - 4} ${y - 8}, ${lx} ${y - 4} Q ${lx - 8} ${y + 6}, 60 ${y + 1}`
              }
              fill={i === leafCount - 1 ? "var(--sprout)" : "var(--fern)"}
              stroke="var(--moss-deep)"
              strokeWidth="1.4"
            />
            <path
              d={left ? `M60 ${y} L ${lx + 2} ${y - 2}` : `M60 ${y} L ${lx - 2} ${y - 2}`}
              stroke="var(--moss-deep)"
              strokeWidth="1"
              fill="none"
            />
          </g>
        );
      })}
      {g > 0.15 && (
        <g>
          <circle cx={56} cy={eyeY} r="1.6" fill="var(--ink)" />
          <circle cx={64} cy={eyeY} r="1.6" fill="var(--ink)" />
          {mood === "happy" && (
            <path
              d={`M56 ${eyeY + 4} Q60 ${eyeY + 7} 64 ${eyeY + 4}`}
              stroke="var(--ink)"
              strokeWidth="1.4"
              fill="none"
              strokeLinecap="round"
            />
          )}
          {mood === "tired" && (
            <path
              d={`M56 ${eyeY + 5} Q60 ${eyeY + 4} 64 ${eyeY + 5}`}
              stroke="var(--ink)"
              strokeWidth="1.4"
              fill="none"
              strokeLinecap="round"
            />
          )}
          {mood === "sleepy" && (
            <>
              <line x1={54} x2={58} y1={eyeY} y2={eyeY} stroke="var(--ink)" strokeWidth="1.4" />
              <line x1={62} x2={66} y1={eyeY} y2={eyeY} stroke="var(--ink)" strokeWidth="1.4" />
            </>
          )}
        </g>
      )}
    </svg>
  );
}

export function HeroTree({ size = 220, style, className }: ArtProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 220 220" style={style} className={className}>
      <path
        d="M110 30 C 60 30, 30 70, 50 110 C 30 130, 60 170, 100 160 C 110 180, 140 178, 150 160 C 190 170, 200 130, 178 110 C 200 70, 160 30, 110 30 Z"
        fill="var(--fern)"
        stroke="var(--moss-deep)"
        strokeWidth="2"
      />
      <path d="M70 60 Q 95 50, 120 60" stroke="var(--sprout)" strokeWidth="3" fill="none" opacity="0.7" />
      <path d="M60 100 Q 90 90, 110 100" stroke="var(--sprout)" strokeWidth="3" fill="none" opacity="0.6" />
      <path d="M120 120 Q 150 115, 175 130" stroke="var(--sprout)" strokeWidth="3" fill="none" opacity="0.6" />
      <path d="M100 158 L 96 200 L 124 200 L 120 158 Z" fill="var(--bark)" stroke="var(--ink)" strokeWidth="1.6" />
      <path d="M105 170 Q 110 180, 105 195" stroke="var(--soil-dark)" strokeWidth="1.2" fill="none" />
      <ellipse cx="105" cy="150" rx="18" ry="14" fill="rgba(43,36,24,0.15)" stroke="none" />
      <circle cx="100" cy="150" r="1.8" fill="var(--ink)" />
      <circle cx="112" cy="150" r="1.8" fill="var(--ink)" />
      <path d="M100 156 Q 106 159, 112 156" stroke="var(--ink)" strokeWidth="1.4" fill="none" />
      <path d="M40 200 Q 110 210, 180 200" stroke="var(--soil-dark)" strokeWidth="1.6" fill="none" />
    </svg>
  );
}

export function ForestSprite({
  size = 96,
  expression = "smile",
  style,
  className,
}: ArtProps & { expression?: "smile" | "o" | "chat" | "sleep" }) {
  const mouth =
    {
      smile: "M44 64 Q 50 70, 56 64",
      o: "M48 64 Q 50 70, 52 64",
      chat: "M44 64 Q 50 67, 56 64",
      sleep: "M46 65 Q 50 67, 54 65",
    }[expression] || "M44 64 Q 50 70, 56 64";
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={style} className={className}>
      <ellipse cx="50" cy="92" rx="26" ry="3" fill="rgba(43,36,24,0.2)" />
      <path d="M50 14 Q 38 4, 30 14 Q 38 22, 50 18" fill="var(--fern)" stroke="var(--moss-deep)" strokeWidth="1.6" />
      <path d="M50 14 Q 62 4, 70 14 Q 62 22, 50 18" fill="var(--sprout)" stroke="var(--moss-deep)" strokeWidth="1.6" />
      <path d="M50 18 L 50 30" stroke="var(--moss-deep)" strokeWidth="1.6" />
      <path
        d="M22 56 Q 22 30, 50 30 Q 78 30, 78 56 Q 78 86, 50 88 Q 22 86, 22 56 Z"
        fill="var(--leaf-pale)"
        stroke="var(--ink)"
        strokeWidth="1.8"
      />
      <path d="M34 60 Q 50 76, 66 60" stroke="var(--moss)" strokeWidth="1.2" fill="none" opacity="0.6" />
      <circle cx="40" cy="56" r="3" fill="var(--ink)" />
      <circle cx="60" cy="56" r="3" fill="var(--ink)" />
      <circle cx="41" cy="55" r="0.9" fill="#fff" />
      <circle cx="61" cy="55" r="0.9" fill="#fff" />
      <path d={mouth} stroke="var(--ink)" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <circle cx="32" cy="62" r="3" fill="var(--blush)" opacity="0.6" />
      <circle cx="68" cy="62" r="3" fill="var(--blush)" opacity="0.6" />
      <ellipse cx="38" cy="90" rx="6" ry="3" fill="var(--moss)" stroke="var(--ink)" strokeWidth="1.2" />
      <ellipse cx="62" cy="90" rx="6" ry="3" fill="var(--moss)" stroke="var(--ink)" strokeWidth="1.2" />
    </svg>
  );
}

export function Snail({ size = 72, style, className }: ArtProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={style} className={className}>
      <ellipse cx="55" cy="86" rx="34" ry="3" fill="rgba(43,36,24,0.18)" />
      <path
        d="M14 80 Q 14 64, 38 64 L 70 64 Q 84 64, 84 78 Q 84 86, 70 86 L 22 86 Q 14 86, 14 80 Z"
        fill="var(--sun-soft)"
        stroke="var(--ink)"
        strokeWidth="1.6"
      />
      <path d="M16 70 Q 8 60, 10 50" stroke="var(--ink)" strokeWidth="1.4" fill="none" />
      <path d="M22 68 Q 18 58, 20 48" stroke="var(--ink)" strokeWidth="1.4" fill="none" />
      <circle cx="10" cy="48" r="2" fill="var(--ink)" />
      <circle cx="20" cy="46" r="2" fill="var(--ink)" />
      <circle cx="58" cy="56" r="22" fill="var(--soil)" stroke="var(--ink)" strokeWidth="1.8" />
      <path
        d="M58 56 m -14 0 a 14 14 0 1 0 28 0 a 10 10 0 1 0 -20 0 a 6 6 0 1 0 12 0"
        stroke="var(--ink)"
        strokeWidth="1.4"
        fill="none"
      />
      <circle cx="20" cy="76" r="1.4" fill="var(--ink)" />
      <path d="M28 80 Q 32 76, 36 80" stroke="var(--ink)" strokeWidth="1.2" fill="none" />
    </svg>
  );
}

export function Frog({ size = 72, style, className }: ArtProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={style} className={className}>
      <ellipse cx="50" cy="90" rx="28" ry="3" fill="rgba(43,36,24,0.18)" />
      <path
        d="M22 70 Q 22 46, 50 46 Q 78 46, 78 70 Q 78 90, 50 90 Q 22 90, 22 70 Z"
        fill="var(--fern)"
        stroke="var(--moss-deep)"
        strokeWidth="1.8"
      />
      <path
        d="M32 80 Q 50 90, 68 80 Q 60 70, 50 70 Q 40 70, 32 80 Z"
        fill="var(--leaf-pale)"
        stroke="var(--moss-deep)"
        strokeWidth="1.2"
      />
      <circle cx="36" cy="42" r="10" fill="var(--fern)" stroke="var(--moss-deep)" strokeWidth="1.6" />
      <circle cx="64" cy="42" r="10" fill="var(--fern)" stroke="var(--moss-deep)" strokeWidth="1.6" />
      <circle cx="36" cy="42" r="5" fill="#fff" stroke="var(--ink)" strokeWidth="1.2" />
      <circle cx="64" cy="42" r="5" fill="#fff" stroke="var(--ink)" strokeWidth="1.2" />
      <circle cx="37" cy="43" r="2.5" fill="var(--ink)" />
      <circle cx="65" cy="43" r="2.5" fill="var(--ink)" />
      <path d="M40 66 Q 50 72, 60 66" stroke="var(--moss-deep)" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <circle cx="32" cy="64" r="2.5" fill="var(--blush)" opacity="0.6" />
      <circle cx="68" cy="64" r="2.5" fill="var(--blush)" opacity="0.6" />
    </svg>
  );
}

export function Mushroom({ size = 64, style, className }: ArtProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" style={style} className={className}>
      <ellipse cx="40" cy="74" rx="20" ry="2.5" fill="rgba(43,36,24,0.18)" />
      <path
        d="M14 44 Q 14 16, 40 16 Q 66 16, 66 44 Q 50 50, 40 50 Q 30 50, 14 44 Z"
        fill="var(--berry)"
        stroke="var(--ink)"
        strokeWidth="1.6"
      />
      <circle cx="28" cy="32" r="3.5" fill="#fff8e8" />
      <circle cx="46" cy="26" r="2.5" fill="#fff8e8" />
      <circle cx="54" cy="38" r="3" fill="#fff8e8" />
      <circle cx="36" cy="42" r="2" fill="#fff8e8" />
      <path d="M30 50 Q 32 70, 32 74 L 48 74 Q 48 70, 50 50 Z" fill="#f5e8c8" stroke="var(--ink)" strokeWidth="1.4" />
      <circle cx="35" cy="60" r="1.3" fill="var(--ink)" />
      <circle cx="45" cy="60" r="1.3" fill="var(--ink)" />
      <path d="M35 64 Q 40 67, 45 64" stroke="var(--ink)" strokeWidth="1.2" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export function Bird({ size = 40, style, className }: ArtProps) {
  return (
    <svg width={size} height={size * 0.6} viewBox="0 0 60 36" style={style} className={className}>
      <path d="M4 18 Q 18 4, 30 18 Q 42 4, 56 18" stroke="var(--ink)" strokeWidth="1.8" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export function Cloud({ size = 120, style, className }: ArtProps) {
  return (
    <svg width={size} height={size * 0.5} viewBox="0 0 120 60" style={style} className={className}>
      <path
        d="M14 40 Q 14 24, 32 26 Q 36 12, 56 16 Q 76 10, 80 26 Q 100 24, 100 40 Q 100 52, 84 52 L 30 52 Q 14 52, 14 40 Z"
        fill="#fff8e8"
        stroke="var(--ink)"
        strokeWidth="1.4"
        opacity="0.9"
      />
    </svg>
  );
}

export function SunArt({ size = 96, style, className }: ArtProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={style} className={className}>
      <circle cx="50" cy="50" r="22" fill="var(--sun)" stroke="var(--ink)" strokeWidth="1.6" />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((a, i) => {
        const rad = (a * Math.PI) / 180;
        const x1 = 50 + Math.cos(rad) * 30;
        const y1 = 50 + Math.sin(rad) * 30;
        const x2 = 50 + Math.cos(rad) * 42;
        const y2 = 50 + Math.sin(rad) * 42;
        return (
          <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--ink)" strokeWidth="1.6" strokeLinecap="round" />
        );
      })}
      <circle cx="44" cy="48" r="1.4" fill="var(--ink)" />
      <circle cx="56" cy="48" r="1.4" fill="var(--ink)" />
      <path d="M44 54 Q 50 58, 56 54" stroke="var(--ink)" strokeWidth="1.4" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export function WateringCan({ size = 64, style, className }: ArtProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" style={style} className={className}>
      <path
        d="M14 36 L 14 64 Q 14 70, 22 70 L 50 70 Q 58 70, 58 64 L 60 36 Z"
        fill="var(--sky)"
        stroke="var(--ink)"
        strokeWidth="1.6"
      />
      <path d="M14 36 L 60 36" stroke="var(--ink)" strokeWidth="1.6" />
      <path d="M58 40 L 72 30 L 76 40 L 70 46 Z" fill="var(--sky)" stroke="var(--ink)" strokeWidth="1.6" />
      <path d="M22 40 Q 36 28, 50 40" stroke="var(--ink)" strokeWidth="1.6" fill="none" />
      <path d="M20 32 L 24 28 L 30 32" stroke="var(--ink)" strokeWidth="1.6" fill="none" />
    </svg>
  );
}

export function LeafSprig({
  size = 56,
  flip = false,
  style,
  className,
}: ArtProps & { flip?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 60 60"
      style={{ transform: flip ? "scaleX(-1)" : undefined, ...style }}
      className={className}
    >
      <path d="M6 54 Q 30 30, 56 6" stroke="var(--moss-deep)" strokeWidth="1.6" fill="none" />
      <path d="M16 44 Q 24 36, 22 26 Q 14 32, 16 44 Z" fill="var(--fern)" stroke="var(--moss-deep)" strokeWidth="1.4" />
      <path d="M30 30 Q 38 22, 36 12 Q 28 18, 30 30 Z" fill="var(--sprout)" stroke="var(--moss-deep)" strokeWidth="1.4" />
      <path d="M44 16 Q 50 10, 50 4 Q 42 6, 44 16 Z" fill="var(--fern)" stroke="var(--moss-deep)" strokeWidth="1.4" />
    </svg>
  );
}

export function StarFilled({
  size = 22,
  filled = false,
  style,
}: ArtProps & { filled?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={style}>
      <path
        d="M12 3 L 14.5 9 L 21 9.5 L 16 13.8 L 17.5 20 L 12 16.6 L 6.5 20 L 8 13.8 L 3 9.5 L 9.5 9 Z"
        fill={filled ? "var(--sun)" : "transparent"}
        stroke="var(--ink)"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function GoogleG({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <path
        d="M21.6 12.227c0-.708-.064-1.39-.182-2.045H12v3.868h5.382a4.6 4.6 0 0 1-1.995 3.018v2.51h3.232c1.891-1.741 2.981-4.305 2.981-7.35z"
        fill="#4285F4"
      />
      <path
        d="M12 22c2.7 0 4.964-.895 6.619-2.422l-3.232-2.51c-.895.6-2.04.955-3.387.955-2.605 0-4.81-1.759-5.595-4.123H3.064v2.59A9.996 9.996 0 0 0 12 22z"
        fill="#34A853"
      />
      <path
        d="M6.405 13.9A6.005 6.005 0 0 1 6.09 12c0-.659.114-1.3.314-1.9V7.51H3.064A9.996 9.996 0 0 0 2 12c0 1.614.386 3.14 1.064 4.49l3.341-2.59z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.977c1.468 0 2.786.504 3.823 1.495l2.868-2.868C16.96 2.99 14.696 2 12 2 8.105 2 4.74 4.235 3.064 7.51l3.341 2.59C7.19 7.736 9.395 5.977 12 5.977z"
        fill="#EA4335"
      />
    </svg>
  );
}

export function CalendarIcon({ size = 22, style }: ArtProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={style}>
      <rect x="3.5" y="5.5" width="17" height="15" rx="2" fill="var(--paper)" stroke="var(--ink)" strokeWidth="1.5" />
      <line x1="3.5" y1="9.5" x2="20.5" y2="9.5" stroke="var(--ink)" strokeWidth="1.5" />
      <line x1="8" y1="3.5" x2="8" y2="7" stroke="var(--ink)" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="16" y1="3.5" x2="16" y2="7" stroke="var(--ink)" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="13" r="1" fill="var(--moss)" />
      <circle cx="12" cy="13" r="1" fill="var(--moss)" />
      <circle cx="16" cy="13" r="1" fill="var(--moss)" />
      <circle cx="8" cy="17" r="1" fill="var(--moss)" />
    </svg>
  );
}

export function Sparkle({ size = 16, style }: ArtProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={style}>
      <path d="M8 1 L 9 7 L 15 8 L 9 9 L 8 15 L 7 9 L 1 8 L 7 7 Z" fill="var(--sun)" stroke="var(--ink)" strokeWidth="1" />
    </svg>
  );
}

export function GardenStrip({ height = 80, style }: { height?: number; style?: CSSProperties }) {
  return (
    <svg viewBox="0 0 1200 80" height={height} width="100%" preserveAspectRatio="none" style={style}>
      <path d="M0 70 Q 300 64, 600 70 T 1200 70" stroke="var(--moss-deep)" strokeWidth="1.6" fill="none" />
      {Array.from({ length: 24 }).map((_, i) => {
        const x = i * 50 + 20;
        return (
          <g key={i}>
            <path
              d={`M${x} 70 L ${x - 2} 60 M ${x} 70 L ${x + 2} 58 M ${x} 70 L ${x + 6} 62`}
              stroke="var(--moss)"
              strokeWidth="1.2"
              fill="none"
            />
          </g>
        );
      })}
      {[120, 360, 660, 940].map((x, i) => (
        <g key={i}>
          <line x1={x} y1="70" x2={x} y2="56" stroke="var(--moss-deep)" strokeWidth="1" />
          <circle cx={x} cy="54" r="3" fill={i % 2 ? "var(--blush)" : "var(--sun)"} stroke="var(--ink)" strokeWidth="1" />
        </g>
      ))}
    </svg>
  );
}
