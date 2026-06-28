import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.friendmap.app',
  appName: 'FriendMap',
  webDir: 'out',           // Next.js static export folder
  server: {
    androidScheme: 'https',
  },
  plugins: {
    Geolocation: {
      // iOS: ask for always-on permission for background updates
      requestAlwaysAuthorization: true,
    },
    BackgroundGeolocation: {
      // Android foreground service notification
      notificationTitle: 'FriendMap',
      notificationText: 'Sharing your location with your group',
      notificationIconColor: '#38bdf8',
    },
  },
}

export default config
