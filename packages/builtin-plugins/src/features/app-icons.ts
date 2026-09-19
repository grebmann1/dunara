import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { Assets } from "../../../core/src/assets.js";
import { Files, revision } from "../../../core/src/files.js";
import { BuilderError } from "../../../core/src/contracts.js";
import { exists, noSymlinks } from "../../../core/src/storage.js";
import { MEDIA_PIXELS } from "../../../core/src/media-contracts.js";
import { iconApplySchema, iconPrepareSchema, iconPreviewSchema, type IconApplication, type IconDiff, type IconPreparation, type IconSelection } from "../../../core/src/icon-contracts.js";

function invalid(message: string): never { throw new BuilderError('INVALID_INPUT', message); }
const object = z.record(z.string(), z.unknown());
export class AppIcons {
  private closed = false;
  constructor(readonly assets: Assets, readonly files: Files) {}
  close() { this.closed = true; return this.assets.projects.mutations.run(async () => {}); }
  private active() { if (this.closed) invalid('Icon operation cancelled or Engine closed'); }
  async check(id: string, assetId: string) {
    const { asset, bytes } = await this.assets.read(id, assetId);
    const unavailable = (reason: string) => ({ available: false, reason });
    if (asset.status !== 'approved') return unavailable('Approve the image before preparing an icon.');
    if (asset.width !== asset.height) return unavailable('Adaptive foreground must be square; import a square transparent layer.');
    const { data, info } = await sharp(bytes, { limitInputPixels: MEDIA_PIXELS }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let visible = 0, outside = false, left = info.width, right = 0, top = info.height, bottom = 0;
    const center = info.width / 2, radius = info.width * 33 / 108;
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * info.channels + info.channels - 1] === 0) continue;
      visible++; left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      if (Math.hypot(x + 0.5 - center, y + 0.5 - center) > radius) outside = true;
    }
    if (!visible) return unavailable('Foreground is empty. Supply a visible original mark.');
    if (outside) return unavailable('Adaptive export unavailable: visible foreground must fit within the centered 66/108 safe-zone circle on transparency. A flattened photo is not a foreground layer.');
    if (Math.max(right - left + 1, bottom - top + 1) < info.width * 48 / 108) return unavailable('Foreground mark is too small: its longest dimension should span at least 48/108 of the canvas.');
    return { available: true, reason: 'Alpha pixels fit the conservative 66/108 safe-zone circle. Review the mark visually: this does not validate its artwork, shadows or native rendering.' };
  }
  async prepare(id: string, input: IconPreparation) {
    const value = iconPrepareSchema.parse(input); this.active();
    const { asset, bytes } = await this.assets.read(id, value.assetId);
    if (asset.status !== 'approved') invalid('Choose an approved image to prepare an icon');
    if (value.kind === 'adaptive') { const check = await this.check(id, asset.id); if (!check.available) invalid(check.reason); }
    const image = sharp(bytes, { limitInputPixels: MEDIA_PIXELS });
    const output = value.kind === 'master'
      ? await image.resize(1024, 1024, { fit: value.fit, background: value.background }).flatten({ background: value.background }).removeAlpha().png().toBuffer()
      : await image.resize(1024, 1024, { kernel: 'nearest' }).png().toBuffer();
    this.active();
    return this.assets.add(id, { expectedRevision: value.expectedRevision, label: `${asset.label.slice(0, 75)} · icon ${value.kind === 'master' ? 'master' : 'foreground'}`, role: 'app-icon', mediaType: 'image/png', rightsNote: asset.rightsNote }, [{ bytes: output, provenance: 'icon', parentId: asset.id }]);
  }
  private async config(id: string) {
    const { root } = await this.assets.projects.get(id);
    for (const name of ['app.config.json', 'app.config.ts', 'app.config.js', 'app.config.mts', 'app.config.cts', 'app.config.mjs', 'app.config.cjs']) {
      const file = path.join(root, name); await noSymlinks(root, file);
      if (await exists(file)) invalid('Automatic icon application supports app.json only. Ask Claude to review the overriding app.config file; Studio does not execute it.');
    }
    return this.files.read(id, 'app.json');
  }
  async preview(id: string, input: IconSelection): Promise<IconDiff> {
    const value = iconPreviewSchema.parse(input); this.active();
    const library = await this.assets.list(id);
    const { asset: master, bytes } = await this.assets.read(id, value.masterId);
    if (!library.revision || master.status !== 'approved' || master.width !== 1024 || master.height !== 1024 || !(await sharp(bytes).stats()).isOpaque) invalid('Select an approved opaque 1024 × 1024 PNG master');
    const file = await this.config(id);
    let document: Record<string, unknown>;
    try { document = object.parse(JSON.parse(file.content)); } catch { invalid('Repair app.json to a JSON object before applying an icon'); }
    const config = document.expo === undefined ? document : object.parse(document.expo);
    const warnings = ['Config only: Expo Go and web previews do not validate an installed native launcher icon. A native build and device review are still required.', 'Masks shown in Studio are approximate previews; exports have no baked rounded corners.'];
    config.icon = `./${master.path}`;
    for (const platform of ['ios', 'android']) {
      if (config[platform] !== undefined) {
        const settings = object.parse(config[platform]);
        if (settings.icon !== undefined) warnings.push(`${platform}.icon is preserved and overrides the standard icon. Ask Claude to review that explicit platform setting.`);
      }
    }
    if (value.foregroundId) {
      const { asset: foreground } = await this.assets.read(id, value.foregroundId);
      const check = await this.check(id, foreground.id);
      if (!check.available || foreground.width !== 1024) invalid(`Select an approved 1024 × 1024 adaptive foreground. ${check.reason}`);
      const android = config.android === undefined ? {} : object.parse(config.android);
      const adaptive = android.adaptiveIcon === undefined ? {} : object.parse(android.adaptiveIcon);
      if (adaptive.monochromeImage !== undefined) warnings.push('Existing Android monochrome icon is preserved; separately review its consistency with the new mark.');
      delete adaptive.backgroundImage;
      android.adaptiveIcon = { ...adaptive, foregroundImage: `./${foreground.path}`, backgroundColor: value.background };
      config.android = android;
    } else if (config.android !== undefined && object.parse(config.android).adaptiveIcon !== undefined) {
      warnings.push('Existing Android adaptive icon is preserved and can override the new standard icon.');
    }
    if (document.expo !== undefined) document.expo = config;
    const after = JSON.stringify(document, null, 2) + '\n';
    return { path: 'app.json', before: file.content, after, expectedConfigRevision: file.revision, expectedMediaRevision: library.revision, proposedRevision: revision(after), warnings };
  }
  async apply(id: string, input: IconApplication) {
    const value = iconApplySchema.parse(input);
    return this.assets.projects.mutations.run(async () => {
      const diff = await this.preview(id, { masterId: value.masterId, foregroundId: value.foregroundId, background: value.background });
      if (diff.expectedConfigRevision !== value.expectedConfigRevision || diff.expectedMediaRevision !== value.expectedMediaRevision || diff.proposedRevision !== value.proposedRevision) throw new BuilderError('REVISION_CONFLICT', 'Icon or config changed. Request and review a fresh diff before confirming.');
      this.active();
      const result = await this.files.writeUnlocked(id, [{ path: 'app.json', content: diff.after, expectedRevision: value.expectedConfigRevision }]);
      return { ...result, warnings: diff.warnings };
    });
  }
}
