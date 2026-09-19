import { z } from 'zod';
import { designSchema, presetSchema, revisionSchema, tokensSchema } from "../../../core/src/contracts.js";
import { Files } from "../../../core/src/files.js";
import { presets } from "../../../templates/src/catalog.js";
export const designUpdateSchema = z.object({
  expectedRevision: revisionSchema, preset: presetSchema.optional(), mode: z.enum(['light', 'dark']).optional(),
  tokens: tokensSchema.partial().optional(),
}).strict();
export class Designs {
  constructor(readonly files: Files) {}
  async read(id: string) {
    const file = await this.files.read(id, 'src/theme/design.json');
    return { ...designSchema.parse(JSON.parse(file.content)), revision: file.revision };
  }
  async apply(id: string, input: z.infer<typeof designUpdateSchema>) {
    const update = designUpdateSchema.parse(input);
    return this.files.projects.mutations.run(async () => {
      const previous = await this.read(id);
      const preset = update.preset ?? previous.preset, mode = update.mode ?? previous.mode;
      const base = update.preset || update.mode ? presets[preset][mode] : previous.tokens;
      const design = designSchema.parse({ preset, mode, tokens: { ...base, ...update.tokens } });
      await this.files.writeUnlocked(id, [{ path: 'src/theme/design.json', expectedRevision: update.expectedRevision, content: JSON.stringify(design, null, 2) + '\n' }]);
      return this.read(id);
    });
  }
}
