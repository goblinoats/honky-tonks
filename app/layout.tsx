import type { Metadata } from 'next';
import { asset } from '../lib/catalog';
import './globals.css';
export const metadata: Metadata = {
  title: { default: 'Honky Tonks — Small software, shared', template: '%s · Honky Tonks' },
  description: 'Browse open Tonk templates. Discover small apps, read their source, and bring their YAML into your own Tonk space.',
  icons: { icon: asset('brand/smiley.png') },
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><head>
    <link rel="alternate" type="application/json" href={asset('catalog.json')} title="Tonk template catalog" />
  </head><body>
    <a className="skip-link" href="#main">Skip to content</a>
    <aside className="contribution-banner" aria-label="Contribute a template">
      <div className="contribution-track">{Array.from({ length: 6 }, (_, i) => <span key={i} aria-hidden={i > 0 ? true : undefined}>
        If you would like to make a contribution please <a href={asset('contribute/')} tabIndex={i > 0 ? -1 : undefined}>click here.</a>{' '}
        <img src={asset('brand/smiley.png')} alt="" width="15" height="15" />{' '}
      </span>)}</div>
    </aside>
    <main id="main">{children}</main>
  </body></html>;
}
