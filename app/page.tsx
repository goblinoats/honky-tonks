import { templates, asset } from '../lib/catalog';
export default function Home() {
  return <>
    <section className="intro">
      <h1>Honky Tonks</h1>
      <p>Small software to take home. Browse the collection, read the YAML,<br className="desktop-break" /> and bring an application into your Tonk space.</p>
    </section>
    <section aria-labelledby="collection-title">
      <div className="section-heading"><h2 id="collection-title">The collection</h2><span>{templates.length} starter templates</span></div>
      <div className="gallery">{templates.map(t => <article className="template-card" key={t.slug}>
        <a className="card-link" href={asset(`templates/${t.slug}/`)}>
          <div className="preview"><img src={asset(`content/${t.slug}/${t.images[0].file}`)} alt={t.images[0].alt} width="960" height="640" /></div>
          <div className="card-title"><h3>{t.name}</h3></div>
          <p>{t.summary}</p>
          <div className="card-meta"><span>{t.category}</span><span>{t.author.name}</span></div>
        </a>
      </article>)}</div>
    </section>
    <aside className="contribute-strip"><div><h2>Add to the collection</h2><p>Share an application with a pull request.</p></div><a className="button" href={asset('contribute/')}>Contribute a Tonk</a></aside>
  </>;
}
