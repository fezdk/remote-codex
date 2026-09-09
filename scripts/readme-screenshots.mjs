// Render the real UI with synthetic data only. Never connects to a Codex daemon,
// reads credentials, or inspects local projects or Git changes.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = new URL('../', import.meta.url);
const output = new URL('docs/screenshots/', root);
const now = 1800000000000;
const project = '/workspace/atlas-web';
const status = { state: 'connected', platform: 'linux', defaultCwd: '/workspace' };
const threads = [
  ['atlas', 'Polish the project dashboard', 'atlas-web', 0, 'active'],
  ['search', 'Add keyboard navigation', 'atlas-web', 24, 'idle'],
  ['docs', 'Write the getting started guide', 'docs-site', 110, 'idle'],
  ['api', 'Review the API error responses', 'trail-api', 220, 'idle'],
  ['tests', 'Add integration tests', 'trail-api', 1600, 'idle'],
  ['tokens', 'Refine the color palette', 'design-system', 2900, 'idle'],
].map(([id, name, folder, minutes, type]) => ({
  id, name, cwd: `/workspace/${folder}`, updatedAt: now / 1000 - minutes * 60,
  status: { type }, model: 'Codex', canAcceptDirectInput: true,
}));
const patch = [
  '@@ -8,7 +8,15 @@',
  ' export function ProjectCard({ project }) {',
  '   return (',
  '-    <div className="project-card">',
  '-      <h2>{project.name}</h2>',
  '+    <a',
  '+      className="project-card"',
  '+      href={`/projects/${project.id}`}',
  '+      aria-label={`Open ${project.name}`}',
  '+    >',
  '+      <span className="project-icon">',
  '+        <FolderIcon aria-hidden="true" />',
  '+      </span>',
  '+      <h2>{project.name}</h2>',
  '       <p>{project.description}</p>',
  '-    </div>',
  '+      <span className="updated-at">',
  '+        Updated {formatRelative(project.updatedAt)}',
  '+      </span>',
  '+    </a>',
  '   );',
  ' }',
].join('\n');
const files = [
  { path: 'src/components/ProjectCard.tsx', kind: 'update', added: 14, removed: 3, patches: [{ turnId: 'demo001', diff: patch }] },
  { path: 'src/styles/dashboard.css', kind: 'update', added: 28, removed: 8, patches: [{ turnId: 'demo001', diff: '@@ -1 +1,3 @@\n-.project-grid { display: block; }\n+.project-grid {\n+  display: grid;\n+}' }] },
  { path: 'tests/project-card.test.tsx', kind: 'add', added: 32, removed: 0, patches: [{ turnId: 'demo001', diff: '@@ -0,0 +1 @@\n+test("opens a project with the keyboard", async () => { /* ... */ });' }] },
];
const turns = [{ id: 'demo001', status: 'inProgress', startedAt: now / 1000 - 120, items: [
  { id: 'user-demo', type: 'userMessage', content: [{ type: 'text', text: 'Give the project dashboard a little polish: clearer cards, keyboard navigation, and a layout that works on mobile.' }] },
  { id: 'agent-demo', type: 'agentMessage', text: 'The dashboard now has **a responsive card grid**, clearer project details, and visible keyboard focus. Each card opens with Enter.\n\nI also added coverage for keyboard navigation and long project names.' },
  { id: 'files-demo', type: 'fileChange', status: 'completed', changes: files.map(file => ({ path: `${project}/${file.path}`, kind: { type: file.kind }, diff: file.patches[0].diff })) },
  { id: 'tests-demo', type: 'commandExecution', command: 'npm test', cwd: project, status: 'completed', exitCode: 0, aggregatedOutput: '24 tests passed.\nDuration: 1.8s' },
  { id: 'agent-next', type: 'agentMessage', text: 'All **24 tests pass**. I’m checking the mobile spacing and focus states next.' },
] }];
const queue = [{ id: 'demo-queued', input: [{ type: 'text', text: 'Then add an empty state for projects with no activity.' }] }];
const staticFiles = new Map([
  ['/', ['index.html', 'text/html']],
  ...['app.js', 'changes.js', 'state.js', 'queue.js', 'projects.js', 'preferences.js', 'i18n.js', 'locales.js'].map(name => [`/${name}`, [name, 'text/javascript']]),
  ['/style.css', ['style.css', 'text/css']], ['/icon.svg', ['icon.svg', 'image/svg+xml']],
]);
const problems = [];
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const json = data => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  try {
    if (path === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(`event: status\ndata: ${JSON.stringify(status)}\n\nevent: pending\ndata: []\n\nevent: resync\ndata: {}\n\n`);
      const heartbeat = setInterval(() => res.write('event: heartbeat\ndata: {}\n\n'), 15000);
      res.on('close', () => clearInterval(heartbeat));
      return;
    }
    if (path === '/api/status') return json(status);
    if (path === '/api/threads') return json({ data: threads, nextCursor: null });
    if (path === '/api/threads/atlas/open') return json({ thread: threads[0] });
    if (path === '/api/threads/atlas/turns') return json({ data: turns, nextCursor: null, bridgeSequence: 0 });
    if (path === '/api/threads/atlas/queue') return json({ data: queue, nextCursor: null });
    if (path === '/api/threads/atlas/changes') return json({ files, truncated: false });
    if (path === '/api/threads/atlas/git') return json({ files: files.map(({ path, kind }) => ({ path, kind })), truncated: false });
    if (path === '/api/threads/atlas/git-diff') return json({ sections: [{ title: 'Unstaged changes', diff: patch }] });
    const asset = staticFiles.get(path);
    if (!asset) { problems.push(`Unexpected demo request: ${path}`); res.writeHead(404); res.end(); return; }
    const body = await readFile(new URL(`public/${asset[0]}`, root));
    res.writeHead(200, { 'Content-Type': asset[1] }); res.end(body);
  } catch (error) { problems.push(error.message); res.writeHead(500); res.end(); }
});

let browser;
try {
  await mkdir(output, { recursive: true });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1050 }, deviceScaleFactor: 1, locale: 'en-US', reducedMotion: 'reduce' });
  // Abort every request outside the isolated demo, including accidental external assets.
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : (problems.push('Unexpected external request'), route.abort()));
  await context.addInitScript(({ now }) => {
    Date.now = () => now;
    localStorage.setItem('remote-codex.language', 'en');
    localStorage.setItem('remote-codex.theme', 'dark');
    localStorage.setItem('remote-codex.changes-width', '500');
  }, { now });
  const page = await context.newPage();
  page.on('pageerror', error => problems.push(error.message));
  await page.goto(`${origin}/#session=atlas`);
  await expect(page.locator('#connection-label')).toHaveText('Connected');
  await expect(page.locator('#messages')).toContainText('24 tests pass');
  await expect(page.locator('#queue-list')).toContainText('empty state');
  await page.locator('.changed-file').first().click();
  await expect(page.locator('#change-detail')).toContainText('formatRelative');
  await page.locator('#message').fill('Keep the focus ring visible in both themes.');
  const capture = async name => {
    await page.locator('#timeline').evaluate(el => { el.scrollTop = 0; });
    await page.locator('#message').evaluate(el => el.blur());
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('#notice')).toBeHidden();
    await page.screenshot({ path: fileURLToPath(new URL(name, output)), animations: 'disabled' });
    console.log(`Created docs/screenshots/${name}`);
  };
  await capture('desktop-dark.png');
  await page.locator('#workspace [data-theme-toggle]').click();
  await page.locator('#git-tab').click();
  await page.locator('.changed-file').first().click();
  await expect(page.locator('#change-detail')).toContainText('Unstaged changes');
  await capture('desktop-light.png');
  await page.locator('#workspace [data-theme-toggle]').click();
  await page.locator('#close-changes').click();
  await page.setViewportSize({ width: 430, height: 1000 });
  await capture('mobile-dark.png');
  expect(problems).toEqual([]);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
