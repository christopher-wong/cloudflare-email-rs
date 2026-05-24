/**
 * Tag-style email recipient input with contact autocomplete.
 *
 * Powers the to/cc/bcc fields in Compose. Recipients render as .chip tags
 * (with display name + ×) and an inline input lets the user type the next
 * one. A card+shadow-pop dropdown surfaces matching contacts.
 *
 * Selection model:
 *   - Each recipient is `{addr, name?}`. `addr` is what gets sent;
 *     `name` is purely presentational on the tag.
 *   - Commit triggers: clicking a suggestion, Enter, Tab, comma, or
 *     blur (if the buffer parses as an email).
 *   - Backspace on an empty input removes the last tag.
 *
 * The component is uncontrolled-ish: it owns the buffer + dropdown
 * state internally, but `value` / `onChange` are controlled at the
 * parent (so Compose can serialize for autosave + send).
 */

import {
  KeyboardEvent,
  ChangeEvent,
  FocusEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  type Contact,
  displayName as contactDisplayName,
  filterContacts,
  useContacts,
} from '@/lib/contacts';

export interface Recipient {
  addr: string;
  name?: string;
}

export interface RecipientFieldProps {
  label: string;
  value: Recipient[];
  onChange: (next: Recipient[]) => void;
  required?: boolean;
  placeholder?: string;
  myAddresses?: string[];
  autocomplete?: boolean;
}

const SEPARATOR_KEYS = new Set([',', ';']);

export default function RecipientField({
  label,
  value,
  onChange,
  required = false,
  placeholder,
  myAddresses = [],
  autocomplete = true,
}: RecipientFieldProps) {
  const [buffer, setBuffer] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { contacts } = useContacts(myAddresses);

  const alreadyAdded = useMemo(() => {
    const s = new Set<string>();
    for (const r of value) s.add(r.addr.toLowerCase());
    return s;
  }, [value]);

  const suggestions = useMemo(() => {
    if (!autocomplete) return [];
    return filterContacts(contacts, buffer).filter(
      (c) => !alreadyAdded.has(c.addr.toLowerCase()),
    );
  }, [autocomplete, contacts, buffer, alreadyAdded]);

  useEffect(() => {
    if (highlight >= suggestions.length) {
      setHighlight(Math.max(0, suggestions.length - 1));
    }
  }, [suggestions.length, highlight]);

  const commitContact = (c: Contact) => {
    if (alreadyAdded.has(c.addr.toLowerCase())) return;
    onChange([...value, { addr: c.addr, name: c.name ?? undefined }]);
    setBuffer('');
    setHighlight(0);
  };

  const commitRaw = (raw: string): boolean => {
    const addr = raw.trim().replace(/,$/, '').replace(/;$/, '');
    if (!addr) return false;
    if (!looksLikeEmail(addr)) return false;
    const lower = addr.toLowerCase();
    if (alreadyAdded.has(lower)) {
      setBuffer('');
      return true;
    }
    const match = contacts.find((c) => c.addr.toLowerCase() === lower);
    onChange([
      ...value,
      match ? { addr: match.addr, name: match.name ?? undefined } : { addr },
    ]);
    setBuffer('');
    setHighlight(0);
    return true;
  };

  const removeAt = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx));
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (open && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => (h + 1) % suggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        commitContact(suggestions[highlight]);
        return;
      }
      if (e.key === 'Escape') {
        setOpen(false);
        return;
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRaw(buffer);
      return;
    }
    if (SEPARATOR_KEYS.has(e.key)) {
      e.preventDefault();
      commitRaw(buffer);
      return;
    }
    if (e.key === 'Backspace' && buffer === '' && value.length > 0) {
      e.preventDefault();
      const last = value[value.length - 1];
      onChange(value.slice(0, -1));
      setBuffer(last.addr);
      return;
    }
  };

  const onBlur = (_e: FocusEvent<HTMLInputElement>) => {
    window.setTimeout(() => setOpen(false), 120);
    if (buffer.trim()) commitRaw(buffer);
  };

  const onChangeBuffer = (e: ChangeEvent<HTMLInputElement>) => {
    setBuffer(e.target.value);
    setOpen(true);
    setHighlight(0);
  };

  return (
    <div className="relative flex items-start gap-3 border-b border-border px-5 py-2.5">
      {/* Field label */}
      <label className="w-10 shrink-0 pt-[3px] text-[12px] text-ink-faint">{label}</label>

      {/* Tags + input */}
      <div
        className="flex flex-1 flex-wrap items-center gap-1.5"
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((r, i) => (
          <span
            key={`${r.addr}-${i}`}
            className="chip"
            title={r.addr}
          >
            <span className="max-w-[14rem] truncate font-mono text-[12px]">
              {r.name && r.name !== r.addr ? r.name : r.addr}
            </span>
            <button
              type="button"
              aria-label={`Remove ${r.addr}`}
              className="text-ink-faint transition-colors hover:text-ink"
              style={{ lineHeight: 1, background: 'none', border: 0, padding: 0, cursor: 'pointer' }}
              onMouseDown={(e) => {
                e.preventDefault();
                removeAt(i);
              }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="min-w-[8rem] flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-ink-faint"
          type="text"
          value={buffer}
          aria-required={required}
          placeholder={value.length === 0 ? placeholder : undefined}
          onChange={onChangeBuffer}
          onFocus={() => setOpen(true)}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>

      {/* Autocomplete popover — card + shadow-pop pattern */}
      {open && suggestions.length > 0 && (
        <ul
          className="card shadow-pop absolute left-[4.5rem] right-0 top-full z-20 mt-1 max-h-64 overflow-y-auto"
          role="listbox"
        >
          {suggestions.map((c, i) => (
            <li
              key={c.addr}
              role="option"
              aria-selected={i === highlight}
              className={[
                'cursor-pointer px-3 py-2 transition-colors duration-[120ms]',
                i === highlight ? 'bg-accent-soft text-accent-ink' : 'hover:bg-hover',
                i < suggestions.length - 1 ? 'border-b border-border' : '',
              ].join(' ')}
              onMouseDown={(e) => {
                e.preventDefault();
                commitContact(c);
              }}
              onMouseEnter={() => setHighlight(i)}
            >
              <div className="text-[13px] font-medium text-ink">{contactDisplayName(c)}</div>
              {c.name && c.name !== c.addr && (
                <div className="font-mono text-[11.5px] text-ink-muted">{c.addr}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
