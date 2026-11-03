'use client';

// The logged-in layout: desktop sidebar, tablet icon rail, phone top bar + bottom tabs + "More" sheet.
// The menu is built from the user's kind and staff permissions (SCREENS.md "Shared rules").

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { useAuth, useTheme } from './Providers';
import { Loading, MockBadge } from './ui';
import { Brand } from '@/theme/brand';
import { prettyPhone } from '@/lib/format';
import type { StaffPerm, User } from '@/lib/types';

export interface NavItem { href: string; label: string; icon: string; perm?: StaffPerm }

export const CUSTOMER_NAV: NavItem[] = [
  { href: '/devices', label: 'My devices', icon: 'bed' },
  { href: '/history', label: 'History', icon: 'moon' },
  { href: '/alerts', label: 'Alerts', icon: 'bell' },
  { href: '/account', label: 'Account', icon: 'user' },
];
export const ADMIN_NAV: NavItem[] = [
  { href: '/admin', label: 'Dashboard', icon: 'grid' },
  { href: '/admin/devices', label: 'Devices', icon: 'chip', perm: 'devices.view' },
  { href: '/admin/register', label: 'Register', icon: 'usb', perm: 'devices.register' },
  { href: '/admin/customers', label: 'Customers', icon: 'users', perm: 'customers.view' },
  { href: '/admin/firmware', label: 'Firmware', icon: 'upload', perm: 'firmware.view' },
  { href: '/admin/team', label: 'Team', icon: 'shield', perm: 'team.manage' },
  { href: '/admin/audit', label: 'Audit log', icon: 'list', perm: 'audit.view' },
  { href: '/admin/sleep-rules', label: 'Sleep rules', icon: 'gear', perm: 'platform.settings' },
];

export const isStaff = (u: User) => u.kind === 'admin';
export const homeFor = (u: User) => (isStaff(u) ? '/admin' : '/devices');

function adminItems(u: User) {
  return isStaff(u) ? ADMIN_NAV.filter((n) => !n.perm || u.permissions.includes(n.perm)) : [];
}

/** The nav item that owns this path: the longest href that is a prefix of it. */
function activeHref(path: string, items: NavItem[]) {
  let best = '';
  for (const n of items) if ((path === n.href || path.startsWith(n.href + '/')) && n.href.length > best.length) best = n.href;
  return best;
}

export function Shell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const path = usePathname();
  const router = useRouter();
  const [more, setMore] = useState(false);

  useEffect(() => {
    if (user === null) router.replace(`/login?next=${encodeURIComponent(path)}`);
  }, [user, path, router]);
  useEffect(() => setMore(false), [path]);

  if (!user) return <Loading label={user === null ? 'Taking you to log in…' : 'Loading…'} />;

  const admin = adminItems(user);
  // Staff see the admin menu first; everyone has the customer side ("My devices" etc.).
  const all = [...admin, ...CUSTOMER_NAV];
  const active = activeHref(path, all);
  const max = 4;
  const tabs = all.length > 5 ? all.slice(0, max) : all;
  const rest = all.length > 5 ? all.slice(max) : [];

  const navLink = (n: NavItem, size = 20) => (
    <Link key={n.href} href={n.href} className={`nav ${active === n.href ? 'on' : ''}`} aria-current={active === n.href ? 'page' : undefined}>
      <Icon name={n.icon} size={size} /><span>{n.label}</span>
    </Link>
  );
  const doLogout = async () => { await logout(); router.replace('/login'); };
  const themeBtn = (
    <button className="iconbtn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? 'Use light theme' : 'Use dark theme'}>
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
    </button>
  );

  return (
    <>
      <header className="topbar">
        <Link href={homeFor(user)} aria-label="Home"><Brand size={24} /></Link>
        <span className="sp" />
        <MockBadge />
        {themeBtn}
      </header>
      <div className="shell">
        <aside className="side">
          <Link href={homeFor(user)} aria-label="Home"><Brand size={26} /></Link>
          {admin.length > 0 && <>
            <span className="label sec">Admin · {user.role?.name}</span>
            {admin.map((n) => navLink(n))}
            <div className="divider" style={{ margin: '10px 4px' }} />
          </>}
          <span className="label sec">My home</span>
          {CUSTOMER_NAV.map((n) => navLink(n))}
          <div className="foot">
            <div className="who small"><b>{user.fullName}</b><span className="xs muted">{prettyPhone(user.phone)}</span></div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn ghost sm" onClick={doLogout}><Icon name="out" size={16} /> Log out</button>
              {themeBtn}
            </div>
            <MockBadge />
          </div>
        </aside>
        <main className="main">{children}</main>
      </div>
      <nav className="tabbar" aria-label="Main">
        {tabs.map((n) => (
          <button key={n.href} className={active === n.href ? 'on' : ''} onClick={() => router.push(n.href)}>
            <Icon name={n.icon} size={22} /><span>{n.label}</span>
          </button>
        ))}
        {rest.length > 0 && (
          <button className={rest.some((n) => n.href === active) ? 'on' : ''} onClick={() => setMore(true)} aria-expanded={more}>
            <Icon name="more" size={22} /><span>More</span>
          </button>
        )}
      </nav>
      {more && <>
        <div className="scrim" onClick={() => setMore(false)} />
        <div className="sheet" role="dialog" aria-label="More">
          <div className="grab" />
          {rest.map((n) => navLink(n))}
          <div className="divider" />
          <button className="nav" onClick={doLogout}><Icon name="out" size={20} /><span>Log out</span></button>
        </div>
      </>}
    </>
  );
}

/** Wrap a staff screen: shows "No access" when the role lacks the permission. */
export function RequireStaff({ perm, children }: { perm?: StaffPerm; children: React.ReactNode }) {
  const { user } = useAuth();
  if (!user) return null;
  if (!isStaff(user)) return <div className="wrap"><LockedInline msg="This screen belongs to the Argus team side." home={homeFor(user)} /></div>;
  if (perm && !user.permissions.includes(perm)) return <div className="wrap"><LockedInline home={homeFor(user)} /></div>;
  return <>{children}</>;
}

function LockedInline({ msg, home }: { msg?: string; home: string }) {
  return (
    <div className="card lock">
      <Icon name="shield" size={30} />
      <h2>No access</h2>
      <p>{msg || 'Your role does not include this permission. Ask an owner to turn it on.'}</p>
      <Link className="btn ghost" href={home}>Go to home</Link>
    </div>
  );
}
