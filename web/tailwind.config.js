/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Neutrals are RGB triples on :root so Tailwind's /alpha syntax
      // (bg-elev/50, border-border/60) works. Accent stays as a raw oklch
      // variable because its alpha is baked into a dedicated ring token.
      colors: {
        bg: 'rgb(var(--bg) / <alpha-value>)',
        elev: 'rgb(var(--bg-elev) / <alpha-value>)',
        sunken: 'rgb(var(--bg-sunken) / <alpha-value>)',
        hover: 'rgb(var(--bg-hover) / <alpha-value>)',
        border: 'rgb(var(--border) / <alpha-value>)',
        'border-strong': 'rgb(var(--border-strong) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        'ink-muted': 'rgb(var(--ink-muted) / <alpha-value>)',
        'ink-faint': 'rgb(var(--ink-faint) / <alpha-value>)',
        accent: {
          DEFAULT: 'var(--accent)',
          soft: 'var(--accent-soft)',
          ink: 'var(--accent-ink)',
          ring: 'var(--accent-ring)',
        },
        danger: { DEFAULT: '#B43A3A', soft: '#FBEEEE' },
        pending: { DEFAULT: '#C9A12B', soft: '#FDF6EE' },
      },
      fontFamily: {
        sans: ['Geist', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['Geist Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['10.5px', { lineHeight: '1.4' }],
      },
      letterSpacing: {
        widest: '0.1em',
      },
      borderRadius: {
        sm: '6px',
        DEFAULT: '10px',
        md: '10px',
        lg: '14px',
      },
      boxShadow: {
        low: '0 1px 0 rgb(20 20 15 / 0.04)',
        pop: '0 1px 0 rgb(20 20 15 / 0.04), 0 12px 32px -8px rgb(20 20 15 / 0.12), 0 4px 12px -4px rgb(20 20 15 / 0.06)',
      },
      ringColor: {
        accent: 'var(--accent-ring)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'zoom-in': {
          from: { transform: 'scale(0.96)', opacity: '0' },
          to: { transform: 'scale(1)', opacity: '1' },
        },
        'slide-up': {
          from: { transform: 'translateY(8px)', opacity: '0' },
          to: { transform: 'translateY(0)', opacity: '1' },
        },
        'pulse-soft': { '0%, 100%': { opacity: '0.55' }, '50%': { opacity: '1' } },
      },
      animation: {
        'fade-in': 'fade-in 140ms ease-out',
        'zoom-in': 'zoom-in 140ms ease-out',
        'slide-up': 'slide-up 160ms ease-out',
        'pulse-soft': 'pulse-soft 2400ms ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
