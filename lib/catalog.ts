import catalog from '../generated/catalog.json';
export const templates = catalog.templates;
export const site = catalog.site;
export const asset = (path: string) => `${catalog.basePath}/${path}`;
