/** Sent = inbox view filtered to outbound threads. */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import Toolbar from '@/components/Toolbar';
import Loader from '@/components/Loader';
import EmptyState from '@/components/EmptyState';

import * as api from '@/lib/api';
import { relativeDate } from '@/lib/time';

export default function Sent() {
  const [threads, setThreads] = useState<api.ThreadRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const nav = useNavigate();

  useEffect(() => {
    let c = false;
    (async () => {
      try {
        // Until the API supports direction filters at the thread level, we
        // approximate "sent" by showing threads that contain only outbound
        // messages or have at least one outbound message. For v1, just show
        // all threads — they're filtered server-side once we add that.
        const t = await api.get<api.ThreadRow[]>('/api/threads?limit=100');
        if (!c) setThreads(t);
      } catch (e: any) {
        if (!c) setErr(e?.message || 'load failed');
      }
    })();
    return () => { c = true; };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <span className="label">sent</span>
      </Toolbar>
      {threads === null && !err && <Loader />}
      {err && <EmptyState title={err} />}
      {threads && threads.length === 0 && <EmptyState title="nothing sent yet" />}
      {threads && threads.length > 0 && (
        <ul className="flex-1 overflow-y-auto">
          {threads.map((t) => (
            <li key={t.id} className="row" onClick={() => nav(`/thread/${t.id}`)}>
              <div className="truncate">{t.participants.join(', ')}</div>
              <div className="truncate text-mute text-xs">[encrypted]</div>
              <div className="text-right text-xs">{relativeDate(t.last_message_at)}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
