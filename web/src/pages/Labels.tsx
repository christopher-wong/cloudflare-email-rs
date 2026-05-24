import { FormEvent, useEffect, useState } from 'react';

import Toolbar from '@/components/Toolbar';
import Loader from '@/components/Loader';
import EmptyState from '@/components/EmptyState';
import { Tag } from 'lucide-react';

import * as api from '@/lib/api';

// Small deterministic swatch palette — same family as avatar colors.
const SWATCHES = [
  '#5C7A6B',
  '#7E6B5A',
  '#6B6A8C',
  '#8A6B7A',
  '#555558',
  '#6B7E8C',
  '#8C7E5A',
  '#B43A3A',
  '#C9A12B',
];

function hashColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return SWATCHES[h % SWATCHES.length];
}

export default function Labels() {
  const [labels, setLabels] = useState<api.Label[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [pickedColor, setPickedColor] = useState(SWATCHES[0]);

  const refresh = async () => {
    try {
      const data = await api.get<api.Label[]>('/api/labels');
      setLabels(data);
    } catch (e: any) {
      setErr(e?.message || 'load failed');
    }
  };

  useEffect(() => { void refresh(); }, []);

  // Auto-pick color from name as user types
  useEffect(() => {
    if (name.trim()) setPickedColor(hashColor(name.trim()));
  }, [name]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await api.post('/api/labels', { name: name.trim() });
      setName('');
      setPickedColor(SWATCHES[0]);
      await refresh();
    } catch (e: any) {
      setErr(e?.message || 'create failed');
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this label?')) return;
    await api.del(`/api/labels/${id}`);
    await refresh();
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <Toolbar><span className="eyebrow">labels</span></Toolbar>

      <div className="mx-auto w-full max-w-3xl px-10 py-9 flex flex-col gap-5">
        {/* Page header */}
        <div>
          <div className="eyebrow mb-1">labels</div>
          <h1 className="text-[26px] font-semibold tracking-tight text-ink">Manage labels</h1>
        </div>

        {/* Create label card */}
        <form onSubmit={create} className="card">
          <div className="card-head">
            <div>
              <div className="text-[13px] font-semibold text-ink">New label</div>
              <div className="text-[12.5px] text-ink-muted">Organize your inbox with colored labels.</div>
            </div>
            <div className="flex-1" />
            <button type="submit" className="btn btn-sm btn-primary" disabled={!name.trim()}>
              Add label
            </button>
          </div>
          <div>
            <div className="field-row">
              <label className="field-label" htmlFor="label-name">Name</label>
              <input
                id="label-name"
                className="input"
                placeholder="work, personal, urgent…"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
            <div className="field-row" style={{ borderBottom: 0 }}>
              <label className="field-label">Color</label>
              <div className="flex items-center gap-3">
                {/* Preview */}
                <span className="label-tag">
                  <span className="dot" style={{ background: pickedColor }} />
                  <span className="text-[12px]">{name || 'preview'}</span>
                </span>
                {/* Swatch grid */}
                <div className="flex gap-1.5">
                  {SWATCHES.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setPickedColor(c)}
                      className="w-5 h-5 rounded-full border-2 transition-transform hover:scale-110"
                      style={{
                        background: c,
                        borderColor: pickedColor === c ? c : 'transparent',
                        outline: pickedColor === c ? `2px solid ${c}` : undefined,
                        outlineOffset: pickedColor === c ? '2px' : undefined,
                      }}
                      aria-label={c}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </form>

        {/* Labels list card */}
        <div className="card">
          <div className="card-head">
            <div>
              <div className="text-[13px] font-semibold text-ink">Your labels</div>
              <div className="text-[12.5px] text-ink-muted">
                {labels ? `${labels.length} label${labels.length !== 1 ? 's' : ''}` : 'Loading…'}
              </div>
            </div>
          </div>

          {labels === null && !err && (
            <div className="py-8"><Loader /></div>
          )}
          {err && (
            <div className="py-8">
              <EmptyState title={err} />
            </div>
          )}
          {labels && labels.length === 0 && (
            <div className="py-8">
              <EmptyState
                title="No labels yet"
                hint="Add your first label above to start organizing your inbox."
                icon={<Tag size={20} />}
              />
            </div>
          )}
          {labels && labels.length > 0 && (
            <div className="flex flex-col text-[13px]">
              {/* Header row */}
              <div className="grid grid-cols-[1fr_auto] gap-3.5 px-[18px] py-2.5 border-b border-border bg-bg">
                <div className="text-[10.5px] tracking-wider uppercase text-ink-faint font-medium">Label</div>
                <div className="text-[10.5px] tracking-wider uppercase text-ink-faint font-medium"></div>
              </div>
              {labels.map((l) => (
                <div
                  key={l.id}
                  className="grid grid-cols-[1fr_auto] gap-3.5 px-[18px] py-3 border-b border-border last:border-0 hover:bg-hover items-center"
                >
                  <span className="label-tag">
                    <span className="dot" style={{ background: hashColor(l.name) }} />
                    <span className="text-[13.5px] text-ink">{l.name}</span>
                  </span>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => remove(l.id)}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
