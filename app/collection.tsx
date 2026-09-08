'use client';

import { useState } from 'react';
import { Input } from '../components/ui/input';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '../components/ui/table';

type Entry = { slug: string; name: string; summary: string; author: string; href: string; image: string; alt: string };

export default function Collection({ entries }: { entries: Entry[] }) {
  const [query, setQuery] = useState('');
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = entries.filter(t => words.every(word => `${t.name} ${t.summary} ${t.author}`.toLocaleLowerCase().includes(word)));

  return <>
    <form role="search" className="template-search" onSubmit={e => e.preventDefault()}>
      <Input type="search" aria-label="Find a template" placeholder="find a template..." value={query} onChange={e => setQuery(e.target.value)} />
    </form>
    <p className="sr-only" role="status">{matches.length} {matches.length === 1 ? 'template' : 'templates'} found</p>
    <Table className="collection-table">
      <caption className="sr-only">Tonk application templates</caption>
      <colgroup><col className="preview-col" /><col className="name-col" /><col className="description-col" /><col className="author-col" /></colgroup>
      <TableHeader><TableRow><TableHead scope="col">preview</TableHead><TableHead scope="col">name</TableHead><TableHead scope="col">description</TableHead><TableHead scope="col">author</TableHead></TableRow></TableHeader>
      <TableBody>
        <TableRow className="collection-band" aria-hidden="true"><TableCell colSpan={4} /></TableRow>
        {matches.map(t => <TableRow className="template-row" key={t.slug}>
          <TableCell className="template-preview"><a href={t.href} aria-label={`View ${t.name}`}><img src={t.image} alt={t.alt} width="960" height="640" /></a></TableCell>
          <TableCell className="template-name"><a href={t.href}>{t.name}</a></TableCell>
          <TableCell className="template-description"><a href={t.href}>{t.summary}</a></TableCell>
          <TableCell className="template-author">{t.author}</TableCell>
        </TableRow>)}
        {!matches.length && <TableRow className="empty-result"><TableCell colSpan={4}>No templates match “{query}”. <button type="button" onClick={() => setQuery('')}>Clear search</button></TableCell></TableRow>}
        <TableRow className="collection-space" aria-hidden="true"><TableCell /><TableCell /><TableCell /><TableCell /></TableRow>
      </TableBody>
    </Table>
  </>;
}
