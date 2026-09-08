import type { Metadata } from 'next';
import { asset, site } from '../lib/catalog';
import './globals.css';
export const metadata: Metadata = {
  title: { default: 'Honky Tonks — Small software, shared', template: '%s · Honky Tonks' },
  description: 'Browse open Tonk templates. Discover small apps, read their source, and bring their YAML into your own Tonk space.',
  icons: { icon: asset('favicon.png') },
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><head>
    <link rel="alternate" type="application/json" href={asset('catalog.json')} title="Tonk template catalog" />
    <link rel="preload" href={asset('fonts/gestalte-regular.otf')} as="font" type="font/otf" crossOrigin="anonymous" />
    <link rel="preload" href={asset('fonts/charter_regular.woff2')} as="font" type="font/woff2" crossOrigin="anonymous" />
    <style>{`@font-face{font-family:Gestalte;src:url('${asset('fonts/gestalte-regular.otf')}') format('opentype');font-weight:400;font-style:normal;font-display:swap}@font-face{font-family:Gestalte;src:url('${asset('fonts/gestalte-medium.otf')}') format('opentype');font-weight:500;font-style:normal;font-display:swap}@font-face{font-family:Charter;src:url('${asset('fonts/charter_regular.woff2')}') format('woff2');font-weight:400;font-style:normal;font-display:swap}`}</style>
  </head><body>
    <a className="skip-link" href="#main">Skip to content</a>
    <div className="site-shell"><header className="site-header">
      <a className="wordmark" href={asset('')} aria-label="Honky Tonks home"><img src={asset('brand/tonk.svg')} alt="Tonk" width="150" height="40" /></a>
      <nav aria-label="Main navigation"><a href={asset('')}>Collection</a><a href={asset('agents/')}>For agents</a><a href={asset('contribute/')}>Contribute</a></nav>
    </header><main id="main">{children}</main>
    <footer className="site-footer"><div><a href="https://tonk.xyz">Tonk</a><a href={site.repository}>GitHub</a><a href={asset('catalog.json')}>Catalog JSON</a><a href={asset('llms.txt')}>llms.txt</a></div><p>Honky Tonks — a collection of small software.</p></footer></div>
  </body></html>;
}
