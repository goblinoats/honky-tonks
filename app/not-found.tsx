import { asset } from '../lib/catalog';
export default function NotFound() { return <article className="prose"><h1>This Tonk isn’t here.</h1><p>It may have moved, or the link may be incomplete.</p><a href={asset('')}>Back to the collection</a></article>; }

