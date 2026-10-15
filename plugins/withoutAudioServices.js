// expo-audio's library manifest declares two foreground services (AudioControlsService,
// mediaPlayback; AudioRecordingService, microphone), and Gradle merges them into the app even
// with recordAudioAndroid:false. Google Play then requires a foreground-service declaration,
// with a demo video, for FOREGROUND_SERVICE_MEDIA_PLAYBACK (store/STORE-8). This app only plays
// audio in the foreground (shouldPlayInBackground:false, no lock-screen controls) and never
// records, so both services are stripped at manifest-merge time with tools:node="remove".
// The matching permissions are removed via android.blockedPermissions in app.json.
//
// If background playback or lock-screen controls are ever added, remove this plugin and file
// the Play declaration.
const { withAndroidManifest } = require('expo/config-plugins');

const TOOLS_NS = 'http://schemas.android.com/tools';
const SERVICES = [
  'expo.modules.audio.service.AudioControlsService',
  'expo.modules.audio.service.AudioRecordingService',
];

module.exports = function withoutAudioServices(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest.$ = { ...manifest.$, 'xmlns:tools': TOOLS_NS };

    const application = manifest.application?.[0];
    if (!application) throw new Error('withoutAudioServices: AndroidManifest has no <application>');
    application.service = application.service ?? [];

    // Idempotent: update an existing entry instead of appending a duplicate on re-prebuild.
    for (const name of SERVICES) {
      const existing = application.service.find((s) => s.$?.['android:name'] === name);
      if (existing) existing.$['tools:node'] = 'remove';
      else application.service.push({ $: { 'android:name': name, 'tools:node': 'remove' } });
    }
    return cfg;
  });
};
