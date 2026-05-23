import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import Toolbar from '@/components/Toolbar';
import EmptyState from '@/components/EmptyState';
import Loader from '@/components/Loader';

import * as api from '@/lib/api';
import { b64uDecode, openSealedString } from '@/lib/crypto';
import * as realtime from '@/lib/realtime';
import { sessionPriv } from '@/lib/webauthn';
import { relativeDate } from '@/lib/time';

export default function Drafts() {
  const [drafts, setDrafts] = useState<api.DraftRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const nav = useNavigate();

  const load = async () => {
    try {
      const d = await api.get<api.DraftRow[]>('/api/drafts');
      setDrafts(d);
    } catch (e: any) {
      setErr(e?.message || 'load failed');
    }
  };

  useEffect(() => {
    void load();
    return realtime.subscribe((ev) => {
      if (ev.type === 'draft.upsert' || ev.type === 'draft.delete') void load();
    });
  }, []);

  const deleteDraft = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm('discard this draft?')) return;
    setDrafts((cur) => (cur ? cur.filter((d) => d.id !== id) : cur));
    try {
      await api.del(`/api/drafts/${encodeURIComponent(id)}`);
    } catch (err: any) {
      setErr(err?.message || 'delete failed');
      void load();
    }
  };

  const decoded = drafts?.map((d) => {
    const priv = sessionPriv();
    let subject = '';
    if (d.subject_ct_b64 && priv) {
      try { subject = openSealedString(b64uDecode(d.subject_ct_b64), priv); } catch {}
    }
    return { ...d, subject };
  });

  return (
    <div className="flex h-full flex-col">
      <Toolbar
        right={
          <Link to="/compose" className="btn btn-primary label">
            compose ▸
          </Link>
        }
      >
        <span className="label">drafts</span>
      </Toolbar>

      {drafts === null && !err && <Loader />}
      {err && <EmptyState title={err} />}
      {drafts && drafts.length === 0 && (
        <EmptyState title="no drafts" hint="autosave kicks in while you compose" />
      )}
      {decoded && decoded.length > 0 && (
        <ul className="flex-1 overflow-y-auto">
          {decoded.map((d) => (
            <li key={d.id} className="row" onClick={() => nav('/compose', { state: { draftId: d.id } })}>
              <div className="truncate">{d.to_addrs.join(', ') || '(no recipient)'}</div>
              <div className="truncate">{d.subject || '(no subject)'}</div>
              <div className="text-right text-xs">{relativeDate(d.updated_at)}</div>
              <button
                type="button"
                className="btn label ml-2"
                onClick={(e) => deleteDraft(e, d.id)}
                title="discard draft"
              >
                discard
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
