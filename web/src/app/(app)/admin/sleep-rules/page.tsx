'use client';

// Sleep rules (API.md 9.20/9.21, needs platform.settings): how device sessions are grouped into nights.

import { useEffect, useState } from 'react';
import { Hypnogram } from '@/components/charts';
import { useToast } from '@/components/Providers';
import { RequireStaff } from '@/components/Shell';
import { Async, Head, Legend, useApi } from '@/components/ui';
import { errText, patch } from '@/lib/api';
import { sampleHyp } from '@/lib/mock/data';
import type { PlatformSettings } from '@/lib/types';

const SAMPLE = sampleHyp();

export default function SleepRulesPage() {
  return <RequireStaff perm="platform.settings"><Inner /></RequireStaff>;
}

function Inner() {
  const toast = useToast();
  const q = useApi<PlatformSettings>('/admin/platform-settings');
  const [f, setF] = useState<PlatformSettings | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data) setF(q.data); }, [q.data]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f) return;
    if (f.mergeGapMin < 0 || f.mergeGapMin > 240) return setErr('Join gap: use 0–240 minutes');
    if (f.minSessionMin < 0 || f.minSessionMin > 120) return setErr('Shortest session: use 0–120 minutes');
    setErr(''); setBusy(true);
    try { q.setData(await patch<PlatformSettings>('/admin/platform-settings', f)); toast('Sleep rules saved. History regroups the next time it is opened.'); }
    catch (e2) { setErr(errText(e2)); } finally { setBusy(false); }
  };

  return (
    <div className="wrap narrow">
      <Head title="Sleep rules" sub="How device sessions are grouped into nights. Applies to every device." />
      <Async q={q}>{() => f && <>
        <div className="card"><h2 style={{ marginBottom: 14 }}>Grouping sessions into a night</h2>
          <form className="form" onSubmit={save}>
            <div className="fields2">
              <div className="field"><label htmlFor="ps-gap">Join sessions less than this apart</label>
                <div className="row" style={{ flexWrap: 'nowrap' }}><input className="inp num" id="ps-gap" type="number" min={0} max={240} value={f.mergeGapMin} onChange={(e) => setF({ ...f, mergeGapMin: Number(e.target.value) })} style={{ maxWidth: 110 }} /><span className="muted">min</span></div>
                <span className="hint">Getting up for the bathroom shouldn&apos;t split the night in two. Default 30.</span></div>
              <div className="field"><label htmlFor="ps-min">Hide sessions shorter than</label>
                <div className="row" style={{ flexWrap: 'nowrap' }}><input className="inp num" id="ps-min" type="number" min={0} max={120} value={f.minSessionMin} onChange={(e) => setF({ ...f, minSessionMin: Number(e.target.value) })} style={{ maxWidth: 110 }} /><span className="muted">min</span></div>
                <span className="hint">Short sessions are still stored, just not shown in history or trends. Default 25.</span></div>
              <div className="field"><label htmlFor="ps-cut">New devices start a new night at</label>
                <input className="inp" id="ps-cut" type="time" value={f.defaultSleepCutoff} onChange={(e) => setF({ ...f, defaultSleepCutoff: e.target.value })} style={{ maxWidth: 160 }} />
                <span className="hint">In the device&apos;s own time zone. Only devices claimed from now on get this; customers can change it per device.</span></div>
            </div>
            {err && <p className="err" role="alert">{err}</p>}
            <button className="btn" type="submit" style={{ alignSelf: 'flex-start' }} disabled={busy}>{busy ? 'Saving…' : 'Save rules'}</button>
          </form>
        </div>
        <div className="card"><h2 style={{ marginBottom: 12 }}>How it works</h2>
          <div className="stack small" style={{ gap: 8 }}>
            <p>1. Every time someone gets into bed and out again, the sensor sends one <b>session</b>.</p>
            <p>2. Sessions on the same date (cut off at each device&apos;s “new night” time) that are less than {f.mergeGapMin} min apart are joined. The gap shows as “out of bed”.</p>
            <p>3. The longest joined group is the <b>main sleep</b>. Any other group is a <b>nap</b>: it gets a badge but doesn&apos;t count in trends.</p>
            <p>4. Sessions shorter than {f.minSessionMin} min are hidden.</p>
          </div>
          <div className="between" style={{ marginTop: 14, flexWrap: 'wrap' }}><span className="label">Example · 2 sessions joined</span><Legend /></div>
          <div className="chartbox"><Hypnogram hyp={SAMPLE} startMin={22 * 60 + 50} label="Example night" /></div>
        </div>
      </>}</Async>
    </div>
  );
}
