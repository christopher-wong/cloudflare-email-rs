# bmail — Design System & Style Guide

A reference for porting the bmail prototype into a React + Tailwind codebase. Tokens, components, patterns, and the rules we follow to keep the product feeling calm, minimal, and trustworthy.

---

## Table of contents

**Foundations**
- [Principles](#principles)
- [Typography](#typography)
- [Color](#color)
- [Spacing & radii](#spacing--radii)
- [Motion](#motion)

**Setup**
- [Tailwind config](#tailwind-config)
- [Global CSS](#global-css)

**Components**
- [Button](#button)
- [Inputs & select](#inputs--select)
- [Toggle & checkbox](#toggle--checkbox)
- [Avatar](#avatar)
- [Label tag](#label-tag)
- [Chip](#chip)
- [Badge & status pill](#badge--status-pill)
- [Card](#card)
- [Field row](#field-row)
- [Data table](#data-table)
- [Icon](#icon)

**Patterns**
- [App shell](#app-shell)
- [List rows (inbox)](#list-rows-inbox)
- [Avatar-as-checkbox](#avatar-as-checkbox)
- [Modal & command palette](#modal--command-palette)
- [Encryption indicators](#encryption-indicators)
- [Empty state](#empty-state)

**Direction**
- [Voice & microcopy](#voice--microcopy)
- [Anti-patterns](#anti-patterns)
- [Implementation order](#implementation-order)

---

## Principles

Five non-negotiables. Everything downstream serves these.

### 1. Calm by default
The product is encryption infrastructure. Loudness reads as desperation. Use one accent color, hairline borders instead of shadows, no gradients, no glow. Reserve color for state changes and security signals.

### 2. Hairlines, not shadows
Cards, rows, and inputs get a 1px `--border` stroke. Shadows only appear on overlays (modals, command palette, hovering elements). Flat, layered surfaces — not floating ones.

### 3. Type does the heavy lifting
Hierarchy comes from size, weight, and color — not from boxes, fills, or decoration. A label is a colored dot plus text. A status is a dot plus a word. Avoid containers that aren't earning their pixels.

### 4. The encryption story is a whisper
One small lock glyph next to a thread subject. The word "encrypted" in a soft pill. A microcopy line under the password input. Never a hero banner, never animated shields, never a key icon larger than 18px.

### 5. Density without crowding
Generous gutters (20–40px page padding, 12–14px row gaps), but rows themselves are tight (28–32px avatars, 12.5–14.5px text). The whole product should feel like a well-organized spreadsheet, not a marketing page.

---

## Typography

Two families. Geist Sans does almost everything; Geist Mono handles addresses, tokens, timestamps, and table data.

### Families

```css
/* globals.css — load once at the document root */
@import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap');
```

### Scale

| Role | Size | Weight | Letter-spacing | Line-height | Tailwind |
|---|---|---|---|---|---|
| Display | 44px | 600 | -0.025em | 1.05 | `text-[44px] font-semibold tracking-[-0.025em] leading-[1.05]` |
| Page title | 26px | 600 | -0.018em | 1.15 | `text-[26px] font-semibold tracking-tight` |
| Section heading | 17px | 600 | -0.005em | 1.4 | `text-[17px] font-semibold` |
| Body | 15px | 400 | 0 | 1.55 | `text-[15px] leading-relaxed` |
| UI / row | 13.5px | 400–500 | 0 | 1.5 | `text-[13.5px]` |
| Caption | 12px | 400 | 0 | 1.5 | `text-xs` |
| Eyebrow | 10.5px | 500 | 0.10em | 1.4 | `text-[10.5px] tracking-wider uppercase` |

### Feature settings

Enable stylistic alternates and slashed zero:

```css
body { font-feature-settings: 'ss01', 'cv11'; }
.font-mono { font-feature-settings: 'zero'; } /* slashed 0 */
```

### When to use Mono

- Email addresses and handles (`christopher@middleseat.vc`)
- Tokens, IDs, hashes (`inv_E_lF53cW…`)
- Timestamps in tables (`2026-05-23 21:11:32 UTC`)
- Cipher names and crypto details
- **Never** for paragraphs, headlines, or button labels. Mono is a label, not a voice.

---

## Color

Warm neutrals, single accent. The whole palette fits in a handful of variables.

### Neutrals

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#FAFAF7` | App background |
| `--bg-elev` | `#FFFFFF` | Cards, popovers, elevated surfaces |
| `--bg-sunken` | `#F4F2EC` | Segmented controls, inert chrome |
| `--bg-hover` | `#F1EFE8` | Row / button hover state |
| `--border` | `#EBE9E2` | Default hairline border |
| `--border-strong` | `#D9D6CC` | Hover border, toggle off |
| `--ink-faint` | `#A09F98` | Eyebrows, placeholder, metadata |
| `--ink-muted` | `#6B6B66` | Body text, default ink for nav |
| `--ink` | `#181816` | Primary text, brand logo, primary button |

### Accents (tweakable)

The accent owns: encryption pills, focus rings, active row tint, primary action backgrounds when an action is constructive (not destructive). Default is sage. Five swappable presets:

| Name | Base (oklch) | Notes |
|---|---|---|
| **Sage** | `oklch(0.55 0.04 155)` | Default — calm, security-product green |
| Indigo | `oklch(0.58 0.13 270)` | Confident, tech-y |
| Amber | `oklch(0.68 0.13 70)` | Warm, founder-y |
| Slate | `oklch(0.45 0.02 250)` | Most neutral — when accent should disappear |
| Rose | `oklch(0.60 0.13 20)` | Distinctive, personal |

Each accent ships with four derived shades:

```css
/* sage — default */
--accent:      oklch(0.55 0.04 155);     /* base */
--accent-soft: oklch(0.95 0.02 155);     /* tint for pills, selected rows */
--accent-ink:  oklch(0.35 0.05 155);     /* text on accent-soft */
--accent-ring: oklch(0.55 0.04 155 / 0.18); /* focus halo */
```

### Semantic colors

| Role | Hex | Use |
|---|---|---|
| Danger | `#B43A3A` | Destructive button text, error helper, expired status |
| Danger soft | `#FBEEEE` | Danger zone backgrounds |
| Pending | `#C9A12B` | Pending status pill |

### Avatar palette

Avatars use a small, deterministic palette — desaturated jewel tones that don't fight the accent.

```
#5C7A6B  #7E6B5A  #6B6A8C  #8A6B7A  #555558  #6B7E8C  #8C7E5A
```

Color is assigned by hashing the user's address (or row-position fallback) into one of the seven slots. Never use the accent color for an avatar — it would steal the encryption signal.

---

## Spacing & radii

A 4px scale plus three corner radii. That's the whole geometry.

| Token | Value | Used for |
|---|---|---|
| `--r-sm` | 6px | Small buttons, sidebar items, checkboxes, chips inside chips |
| `--r-md` | 10px | Default cards, inputs, buttons, modals |
| `--r-lg` | 14px | Compose modal, command palette |
| `--r-pill` | 999px | Avatars, chips, status pills, badges |

### Spacing scale

Use Tailwind's default 4px grid. Recurring patterns:

- **Row gap** within a card: `gap-3` / `gap-3.5` (12–14px)
- **Card padding**: `p-4` body, `px-[18px] py-[14px]` header
- **Page padding**: `px-10 py-9` (40px / 36px) on settings/admin pages
- **Sidebar padding**: `px-[14px] py-[18px]`

### Shadows

```css
--shadow-low: 0 1px 0 rgba(20,20,15,0.04);
--shadow-pop: 0 1px 0 rgba(20,20,15,0.04),
              0 12px 32px -8px rgba(20,20,15,0.12),
              0 4px 12px -4px rgba(20,20,15,0.06);
```

Use `--shadow-pop` only for floating overlays (modals, command palette, dropdowns). Everything else should be flat.

---

## Motion

Quick, quiet, predictable. Nothing animates unless it improves comprehension.

| Action | Duration | Easing | Tailwind |
|---|---|---|---|
| Hover color/border swap | 120ms | ease | `transition-colors duration-[120ms]` |
| Button press | 80ms | ease | `active:scale-[0.99] duration-75` |
| Toggle thumb slide | 140ms | ease | `duration-150` |
| Modal pop-in | 140ms | ease | `animate-in fade-in zoom-in-95` |
| Pulse (idle sync) | 2400ms loop | ease-out | custom keyframes |

---

## Tailwind config

Drop this into `tailwind.config.ts`. It extends the default theme rather than replacing it — keeps Tailwind's stock utilities working everywhere else.

```ts
// tailwind.config.ts
import type { Config } from 'tailwindcss';

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg:               'rgb(var(--bg) / <alpha-value>)',
        elev:             'rgb(var(--bg-elev) / <alpha-value>)',
        sunken:           'rgb(var(--bg-sunken) / <alpha-value>)',
        hover:            'rgb(var(--bg-hover) / <alpha-value>)',
        border:           'rgb(var(--border) / <alpha-value>)',
        'border-strong':  'rgb(var(--border-strong) / <alpha-value>)',
        ink:              'rgb(var(--ink) / <alpha-value>)',
        'ink-muted':      'rgb(var(--ink-muted) / <alpha-value>)',
        'ink-faint':      'rgb(var(--ink-faint) / <alpha-value>)',
        accent: {
          DEFAULT: 'var(--accent)',
          soft:    'var(--accent-soft)',
          ink:     'var(--accent-ink)',
          ring:    'var(--accent-ring)',
        },
        danger: { DEFAULT: '#B43A3A', soft: '#FBEEEE' },
      },
      fontFamily: {
        sans: ['Geist', 'ui-sans-serif', 'system-ui'],
        mono: ['Geist Mono', 'ui-monospace'],
      },
      borderRadius: {
        sm: '6px',
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
    },
  },
} satisfies Config;
```

> Neutral colors use the `rgb(var(--…))` alpha pattern so Tailwind utilities like `bg-elev/50` work. The accent stays as a raw oklch CSS variable because its alpha is baked into the ring token.

---

## Global CSS

Put this in `app/globals.css` (or equivalent). It declares the tokens, swaps the accent palette by data attribute, and sets sane defaults.

```css
/* app/globals.css */
@import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap');
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    /* neutrals — RGB triples so Tailwind's /<alpha> syntax works */
    --bg:            250 250 247;
    --bg-elev:       255 255 255;
    --bg-sunken:     244 242 236;
    --bg-hover:      241 239 232;
    --border:        235 233 226;
    --border-strong: 217 214 204;
    --ink:           24  24  22;
    --ink-muted:     107 107 102;
    --ink-faint:     160 159 152;

    /* accent — sage default */
    --accent:       oklch(0.55 0.04 155);
    --accent-soft:  oklch(0.95 0.02 155);
    --accent-ink:   oklch(0.35 0.05 155);
    --accent-ring:  oklch(0.55 0.04 155 / 0.18);
  }

  [data-accent="indigo"] {
    --accent:      oklch(0.58 0.13 270);
    --accent-soft: oklch(0.96 0.02 270);
    --accent-ink:  oklch(0.40 0.10 270);
    --accent-ring: oklch(0.58 0.13 270 / 0.18);
  }
  [data-accent="amber"] {
    --accent:      oklch(0.68 0.13 70);
    --accent-soft: oklch(0.96 0.04 80);
    --accent-ink:  oklch(0.45 0.10 70);
    --accent-ring: oklch(0.68 0.13 70 / 0.18);
  }
  [data-accent="slate"] {
    --accent:      oklch(0.45 0.02 250);
    --accent-soft: oklch(0.94 0.01 250);
    --accent-ink:  oklch(0.30 0.02 250);
    --accent-ring: oklch(0.45 0.02 250 / 0.18);
  }
  [data-accent="rose"] {
    --accent:      oklch(0.60 0.13 20);
    --accent-soft: oklch(0.96 0.03 20);
    --accent-ink:  oklch(0.40 0.10 20);
    --accent-ring: oklch(0.60 0.13 20 / 0.18);
  }

  html, body {
    @apply bg-bg text-ink font-sans antialiased;
    font-feature-settings: 'ss01', 'cv11';
  }
  .font-mono { font-feature-settings: 'zero'; }
}
```

To swap the accent at runtime: `document.documentElement.dataset.accent = 'indigo'`.

---

## Button

Four variants, two sizes. Same height, same radius, same transition. The only thing that changes is the fill.

| Variant | Use | Background | Text |
|---|---|---|---|
| **Primary** | The one main action on a page. Saves, confirms, navigates forward. | `var(--ink)` | white |
| **Accent** | Constructive sends — *Send*, *Create link*. Where you want the encryption signal. | `var(--accent)` | white |
| **Default** | Secondary actions. Most buttons. | `var(--bg-elev)` | ink |
| **Ghost** | Tertiary, hover-only. Cancel, dismiss, expand. | transparent | ink-muted |
| **Danger** | Destructive. Red text on default background; red tint on hover. | elev → soft red | `#B43A3A` |

### React component

```tsx
// components/ui/Button.tsx
import { cn } from '@/lib/utils';

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'accent' | 'default' | 'ghost' | 'danger';
  size?: 'md' | 'sm';
};

const base = 'inline-flex items-center gap-2 font-medium transition-colors active:scale-[0.99] disabled:opacity-50 disabled:pointer-events-none';

const sizes = {
  md: 'h-[34px] px-[14px] text-[13px] rounded-md',
  sm: 'h-7 px-2.5 text-[12.5px] rounded-sm',
};

const variants = {
  primary: 'bg-ink text-white border border-ink hover:bg-black',
  accent:  'bg-accent text-white border border-transparent hover:brightness-95',
  default: 'bg-elev text-ink border border-border hover:border-border-strong',
  ghost:   'bg-transparent text-ink-muted hover:bg-hover hover:text-ink',
  danger:  'bg-elev text-[#B43A3A] border border-border hover:bg-danger-soft hover:border-[#F2D6D6]',
};

export function Button({ variant = 'default', size = 'md', className, ...p }: Props) {
  return <button {...p} className={cn(base, sizes[size], variants[variant], className)} />;
}
```

---

## Inputs & select

34px tall. 1px border. Accent-tinted focus ring (3px). That's the whole input system — text, email, password, search, select all use the same chassis.

### Tailwind shape

```tsx
<input className="h-[34px] px-3 rounded-md border border-border bg-elev text-[13.5px] text-ink
                  placeholder:text-ink-faint outline-none
                  transition-[border-color,box-shadow] duration-[120ms]
                  focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-ring)]" />
```

### Select

Same chassis as input, but with an inline SVG chevron as background-image and `appearance: none`. 32px right padding to make room for the chevron.

### Search variant

Search lives in the topbar. It's a button-shaped input with an icon, a placeholder, and a ⌘K hint that triggers the command palette.

---

## Toggle & checkbox

36×20 toggle. 16×16 checkbox. Both fill with the accent when on.

```css
.toggle {
  appearance: none;
  width: 36px; height: 20px;
  background: var(--border-strong);
  border-radius: 99px;
  position: relative;
  cursor: pointer;
  transition: background 140ms ease;
}
.toggle::after {
  content: ''; position: absolute; top: 2px; left: 2px;
  width: 16px; height: 16px; border-radius: 99px;
  background: white;
  box-shadow: 0 1px 2px rgba(0,0,0,0.2);
  transition: left 140ms ease;
}
.toggle:checked { background: var(--accent); }
.toggle:checked::after { left: 18px; }

.check {
  appearance: none;
  width: 16px; height: 16px;
  border: 1.5px solid var(--border-strong);
  border-radius: 5px;
  background: var(--bg-elev);
  cursor: pointer;
  display: grid; place-items: center;
}
.check:checked { background: var(--accent); border-color: var(--accent); }
.check:checked::after {
  content: '';
  width: 9px; height: 5px;
  border: 2px solid white; border-top: 0; border-right: 0;
  transform: rotate(-45deg) translateY(-1px);
}
```

For form-level toggle rows, use the [field row](#field-row) pattern with the label on the left and the toggle pinned right.

---

## Avatar

Initials on a colored disc. Sizes 24 / 28 / 32 / 36. Always a circle except for the brand logo, which is an 8px-radius square.

```tsx
function Avatar({ name, size = 32, colorIdx }: { name: string; size?: number; colorIdx: number }) {
  const initials = name.split(' ').filter(Boolean).slice(0, 2).map(s => s[0]?.toUpperCase()).join('');
  return (
    <div
      className="inline-grid place-items-center rounded-full text-white font-semibold"
      style={{
        width: size, height: size,
        fontSize: Math.floor(size * 0.38),
        background: AVATAR_PALETTE[colorIdx % AVATAR_PALETTE.length],
      }}
    >
      {initials}
    </div>
  );
}

const AVATAR_PALETTE = ['#5C7A6B', '#7E6B5A', '#6B6A8C', '#8A6B7A', '#555558', '#6B7E8C', '#8C7E5A'];
```

---

## Label tag

Dot plus name. No pill. No fill. **This is the most-violated rule in early drafts of the app** — labels keep wanting to be chips. They aren't.

```tsx
<span className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
  <span className="size-1.5 rounded-full" style={{ background: label.color }} />
  {label.name}
</span>
```

---

## Chip

Filter chips on the inbox toolbar. Pill-shaped, default state is hairline border on elev. Active state inverts to ink-on-white.

```tsx
function Chip({ active, children, ...p }: { active?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...p}
      className={cn(
        'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border text-[12.5px] cursor-pointer transition-colors',
        active
          ? 'bg-ink text-white border-ink'
          : 'bg-elev text-ink-muted border-border hover:text-ink hover:border-border-strong'
      )}
    >
      {children}
    </button>
  );
}
```

---

## Badge & status pill

Two badge styles for in-row tags. Status pill is a dot + word for live state — uses color sparingly.

**Rule:** if it's a *tag* attached to an entity (admin, this device), use a badge. If it's a *live state* that can change (opened, pending), use a status pill.

```tsx
// Badge — for static tags on entities
<span className="inline-flex items-center text-[10.5px] tracking-wider uppercase px-1.5 py-0.5 rounded-full font-medium
                 bg-ink text-white">admin</span>

<span className="inline-flex items-center text-[10.5px] tracking-wider uppercase px-1.5 py-0.5 rounded-full font-medium
                 bg-accent-soft text-accent-ink">this device</span>

// Status pill — for live state
<span className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
  <span className="size-1.5 rounded-full bg-accent" /> opened
</span>
```

Status pill colors:
- `opened`: dot is accent
- `pending`: dot is `#C9A12B` with a 3px soft ring
- `expired`: dot is `#B43A3A`
- `revoked`: text gets `line-through` + ink-faint color

---

## Card

The workhorse container. 1px border, 10px radius, white fill. Optional head with title + helper text + actions. Body padding 18px.

```tsx
<div className="rounded-md border border-border bg-elev overflow-hidden">
  <div className="flex items-center gap-2.5 px-[18px] py-3.5 border-b border-border">
    <div>
      <h3 className="text-[13px] font-semibold">Passkeys</h3>
      <p className="text-[12.5px] text-ink-muted">Devices that can decrypt your inbox.</p>
    </div>
    <div className="flex-1" />
    <Button size="sm">+ Add passkey</Button>
  </div>
  <div className="p-[18px]">{children}</div>
</div>
```

---

## Field row

Settings pages and form modals use a two-column row: 160px label on the left, controls on the right. Rows divide with a 1px border.

```tsx
<div className="grid grid-cols-[160px_1fr] items-center gap-4 px-[18px] py-3
                border-b border-border last:border-0">
  <label className="text-[13px] text-ink-muted">Display name</label>
  <div className="flex gap-2 items-center">
    <Input defaultValue="Christopher Wong" />
  </div>
</div>
```

For a settings page, stack field rows inside a card. The last row drops the bottom border. The bottom-most row often becomes the "Save / Discard" action row.

---

## Data table

No `<table>`. CSS grid rows. Headers are uppercase eyebrow text. Mono for tokens, dates, paths.

```tsx
<div className="flex flex-col text-[13px]">
  <div className="grid grid-cols-[1.6fr_0.9fr_1fr_0.6fr_1.1fr_auto] gap-3.5
                  px-[18px] py-2.5 border-b border-border bg-bg
                  text-[10.5px] tracking-wider uppercase text-ink-faint font-medium">
    <div>Recipient</div>
    <div>Status</div>
    <div>Policy</div>
    <div className="text-right">Opens</div>
    <div>Created</div>
    <div />
  </div>
  {rows.map(r => (
    <div key={r.id}
      className="grid grid-cols-[1.6fr_0.9fr_1fr_0.6fr_1.1fr_auto] gap-3.5
                 px-[18px] py-3 border-b border-border last:border-0
                 hover:bg-hover items-center">
      {/* cells */}
    </div>
  ))}
</div>
```

---

## Icon

Stroke icons, 1.5px stroke, 24×24 viewbox, round caps and joins. Default render size is 14–16px. Use [Lucide](https://lucide.dev) — its defaults match ours.

| Our name | Lucide equivalent | Used for |
|---|---|---|
| `inbox` | `Inbox` | Sidebar primary nav |
| `drafts` | `FileText` | Sidebar — drafts |
| `send` | `Send` | Sent folder, send button |
| `archive` | `Archive` | Archive folder, hover action |
| `trash` | `Trash2` | Trash folder, hover action |
| `lock-sm` | `Lock` | Encryption pill, thread subject |
| `shield-check` | `ShieldCheck` | Verified backup, encryption fact |
| `fingerprint` | `Fingerprint` | Passkey button, passkey list rows |
| `key` | `Key` | Recovery phrase, copy key |
| `database` | `Database` | Backups |
| `users` / `user` | `Users` / `User` | Admin, members |
| `tag` | `Tag` | Labels in compose |
| `paperclip` | `Paperclip` | Attach files |
| `sparkle` | `Sparkles` | Sort/filter chip — that one indulgence |

---

## App shell

Two-column grid: 232px sidebar on the left, fluid main on the right. Sidebar density is adjustable (200 / 232 / 264px) via a data attribute.

```tsx
<div className="grid grid-cols-[232px_1fr] h-screen bg-bg">
  <Sidebar />
  <main className="flex flex-col min-w-0 min-h-0">
    <Topbar />
    <div className="flex-1 overflow-auto">{children}</div>
  </main>
</div>
```

### Sidebar anatomy

- **Brand block** — 28px ink-colored square logo with an accent dot in the bottom-right corner; wordmark + workspace beneath.
- **Compose button** — full-width primary, with a `C` keyboard hint on the right.
- **Primary nav** — Inbox, Drafts, Sent, Archive, Trash.
- **Labels section** — dot + name rows, "Add label" at the bottom.
- **Account section** — Settings, Admin (admins only).
- **Account block** — avatar + name + handle, click to settings.

### Topbar

- 56px tall, 1px bottom border, 22px horizontal padding.
- Left: page title (and tiny crumb above it for context — "12 conversations", "Account preferences").
- Center-right: search input (320px), ⌘K opens the command palette.
- Right: page-specific actions (Compose, Reply, Create link, etc.).

---

## List rows (inbox)

A four-column grid: avatar / sender / preview / meta. Rows are 64px (cozy), 52px (compact), or 76px (roomy). Unread rows get a 6px accent dot on the left edge.

```tsx
<div className="grid grid-cols-[32px_220px_1fr_auto] items-center gap-3.5 px-[22px] h-16
                border-b border-border hover:bg-elev cursor-pointer relative
                data-[unread=true]:before:absolute data-[unread=true]:before:left-2 data-[unread=true]:before:top-1/2
                data-[unread=true]:before:size-1.5 data-[unread=true]:before:rounded-full data-[unread=true]:before:bg-accent
                data-[unread=true]:before:-translate-y-1/2"
     data-unread={thread.unread}>
  <AvatarSelect /* see avatar-as-checkbox */ />
  <div className={cn("min-w-0 truncate", thread.unread && "font-semibold")}>
    {thread.from}
  </div>
  <div className="min-w-0 truncate text-[13.5px] text-ink-muted">
    <b className="text-ink font-medium">{thread.subject}</b>
    <span className="text-ink-faint px-1.5">·</span>
    {thread.snippet}
  </div>
  <div className="flex items-center gap-2 text-xs text-ink-faint">
    {thread.labels.map(l => <LabelTag key={l.id} {...l} />)}
    <LockSm size={12} className="opacity-60" />
    <span className="font-mono tabular-nums min-w-14 text-right">{thread.time}</span>
  </div>
</div>
```

### Hover-revealed actions

Quick actions (archive / star / trash) live in an absolutely-positioned cluster on the right of the row, with `opacity-0` by default. On row hover, the meta column hides and the actions cluster fades in. This keeps the row visually quiet at rest.

---

## Avatar-as-checkbox

A core interaction. We don't reserve a column for a checkbox; the avatar is the affordance.

1. At rest, the avatar shows initials normally.
2. On hover, the avatar dims to 30% and an ink check overlay fades in (zoom-95 → 100).
3. On click, the row becomes selected: avatar fully replaced with an accent check, row background tints to `accent-soft`.
4. Selected state persists; click again to deselect.

The trick is that the avatar is a `button`, not an input, so it stops propagation and the row's `onClick` (open thread) doesn't fire.

```tsx
<button
  type="button"
  aria-pressed={selected}
  onClick={(e) => { e.stopPropagation(); toggleSelect(); }}
  className="group relative size-8 rounded-full"
>
  <span className={cn(
    "absolute inset-0 transition-opacity",
    selected ? "opacity-0" : "group-hover:opacity-30"
  )}>
    <Avatar name={t.from} colorIdx={t.colorIdx} size={32} />
  </span>
  <span className={cn(
    "absolute inset-0 grid place-items-center rounded-full transition",
    selected
      ? "bg-accent text-white opacity-100 scale-100"
      : "bg-ink text-white opacity-0 scale-90 group-hover:opacity-100 group-hover:scale-100"
  )}>
    <Check size={14} />
  </span>
</button>
```

---

## Modal & command palette

Two overlays. Both sit on a 32% black scrim. The compose modal centers; the command palette pins to 12vh from the top.

| Surface | Size | Notes |
|---|---|---|
| **Compose** | `max-w-[720px] rounded-lg shadow-pop` | 14px radius, pop shadow, slide-in from 8px below |
| **Cmd palette** | `max-w-[560px] rounded-lg shadow-pop` | Top-aligned, 12vh from top, esc to close, ⌘K to toggle |

### Behavior contract

- **Scrim click** → close.
- **Escape** → close.
- **Cmd/Ctrl-K** → toggle command palette.
- **C** (when not in an input) → open compose.
- Focus first input on mount; restore focus to invoker on close.

---

## Encryption indicators

A consistent vocabulary for showing "this is end-to-end encrypted" without shouting.

| Where | Treatment | Why |
|---|---|---|
| Inbox row | Tiny lock glyph, 12px, `opacity-60`, in the meta column | Confirms at-a-glance without competing with subject |
| Thread subject | Soft pill: `accent-soft` bg, `accent-ink` text, "encrypted" | Calm reassurance at the top of the thread |
| Reply composer foot | Inline microcopy: "Encrypted to {recipient}" | Reminds the sender at the moment of action |
| Compose modal head | Same pill, "end-to-end encrypted" | One-time confirmation at start of write |
| Share / Secrets pages | Body copy explains; no visual badge | The page *is* the encryption — overpaint is redundant |
| Sidebar footer | **Nothing.** We removed this. | The product doesn't need to remind users it's encrypted at every chrome edge |

> **Rule:** Never use a green or red color to signal encryption health. Use accent for "on track" and ink-faint for neutral. Color is for status changes (opened, expired), not for ambient reassurance.

---

## Empty state

56×56 icon disc, headline, one-line explainer. No illustrations.

```tsx
<div className="grid place-items-center py-20 px-5 text-ink-muted text-center">
  <div className="size-14 rounded-full bg-elev border border-border grid place-items-center mb-3.5">
    <Inbox size={20} />
  </div>
  <h3 className="text-ink font-semibold mb-1.5">No conversations</h3>
  <div>Try clearing the filter.</div>
</div>
```

---

## Voice & microcopy

### Tone

- **Plain.** "Sign in," not "Authenticate now." "Backups," not "Snapshot integrity."
- **Specific.** "Encrypted to Addison" beats "End-to-end encrypted message."
- **Honest about limits.** The recovery-phrase explainer says "There is no in-app 'regenerate phrase' — that would defeat the encryption guarantee." Don't hide tradeoffs.
- **No marketing words** in product UI: "powerful," "seamless," "delight," "magic" — all banned.

### Casing

- **Sentence case** for everything: button labels, headings, menu items, settings rows.
- **Lowercase** for: labels (work, personal, urgent), eyebrows ("welcome back", "profile", "appearance"), small badges (admin, this device).
- **ALL CAPS** reserved for eyebrows and section labels via `tracking-wider uppercase`. Never type all caps directly.

### Empty input placeholders

- Show an example, not an instruction: "addison@middleseat.vc" not "Enter email."
- Subject placeholders can be aspirational: "A clear subject."
- Search: "Search mail, people, threads…"

---

## Anti-patterns

If a design starts to look like one of these, stop and refactor.

> ⚠️ **Don't** wrap labels, statuses, or tags in pill backgrounds by default. The visual noise compounds — a row with three pills reads as a parking lot. **Use a dot + text instead.** Only use a pill when the thing genuinely needs a fill (e.g., the encryption pill at thread head — that's intentional emphasis).

> ⚠️ **Don't** use shadows on resting elements. Cards, rows, sidebar items — all flat with hairline borders. Shadows are exclusively for floating overlays.

> ⚠️ **Don't** add a gradient. Anywhere. The login left panel uses a soft accent *glow* behind the brand, not a gradient — that's the one place radial color is allowed, and it's blurred behind dark ink.

> ⚠️ **Don't** draw bespoke iconography in a feature. If we don't have an icon for it, ask before inventing. Default to text labels — "Forward," "Archive" — over invented glyphs.

> ⚠️ **Don't** mix font weights more than necessary. We use 400, 500, 600. Never bold (700) in body. Never italic.

> ⚠️ **Don't** use emoji. The product handles serious correspondence; emoji break the visual register. Exception: user-authored email content, which is theirs to style.

> ⚠️ **Don't** build a hero banner for the encryption story. The whole point is that encryption is the floor, not a feature. One small pill, one small lock, that's it.

---

## Implementation order

If you're porting an existing Tailwind app to this system, do it in this order — each step is independently shippable.

1. **Tokens first.** Land `tailwind.config.ts` and `globals.css`. Don't touch components yet. Verify the page still works, just with new neutrals.
2. **Type.** Swap Inter (or whatever) for Geist on body and Geist Mono on monospace classes. Audit headings to the scale in this doc.
3. **Buttons + inputs.** Replace the existing primitives. These are the most-used components and unlock the rest.
4. **Card + field row.** Re-skin settings pages first — they're contained and easy to verify.
5. **Sidebar + topbar.** The shell. Now the chrome matches.
6. **Inbox row + avatar-as-checkbox.** The signature interaction. Spend time here.
7. **Thread, compose, command palette.** The remaining surfaces.
8. **Audit pass.** Walk every screen and apply the anti-patterns checklist. Remove every shadow-on-resting-element and every pill-around-a-label.

---

*Questions, edge cases, additions — keep the doc honest by editing this file rather than scattering one-off rules across PRs.*
