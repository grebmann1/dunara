const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const inherited = config.resolver.blockList;
config.resolver.blockList = [
  ...(Array.isArray(inherited) ? inherited : inherited ? [inherited] : []),
  // Studio navigation is metadata, not application source. Watching it can
  // schedule an HMR update while a route switch closes the previous client.
  /[/\\]\.mobile-builder\.json$/,
  /[/\\]\.builder-[^/\\]+\.tmp$/,
];

module.exports = config;
