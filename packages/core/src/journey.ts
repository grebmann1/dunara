import { BuilderError } from './contracts.js';
import { revision } from './files.js';
import { journeyPreferencesSchema, journeyUpdateSchema } from './journey-contracts.js';
import type { Projects } from './projects.js';

export class ProjectJourney {
  constructor(private projects: Projects, private sourceRevision: (id: string) => Promise<string>) {}
  async read(id: string) {
    const metadata = await this.projects.metadata(await this.projects.get(id));
    const preferences = journeyPreferencesSchema.parse('journey' in metadata ? metadata.journey ?? {} : {});
    return { preferences, revision: revision(JSON.stringify(preferences)), saved: 'journey' in metadata && !!metadata.journey };
  }
  async update(id: string, input: unknown) {
    const value = journeyUpdateSchema.parse(input);
    return this.projects.mutations.run(async () => {
      const current = await this.read(id);
      if (current.revision !== value.expectedRevision) throw new BuilderError('REVISION_CONFLICT', 'Journey progress changed in another window. Review the latest progress and save again.');
      const { tested, ...patch } = value.patch;
      const preferences = { ...current.preferences, ...patch };
      if (tested === true) {
        const source = await this.sourceRevision(id);
        if (source !== value.sourceRevision) throw new BuilderError('REVISION_CONFLICT', 'Your app changed. Check the current preview before marking it tested.');
        preferences.testedSourceRevision = source;
      } else if (tested === false) preferences.testedSourceRevision = null;
      const project = await this.projects.get(id), metadata = await this.projects.metadata(project);
      await this.projects.writeMetadata(project, metadata.studio, undefined, preferences);
      return this.read(id);
    });
  }
}
export type JourneyState = Awaited<ReturnType<ProjectJourney['read']>>;
