import type { Metadata } from 'next';
import { asset } from '../lib/catalog';
import './globals.css';
export const metadata: Metadata = {
  title: { default: 'Honky Tonks — Small software, shared', template: '%s · Honky Tonks' },
  description: 'Browse open Tonk templates. Discover small apps, read their source, and bring their YAML into your own Tonk space.',
  icons: { icon: asset('favicon.svg') },
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><head><link rel="alternate" type="application/json" href={asset('catalog.json')} title="Tonk template catalog" /></head><body>
    <a className="skip-link" href="#main">Skip to content</a>
    <div className="site-shell"><header className="site-header">
      <a className="wordmark" href={asset('')} aria-label="Honky Tonks home">honky <span>tonks</span><i aria-hidden="true">✳</i></a>
      <nav aria-label="Main navigation"><a href={asset('')}>Collection</a><a href={asset('agents/')}>For agents</a><a href={asset('contribute/')}>Contribute ↗</a></nav>
    </header><main id="main">{children}</main>
    <footer className="site-footer"><p>Little apps. Yours to make your own.</p><div><a href="https://tonk.xyz">About Tonk ↗</a><a href={asset('catalog.json')}>Catalog JSON</a><a href={asset('llms.txt')}>llms.txt</a></div></footer></div>
  </body></html>;
}
