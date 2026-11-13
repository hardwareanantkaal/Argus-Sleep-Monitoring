'use client';

// Shared bits of the manufacturing station and the factory log (API.md §9b).

import type { FactoryRun } from '@/lib/types';

export function ResultPill({ r }: { r: Pick<FactoryRun, 'result' | 'failReason'> }) {
  if (r.result === 'pass') return <span className="pill ok">PASS</span>;
  if (r.result === 'fail') return <span className="pill bad">FAIL{r.failReason ? ` · ${r.failReason}` : ''}</span>;
  if (r.result === 'aborted') return <span className="pill">Aborted</span>;
  return <span className="pill live"><span className="dot pulse" />Running</span>;
}

export const FLASH_BYTES: Record<string, number> = { '2MB': 2 << 20, '4MB': 4 << 20, '8MB': 8 << 20, '16MB': 16 << 20 };

/** Lowercase hex sha256 of the bytes (browser crypto). */
export async function sha256Hex(data: Uint8Array) {
  const h = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const macUpper = (m: string) => (m.includes(':') ? m : m.match(/.{2}/g)?.join(':') || m).toUpperCase();
