import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="main"><div className="wrap narrow">
      <div className="card lock"><h2>Page not found</h2><p>This page doesn&apos;t exist or was moved.</p><Link className="btn ghost" href="/">Go to home</Link></div>
    </div></div>
  );
}
