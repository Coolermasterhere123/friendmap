# FriendMap

Real-time friend location sharing with background GPS. Works as a web PWA or as a native Android/iOS app with true background location.

---

## Supabase setup

### 1. Run this SQL (Dashboard → SQL Editor)

```sql
create table if not exists room_members (
  id text primary key,
  room text not null,
  name text not null,
  color text not null,
  lat double precision,
  lng double precision,
  accuracy integer,
  heading integer,
  speed double precision,
  updated_at timestamptz default now()
);

alter table room_members enable row level security;
create policy "allow all" on room_members for all using (true) with check (true);

create table if not exists meetup_pins (
  id uuid primary key default gen_random_uuid(),
  room text not null,
  lat double precision not null,
  lng double precision not null,
  set_by text not null,
  set_by_name text not null,
  created_at timestamptz default now()
);

alter table meetup_pins enable row level security;
create policy "allow all" on meetup_pins for all using (true) with check (true);

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  room text not null,
  member_id text not null,
  member_name text not null,
  member_color text not null,
  message text not null,
  created_at timestamptz default now()
);

alter table chat_messages enable row level security;
create policy "allow all" on chat_messages for all using (true) with check (true);
```

If the table already exists, just add the new columns:
```sql
alter table room_members add column if not exists accuracy integer;
alter table room_members add column if not exists heading integer;
alter table room_members add column if not exists speed double precision;
```

### 2. Enable Realtime
Dashboard → Database → Replication → toggle on `room_members`, `meetup_pins`, and `chat_messages`

### 3. Environment variables
Copy `.env.local.example` → `.env.local` and fill in your Supabase URL and anon key.
Add the same two vars to Vercel for the web deployment.

---

## Web deployment (Vercel)

```bash
npm install
npm run build   # produces /out folder
```

Drop zip into your auto-deploy script as normal. The web version uses browser GPS — works well but stops when the phone sleeps.

---

## Native app build (Android/iOS) — background GPS

This gives you true background location that works at the lock screen.

### Prerequisites
- Android Studio installed (for Android)
- Xcode installed (for iOS, Mac only)
- Node 18+

### Step 1 — Install and init Capacitor

```bash
npm install
npx cap init FriendMap com.friendmap.app --web-dir out
npx cap add android
npx cap add ios        # Mac only
```

### Step 2 — Build the web app and sync

```bash
npm run build
npx cap sync
```

Run this every time you change the web code.

### Step 3 — Android: add permissions to AndroidManifest.xml

Open `android/app/src/main/AndroidManifest.xml` and add inside `<manifest>` (above `<application>`):

```xml
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
```

And inside `<application>`:
```xml
<service
    android:name="com.transistorsoft.locationmanager.service.TrackingService"
    android:foregroundServiceType="location" />
```

### Step 4 — iOS: add Info.plist keys

Open `ios/App/App/Info.plist` and add inside `<dict>`:

```xml
<key>NSLocationWhenInUseUsageDescription</key>
<string>FriendMap shows your location to friends in your group.</string>
<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
<string>FriendMap shares your location in the background so friends can find you even when the app is closed.</string>
<key>NSLocationAlwaysUsageDescription</key>
<string>FriendMap shares your location in the background so friends can find you even when the app is closed.</string>
<key>UIBackgroundModes</key>
<array>
    <string>location</string>
</array>
```

### Step 5 — Open in Android Studio / Xcode

```bash
npx cap open android   # opens Android Studio
npx cap open ios       # opens Xcode (Mac only)
```

Then build and run on your device as normal.

### Quick rebuild after code changes

```bash
npm run build && npx cap sync android
```

---

## How background GPS works

- On **Android**: the `@capacitor-community/background-geolocation` plugin runs a foreground service with a persistent notification ("FriendMap is sharing your location"). This keeps GPS alive at the lock screen and when the app is swiped away.
- On **iOS**: uses `CLLocationManager` with `allowsBackgroundLocationUpdates = true`. iOS may still throttle updates in low-power mode, but location continues in the background.
- On **web**: falls back to `navigator.geolocation.watchPosition` with a 60-second force re-poll to work around browsers killing the watch.

## Location update frequency

- App open and active: updates every time you move 10+ metres
- Background / lock screen (native app): same — every 10 metres moved
- Web PWA with screen off: may stop after 5–15 min (OS limitation)
