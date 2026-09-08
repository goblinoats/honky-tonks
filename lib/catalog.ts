import catalog from '../generated/catalog.json';

export type TemplateFile = { file: string; description: string; optional?: boolean; sha256: string; bytes: number; source: string };
export type TemplateImage = { file: string; alt: string; caption: string };
export type TemplateAuthor = { name: string; url: string | null; contact: string | null };
export type Template = {
  schemaVersion: number;
  slug: string;
  name: string;
  summary: string;
  description: string;
  category: string;
  version: string;
  license: string;
  author: TemplateAuthor;
  features: string[];
  images: TemplateImage[];
  files: TemplateFile[];
  entrypoint: string;
  compatibility: string;
  notes: string;
};

// The catalog JSON is generated from the manifests, so its inferred shape
// changes with their contents (for example when no file is optional and no
// author field is null). The explicit type keeps the pages stable.
export const templates: Template[] = catalog.templates;
export const site = catalog.site;
export const asset = (path: string) => `${catalog.basePath}/${path}`;
