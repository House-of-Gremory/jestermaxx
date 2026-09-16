import type { MetadataRoute } from 'next';
import { getSiteUrl } from '@/lib/site-config';

const PUBLIC_ROUTES = ['/', '/auth', '/intro', '/arena'];

export default function sitemap(): MetadataRoute.Sitemap {
  const siteUrl = getSiteUrl();
  const lastModified = new Date();

  return PUBLIC_ROUTES.map((route) => ({
    url: new URL(route, siteUrl).toString(),
    lastModified,
    changeFrequency: route === '/' ? 'weekly' : 'monthly',
    priority: route === '/' ? 1 : 0.7,
  }));
}
