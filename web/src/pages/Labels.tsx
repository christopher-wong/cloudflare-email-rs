import { FormEvent, useEffect, useState } from 'react';

import Toolbar from '@/components/Toolbar';
import Loader from '@/components/Loader';
import EmptyState from '@/components/EmptyState';

import * as api from '@/lib/api';

export default function Labels() {
  const [labels, setLabels] = useState<api.Label[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState('');

  const refresh = async () => {
    try {
      const data = await api.get<api.Label[]>('/api/labels');
      setLabels(data);
    } catch (e: any) {
      setErr(e?.message || 'load failed');
    }
  };

  useEffect(() => { void refresh(); }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await api.post('/api/labels', { name: name.trim() });
      setName('');
      await refresh();
    } catch (e: any) {
      setErr(e?.message || 'create failed');
    }
  };

  const remove = async (id: string) => {
    if (!confirm('delete this label?')) return;
    await api.del(`/api/labels/${id}`);
    await refresh();
  };

  return (
    <div className="flex h-full flex-col">
      <Toolbar><span className="label">labels</span></Toolbar>

      <form onSubmit={create} className="hair-b grid grid-cols-[1fr_auto] gap-2 p-3">
        <input
          placeholder="new label"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" className="btn btn-primary label">add ▸</button>
      </form>

      {labels === null && !err && <Loader />}
      {err && <EmptyState title={err} />}
      {labels && labels.length === 0 && <EmptyState title="no labels yet" />}
      {labels && labels.length > 0 && (
        <ul className="flex-1 overflow-y-auto">
          {labels.map((l) => (
            <li key={l.id} className="hair-b grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-2">
              <span className="chip">{l.name}</span>
              <button className="btn btn-ghost label" onClick={() => remove(l.id)}>
                delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
