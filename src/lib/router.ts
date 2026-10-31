import { useEffect, useState } from 'react';

export type Route =
  | { page: 'overview' }
  | { page: 'live' }
  | { page: 'projects' }
  | { page: 'project'; key: string }
  | { page: 'sessions' }
  | { page: 'models' }
  | { page: 'sources' };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/^\/+/, '');
  const [head, ...rest] = path.split('/');
  switch (head) {
    case 'live':
      return { page: 'live' };
    case 'projects':
      return rest.length && rest[0] ? { page: 'project', key: decodeURIComponent(rest.join('/')) } : { page: 'projects' };
    case 'sessions':
      return { page: 'sessions' };
    case 'models':
      return { page: 'models' };
    case 'sources':
      return { page: 'sources' };
    default:
      return { page: 'overview' };
  }
}

export function href(route: Route): string {
  switch (route.page) {
    case 'overview':
      return '#/';
    case 'project':
      return `#/projects/${encodeURIComponent(route.key)}`;
    default:
      return `#/${route.page}`;
  }
}

export function navigate(route: Route) {
  window.location.hash = href(route).slice(1);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onHash = () => {
      setRoute(parseHash(window.location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}
