import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';
import { AssistantService } from '../../packages/assistant/src/service.js';
import type { HarnessInput } from '../../packages/assistant/src/contracts.js';

test.use({ trace: 'off' });
test('starts with included credits and preserves explicit personal funding at every viewport', async ({ page }, info) => {
  test.setTimeout(60_000);
  const root = await mkdtemp(path.join(os.tmpdir(),'studio-managed-ai-')), home = path.join(root,'home');
  const balance = { remaining: 87.42,reserved: 2.58,limit:100,resetsAt:'2026-09-23T00:00:00Z' };
  const managed = { label:'Dunara credits',apiKey:'scoped-token-sentinel',baseUrl:'http://127.0.0.1:45678/v1',models:[{id:'gpt-6-astra',label:'GPT-6 Astra'}],balance:()=>balance };
  const calls: HarnessInput[] = [];
  const engine = new Engine(await Projects.open(path.join(root,'apps'),home),false,false,undefined,{}, {},undefined,{}, {hosted:true,managedImages:managed});
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
    await expect(settings.getByLabel('Assistant provider')).toHaveValue('managed');
    for (const [width,height] of [[1440,1000],[375,812],[430,932]] as const) {
      await page.setViewportSize({width,height}); await settings.scrollIntoViewIfNeeded();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({path:info.outputPath(`managed-settings-${width}.png`),animations:'disabled'});
      await images.scrollIntoViewIfNeeded(); await page.screenshot({path:info.outputPath(`managed-images-${width}.png`),animations:'disabled'});
    }
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
