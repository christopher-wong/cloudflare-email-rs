/**
 * Tag-style email recipient input with contact autocomplete.
 *
 * Powers the to/cc/bcc fields in Compose. Recipients render as tags
 * (with display name + ✕) and an inline input lets the user type the
 * next one. A dropdown surfaces matching contacts as they type.
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
  /** Field label rendered in the gutter ("to", "cc", "bcc"). */
  label: string;
  /** Current tag list. */
  value: Recipient[];
  /** Called with the new tag list after any add/remove. */
  onChange: (next: Recipient[]) => void;
  /** Form `required` semantics — we set aria-required and refuse blur-
   *  commit of an empty input when this is true and the list is empty. */
  required?: boolean;
  /** Placeholder for the inline input when there are no tags yet. */
  placeholder?: string;
  /** Authenticated user's addresses — filtered out of suggestions so
   *  the user doesn't get themselves. */
  myAddresses?: string[];
  /** Show suggestion dropdown? Off by default for bcc (less common
   *  use) but on for to/cc. */
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

  // Filter out contacts already in the tag list — once the user has
  // picked someone, don't keep suggesting them.
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

  // Reset highlight when the suggestion list shrinks past it.
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
      // Already present — just clear the buffer.
      setBuffer('');
      return true;
    }
    // If the typed string matches a known contact's email (case-
    // insensitive), promote to the contact-with-name version. Lets
    // the user pasting "christopher@…" still get the display name.
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
      // Pop the last tag back into the buffer so the user can edit it
      // rather than re-typing the whole thing.
      const last = value[value.length - 1];
      onChange(value.slice(0, -1));
      setBuffer(last.addr);
      return;
    }
  };

  const onBlur = (_e: FocusEvent<HTMLInputElement>) => {
    // Defer the close so a click inside the dropdown isn't pre-empted
    // by a blur of the input.
    window.setTimeout(() => setOpen(false), 120);
    if (buffer.trim()) commitRaw(buffer);
  };

  const onChangeBuffer = (e: ChangeEvent<HTMLInputElement>) => {
    setBuffer(e.target.value);
    setOpen(true);
    setHighlight(0);
  };

  return (
    <div className="field relative">
      <div className="field-label">{label}</div>
      <div
        className="field-value flex w-full flex-wrap items-center gap-1 border-0"
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((r, i) => (
          <span
            key={`${r.addr}-${i}`}
            className="hair-all flex items-center gap-1 bg-[var(--bg-mute,#f5f5f5)] px-2 py-0.5 text-xs"
            title={r.addr}
          >
            <span className="max-w-[14rem] truncate">
              {r.name && r.name !== r.addr ? r.name : r.addr}
            </span>
            <button
              type="button"
              aria-label={`remove ${r.addr}`}
              className="text-mute hover:text-black"
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
          className="min-w-[10rem] flex-1 border-0 bg-transparent focus:outline-none"
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

      {open && suggestions.length > 0 && (
        <ul
          className="hair-all absolute left-[6rem] right-0 top-full z-20 mt-0.5 max-h-72 overflow-y-auto bg-white shadow-md"
          role="listbox"
        >
          {suggestions.map((c, i) => (
            <li
              key={c.addr}
              role="option"
              aria-selected={i === highlight}
              className={
                'cursor-pointer px-2 py-1 text-sm ' +
                (i === highlight ? 'inv' : 'hover:bg-[var(--bg-mute,#f5f5f5)]')
              }
              // Use onMouseDown so the click fires BEFORE the input's
              // blur — otherwise the dropdown would close first.
              onMouseDown={(e) => {
                e.preventDefault();
                commitContact(c);
              }}
              onMouseEnter={() => setHighlight(i)}
            >
              <div className="font-medium">{contactDisplayName(c)}</div>
              {c.name && c.name !== c.addr && (
                <div className="text-mute text-xs">{c.addr}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function looksLikeEmail(s: string): boolean {
  // Intentionally permissive — Compose's existing inputs allowed any
  // text and let the worker validate. We just want to refuse obvious
  // junk like a stray period.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
