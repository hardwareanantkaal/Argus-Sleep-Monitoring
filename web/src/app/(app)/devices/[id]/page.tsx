'use client';

// Live device dashboard (API.md 3.4 + Socket.IO live:subscribe / device:live), laid out like the
// Firebase-era dashboard: header, live cards, live hypnogram, diagnostics, nightly session, controls, footer.
// Live values are shown, never stored.

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Spark } from '@/components/charts';
import { StageTiles, StageTimeline } from '@/components/StageTimeline';
import { Icon } from '@/components/Icon';
import { firstLocalMin, pushStage } from '@/components/LiveTelemetry';
import { Placement } from '@/components/Placement';
import { useTheme, useToast } from '@/components/Providers';
import { Async, Head, Legend, TzTag, useApi } from '@/components/ui';
import { whenLocal } from '@/components/vendor';
import { errText, post } from '@/lib/api';
import { ago, BREATH_STATE, dur, placeName, presenceText, STAGE_NAME, uptime } from '@/lib/format';
import { useAccessChanged, useLive, type LiveMsg } from '@/lib/useLive';
import type { DeviceDetail, LiveValues } from '@/lib/types';

const KEEP = 40; // points in each sparkline
const MOTION = ['None', 'Still', 'Active'];
// Sensor 'sleep abnormality' (0x84 0x8E): a reason, not a level. 3 = none.
const LEVEL = ['Slept < 4 h', 'Slept > 12 h', 'Long absence', 'None'];
// Sensor quality rating (0x84 0x90): 0 none, 1 good, 2 general, 3 poor.
const RATING = ['—', 'Good', 'General', 'Poor'];
const STRUGGLE: [string, string][] = [['None', ''], ['Normal', 'ok'], ['Abnormal', 'bad']];
const STAGE_TONE: Record<number, string> = { 0: 'violet', 1: 'cyan', 2: 'amber' };

/** Re-render every `ms` (header clock, "updated x s ago"). */
function useTick(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

export default function LivePage() {
  const { id } = useParams<{ id: string }>();
  const q = useApi<DeviceDetail>(`/devices/${id}`);
  const d = q.data;
  const canLive = !!d?.myPermissions.includes('live.view');
  const hist = useRef<{ hr: number[]; br: number[] }>({ hr: [], br: [] });
  const stages = useRef<{ first: number | null; mins: string[] }>({ first: null, mins: [] }); // live hypnogram from sess.st
  const [, bump] = useState(0);
  const router = useRouter();
  const toast = useToast();
  // API.md §10: access ended (temporary access over, share removed) → leave the device; otherwise reload permissions
  useAccessChanged((m) => {
    if (m.deviceId !== id) return;
    if (m.myPermissions === null) { toast('Your access to this sensor has ended'); router.replace('/devices'); } else q.reload();
  });
  const { live, status } = useLive(d ? [d.id] : [], d && canLive ? [d.id] : [], (m: LiveMsg) => {
    if (m.hr) hist.current.hr = [...hist.current.hr, m.hr].slice(-KEEP);
    if (m.br) hist.current.br = [...hist.current.br, m.br].slice(-KEEP);
    if (d) pushStage(stages.current, m, d.tz);
    bump((n) => n + 1);
  });

  return (
    <Async q={q}>{(d) => {
      const online = status[d.id]?.online ?? d.status.online;
      const lastSeen = status[d.id]?.lastSeenAt ?? d.status.lastSeenAt;
      const lv = live[d.id] || d.live || null;
      const perms = d.myPermissions;
      const vendorDev = d.access === 'vendor' || d.access === 'grant';
      const back: [string, string] = d.access === 'vendor' ? ['/vendor', 'Devices'] : ['/devices', 'Monitors'];
      // v2: a customer's device bought from a vendor shows "Sold by <vendor>"
      const vendorTag = d.vendor ? (d.access === 'owner' || d.access === 'share' ? `Sold by ${d.vendor.name}` : d.vendor.name) : null;
      const sub = [d.room || d.serial, vendorTag, d.group?.name].filter(Boolean).join(' · ');
      const until = d.access === 'grant' && d.accessEndsAt ? <div className="note"><Icon name="clock" /><span>Access from {d.vendor?.name || 'the vendor'} until <b>{whenLocal(d.accessEndsAt)}</b>. It ends by itself after that.</span></div> : null;
      const links = <>
        {perms.includes('history.view') && <Link className="btn ghost sm" href={`/history/${d.id}`}><Icon name="moon" size={16} /> History</Link>}
        {!vendorDev && perms.includes('sharing.manage') && <Link className="btn ghost sm" href={`/devices/${d.id}/share`}><Icon name="share" size={16} /> Share</Link>}
        {perms.includes('settings.edit') && <Link className="btn ghost sm" href={`/devices/${d.id}/settings`}><Icon name="gear" size={16} /> Settings</Link>}
      </>;

      if (!canLive) return (
        <div className="wrap">
          <Head title={d.name} sub={sub} actions={links} back={back} />
          {until}
          <div className="card empty"><Icon name="shield" size={30} /><h2>Live values aren&apos;t shared with you</h2><p>Ask the owner to turn on “See live values” for you.</p></div>
        </div>
      );

      return (
        <div className="wrap dash">
          <DashHeader d={d} sub={sub} online={online} lastSeen={lastSeen} lv={lv} back={back} />
          {until}
          {!online && <div className="dash-banner warn"><Icon name="alert" /><span>This sensor is offline. Showing the last values received ({ago(lastSeen).toLowerCase()}).</span></div>}

          <Section title="Real-Time Live Telemetry" sub="Direct sensor stream">
            <LiveCards lv={lv} online={online} hr={hist.current.hr} br={hist.current.br} />
            <LiveHypnogram lv={lv} tz={d.tz} stages={stages.current} />
          </Section>

          <Section title="Composite Telemetry & Diagnostics" sub={lv?.cmp && !lv.cmp.resp && !lv.cmp.hr ? "Collecting: the sensor updates these about every 10 minutes of sleep" : "The sensor's own rolling values, updated about every 10 minutes"}>
            <Composite lv={lv} />
          </Section>

          <Section title="Nightly Session" sub={lv?.ngt && !lv.ngt.sc ? "Live session now. The sensor's night statistics arrive when the sleep ends (bed exit)" : "The session running now, plus the sensor's night statistics"}>
            <Nightly d={d} lv={lv} />
          </Section>

          <Section title="Device Controls" sub={<span className="row" style={{ gap: 8 }}>{links}</span>}>
            <Controls d={d} online={online} />
          </Section>

          <div className="note"><Icon name="info" /><span>Live values come straight from the sensor and are <b>not saved</b>. The saved record is the nightly sleep summary.</span></div>

          <footer className="dash-foot">
            <span>Node sequence: #{lv?.seq ?? '—'}</span>
            <span>Serial: {d.serial}</span>
            <span>FW: {lv?.fw || d.connection?.fw ? `v${lv?.fw || d.connection?.fw}` : '—'}</span>
            <span>Radar link: {lv?.radar == null ? '—' : lv.radar ? 'HEALTHY' : 'DOWN'}</span>
            <span>Uptime: {uptime(lv?.up ?? d.connection?.uptimeS)}</span>
          </footer>
        </div>
      );
    }}</Async>
  );
}

/* ---------- header ---------- */

function DashHeader({ d, sub, online, lastSeen, lv, back }: { d: DeviceDetail; sub: string; online: boolean; lastSeen: string | null; lv: LiveValues | null; back: [string, string] }) {
  const now = useTick(1000);
  const { theme, setTheme } = useTheme();
  const time = new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: d.tz });
  const rssi = lv?.rssi ?? d.connection?.rssi;
  const at = lv?.at ? Date.parse(lv.at) : NaN;
  const secs = Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 1000)) : null;
  const updated = !online ? `Last seen ${ago(lastSeen).toLowerCase()}` : secs == null ? 'Waiting for data' : secs < 10 ? 'Updated just now' : secs < 60 ? `Updated ${secs}s ago` : `Updated ${Math.floor(secs / 60)} min ago`;
  return (
    <header className="dash-head">
      <div className="dash-head-l">
        <Link href={back[0]} className="dash-back" title={`Back to ${back[1]}`}><Icon name="back" size={16} /><span>{back[1]}</span></Link>
        <span className="dash-logo" aria-hidden="true">
          <svg width="34" height="34" viewBox="0 0 32 32" fill="none"><rect width="32" height="32" rx="10" fill="url(#dashLogo)" /><circle cx="16" cy="16" r="8" stroke="#fff" strokeWidth="2" strokeDasharray="3 2" /><circle cx="16" cy="16" r="3" fill="#fff" />
            <defs><linearGradient id="dashLogo" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse"><stop stopColor="var(--cyan)" /><stop offset="1" stopColor="var(--violet)" /></linearGradient></defs></svg>
        </span>
        <div className="dash-title"><h1>{d.name}</h1><span>{sub}<TzTag tz={d.tz} place={d.place} /></span></div>
      </div>
      <div className="dash-head-r">
        <button className="dash-theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? 'Use light theme' : 'Use dark theme'}>
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} /><span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
        </button>
        <span className={`dash-status ${online ? 'on' : 'off'}`}><i />{online ? 'LIVE' : 'OFFLINE'}</span>
        <span className="dash-meta">
          <span title={`${placeName(d.tz, d.place)} time`}>{time}</span>
          {rssi != null && <><b>·</b><span>{rssi} dBm</span></>}
          <b>·</b><span>{updated}</span>
        </span>
      </div>
    </header>
  );
}

function Section({ title, sub, children }: { title: string; sub?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="dash-sec">
      <div className="dash-sec-h"><h2>{title}</h2>{sub && <span>{typeof sub === 'string' ? `· ${sub}` : sub}</span>}</div>
      {children}
    </section>
  );
}

function CardHead({ icon, tone, title, chip, chipTone }: { icon: string; tone: string; title: string; chip?: React.ReactNode; chipTone?: string }) {
  return (
    <div className="dc-h">
      <span className={`dc-t t-${tone}`}><Icon name={icon} size={17} /><span>{title}</span></span>
      {chip != null && <span className={`chip ${chipTone || ''}`}>{chip}</span>}
    </div>
  );
}

/* ---------- live cards ---------- */

function LiveCards({ lv, online, hr: hrs, br: brs }: { lv: LiveValues | null; online: boolean; hr: number[]; br: number[] }) {
  const hr = lv?.hr || 0, br = lv?.br || 0, mr = lv?.mr ?? 0;
  const bs = BREATH_STATE[lv?.bs ?? 4] || BREATH_STATE[4];
  const motion = lv?.mv == null ? '—' : MOTION[lv.mv] ?? '—';
  const inBed = lv?.bed === 1;
  const st = lv?.sess ? lv.sess.st : lv?.ss;   // engine stage during a session, else the sensor's
  const stage = inBed && lv && st != null ? STAGE_NAME[st] ?? '—' : '—';
  return (
    <div className="dash-grid4">
      <div className="dcard">
        <CardHead icon="activity" tone="cyan" title="Vital Signs" chip={online ? 'Active stream' : 'Offline'} chipTone={online ? 'cyan' : ''} />
        <div className="vit2">
          <div>
            <span className="lbl">Heart rate</span>
            <div className="val"><b className={`t-cyan${online && hr ? ' beat' : ''}`}>{hr || '—'}</b><small>BPM</small></div>
            <span className="sub">{hr ? (hr > 100 ? 'Elevated rate' : hr < 45 ? 'Low rate' : 'Normal rhythm') : 'No signal lock'}</span>
          </div>
          <i className="vdiv" />
          <div>
            <span className="lbl">Respiration</span>
            <div className="val"><b className={`t-emerald${online && br ? ' beat' : ''}`}>{br || '—'}</b><small>RPM</small></div>
            <span className="sub">Pattern: <strong>{bs[0]}</strong></span>
          </div>
        </div>
        <div className="sparks">
          <Spark vals={hrs} min={Math.min(...hrs, hr || 60) - 4} max={Math.max(...hrs, hr || 60) + 4} col="var(--cyan)" h={34} />
          <Spark vals={brs} min={Math.min(...brs, br || 14) - 3} max={Math.max(...brs, br || 14) + 3} col="var(--emerald)" h={34} />
        </div>
      </div>

      <div className="dcard">
        <CardHead icon="person" tone="amber" title="Movement" chip={motion} chipTone="amber" />
        <div className="big t-amber">{motion}</div>
        <div className="kv2">
          <span>Moving range</span><b>{lv?.mr != null ? `${mr}%` : '—'}</b>
          <span>Target distance</span><b>{lv?.dist ? `${lv.dist} cm` : '—'}</b>
        </div>
        <div className="meter"><i style={{ width: `${Math.min(100, mr)}%`, background: 'var(--amber)' }} /></div>
      </div>

      <div className="dcard">
        <CardHead icon="bed" tone="emerald" title="Bed & Presence" chip={inBed ? 'In bed' : 'Out of bed'} chipTone={inBed ? 'emerald' : ''} />
        <div className="big">{inBed ? 'In bed' : 'Out of bed'}</div>
        <span className="sub">{presenceText(lv?.pr, lv?.bed)}{lv?.pr === 1 ? ' · person detected' : ''}</span>
      </div>

      <div className="dcard">
        <CardHead icon="moon" tone="violet" title="Current Sleep Stage" chip={stage} chipTone={inBed && lv && st != null ? STAGE_TONE[st] : ''} />
        <div className="big">{stage}</div>
        <span className="sub">{inBed ? 'From the radar, live' : 'Shown while someone is in bed'} · no REM on this sensor</span>
      </div>
    </div>
  );
}

function LiveHypnogram({ lv, tz, stages }: { lv: LiveValues | null; tz: string; stages: { first: number | null; mins: string[] } }) {
  const s = lv?.sess;
  const firstMin = firstLocalMin(stages.first, tz);
  const hyp = stages.mins.join('');
  return (
    <div className="dcard">
      <div className="dc-h"><span className="dc-t t-violet"><Icon name="moon" size={17} /><span>Live Sleep Stage Timeline (current session)</span></span>{s && <Legend />}</div>
      {!s ? <p className="sub">No active session. The timeline appears while someone is in bed.</p> : <>
        <StageTiles deep={s.dp} light={s.lt} awake={s.aw} />
        {hyp.length >= 1 && firstMin != null
          ? <StageTimeline hyp={hyp} startMin={firstMin} epochMin={1} startIso={new Date((stages.first ?? 0) * 60000).toISOString()} tz={tz} label="Live sleep stages" />
          : <p className="sub">Building the chart… one block per minute.</p>}
        <span className="xs muted">Totals cover the whole session (from the sensor). The chart covers the time since this page opened.</span>
      </>}
    </div>
  );
}

/* ---------- composite ---------- */

function Composite({ lv }: { lv: LiveValues | null }) {
  const c = lv?.cmp;
  if (!c) return <div className="dcard"><p className="sub">No active session. These values appear while someone is in bed.</p></div>;
  const st = STRUGGLE[c.abn] || [String(c.abn), ''];
  return <>
    <div className="dash-grid3">
      <div className="dcard">
        <CardHead icon="alert" tone="rose" title="Sleep Disturbance" chip={c.dis === 3 ? 'Normal' : 'Alert'} chipTone={c.dis === 3 ? 'emerald' : 'rose'} />
        <div className={`big ${c.dis === 3 ? 't-emerald' : 't-rose'}`}>{LEVEL[c.dis] ?? c.dis}</div><span className="sub">Sleep abnormality reported by the sensor</span>
      </div>
      <div className="dcard">
        <CardHead icon="person" tone="amber" title="Struggle Monitor" chip={st[0]} chipTone={st[1] === 'bad' ? 'rose' : st[1] === 'ok' ? 'emerald' : ''} />
        <div className="big t-amber">{c.abn === 2 && '⚠ '}{st[0]}</div><span className="sub">Abnormal struggle and movement detection</span>
      </div>
      <div className="dcard">
        <CardHead icon="check" tone="cyan" title="Quality Rating" chip={RATING[c.rat] ?? c.rat} chipTone="cyan" />
        <div className="big t-cyan">{RATING[c.rat] ?? c.rat}</div><span className="sub">{c.rat ? 'Rated by the sensor' : 'Rated by the sensor at the end of sleep'}</span>
      </div>
    </div>
    <div className="dash-stats">
      <Stat l="Avg respiration" v={c.resp} u="RPM" tone="cyan" s="Breathing rate" />
      <Stat l="Avg heart rate" v={c.hr} u="BPM" tone="emerald" s="Heartbeat rate" />
      <Stat l="Apnea events" v={c.apn} tone="rose" s="Breathing pauses" />
      <Stat l="Turnovers" v={c.turn} tone="violet" s="Body rotations" />
      <Stat l="Large movement" v={`${c.lg}%`} tone="amber" s="Of the session" />
      <Stat l="Minor movement" v={`${c.mn}%`} s="Of the session" />
    </div>
  </>;
}

function Stat({ l, v, u, tone, s }: { l: string; v: React.ReactNode; u?: string; tone?: string; s?: string }) {
  return <div className="dstat"><span className="lbl">{l}</span><div className="val"><b className={tone ? `t-${tone}` : ''}>{v}</b>{u && <small>{u}</small>}</div>{s && <span className="sub">{s}</span>}</div>;
}

/* ---------- nightly ---------- */

function Ring({ v, rating }: { v: number; rating?: string }) {
  const r = 58, c = 2 * Math.PI * r, val = Math.max(0, Math.min(100, v));
  return (
    <div className="dring">
      <svg width="150" height="150" viewBox="0 0 150 150" aria-label={`Score ${val} of 100`}>
        <defs><linearGradient id="dashRing" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stopColor="var(--cyan)" /><stop offset="50%" stopColor="var(--emerald)" /><stop offset="100%" stopColor="var(--violet)" /></linearGradient></defs>
        <circle cx="75" cy="75" r={r} fill="none" stroke="var(--panel-2)" strokeWidth="12" />
        <circle cx="75" cy="75" r={r} fill="none" stroke="url(#dashRing)" strokeWidth="12" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c - (val / 100) * c} transform="rotate(-90 75 75)" style={{ transition: 'stroke-dashoffset .6s' }} />
      </svg>
      <div className="dring-c"><b>{val}</b><span>/ 100</span>{rating && <em>{rating}</em>}</div>
    </div>
  );
}

function Nightly({ d, lv }: { d: DeviceDetail; lv: LiveValues | null }) {
  const s = lv?.sess, n = lv?.ngt;
  if (!s) {
    const ln = d.lastNight;
    return (
      <div className="dcard dnight">
        {ln && ln.score != null ? <Ring v={ln.score} /> : null}
        <div className="stack" style={{ gap: 6, flex: 1, minWidth: 200 }}>
          <span className="lbl">No session running</span>
          {ln ? <h3>Last night ({ln.sleepDate}): {ln.totalSleepMin != null ? dur(ln.totalSleepMin) : '—'} asleep{ln.score != null ? `, score ${ln.score}` : ''}</h3> : <h3>No saved nights yet</h3>}
          <span className="sub">The live session block appears as soon as someone gets into bed.</span>
          {d.myPermissions.includes('history.view') && <Link className="btn ghost sm" style={{ alignSelf: 'flex-start', marginTop: 6 }} href={`/history/${d.id}`}><Icon name="moon" size={16} /> See sleep history</Link>}
        </div>
      </div>
    );
  }
  const score = s.sc ?? n?.sc ?? 0;
  const rating = lv?.cmp ? RATING[lv.cmp.rat] : undefined;
  const asleep = s.slp;
  const deepPct = n?.dp ?? (s.slp ? Math.round((s.dp / s.slp) * 100) : 0);
  const lightPct = n?.sh ?? (s.slp ? Math.round((s.lt / s.slp) * 100) : 0);
  return <>
    <div className="dcard dqi">
      <div className="dqi-h">Sleep Quality Index <b className="t-amber">{rating && rating !== '—' ? rating : 'None'}</b></div>
      <div className="dqi-body">
        <Ring v={score} />
        <div className="dqi-pills">
          <div><span>Time asleep</span><b>{(asleep / 60).toFixed(1)} hrs</b></div>
          <div><span>Deep ratio</span><b>{deepPct}%</b></div>
        </div>
        <div className="kv2" style={{ minWidth: 190 }}>
          <span>Stage now</span><b>{STAGE_NAME[s.st] ?? '—'}</b>
          <span>Started</span><b>{new Date(s.start * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: d.tz })}</b>
          <span>Fell asleep after</span><b>{s.on} min</b>
          <span>Wake-ups</span><b>{s.wk}</b>
        </div>
      </div>
    </div>
    <div className="dash-tiles5">
      <Hero l="Total sleep duration" v={dur(asleep)} s={`${asleep} minutes`} />
      <Hero l="Deep rest ratio" v={`${deepPct}%`} s="Restorative sleep" />
      <Hero l="Light rest ratio" v={`${lightPct}%`} s="Light sleep phase" />
      <Hero l="Awake duration" v={`${s.aw}m`} s="Awake period in bed" />
      <Hero l="Out of bed time" v={n ? `${n.oob}m` : '—'} s="Minutes out of bed" />
      <Hero l="Nightly score" v={<>{n?.sc ?? score}<small>/100</small></>} s={n ? 'Overall score' : 'Live session score'} />
    </div>
    {n && <div className="dpanel"><div className="dash-stats five">
      <Stat l="Apnea disruptions" v={n.apn} s="Breathing pause events" />
      <Stat l="Bed exits" v={n.ex} s="Times exited bed" />
      <Stat l="Position turnovers" v={n.tn} s="Body rotations" />
      <Stat l="Avg cardiac rate" v={n.hr} u="BPM" s="Nightly heart rate average" />
      <Stat l="Avg respiration" v={n.resp} u="RPM" s="Nightly respiration average" />
    </div></div>}
  </>;
}

function Hero({ l, v, s, tone }: { l: string; v: React.ReactNode; s?: string; tone?: string }) {
  return <div className="dhero"><span className="lbl">{l}</span><b className={tone ? `t-${tone}` : ''}>{v}</b>{s && <span className="sub">{s}</span>}</div>;
}

/* ---------- controls ---------- */

function Controls({ d, online }: { d: DeviceDetail; online: boolean }) {
  const toast = useToast();
  const [placing, setPlacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const canEdit = d.myPermissions.includes('settings.edit');
  const config = async () => {
    if (!confirm('Put the sensor into Config Mode (Wi-Fi setup)? It goes offline until you connect it to a network.')) return;
    setBusy(true);
    try {
      const r = await post<{ commandId: string; status: 'sent' | 'expired' }>(`/devices/${d.id}/wifi-setup`);
      if (r.status === 'sent') { setSent(true); toast('Config Mode started. Connect your phone to the sensor’s setup network.'); }
      else toast('The sensor is offline, so it can’t be switched. Press its button 5 times to open setup.');
    } catch (e) { toast(errText(e)); } finally { setBusy(false); }
  };
  return <>
    <div className="dash-grid2">
      <button type="button" className="dctl" disabled={!online} onClick={() => setPlacing(!placing)} aria-expanded={placing}>
        <span className="dctl-ic violet"><Icon name="shield" size={22} /></span>
        <span className="dctl-tx"><b>Placement Check</b><span>{online ? 'Check the radar position and signal lock score' : 'Unavailable: turn the sensor on first'}</span></span>
        <span className="dctl-btn">{!online ? 'Offline' : placing ? 'Close' : 'Run check'}</span>
      </button>
      <button type="button" className={`dctl${sent ? ' amber' : ''}`} disabled={!online || !canEdit || busy} onClick={config}>
        <span className={`dctl-ic ${sent ? 'amber' : 'cyan'}`}><Icon name="wifi" size={22} /></span>
        <span className="dctl-tx"><b>Config Mode (Wi-Fi setup)</b><span>{!canEdit ? 'Needs “Change settings” permission' : !online ? 'Unavailable: turn the sensor on first' : sent ? 'Sent. The sensor opens its setup network and goes offline' : 'Open the sensor’s Wi-Fi setup portal'}</span></span>
        <span className="dctl-btn">{busy ? 'Sending…' : sent ? 'Sent' : 'Start config'}</span>
      </button>
    </div>
    {placing && online && <div className="dcard"><Placement id={d.id} online={online} /></div>}
  </>;
}
