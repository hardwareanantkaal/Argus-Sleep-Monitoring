'use client';

// Two-column page for log in / sign up / invite / reset (art panel hides on phones).

import { useEffect, useState } from 'react';
import { BRAND, Brand } from '@/theme/brand';
import { sampleHyp } from '@/lib/mock/data';
import { Hypnogram } from './charts';
import { Legend } from './ui';

const SAMPLE = sampleHyp();

export function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth">
      <div className="art">
        <Brand size={28} />
        <div className="stack" style={{ gap: 18 }}>
          <h2>{BRAND.tagline}</h2>
          <p className="muted" style={{ maxWidth: '44ch' }}>A 60&nbsp;GHz radar beside the bed reads breathing, heart rate and movement. You see it live, and get a summary every morning.</p>
        </div>
        <div className="card" style={{ background: 'var(--bg)' }}>
          <div className="between" style={{ marginBottom: 8, flexWrap: 'wrap' }}><span className="label">Last night · sample</span><Legend /></div>
          <div className="chartbox"><Hypnogram hyp={SAMPLE} startMin={22 * 60 + 50} label="Sample night" /></div>
        </div>
      </div>
      <div className="side-form"><div className="box">{children}</div></div>
    </div>
  );
}

/** Safe `?next=` target: only paths inside this app. Read on the client (avoids a Suspense boundary). */
export function useNextParam(): string | null {
  const [next, setNext] = useState<string | null>(null);
  useEffect(() => {
    const n = new URLSearchParams(window.location.search).get('next');
    setNext(n && n.startsWith('/') && !n.startsWith('//') ? n : null);
  }, []);
  return next;
}

export function SupportCard() {
  const s = BRAND.support;
  const ph = null;
  return (
    <div className="card stack" style={{ gap: 10 }}>
      <h2>Contact {s.company} support</h2>
      <p className="small muted">Tell them the phone number you log in with. They&apos;ll send you a one-time link to set a new password.</p>
      <dl className="kv">
        <dt>Phone / WhatsApp</dt><dd className="mono" style={{ userSelect: 'all' }}>{s.phone} {ph}</dd>
        <dt>Email</dt><dd className="mono" style={{ userSelect: 'all' }}>{s.email} {ph}</dd>
        <dt>Hours</dt><dd>{s.hours} {ph}</dd>
      </dl>
    </div>
  );
}
