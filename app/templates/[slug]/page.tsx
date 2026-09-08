import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { templates, asset, site } from '../../../lib/catalog';
import styles from './article.module.css';

type Props = { params: Promise<{ slug: string }> };
export const dynamicParams = false;
export function generateStaticParams() { return templates.map(t => ({ slug: t.slug })); }
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const t = templates.find(t => t.slug === slug);
  return t ? { title: t.name, description: t.summary } : { title: 'Template not found' };
}

function ArticleHeading({ text, as: Heading = 'h2' }: { text: string; as?: 'h1' | 'h2' }) {
  return <Heading>{text}</Heading>;
}

export default async function Template({ params }: Props) {
  const { slug } = await params;
  const t = templates.find(t => t.slug === slug);
  if (!t) notFound();
  const sourceUrl = `${site.repository}/tree/${site.branch}/templates/${t.slug}`;
  const required = t.files.filter(f => !f.optional);
  const installFile = required.length === 1 ? required[0].file : 'combined.yaml';
  const [featured, ...moreImages] = t.images;
  const figure = (img: typeof featured) => <figure className={styles.figure} key={img.file}>
    <a href={asset(`content/${t.slug}/${img.file}`)}><img src={asset(`content/${t.slug}/${img.file}`)} alt={img.alt} width="960" height="640" /></a>
    <figcaption>{img.caption}</figcaption>
  </figure>;

  return <article className={styles.article}>
    <header>
      <ArticleHeading as="h1" text={t.name} />
      <div className={styles.meta}>
        <span><em>made by</em>{' '}{t.author.url ? <a href={t.author.url}>{t.author.name}</a> : t.author.name}</span>
        <span>· {t.category} · Version {t.version}</span>
      </div>
      <p className={styles.summary}>{t.summary}</p>
    </header>
    <div className={styles.cta}><a className="button" href="#source">Get the YAML</a></div>
    {figure(featured)}

    <div className={styles.body}>
      <div className={styles.column}>{t.description.trim().split('\n').map((p, i) => <p key={i}>{p}</p>)}</div>
      {moreImages.map(figure)}

      <section className={styles.section} id="details">
        <ArticleHeading text="Details" />
        <div className={styles.column}>
          <h3 className={styles.minorHeading}>Features</h3>
          <ul>{t.features.map(f => <li key={f}>{f}</li>)}</ul>
          <p>{t.notes}</p>
          <p><strong>Compatibility.</strong> {t.compatibility}</p>
          <p><strong>License.</strong> {t.license}</p>
          <p>{t.author.contact ? <a href={t.author.contact}>Contact the author</a> : <a href={`${site.repository}/issues`}>Contact project maintainers</a>}</p>
          <h3 className={styles.minorHeading} id="source">Source files</h3>
          <p>Read the source or download the files below. They are listed in evaluation order; example data is optional.</p>
          <ol className={styles.files}>{t.files.map(f => <li key={f.file}>
            <a href={asset(`content/${t.slug}/${f.file}.txt`)}><code>{f.file}</code></a>
            <p>{f.description}{f.optional ? ' (optional)' : ''}</p>
            <a href={asset(`content/${t.slug}/${f.file}`)} download>Download {f.file}</a>
          </li>)}</ol>
          <p><a href={sourceUrl}>View on GitHub</a>{' · '}<a href={asset(`content/${t.slug}/template.yaml`)}>Template manifest</a>{' · '}<a href={asset('catalog.json')}>Metadata & checksums</a></p>
          <h3 className={styles.minorHeading}>Installation</h3>
          <p>Download the required files above. Replace <code>YOUR_SPACE</code> with your space name, then preview before installing. {required.length > 1 ? 'Combine the required files in the listed order into combined.yaml first.' : ''}</p>
          <pre><code>{`tonk --space YOUR_SPACE eval ${installFile} --dry-run\ntonk --space YOUR_SPACE eval ${installFile}`}</code></pre>
          <p>Open the <code>{t.entrypoint}</code> concept in Tonk. To use it as your space’s home, add <code>--home {t.entrypoint}</code> when installing. Optional example files go afterwards.</p>
          <details><summary>Read the required YAML here</summary>{required.map(f => <div key={f.file}><h4 className={styles.minorHeading}>{f.file}</h4><pre><code>{f.source}</code></pre></div>)}</details>
          <p><a href={asset('')}>Back to the collection</a></p>
        </div>
      </section>
    </div>
  </article>;
}
