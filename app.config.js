// Dynamic layer on top of app.json. Everything static stays in app.json; this file only adds
// what depends on the build environment.
//
// googleServicesFile: Android push cannot mint an Expo push token without the Firebase client
// config (google-services.json) compiled into the app. The FCM V1 service-account key uploaded
// with `eas credentials` is only the server half, used by Expo's push service to send.
//
//   EAS Build: create a "file" environment variable named GOOGLE_SERVICES_JSON
//              (eas env:create --name GOOGLE_SERVICES_JSON --type file ...). EAS writes the
//              file on the worker and sets the variable to its path.
//   Locally:   drop google-services.json in the project root (it is gitignored).
//
// When neither is present the key is left out entirely, so `npx expo config` and iOS builds
// keep working; scripts/preflight.mjs fails an Android release build that lacks it.
const fs = require('fs');
const path = require('path');

module.exports = ({ config, projectRoot }) => {
  // Checked against projectRoot, not the cwd: Expo does not chdir before evaluating this file.
  // The relative value is fine, Expo resolves it against the project root.
  const googleServicesFile =
    process.env.GOOGLE_SERVICES_JSON ||
    (fs.existsSync(path.join(projectRoot, 'google-services.json'))
      ? './google-services.json'
      : undefined);

  return {
    ...config,
    android: {
      ...config.android,
      ...(googleServicesFile ? { googleServicesFile } : {}),
    },
  };
};
