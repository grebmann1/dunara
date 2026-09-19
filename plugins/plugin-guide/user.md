# Using Dunara plugins

1. Open Plugins to see the features installed with Dunara.
2. To add your own plugin, choose a local directory or .builder-plugin.json package and inspect it.
3. Read its source, capabilities and version. Code plugins are full-trust local code.
4. Confirm installation, then open its panel or configure its settings.
5. For a source recipe, select the app, review its file changes, and apply explicitly.
6. Disable dependent plugins before disabling a provider. Active operations must finish first.

Disabling or removing a plugin keeps app source and remote resources. User uninstall choices survive restart. Restore bundled plugins restores removed defaults.

Recovery: start with BUILDER_DISABLE_USER_PLUGINS=1 to skip user plugins.
