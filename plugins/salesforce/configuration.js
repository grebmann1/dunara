export const SDK = Object.freeze({ version: '13.2.1', reactNative: '0.81.5', react: '19.1.0', commit: 'a040de6a1515d20eef9c5c9785626c265089aa24', package: 'react-native-force' });
export const environments = ['development', 'staging', 'production'];
export const configurationPath = 'backend/salesforce.json';
const identifier = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
export const connectionSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    environment: { type: 'string', enum: environments },
    label: { type: 'string', minLength: 1, maxLength: 80 },
    loginUrl: { type: 'string', minLength: 1, maxLength: 200 },
    clientId: { type: 'string', minLength: 10, maxLength: 512 },
    redirectUri: { type: 'string', minLength: 1, maxLength: 200 },
    object: { type: 'string', minLength: 1, maxLength: 80 },
    fields: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 80 } },
  },
  required: ['environment', 'label', 'loginUrl', 'clientId', 'redirectUri', 'object', 'fields'],
};
export function connection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !Object.hasOwn(connectionSchema.properties, key))) throw Error('Use only the public Salesforce connection fields.');
  if (!environments.includes(value.environment) || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 80) throw Error('Choose an environment and an org label.');
  let url;
  try { url = new URL(value.loginUrl); } catch { throw Error('Enter an HTTPS Salesforce login or My Domain URL.'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !/^(?:login\.salesforce\.com|test\.salesforce\.com|[a-z0-9][a-z0-9.-]*\.my\.salesforce\.com)$/.test(url.hostname)) throw Error('Enter an HTTPS Salesforce login or My Domain URL without a path or credentials.');
  if (typeof value.clientId !== 'string' || !/^[A-Za-z0-9._-]{10,512}$/.test(value.clientId)) throw Error('Enter the public OAuth consumer key, not a client secret or token.');
  if (typeof value.redirectUri !== 'string' || value.redirectUri.length > 200 || !/^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9/._-]+$/.test(value.redirectUri) || /^(?:https?|file|javascript|data):/i.test(value.redirectUri)) throw Error('Use a native callback URL such as myapp://salesforce/auth.');
  if (typeof value.object !== 'string' || !identifier.test(value.object) || !Array.isArray(value.fields) || !value.fields.length || value.fields.length > 20 || value.fields.some(field => typeof field !== 'string' || !identifier.test(field))) throw Error('Use Salesforce object and field API names without expressions.');
  const fields = [...new Set(['Id', ...value.fields])];
  if (fields.length > 20) throw Error('Choose at most 20 fields, including Id.');
  return { environment: value.environment, label: value.label.trim(), loginUrl: url.origin, clientId: value.clientId, redirectUri: value.redirectUri, object: value.object, fields };
}
export function configuration(value) {
  if (!value || value.version !== 1 || !value.environments || typeof value.environments !== 'object' || Array.isArray(value.environments) || Object.keys(value).some(key => !['version', 'environments'].includes(key))) throw Error('Unsupported Salesforce configuration.');
  const parsed = {};
  for (const [environment, saved] of Object.entries(value.environments)) {
    if (saved?.environment !== environment) throw Error('Salesforce environment does not match its configuration.');
    parsed[environment] = connection(saved);
  }
  return { version: 1, environments: parsed };
}
export function compatibility(manifest) {
  const dependencies = { ...manifest.devDependencies, ...manifest.dependencies };
  const reactNative = dependencies['react-native'] ?? null, react = dependencies.react ?? null;
  const dependency = dependencies[SDK.package] ?? null;
  const pinned = `git+https://github.com/forcedotcom/SalesforceMobileSDK-ReactNative.git#${SDK.commit}`;
  const compatible = reactNative === SDK.reactNative && react === SDK.react;
  return { sdk: SDK, reactNative, react, dependency, compatible,
    state: !compatible ? 'incompatible' : dependency !== pinned ? 'native-setup-required' : 'native-verification-required',
    message: !compatible ? `Mobile SDK ${SDK.version} uses React Native ${SDK.reactNative} and React ${SDK.react}. This app uses ${reactNative ?? 'an unknown React Native version'} and ${react ?? 'an unknown React version'}. Native integration needs a separately qualified build.` : 'Verify the iOS and Android SDK initialization, OAuth callback and a signed-in device build before using live Salesforce data.',
  };
}
