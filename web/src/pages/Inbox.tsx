import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import Toolbar from '@/components/Toolbar';
import EmptyState from '@/components/EmptyState';
import Loader from '@/components/Loader';

import * as api from '@/lib/api';
import { relativeDate } from '@/lib/time';
import { useApp } from '@/lib/store';

export default function Inbox() {
  const [threads, setThreads] = useState<api.ThreadRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { state } = useApp();
  const nav = useNavigate();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const t = await api.get<api.ThreadRow[]>('/api/threads?limit=100&inbound_only=1');
        if (!cancelled) setThreads(t);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || 'load failed');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <Toolbar
        right={
          <Link to="/compose" className="btn btn-primary label">
            compose ▸
          </Link>
        }
      >
        <span className="label">inbox</span>
        <span className="text-mute text-xs">{state.me?.addresses.join(', ')}</span>
      </Toolbar>

      {threads === null && !err && <Loader />}
      {err && <EmptyState title={err} />}
      {threads && threads.length === 0 && (
        <EmptyState
          title="inbox is empty"
          hint="emails routed to your address(es) will appear here once received."
        />
      )}
      {threads && threads.length > 0 && (
        <ul className="flex-1 overflow-y-auto">
          {threads.map((t) => (
            <li
              key={t.id}
              className={'row ' + (t.unread_count > 0 ? 'unread' : '')}
              onClick={() => nav(`/thread/${t.id}`)}
            >
              <div className="truncate">
                {t.participants.slice(0, 3).join(', ')}
                {t.participants.length > 3 && ` +${t.participants.length - 3}`}
              </div>
              <div className="flex items-center gap-2 truncate">
                <span className="text-mute text-xs">[encrypted]</span>
                {t.has_starred && <span className="chip">★</span>}
                {t.message_count > 1 && (
                  <span className="chip">{t.message_count}</span>
                )}
                {t.subject_hint && (
                  <span className="truncate">{t.subject_hint}</span>
                )}
              </div>
              <div className="text-right text-xs">
                {relativeDate(t.last_message_at)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
