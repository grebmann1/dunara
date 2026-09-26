# Salesforce Mobile SDK integration

This app contains a typed adapter and React context for **Salesforce Mobile SDK 13.2.1**. Public environment settings live in `backend/salesforce.json`. Saving those settings or adding this source does not install or initialize the native SDK, authenticate anyone, or change the app's entry point.

## Build compatibility

The stable Salesforce template pins React Native **0.81.5** and React **19.1.0**. Dunara's current Expo template uses React Native **0.86.3** and React **19.2.3**. Do not install Mobile SDK into that template or downgrade React Native independently of Expo. SDK 14 release candidates are not qualified by this plugin. Dunara's managed Preview and build profiles do not yet support a Salesforce native dependency profile.

Use a separately reviewed native integration based on the [official 13.2.1 TypeScript template](https://github.com/forcedotcom/SalesforceMobileSDK-Templates/tree/v13.2.1/ReactNativeTypeScriptTemplate). The official generator is `forcereact@13.2.1`. Create a separate disposable native project first and qualify iOS and Android before migrating existing app screens.

The SDK dependency used by this adapter is the immutable source commit:

```json
{
  "react-native-force": "git+https://github.com/forcedotcom/SalesforceMobileSDK-ReactNative.git#a040de6a1515d20eef9c5c9785626c265089aa24"
}
```

The npm registry's unversioned `react-native-force` release is older. Use the matching official native SDK/template versions, not an unpinned registry install. Follow the template's CocoaPods, Android SDK, app delegate/application initialization, native login and callback wiring. Adding the JavaScript dependency alone is insufficient. Installing a native client is separate from Dunara's source review; inspect and qualify the resulting manifest, lockfile and native changes.

## Register the app in Salesforce

Create an External Client App (or an existing Connected App supported by your org) for a public native OAuth client. Enable the API and refresh-token scopes needed by your app, configure the exact native callback URI and follow Mobile SDK's OAuth settings. Keep client secrets out of the mobile app. Each app user signs in with their own Salesforce account and receives the org's existing object, field and record permissions.

Copy the selected environment's public consumer key, login URL and callback URI into the native template's boot configuration. Salesforce My Domain/sandbox routing and callback registration must agree with that native configuration. `backend/salesforce.json` is not automatically read by native boot code. Changing the environment requires updating and rebuilding the native app. Studio does not store Salesforce access or refresh tokens.

## Connect the React layer

In the **qualified native app**, create a client once outside component rendering:

```tsx
import { oauth, net } from 'react-native-force';
import configuration from './backend/salesforce.json';
import { createSalesforceClient } from './src/salesforce/client';
import { SalesforceProvider } from './src/salesforce/SalesforceProvider';

const settings = configuration.environments.development;
const client = createSalesforceClient({ oauth, net }, settings);

export default function App() {
  return <SalesforceProvider client={client}><YourApp /></SalesforceProvider>;
}
```

Use `useSalesforce()` from a child screen. Call `signIn()` from the sign-in action, then `loadRecords()` to read up to 100 rows of the configured object/fields. Handle rejected actions in the screen. `status`, `identity`, `records` and `error` are reactive. `signOut()` clears app records immediately and asks the native SDK to end its session. Raw SDK errors and OAuth tokens are not exposed by the adapter. The SDK manages token storage and refresh. Clear your own app caches on logout/account changes too.

For web or an Expo Go preview, pass `null` instead of importing `react-native-force`. This reports `native-setup-required` and never pretends to be signed in. Use separate platform entry files so a web bundle never imports the native SDK. No sample/live data fallback is automatic.

This initial adapter covers sign-in, sign-out and a bounded read. SmartStore/MobileSync are SDK capabilities, but this integration does not yet configure offline soups, synchronization, record writes, push notifications or Agentforce.

## Device checks before release

Verify sign-in/cancellation, API access to your chosen object and fields, expired-token refresh, logout while a read is pending, another user's login, and both iOS and Android callback behavior. Repeat for each environment. Fixture tests and web screenshots do not qualify a native device or a live Salesforce org.
