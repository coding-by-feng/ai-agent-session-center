/**
 * CliBrandIcons — small brand-style marks for the AI CLIs, used by the DIRS
 * launcher to start a specific CLI in a directory. These are recognizable
 * approximations of the official logos rendered as inline SVG (Anthropic
 * sunburst, OpenAI blossom-knot, Google Gemini spark) in their brand colors.
 */

interface IconProps {
  size?: number;
}

/** Claude — Anthropic sunburst (coral). */
export function ClaudeIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <g stroke="#D97757" strokeWidth="2.1" strokeLinecap="round">
        <line x1="12" y1="3.5" x2="12" y2="20.5" />
        <line x1="3.5" y1="12" x2="20.5" y2="12" />
        <line x1="6" y1="6" x2="18" y2="18" />
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="8.7" y1="4.3" x2="15.3" y2="19.7" />
        <line x1="19.7" y1="8.7" x2="4.3" y2="15.3" />
      </g>
    </svg>
  );
}

/** Codex — OpenAI blossom knot (three interlocking loops, OpenAI green). */
export function CodexIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <g stroke="#10a37f" strokeWidth="1.5" fill="none">
        <ellipse cx="12" cy="12" rx="9" ry="3.7" />
        <ellipse cx="12" cy="12" rx="9" ry="3.7" transform="rotate(60 12 12)" />
        <ellipse cx="12" cy="12" rx="9" ry="3.7" transform="rotate(120 12 12)" />
      </g>
    </svg>
  );
}

/** Gemini — Google four-point spark (blue→purple→coral gradient). */
export function GeminiIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="geminiSpark" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
          <stop stopColor="#4285F4" />
          <stop offset="0.5" stopColor="#9b72cb" />
          <stop offset="1" stopColor="#d96570" />
        </linearGradient>
      </defs>
      <path
        d="M12 2c.45 4.85 2.65 7.05 8 8-5.35 .95-7.55 3.15-8 8-.45-4.85-2.65-7.05-8-8 5.35-.95 7.55-3.15 8-8Z"
        fill="url(#geminiSpark)"
      />
    </svg>
  );
}
