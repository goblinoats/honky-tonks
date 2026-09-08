import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { templates, asset, site } from '../../../lib/catalog';
import ScreenshotGallery from '../../screenshot-gallery';

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
  const required = t.files.filter(f => !f.optional);
  const installFile = required.length === 1 ? required[0].file : 'combined.yaml';
  const sourceUrl = `${site.repository}/tree/${site.branch}/templates/${t.slug}`;
  const compatibilityVersion = t.compatibility.match(/^Tonk CLI (\d+\.\d+\.\d+) notation and standard library$/)?.[1];

  return <div className="detail-page">
    <nav className="detail-nav" aria-label="Template navigation">
      <a href={asset('')}>Back to collection</a>
      <div><a href={asset('catalog.json')}>Catalog JSON</a><a href={asset('llms.txt')}>llms.txt</a></div>
    </nav>
    <article className="detail-panel">
      <h1 className="detail-title">{t.name}</h1>
      <ScreenshotGallery name={t.name} images={t.images.slice(0, 5).map(img => ({ src: asset(`content/${t.slug}/${img.file}`), alt: img.alt, caption: img.caption }))} />
      <section className="description-section" aria-labelledby="description-title">
        <h2 id="description-title">Description</h2>
        <div className="description-copy">
          {t.description.trim().split('\n').map((p, i) => <p key={i}>{p}</p>)}
        </div>
        <div className="features"><h3>Features</h3><ul>{t.features.map(f => <li key={f}>{f}</li>)}</ul></div>
        <a className="download-button" href={asset(`content/${t.slug}/${t.slug}.zip`)} download>Download Files</a>
        <p className="contact-authors"><a href={t.author.contact || t.author.url || `${site.repository}/issues`}>Contact Authors</a></p>
      </section>
      <dl className="template-facts">
        <div className="fact-row"><dt>License</dt><dd><strong>{t.license === 'MIT' ? 'MIT License' : t.license}</strong></dd></div>
        <div className="fact-row"><dt>Compatibility</dt><dd><strong title={t.compatibility}>{compatibilityVersion || t.compatibility}</strong></dd></div>
        <div className="fact-row source-row" id="source">
          <dt>Source files</dt>
          <dd><details className="source-disclosure" open>
            <summary aria-label="Show or hide source files"><span aria-hidden="true" className="disclosure-chevron" /></summary>
            <ul className="source-files">{t.files.map(f => <li key={f.file}>
              <a href={asset(`content/${t.slug}/${f.file}.txt`)}>{f.file}</a>
              <span>{f.description}{f.optional ? ' (optional)' : ''}</span>
            </li>)}</ul>
            <div className="source-metadata"><a href={asset('catalog.json')}>Metadata &amp; checksums</a><a href={asset(`content/${t.slug}/template.yaml`)}>Template manifest</a></div>
          </details></dd>
        </div>
      </dl>
      <section className="installation-section" aria-labelledby="installation-title">
        <a className="github-link" href={sourceUrl}>View on Github</a>
        <h2 id="installation-title">Installation</h2>
        <div className="installation-copy">
          <p>Download the required files above. Replace <code>YOUR_SPACE</code> with your space name, then preview before installing. {required.length > 1 ? 'Combine the required files in the listed order into combined.yaml first.' : ''}</p>
          <pre><code>{`tonk --space YOUR_SPACE eval ${installFile} --dry-run\ntonk --space YOUR_SPACE eval ${installFile}`}</code></pre>
          <p>Open the <code>{t.entrypoint}</code> concept in Tonk. To use it as your space’s home, add <code>--home {t.entrypoint}</code> when installing. Optional example files go afterwards.</p>
          <details className="yaml-disclosure"><summary>Read the required YAML here</summary>{required.map(f => <div key={f.file}><h3>{f.file}</h3><pre><code>{f.source}</code></pre></div>)}</details>
        </div>
      </section>
    </article>
  </div>;
}
