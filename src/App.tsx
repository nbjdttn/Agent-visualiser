import { AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';
import { rangeLabel } from './lib/format';
import { useRoute, type Route } from './lib/router';
import { DataProvider, DrawerProvider, FilterProvider, useData, useFilters } from './lib/store';
import { AppShell } from './components/AppShell';
import { FilterBar } from './components/FilterBar';
import { SessionDrawer } from './components/SessionDrawer';
import { Card, EmptyState } from './components/ui';
import { LivePage } from './pages/Live';
import { ModelsPage } from './pages/Models';
import { OverviewPage } from './pages/Overview';
import { ProjectDetailPage } from './pages/ProjectDetail';
import { ProjectsPage } from './pages/Projects';
import { SessionsPage } from './pages/Sessions';
import { SourcesPage } from './pages/Sources';

const TITLES: Record<Route['page'], string> = {
  overview: 'Overview',
  live: 'Live',
  projects: 'Projects',
  project: 'Project',
  sessions: 'Sessions',
  models: 'Models',
  sources: 'Data sources',
};

function Loading() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="Loading">
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="card h-[230px] animate-pulse lg:col-span-5" />
        <div className="grid grid-cols-2 gap-4 lg:col-span-7 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="card h-[106px] animate-pulse" />
          ))}
        </div>
      </div>
      <div className="card h-[380px] animate-pulse" />
    </div>
  );
}

function Pages() {
  const route = useRoute();
  const { data, error } = useData();
  const { range } = useFilters();

  const withFilters = route.page !== 'live' && route.page !== 'sources';
  const subtitle =
    route.page === 'live'
      ? 'Agents working right now, plan windows and limits'
      : route.page === 'sources'
        ? 'Where the numbers come from'
        : rangeLabel(range.from, range.to);

  let body: ReactNode;
  if (error && !data) {
    body = (
      <Card>
        <EmptyState title="Can't reach the Agent Visualiser server" icon={<AlertTriangle size={22} />}>
          Start it with <code className="font-mono">npm run dev</code> (or <code className="font-mono">npm start</code> after a build)
          and reload. ({error})
        </EmptyState>
      </Card>
    );
  } else if (!data) {
    body = <Loading />;
  } else {
    switch (route.page) {
      case 'overview':
        body = <OverviewPage data={data} />;
        break;
      case 'live':
        body = <LivePage />;
        break;
      case 'projects':
        body = <ProjectsPage data={data} />;
        break;
      case 'project':
        body = <ProjectDetailPage data={data} projectKey={route.key} />;
        break;
      case 'sessions':
        body = <SessionsPage data={data} />;
        break;
      case 'models':
        body = <ModelsPage data={data} />;
        break;
      case 'sources':
        body = <SourcesPage data={data} />;
        break;
    }
  }

  const projectName =
    route.page === 'project' && data ? data.projects[data.projectByKey.get(route.key) ?? -1]?.name : undefined;

  return (
    <AppShell
      route={route}
      title={projectName ?? TITLES[route.page]}
      subtitle={subtitle}
      filters={withFilters ? <FilterBar hideProject={route.page === 'project'} /> : undefined}
    >
      <div key={route.page === 'project' ? `project:${route.key}` : route.page} className="fade-in">
        {body}
      </div>
    </AppShell>
  );
}

export default function App() {
  return (
    <DataProvider>
      <FilterProvider>
        <DrawerProvider>
          <Pages />
          <SessionDrawer />
        </DrawerProvider>
      </FilterProvider>
    </DataProvider>
  );
}
