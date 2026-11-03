// Brand placeholders. The owner will give the final name, logo and support details;
// change them here (and the colours in theme.css) and the whole app follows.

export const BRAND = {
  name: 'Argus',
  tagline: 'Know how they slept, without a wearable.',
  // PLACEHOLDERS until the owner confirms (CLAUDE.md §8)
  support: {
    company: 'Anantkaal',
    phone: '+91 00000 00000',
    email: 'support@example.com',
    hours: 'Mon–Sat, 10:00–18:00 IST',
    placeholder: true,
  },
};

export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M2.5 16S8 7 16 7s13.5 9 13.5 9S24 25 16 25 2.5 16 2.5 16z" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
      <circle cx="16" cy="16" r="5.2" fill="currentColor" />
      <circle cx="18.2" cy="14.2" r="4" fill="var(--panel)" />
    </svg>
  );
}

export function Brand({ size = 26 }: { size?: number }) {
  return (
    <span className="brand">
      <Logo size={size} />
      <span>{BRAND.name}</span>
    </span>
  );
}
