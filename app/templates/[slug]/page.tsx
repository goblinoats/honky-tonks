import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { templates, asset, site } from '../../../lib/catalog';
type Props = { params: Promise<{ slug: string }> };
export const dynamicParams = false;
export function generateStaticParams() { return templates.map(t => ({ slug: t.slug })); }
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const t = templates.find(t => t.slug === slug);
  return t ? { title: t.name, description: t.summary } : { title: 'Template not found' };
}
export default async function Template({ params }: Props) {
  const { slug } = await params;
  const t = templates.find(t => t.slug === slug);
  if (!t) notFound();
  const sourceUrl = `${site.repository}/tree/${site.branch}/templates/${t.slug}`;
  const required = t.files.filter(f => !f.optional);
  return <>
    <a className="back-link" href={asset('')}>← Back to the collection</a>
    <header className="detail-header"><div><p className="eyebrow">{t.category.toUpperCase()} / STARTER TEMPLATE</p><h1>{t.name}</h1><p>{t.summary}</p></div><a className="button" href="#source">Get the YAML ↓</a></header>
    <div className="detail-grid"><div className="detail-images">{t.images.map(img => <figure key={img.file}><a href={asset(`content/${t.slug}/${img.file}`)}><img src={asset(`content/${t.slug}/${img.file}`)} alt={img.alt} width="960" height="640" /></a><figcaption>{img.caption}</figcaption></figure>)}</div>
    <div className="detail-copy"><h2>A little about it</h2>{t.description.trim().split('\n').map((p, i) => <p key={i}>{p}</p>)}<h2>What it does</h2><ul>{t.features.map(f => <li key={f}>{f}</li>)}</ul>
      <dl><dt>Made by</dt><dd>{t.author.url ? <a href={t.author.url}>{t.author.name}</a> : t.author.name}</dd><dt>Contact</dt><dd>{t.author.contact ? <a href={t.author.contact}>Contact the author ↗</a> : <a href={`${site.repository}/issues`}>Contact project maintainers ↗</a>}</dd><dt>Version / license</dt><dd>{t.version} / {t.license}</dd><dt>Compatibility</dt><dd>{t.compatibility}</dd></dl>
    </div></div>
    <section className="source-section" id="source"><h2>Yours to make your own.</h2><p>Read the source, download it, and bring it into your Tonk space.</p>
      <ul className="source-list">{t.files.map((f, index) => <li key={f.file}><a href={asset(`content/${t.slug}/${f.file}.txt`)}><code>{String(index + 1).padStart(2,'0')} / {f.file}</code></a><span>{f.description}{f.optional ? ' · Optional' : ''}</span><a className="download" href={asset(`content/${t.slug}/${f.file}`)} download>Download ↓</a></li>)}</ul>
      <div className="inline-links"><a href={sourceUrl}>View on GitHub ↗</a><a href={asset(`content/${t.slug}/template.yaml`)}>Template manifest</a><a href={asset('catalog.json')}>Metadata & checksums</a></div>
      <div className="notice">{t.notes}</div>
      <h3>Bring it into your space</h3><p>Download the required files above. Replace <code>YOUR_SPACE</code> with your space name, then preview before installing. {required.length > 1 ? 'Combine the required files in the listed order into combined.yaml first.' : ''}</p>
      <pre><code>{`tonk --space YOUR_SPACE eval ${required.length === 1 ? required[0].file : 'combined.yaml'} --dry-run\ntonk --space YOUR_SPACE eval ${required.length === 1 ? required[0].file : 'combined.yaml'}`}</code></pre>
      <p>Open the <code>{t.entrypoint}</code> concept in Tonk. To use it as your space’s home, add <code>--home {t.entrypoint}</code> when installing. Optional example files go afterwards.</p>
      <details><summary>Read the required YAML here</summary>{required.map(f => <div key={f.file}><h3>{f.file}</h3><pre><code>{f.source}</code></pre></div>)}</details>
    </section>
  </>;
}

