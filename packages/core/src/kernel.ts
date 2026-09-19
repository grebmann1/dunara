import { Projects } from './projects.js';
import { Files } from './files.js';
import { Diagnostics } from './diagnostics.js';
import { StudioControl } from './studio-control.js';
import { SourceChanges } from './source-changes.js';
/** The application kernel owns project identity and mutation authority, not feature construction. */
export class BuilderKernel {
  readonly files: Files;
  readonly diagnostics = new Diagnostics();
  readonly studio: StudioControl;
  readonly sourceChanges: SourceChanges;
  constructor(readonly projects: Projects) {
    this.files = new Files(projects);
    this.sourceChanges = new SourceChanges(this.files); this.files.journal = this.sourceChanges;
    this.studio = new StudioControl(projects, () => this.diagnostics.emit('change'));
  }
}
