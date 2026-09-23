/** A human-editable request, staged only; the user still chooses when to send. */
export function projectBuildPrompt(name: string, brief: string) {
  return `Build the first version of ${name}.\n\n${brief.trim()}\n\nMake it feel like a complete, distinctive app: cohesive screens, thoughtful artwork, and working interactions. Replace unrelated starter content. Start the preview when execution is available, inspect the changed screens at both phone sizes, and tell me what I can try and what still needs work.`;
}
