'use client';

// The page an invite link opens (/invite/<token>), logged in or out.
// Link-only (owner decision 3 Nov): whoever opens it with a logged-in account can accept.
// The phone number is never compared. One use, 7 days.

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { AuthLayout } from '@/components/AuthLayout';
import { Icon } from '@/components/Icon';
import { useAuth } from '@/components/Providers';
import { ErrorBox, Loading, permLabel, useApi } from '@/components/ui';
import { ApiError, errText, post } from '@/lib/api';
import { STAFF_PERMS } from '@/lib/mock/data';
import { whenLocal } from '@/components/vendor';
import { day, prettyPhone } from '@/lib/format';
import type { DeviceCard, InvitePreview } from '@/lib/types';

const staffLabel = (p: string) => STAFF_PERMS.find((x) => x.code === p)?.label || p;

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const { user, logout, reload } = useAuth();
  const router = useRouter();
  const q = useApi<InvitePreview>(`/invites/${encodeURIComponent(token)}`);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const here = `/invite/${token}`;

  const accept = async () => {
    setErr(''); setBusy(true);
    try {
      const r = await post<{ device?: DeviceCard | null; role?: unknown; vendor?: unknown; grant?: unknown }>(`/invites/${encodeURIComponent(token)}/accept`);
      if (r.device) router.replace(`/devices/${r.device.id}`);
      else if (r.grant) router.replace('/devices'); // access starts later: the device shows up at startsAt
      else if (r.vendor) { await reload(); router.replace('/vendor'); } // joined a vendor team: reload /me.vendor
      else { await reload(); router.replace('/admin'); } // new staff role: reload permissions
    } catch (e) { setErr(errText(e)); setBusy(false); }
  };

  const invalid = q.error instanceof ApiError && (q.error.code === 'INVITE_INVALID' || q.error.status === 404);
  const inv = q.data;

  return (
    <AuthLayout>
      {q.loading && !inv && <Loading />}
      {invalid && <>
        <h1>This invite link doesn&apos;t work</h1>
        <p className="muted">It has expired, was cancelled, or was already used. Ask the person who sent it for a new link.</p>
        <Link className="btn ghost block" href="/">Go to the app</Link>
      </>}
      {q.error && !invalid ? <ErrorBox error={q.error} retry={q.reload} /> : null}
      {inv && <>
        <span className="label">Invite · expires {day(inv.expiresAt)}</span>
        {inv.kind === 'device' ? <>
          <h1>{inv.inviterName} invited you to “{inv.deviceName}”</h1>
          <p className="muted">A sleep sensor{inv.place ? ` in ${inv.place}` : ''}. You&apos;ll be able to:</p>
          <div className="stack" style={{ gap: 6 }}>
            {(inv.permissions || []).map((p) => <div key={p} className="row small" style={{ flexWrap: 'nowrap' }}><Icon name="check" size={16} /> {permLabel(p)}</div>)}
          </div>
        </> : inv.kind === 'vendor' ? <>
          <h1>Join {inv.vendorName} as {inv.vendorRole === 'owner' ? 'owner' : 'staff'}</h1>
          <p className="muted">{inv.inviterName} invited you. You&apos;ll see all of {inv.vendorName}&apos;s sensors: live values, sleep history and alerts{inv.vendorRole === 'owner' ? ', and you can invite your own staff' : ''}.</p>
        </> : inv.kind === 'grant' ? <>
          <h1>{inv.vendorName} gives you access to “{inv.deviceName}”</h1>
          <p className="muted">From <b>{whenLocal(inv.startsAt)}</b> to <b>{whenLocal(inv.endsAt)}</b>{inv.place ? ` · ${inv.place}` : ''}. Access ends by itself after that. You&apos;ll be able to:</p>
          <div className="stack" style={{ gap: 6 }}>
            {(inv.permissions || []).map((p) => <div key={p} className="row small" style={{ flexWrap: 'nowrap' }}><Icon name="check" size={16} /> {permLabel(p)}</div>)}
          </div>
        </> : <>
          <h1>{inv.inviterName} invited you to the team</h1>
          <p className="muted">Role: <b>{inv.roleName}</b>.{inv.permissions?.length ? ' You’ll be able to:' : ''}</p>
          {!!inv.permissions?.length && <div className="stack" style={{ gap: 6 }}>
            {inv.permissions.map((p) => <div key={p} className="row small" style={{ flexWrap: 'nowrap' }}><Icon name="check" size={16} /> {staffLabel(p)}</div>)}
          </div>}
        </>}
        {user === undefined ? <Loading /> : user ? <>
          <div className="note"><Icon name="user" /><span>You&apos;re logged in as <b>{user.fullName}</b> ({prettyPhone(user.phone)}). Accepting adds this to that account.</span></div>
          {err && <p className="err" role="alert">{err}</p>}
          <button className="btn block" onClick={accept} disabled={busy}>{busy ? 'Accepting…' : 'Accept invite'}</button>
          <button className="link small" onClick={async () => { await logout(); router.push(`/login?next=${encodeURIComponent(here)}`); }}>Not you? Log in as someone else</button>
        </> : <>
          <Link className="btn block" href={`/signup?next=${encodeURIComponent(here)}`}>Create an account and accept</Link>
          <Link className="btn ghost block" href={`/login?next=${encodeURIComponent(here)}`}>I have an account: log in</Link>
        </>}
        <p className="xs muted">Your phone number doesn&apos;t need to match anything. The link is the invite: it works once, for whoever accepts it first.</p>
      </>}
    </AuthLayout>
  );
}
