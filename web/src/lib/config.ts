// Which API areas talk to the real backend and which use built-in sample data.
// Lets every screen work before its endpoint exists; switch areas on as the backend lands.

export type Area =
  | 'auth' | 'devices' | 'live' | 'claim' | 'sleep' | 'settings' | 'sharing' | 'alerts'
  | 'admin-devices' | 'customers' | 'ota' | 'team' | 'audit' | 'platform';

const MODE = (process.env.NEXT_PUBLIC_API_MODE || 'mock') as 'mock' | 'live' | 'mixed';
const LIVE_AREAS = new Set((process.env.NEXT_PUBLIC_LIVE_AREAS || '').split(',').map((s) => s.trim()).filter(Boolean));

export function isLive(area: Area): boolean {
  if (MODE === 'live') return true;
  if (MODE === 'mock') return false;
  return LIVE_AREAS.has(area);
}

export const anyMock = MODE !== 'live';

// Order matters: first match wins.
const AREAS: [Area, RegExp][] = [
  ['auth', /^\/(auth|me)(\/|$)/],
  ['claim', /^\/devices\/claim/],
  ['sleep', /^\/devices\/[^/]+\/nights/],
  ['settings', /^\/devices\/[^/]+\/(sensor-settings|wifi-setup)/],
  ['sharing', /^\/(devices\/[^/]+\/(shares|invites)|invites\/)/],
  ['alerts', /^\/(alerts|devices\/[^/]+\/alert-rules)/],
  ['devices', /^\/devices/],
  ['admin-devices', /^\/admin\/(dashboard|devices)/],
  ['customers', /^\/admin\/customers/],
  ['ota', /^\/admin\/(firmware|ota)/],
  ['team', /^\/admin\/(team|roles)/],
  ['audit', /^\/admin\/audit/],
  ['platform', /^\/admin\/platform-settings/],
];

export function areaOf(path: string): Area {
  const p = path.split('?')[0];
  for (const [a, re] of AREAS) if (re.test(p)) return a;
  return 'devices';
}
