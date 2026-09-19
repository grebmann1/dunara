import { randomUUID } from 'node:crypto';
import { chromium, type Browser } from 'playwright';
import { BuilderError, routeSchema, viewportSchema } from "../../../core/src/contracts.js";
import type { PreviewDriver } from "../../../core/src/preview-driver.js";
export const viewports = { compact: { width: 375, height: 812 }, large: { width: 430, height: 932 } } as const;
export type Artifact = { id: string; projectId: string; route: string; viewport: string; width: number; height: number; createdAt: string; rendering: 'React Native Web'; bytes: number; environment?: string; configurationRevision?: string };
export class Captures {
  private artifacts: { meta: Artifact; png: Buffer }[] = [];
  private browsers = new Set<Browser>();
  private active = 0;
  private closed = false;
  constructor(readonly previews: PreviewDriver, private readonly remoteCapture?: (id: string, route: string, viewport: {width: number; height: number}, signal?: AbortSignal) => Promise<Buffer>) {}
  private prune() { this.artifacts = this.artifacts.filter(a => Date.now() - Date.parse(a.meta.createdAt) < 3_600_000).slice(-20); }
  list(id: string) { this.prune(); return this.artifacts.filter(a => a.meta.projectId === id).map(a => a.meta); }
  get(projectId: string, artifactId: string) {
    this.prune();
    const artifact = this.artifacts.find(a => a.meta.projectId === projectId && a.meta.id === artifactId);
    if (!artifact) throw new BuilderError('INVALID_INPUT', 'Capture not found or expired');
    return artifact;
  }
  async capture(projectId: string, inputRoute: string, inputViewport: string, signal?: AbortSignal) {
    const route = routeSchema.parse(inputRoute), viewport = viewportSchema.parse(inputViewport);
    await this.previews.projects.get(projectId);
    const session = this.previews.status(projectId);
    if (session.status !== 'ready' || !session.url) throw new BuilderError('PREVIEW_NOT_READY', 'Start a managed preview before capturing');
    if (this.closed || this.active >= 2) throw new BuilderError('LIMIT_EXCEEDED', 'Capture capacity reached');
    signal?.throwIfAborted(); this.active++;
    let browser: Browser | undefined;
    const controller = new AbortController();
    const abort = () => { controller.abort(); void browser?.close(); };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 40_000);
    try {
      if (this.remoteCapture) {
        const png = await this.remoteCapture(projectId, route, viewports[viewport], controller.signal);
        controller.signal.throwIfAborted();
        if (this.closed || png.length > 2_000_000) throw new BuilderError('LIMIT_EXCEEDED', 'Capture unavailable or exceeds 2 MB');
        const meta: Artifact = { id: randomUUID(), projectId, route, viewport, ...viewports[viewport], createdAt: new Date().toISOString(), rendering: 'React Native Web', bytes: png.length, configurationRevision: session.configurationRevision, ...(session.environment ? {environment:session.environment} : {}) };
        this.artifacts.push({meta,png}); this.prune(); return {meta,png};
      }
      browser = await chromium.launch({ headless: true, timeout: 15_000 });
      this.browsers.add(browser);
      if (this.closed) throw new BuilderError('PROCESS_FAILED', 'Runtime is shutting down');
      signal?.throwIfAborted(); controller.signal.throwIfAborted();
      const origin = new URL(session.url).origin;
      const backendOrigin = session.backendUrl ? new URL(session.backendUrl).origin : null;
      const context = await browser.newContext({ viewport: viewports[viewport], deviceScaleFactor: 1, reducedMotion: 'reduce', serviceWorkers: 'block', acceptDownloads: false });
      // Fulfilled responses can trigger Chromium's local-network check for Metro sockets.
      await context.grantPermissions(['local-network-access'], { origin });
      await context.route('**/*', async request => {
        const url = new URL(request.request().url());
        if (url.origin !== origin && url.origin !== backendOrigin) return request.abort('blockedbyclient');
        try {
          const response = await request.fetch({ maxRedirects: 0, timeout: 30_000 });
          // Routing does not reliably intercept every redirect hop. Disallow redirects entirely.
          if (response.status() >= 300 && response.status() < 400 && response.status() !== 304) return await request.abort('blockedbyclient');
          await request.fulfill({ response });
        } catch { await request.abort().catch(() => {}); }
      });
      await context.routeWebSocket('**/*', socket => {
        const url = new URL(socket.url()); url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
        if (url.origin === origin || (url.origin === backendOrigin && url.pathname.startsWith('/realtime/'))) socket.connectToServer(); else socket.close();
      });
      const page = await context.newPage();
      page.on('pageerror', error => this.previews.diagnostics.add(projectId, 'browser', 'error', error.message));
      page.on('console', message => { if (message.type() === 'error') this.previews.diagnostics.add(projectId, 'browser', 'error', message.text()); });
      page.on('popup', popup => { void popup.close(); });
      const response = await page.goto(new URL(route, origin).href, { waitUntil: 'networkidle', timeout: 30_000 });
      if (!response?.ok() || new URL(page.url()).origin !== origin) throw new BuilderError('INVALID_PATH', 'Capture navigation failed or left the managed preview');
      await page.evaluate(() => document.fonts.ready);
      await page.locator('body').waitFor({ state: 'visible' });
      const png = await page.screenshot({ type: 'png', animations: 'disabled', fullPage: false, timeout: 5000 });
      controller.signal.throwIfAborted();
      if (png.length > 2_000_000) throw new BuilderError('LIMIT_EXCEEDED', 'Capture exceeds 2 MB');
      const meta: Artifact = { id: randomUUID(), projectId, route, viewport, ...viewports[viewport], createdAt: new Date().toISOString(), rendering: 'React Native Web', bytes: png.length, configurationRevision: session.configurationRevision, ...(session.environment ? { environment: session.environment } : {}) };
      this.artifacts.push({ meta, png }); this.prune();
      return { meta, png };
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (browser) { await browser.close(); this.browsers.delete(browser); }
      this.active--;
    }
  }
  async close() { this.closed = true; await Promise.all([...this.browsers].map(browser => browser.close())); this.artifacts = []; }
}
