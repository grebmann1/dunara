# Salesforce backend

Enable **Salesforce** in Plugins, then open **Backend → Salesforce** in an app. Salesforce is optional and can coexist with Supabase. Each app keeps its own development, staging and production org settings.

The plugin is bundled with Dunara, not installed into every app. Enabling it or opening its workspace adds no app files or dependencies. Only the app selected for an explicitly reviewed Salesforce change receives that change; other apps keep their existing source, settings and dependencies.

1. In **Org settings**, enter the org label, Salesforce login/My Domain URL, public OAuth consumer key and native callback URI. Choose the object and field API names the app will read.
2. Choose **Review org settings**, then apply the change in the host's **Reviews** tab. A saved configuration does not mean the app has signed in.
3. In **React SDK**, inspect compatibility and choose **Add React integration**. Review the typed client, React provider/hooks and setup guide before applying.
4. Follow `salesforce/SETUP.md` in the app to initialize the official native SDK and connect your React entry point. App users sign in on their devices; Studio never asks for a Salesforce password, client secret or token.

Mobile SDK 13.2.1 targets React Native 0.81.5. Dunara's current Expo template uses 0.86.3, so native installation needs a separately qualified build. This plugin adds portable source and public configuration; it does not change dependencies, claim Expo Go compatibility, or qualify a native build. The existing preview stays unchanged. No live org was used to qualify this plugin.

The initial React adapter supports authentication and a read of up to 100 records. Offline sync, record writes and push notifications need additional integration. Disabling or uninstalling the plugin retains app source/configuration and does not sign users out of their devices.

[Official SDK 13.2.1](https://github.com/forcedotcom/SalesforceMobileSDK-ReactNative/tree/v13.2.1) · [Native template](https://github.com/forcedotcom/SalesforceMobileSDK-Templates/tree/v13.2.1/ReactNativeTypeScriptTemplate)
