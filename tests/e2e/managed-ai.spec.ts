import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';
import { AssistantService } from '../../packages/assistant/src/service.js';
import type { HarnessInput } from '../../packages/assistant/src/contracts.js';
import { ASTRA_MODEL, IMAGE_MODEL } from '../../packages/core/src/media-job-contracts.js';
import { closeMediaDrawer } from './media-workspace-helpers.js';

test.use({ trace: 'off', actionTimeout: 15_000 });
test('starts with included credits and preserves explicit personal funding at every viewport', async ({ page }, info) => {
  test.setTimeout(60_000);
  const root = await mkdtemp(path.join(os.tmpdir(),'studio-managed-ai-')), home = path.join(root,'home');
  const balance = { remaining: 87.42,reserved: 2.58,limit:100,resetsAt:'2026-09-23T00:00:00Z' };
  const managed = { label:'Dunara credits',apiKey:'scoped-token-sentinel',baseUrl:'http://127.0.0.1:45678/v1',models:[{id:'gpt-6-astra',label:'GPT-6 Astra'}],balance:()=>balance };
  const calls: HarnessInput[] = [];
  const engine = new Engine(await Projects.open(path.join(root,'apps'),home),false,false,undefined,{}, {},undefined,{}, {hosted:true,managedImages:{ ...managed, models: [{ id: IMAGE_MODEL, label: 'GPT Image' }] }});
  await engine.projects.create({name:'Credit review',slug:'credit-review'});
  const assistant = new AssistantService({home,managedAi:managed,chatgptLogin:'device_code',createHarness:()=>({async run(input,callbacks){calls.push(input);callbacks.text('Included AI is ready.');},async close(){}}),createGateway:async()=>({tools:[],async call(){return {content:[]};},async close(){}})});
  const studio = await startStudio(engine,path.resolve('dist/studio'),assistant);
  try {
    expect(assistant.status()).toMatchObject({configured:true,providerId:'managed'});
    const responses: string[] = [];
    page.on('response',response=>{if(response.url().includes('/api/'))void response.text().then(text=>responses.push(text)).catch(()=>{});});
    await page.goto(studio.launchUrl); await page.getByRole('button',{name:'Settings',exact:true}).click();
    const settings = page.getByRole('region',{name:'Assistant configuration'}), images = page.getByRole('region',{name:'OpenAI configuration'});
    await expect(settings.getByText('87.42 / 100 credits left')).toBeVisible();
    await expect(settings.getByRole('group', { name: 'Active AI connection' })).toContainText('Dunara credits');
    for (const [width,height] of [[1440,1000],[375,812],[430,932]] as const) {
      await page.setViewportSize({width,height}); await settings.scrollIntoViewIfNeeded();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({path:info.outputPath(`managed-settings-${width}.png`),animations:'disabled'});
      await images.scrollIntoViewIfNeeded(); await page.screenshot({path:info.outputPath(`managed-images-${width}.png`),animations:'disabled'});
    }
    await images.getByText('Use another image connection', { exact: true }).click();
    await images.getByLabel('OpenAI API key',{exact:true}).fill('personal-image-key-sentinel');
    await images.getByRole('button',{name:'Save for this Dunara session'}).click();
    await expect(images.getByRole('button',{name:'Use personal image key'})).toBeEnabled();
    expect(engine.mediaJobs.providerStatus().source).toBe('managed');
    await images.getByRole('button',{name:'Use personal image key'}).click();
    await expect.poll(()=>engine.mediaJobs.providerStatus().source).toBe('session');
    expect(assistant.status().providerId).toBe('managed');
    await page.getByRole('button',{name:'Assistant',exact:true}).click();
    const chat = page.getByRole('dialog',{name:/Assistant/});
    await chat.getByRole('textbox',{name:'Message assistant'}).fill('Explain this app'); await chat.getByRole('button',{name:'Send message'}).click();
    await expect(chat.getByText('Included AI is ready.',{exact:true})).toBeVisible();
    expect(calls[0]).toMatchObject({provider:'managed',apiKey:managed.apiKey});
    for (const [width,height] of [[1440,1000],[375,812],[430,932]] as const) {
      await page.setViewportSize({width,height}); await expect(chat.getByText('87.42 / 100 credits left')).toBeVisible();
      await page.screenshot({path:info.outputPath(`managed-chat-${width}.png`),animations:'disabled'});
    }
    expect(responses.join('')).not.toMatch(/scoped-token-sentinel|personal-image-key-sentinel|45678/);
  } finally { await assistant.close(); await studio.close(); await engine.close(); await rm(root,{recursive:true,force:true}); }
});

test('uses allowed image models and preserves blocked Astra drafts and requests after a funding switch', async ({ page }, info) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-image-policy-'));
  let personalCalls = 0;
  const engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false, false, undefined,
    { createProvider: () => ({ async run() { personalCalls++; return []; } }) }, {}, undefined, {},
    { hosted: true, managedImages: { label: 'Dunara credits', apiKey: 'fixture-token', baseUrl: 'http://127.0.0.1:45678/v1', models: [{ id: IMAGE_MODEL, label: 'GPT Image' }], estimate: () => 5 } });
  const project = await engine.projects.create({ name: 'Image policy', slug: 'image-policy' });
  const studio = await startStudio(engine, path.resolve('dist/studio'));
  const form = page.getByRole('form', { name: 'Image generation', exact: true });
  const images = page.getByRole('region', { name: 'OpenAI configuration' });
  const openGenerator = async () => {
    await closeMediaDrawer(page); await page.getByRole('button', { name: 'Assets', exact: true }).click();
    await closeMediaDrawer(page); await page.getByRole('button', { name: 'Generate', exact: true }).click();
  };
  const screenshots = async (state: string, target = form) => {
    for (const [width, height] of [[1440, 1000], [375, 812], [430, 932]] as const) {
      await page.setViewportSize({ width, height }); await target.scrollIntoViewIfNeeded();
      await target.locator('p:visible').first().scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`${state}-${width}.png`), animations: 'disabled' });
      const action = target.getByRole('button', { name: /^(Stage request for review|Approve paid request)$/ });
      await action.scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`${state}-controls-${width}.png`), animations: 'disabled' });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  };
  try {
    await page.goto(studio.launchUrl);
    await closeMediaDrawer(page); await page.getByRole('button', { name: 'App Icons', exact: true }).click();
    await page.getByRole('button', { name: 'Generate an icon', exact: true }).click();
    const iconForm = page.getByRole('form', { name: 'Icon generation', exact: true });
    await expect(iconForm.getByText('Included credits use GPT Image direct.', { exact: false })).toBeVisible();
    await screenshots('included-icon', iconForm);
    await openGenerator();
    await expect(form.getByText('Included credits use GPT Image direct.', { exact: false })).toBeVisible();
    await form.getByText('References & advanced settings', { exact: true }).click();
    const model = form.getByRole('combobox', { name: 'Generation model' });
    await expect(model).toContainText('GPT Image direct'); await model.click();
    await expect(page.getByRole('option')).toHaveCount(1);
    await page.getByRole('option', { name: 'GPT Image direct', exact: true }).click();
    await screenshots('included-direct');
    await form.getByLabel('Image prompt', { exact: true }).fill('A fixture illustration');
    await form.getByRole('button', { name: 'Stage request for review' }).click();
    await expect.poll(async () => (await engine.mediaJobs.list(project.id)).jobs.length).toBe(1);
    expect((await engine.mediaJobs.list(project.id)).jobs[0]!.model).toBe(IMAGE_MODEL);
    await closeMediaDrawer(page); await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await images.getByText('Use another image connection', { exact: true }).click();
    await images.getByLabel('OpenAI API key', { exact: true }).fill('fixture-personal-key');
    await images.getByRole('button', { name: 'Save for this Dunara session' }).click();
    await expect(images.getByRole('button', { name: 'Use personal image key' })).toBeEnabled();
    expect(engine.mediaJobs.providerStatus().source).toBe('managed');
    await images.getByRole('button', { name: 'Use personal image key' }).click();
    await expect.poll(() => engine.mediaJobs.providerStatus().source).toBe('session');
    await openGenerator(); await form.getByText('References & advanced settings', { exact: true }).click();
    await model.click(); await expect(page.getByRole('option')).toHaveCount(2);
    await page.getByRole('option', { name: 'Astra + GPT Image', exact: true }).click();
    await form.getByLabel('Request label', { exact: true }).fill('Personal Astra');
    await form.getByLabel('Image prompt', { exact: true }).fill('Keep my personal Astra idea');
    await screenshots('personal-astra');
    await form.getByRole('button', { name: 'Stage request for review' }).click();
    await expect.poll(async () => (await engine.mediaJobs.list(project.id)).jobs.length).toBe(2);
    expect((await engine.mediaJobs.list(project.id)).jobs[1]!.model).toBe(ASTRA_MODEL);
    await closeMediaDrawer(page); await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await images.getByRole('button', { name: 'Use Dunara credits', exact: true }).click();
    await expect.poll(() => engine.mediaJobs.providerStatus().source).toBe('managed');
    await openGenerator();
    await expect(form.getByRole('alert')).toContainText('Your draft has not been changed');
    await expect(form.getByLabel('Image prompt', { exact: true })).toHaveValue('Keep my personal Astra idea');
    await expect(form.getByRole('button', { name: 'Stage request for review' })).toBeDisabled();
    await screenshots('blocked-draft');
    await closeMediaDrawer(page); await page.getByRole('button', { name: 'Activity', exact: true }).click();
    await page.getByRole('button', { name: 'Requests · 2', exact: true }).click();
    await page.getByRole('button', { name: 'Open request Personal Astra', exact: true }).click();
    const job = page.getByRole('article', { name: 'Personal Astra request', exact: true });
    await expect(job.getByRole('alert')).toContainText('No provider call has been made');
    await expect(job.getByRole('heading', { level: 3 })).toContainText('Choose image connection');
    await expect(job.getByRole('button', { name: 'Approve paid request' })).toBeDisabled();
    await screenshots('blocked-request', job);
    expect(personalCalls).toBe(0);
    expect((await engine.mediaJobs.list(project.id)).jobs.every(job => job.state === 'awaiting-approval')).toBe(true);
  } finally { await studio.close(); await engine.close(); await rm(root, { recursive: true, force: true }); }
});
