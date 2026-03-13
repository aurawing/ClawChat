import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.clawchat.app',
  appName: 'ClawChat',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: true,
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
    Keyboard: {
      resize: 'body',
      resizeOnFullScreen: true,
    },
    Camera: {
      presentationStyle: 'fullScreen',
    },
  },
};

export default config;
