import { templates, asset } from '../lib/catalog';
import Collection from './collection';

export default function Home() {
  const entries = [...templates].sort((a, b) => a.name.localeCompare(b.name)).map(t => ({
    slug: t.slug, name: t.name, summary: t.summary, author: t.author.name,
    href: asset(`templates/${t.slug}/`),
    image: asset(`content/${t.slug}/${t.images[0].file}`), alt: t.images[0].alt,
  }));
  return <div className="collection-page">
    <h1 className="ascii-heading"><img src={asset('brand/honkytonk.svg')} alt="Honky Tonk" width="1019" height="88" /></h1>
    <Collection entries={entries} />
  </div>;
}
