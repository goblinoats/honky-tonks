import { asset } from '../lib/catalog';
export default function NotFound() { return <div className="utility-page"><article className="prose"><h1>Template not found</h1><p>It may have moved, or the link may be incomplete.</p><a href={asset('')}>Back to collection</a></article></div>; }
