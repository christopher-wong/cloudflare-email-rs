/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    // Brutalist-minimal: black, white, one shade of muted gray for hints.
    // No color. No radius. No shadows. No gradients.
    colors: {
      black: '#000',
      white: '#fff',
      ink: '#000',
      paper: '#fff',
      mute: '#999',
      faint: '#e6e6e6',
      transparent: 'transparent',
      current: 'currentColor',
    },
    borderRadius: { none: '0', DEFAULT: '0', full: '9999px' },
    boxShadow: { none: 'none' },
    fontFamily: {
      mono: [
        'JetBrains Mono',
        'IBM Plex Mono',
        'ui-monospace',
        'SFMono-Regular',
        'Menlo',
        'Monaco',
        'Consolas',
        'monospace',
      ],
      sans: [
        'JetBrains Mono',
        'IBM Plex Mono',
        'ui-monospace',
        'SFMono-Regular',
        'Menlo',
        'Monaco',
        'Consolas',
        'monospace',
      ],
    },
    extend: {
      fontSize: {
        '2xs': '0.6875rem',
      },
      letterSpacing: {
        wider: '0.06em',
        widest: '0.12em',
      },
    },
  },
  plugins: [],
};
