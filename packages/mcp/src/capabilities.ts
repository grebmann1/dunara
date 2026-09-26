/** Agent-facing workflow map; schemas are always discovered from tools/list. */
export const agentAccess = {
  version: 1,
  discovery: 'Use tools/list, resources/list, resources/templates/list and prompts/list. CLI exposes tools, resources, resource-templates and prompts. Call any discovered tool with call; read resources with resource.',
  connection: 'Run mobile-builder runtimes, then use --connect-home with the chosen running runtime home. This shares the editor Engine. No computer use or launch ticket is needed. Private Unix sockets support macOS/Linux.',
  files: 'Use --output for images, JSON or complete project ZIP/Android APK downloads. Downloads expose ordered scoped chunk resources with SHA-256 and expiry. Never claim visual review from metadata alone; open the returned image using the agent’s image viewer.',
  workflows: [
    { area: 'Projects and source', tools: ['project_catalog', 'project_list', 'project_open', 'project_create', 'project_inspect', 'project_write_files', 'project_diagnostics', 'project_remove_unavailable', 'project_import_review', 'project_import_inspect', 'project_import_apply', 'project_export'] },
    { area: 'Navigation and journey', tools: ['studio_inspect', 'studio_control', 'activity_list', 'project_journey_read', 'project_journey_update'] },
    { area: 'Design and previews', prefixes: ['design_', 'preview_', 'board_', 'inspector_'] },
    { area: 'Assets, icons and launch kits', prefixes: ['media_', 'icon_', 'launch_kit_'], composition: 'Screen references use board_capture, its image resource, media_import, then user-reviewed media_approve. No computer use is needed.' },
    { area: 'Backend providers and plugins', tools: ['project_backend_list', 'plugin_list', 'plugin_guide', 'plugin_reviews', 'plugin_action'], prefixes: ['backend_', 'recipe_upgrade_', 'mb_'], composition: 'Discover installed and available plugins. Read project enablement, action schemas and guides. Invoke project-scoped Salesforce or future backend actions with plugin_action. Mutations prepare user reviews. An installed editor plugin does not enable it in an app.' },
    { area: 'Native preparation and delivery', prefixes: ['native_', 'android_delivery_'] },
  ],
  humanSteps: [
    { area: 'Plugin trust and backend choice', reason: 'The user installs/enables code in Plugins and manually enables each provider for each app in Backend. Agents inspect choices and prepare Install in app reviews; they do not authorize their own code installation.' },
    { area: 'Review approval and spending', reason: 'Plugin writes, remote backend changes and paid media execution require authenticated user approval. Agents can prepare and inspect them; they must not automate the approval UI. Confirmed local tools require the user’s prior authorization; the built-in Assistant uses its approval broker.' },
    { area: 'Private configuration and accounts', reason: 'Credentials, OAuth/login, account administration, private variables, image-provider settings and Assistant configuration stay with the operator. Public capability/status tools explain missing prerequisites; no tool accepts or reads private credentials.' },
    { area: 'Physical device observations', reason: 'Agents can prepare, build, install and read receipts. The user records actual phone test results and journey testing completion; a launch or web capture is not a physical test.' },
  ],
  pluginAuthoring: 'mobile-builder plugin new|validate|pack|dev. Plugin workflows must register actions with public schemas, scope and effect; panels should invoke those actions instead of hiding capabilities in UI callbacks. Guides are context, never authorization.',
};
