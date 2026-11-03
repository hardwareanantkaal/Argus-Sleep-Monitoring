import type { Metadata, Viewport } from 'next';
import { Sora, Figtree, JetBrains_Mono } from 'next/font/google';
import '@/theme/theme.css';
import './globals.css';
import { BRAND } from '@/theme/brand';
import { Providers } from '@/components/Providers';

const display = Sora({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-display' });
const body = Figtree({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-body' });
const mono = JetBrains_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-mono' });

export const metadata: Metadata = { title: BRAND.name, description: 'Contactless sleep monitoring' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#111a2e' };

// The theme is read from localStorage before paint so dark/light doesn't flash.
const themeScript = `try{var t=localStorage.getItem('argus-theme');if(t)document.documentElement.setAttribute('data-theme',t)}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
      <body><Providers>{children}</Providers></body>
    </html>
  );
}
